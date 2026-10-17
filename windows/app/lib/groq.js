'use strict';

// Groq 호출부: Whisper 받아쓰기 + 채팅 번역. 맥 Groq.swift(GroqClient) 이식.
//
// 모델 순서는 large-v3 → turbo. 한도(429)는 모델마다 따로 잡히므로 막히면 다음 모델로 넘긴다.
// 5xx(520·525 등 Groq 앞단 Cloudflare 장애)와 네트워크 오류는 같은 음성으로 다시 보낸다.
//
// "설명해줘"(explainUnified 등)는 4단계에서 붙인다. 그때 필요한 것들은 열어 두었다:
//   chat(body, key) 공개, VISION_MODEL·REASONING_MODEL 상수, lastTokens, lenientJSON 주입 자리.
//
// API 키는 Authorization 헤더에만 쓰고, 오류 메시지에 섞여 들어오면 *** 로 가린다.

const { randomUUID } = require('node:crypto');
const Hallucination = require('./hallucination');
const Usage = require('./usage');
const { encodeWav } = require('./wav');
const { suffix, trimWs, trimWsNl, parseDoubleStrict } = require('./text');

const WHISPER_MODELS = Object.freeze(['whisper-large-v3', 'whisper-large-v3-turbo']);
const CHAT_MODELS = Object.freeze(['openai/gpt-oss-120b', 'openai/gpt-oss-20b']); // qwen 은 번역 중간에 중국어가 섞여서 뺐다
const VISION_MODEL = 'qwen/qwen3.8-27b';
const REASONING_MODEL = 'openai/gpt-oss-120b';
const TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const RETRIES = 3;
const TIMEOUT_MS = 60_000;
const PROMPT_CHARS = 400; // 직전 문맥: 고유명사·용어 인식률이 오른다

// 매 요청마다 입력 토큰으로 세지므로 짧게 둔다
const TRANSLATE_PROMPT = 'Translate numbered lecture transcript lines into natural Korean. Output only "N. translation", one per line. '
  + 'Lines are speech-recognition chunks: a sentence may continue across lines; fix clearly misheard words; '
  + 'drop fillers (um, uh). Keep technical terms accurate. No notes. '
  // 앞줄이 문장 중간에서 끊기면 모델이 앞줄까지 "1." 로 옮겨 번호가 하나씩 밀렸다. 맥과 같은 문장 (fixtures/mac-providers)
  + 'Never output the Previous line; "1." is the first numbered line.';

const MESSAGES = Object.freeze({
  noKey: 'Groq API 키가 없습니다. 설정에서 키를 입력하세요.',
  badKey: 'API 키가 올바르지 않습니다. 설정에서 다시 확인하세요.',
});

class GroqError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GroqError';
  }
}

/** 429. retryAfter: 응답 헤더 retry-after (초) 또는 null */
class RateLimitedError extends Error {
  constructor(retryAfter = null) {
    const wait = retryAfter == null ? '잠시 뒤'
      : retryAfter >= 60 ? `${Math.ceil(retryAfter / 60)}분 뒤` : `${Math.ceil(retryAfter)}초 뒤`;
    super(`Groq 무료 한도에 걸렸습니다. ${wait} 다시 눌러 주세요.`);
    this.name = 'RateLimitedError';
    this.retryAfter = retryAfter;
  }
}

/** 다시 보내면 풀릴 수 있는 오류 */
class TransientError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransientError';
  }
}

function redact(text, key) {
  const s = String(text);
  return key ? s.split(key).join('***') : s;
}

/** JSON 객체(배열 아님)면 그 객체, 아니면 null — Swift `as? [String: Any]` */
function parseObject(data) {
  try {
    const v = JSON.parse(data.toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' ? v : 0);

/** 앞줄(문장이 이어질 때 참고, 옮기지 않음) + 번호 붙인 옮길 줄 */
function translationInput(lines, context = []) {
  const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
  return context.length === 0 ? numbered : `Previous (do not translate): ${context.join(' ')}\n${numbered}`;
}

/**
 * "N. 번역" 줄들 → 입력과 같은 길이의 배열. 응답에서 못 찾은 줄은 null.
 * context: 앞줄을 함께 보냈다. 모델이 앞줄을 1번으로 옮겨 1..count+1 이 빠짐없이 오면 한 줄 밀린 것으로 보고 첫 줄을 버린다
 */
function parseTranslation(out, count, { context = false } = {}) {
  if (context) {
    const nums = new Map();
    for (const raw of String(out).split(/\r?\n/)) {
      const m = /^\s*(\d+)\.\s*(\S.*)$/.exec(raw);
      if (m) nums.set(Number(m[1]), m[2]);
    }
    const shifted = nums.size === count + 1 && [...Array(count + 1).keys()].every((i) => nums.has(i + 1));
    if (shifted) return Array.from({ length: count }, (_, i) => trimWs(nums.get(i + 2)) || null);
  }
  const result = new Array(count).fill(null);
  // Swift 는 "\r\n" 을 한 글자로 봐서 "\n" 으로 나누지 못한다. 여기서는 CRLF 도 줄로 나눈다
  for (const raw of String(out).split(/\r?\n/)) {
    const line = trimWs(raw);
    const dot = line.indexOf('.');
    if (dot < 0) continue;
    const head = line.slice(0, dot);
    if (!/^[+-]?\d+$/.test(head)) continue; // Swift Int(String)
    const n = Number(head);
    if (n < 1 || n > count) continue;
    const text = trimWs(line.slice(dot + 1));
    if (text) result[n - 1] = text;
  }
  return result;
}

function retryAfterOf(headers) {
  return parseDoubleStrict(headers?.get?.('retry-after') ?? null);
}

class GroqClient {
  /**
   * fetch: 주입 가능한 fetch (기본 전역 fetch). 시험에서는 가짜를 넣는다
   * getKey: () => 키 문자열 또는 null (keystore.read)
   * sleep(ms), now(): 재시도 대기·쉬는 시간 계산용
   * onUsage(model, {remaining, limit}): 남은 요청 수 헤더가 있을 때 (맥 Usage.report)
   * onSpent(model, 'audio'|'tokens', amount): 응답에 실린 쓴 양 (맥 Usage.spent)
   * lenientJSON(raw) → 고친 JSON 문자열 또는 null: 4단계 "설명해줘"에서 넣는다
   */
  constructor({
    fetch = globalThis.fetch, getKey, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(), onUsage = () => {}, onSpent = () => {}, lenientJSON = null, timeoutMs = TIMEOUT_MS,
  } = {}) {
    if (typeof getKey !== 'function') throw new TypeError('GroqClient: getKey 함수가 필요합니다');
    this.fetch = fetch;
    this.getKey = getKey;
    this.sleep = sleep;
    this.now = now;
    this.onUsage = onUsage;
    this.onSpent = onSpent;
    this.lenientJSON = lenientJSON;
    this.timeoutMs = timeoutMs;
    this.cooldown = new Map(); // 모델 → 다시 써도 되는 시각(ms)
    this.lastTokens = 0; // 마지막으로 성공한 채팅 요청의 토큰
  }

  requireKey() {
    const key = this.getKey();
    if (!key) throw new GroqError(MESSAGES.noKey);
    return key;
  }

  /** 요청 한 번. 연결·본문 읽기 실패는 Transient */
  async request(url, init, key) {
    try {
      const res = await this.fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      const data = Buffer.from(await res.arrayBuffer());
      return { status: res.status, headers: res.headers, data };
    } catch (e) {
      throw new TransientError(`네트워크 오류: ${redact(e?.message ?? e, key)}`);
    }
  }

  reportUsage(model, headers) {
    const u = Usage.read(headers);
    if (u) this.onUsage(model, u);
  }

  /** 401·429·5xx 공통 처리 */
  static failCommon(status, headers) {
    if (status === 401) throw new GroqError(MESSAGES.badKey);
    if (status === 429) throw new RateLimitedError(retryAfterOf(headers));
    // 52x 는 Cloudflare 가 HTML 페이지를 돌려준다. 본문 대신 코드만 보여준다
    if (status >= 500 && status <= 599) throw new TransientError(`Groq 서버 일시 장애 (${status})`);
  }

  // --- 받아쓰기 ---

  /** 지어낸 문장을 거른 글. onFallback(막힌 모델, 다음 모델) */
  async transcribe(wav, { language, prompt = '', onFallback } = {}) {
    const segs = await this.segments(wav, { language, prompt, onFallback });
    return Hallucination.keep(segs.map((s) => ({ text: s.text, noSpeechProb: s.noSpeech })));
  }

  /** 구간별 글과 시각 [{text, start, end, noSpeech}]. 다시 받아 적기는 이 시각으로 줄을 나눈다 */
  async segments(wav, { language, prompt = '', onFallback = () => {} } = {}) {
    const key = this.requireKey();
    const now = this.now();
    const usable = WHISPER_MODELS.filter((m) => (this.cooldown.get(m) ?? -Infinity) <= now);
    const chain = usable.length ? usable : [WHISPER_MODELS[0]];

    let lastError = new GroqError('음성 인식에 실패했습니다');
    for (let i = 0; i < chain.length; i++) {
      const model = chain[i];
      try {
        return await this.sendWithRetry(wav, model, key, language, prompt);
      } catch (e) {
        if (!(e instanceof RateLimitedError)) throw e;
        const wait = Math.min(Math.max(e.retryAfter ?? 30, 30), 600);
        this.cooldown.set(model, this.now() + wait * 1000);
        lastError = new GroqError(`'${model}' 한도를 초과했고 대체할 모델도 없습니다. 잠시 후 다시 시도하세요.`);
        if (i + 1 < chain.length) onFallback(model, chain[i + 1]);
      }
    }
    throw lastError;
  }

  async sendWithRetry(wav, model, key, language, prompt) {
    let lastMessage = '음성 인식에 실패했습니다';
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      try {
        return await this.sendOnce(wav, model, key, language, prompt);
      } catch (e) {
        if (!(e instanceof TransientError)) throw e;
        lastMessage = e.message;
        if (attempt < RETRIES) await this.sleep(1500 * attempt);
      }
    }
    throw new GroqError(`${lastMessage} — ${RETRIES}번 다시 보냈지만 실패`);
  }

  async sendOnce(wav, model, key, language, prompt) {
    // verbose_json: 구간마다 "말소리 없음 확률"이 와서 지어낸 문장을 구간 단위로 거를 수 있다
    const fields = [['model', model], ['response_format', 'verbose_json'], ['temperature', '0'], ['language', language]];
    if (prompt) fields.push(['prompt', suffix(prompt, PROMPT_CHARS)]);
    const boundary = `ezrite-${randomUUID()}`;
    const { status, headers, data } = await this.request(TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: GroqClient.multipart(fields, wav, boundary),
    }, key);
    this.reportUsage(model, headers);

    if (status === 200) {
      const obj = parseObject(data);
      if (typeof obj?.duration === 'number') this.onSpent(model, 'audio', obj.duration);
      const segs = obj?.segments;
      if (!Array.isArray(segs) || !segs.every(isPlainObject)) {
        const text = trimWsNl(typeof obj?.text === 'string' ? obj.text : '');
        return text ? [{ text, start: 0, end: 0, noSpeech: 0 }] : [];
      }
      return segs.map((s) => ({
        text: typeof s.text === 'string' ? s.text : '', start: num(s.start), end: num(s.end), noSpeech: num(s.no_speech_prob),
      }));
    }
    GroqClient.failCommon(status, headers);
    const msg = parseObject(data)?.error?.message;
    const detail = typeof msg === 'string' ? msg : data.subarray(0, 200).toString('utf8');
    throw new GroqError(redact(`Groq 오류 ${status}: ${detail}`, key));
  }

  /** fields: [[이름, 값]] — 맥은 사전(순서 없음)이라 칸 순서는 의미 없다 */
  static multipart(fields, file, boundary) {
    const parts = fields.map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
    return Buffer.concat([
      Buffer.from(parts.join('') + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\n`
        + 'Content-Type: audio/wav\r\n\r\n', 'utf8'),
      Buffer.from(file),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);
  }

  // --- 번역 ---

  /** 여러 줄을 한 번에 옮긴다. 120b 가 막히면(429) 20b 로. 돌려받은 배열은 입력과 같은 길이, 못 찾은 줄은 null */
  async translate(lines, context = []) {
    const key = this.requireKey();
    const input = translationInput(lines, context);
    let lastError = new GroqError('번역에 실패했습니다');
    for (const model of CHAT_MODELS) {
      for (let attempt = 1; attempt <= RETRIES; attempt++) {
        try {
          return parseTranslation(await this.chatOnce(model, key, input), lines.length, { context: context.length > 0 });
        } catch (e) {
          if (e instanceof RateLimitedError) {
            lastError = new GroqError('번역 한도 초과');
            break; // 다음 모델로
          }
          if (!(e instanceof TransientError)) throw e;
          lastError = new GroqError(`번역: ${e.message}`);
          if (attempt < RETRIES) await this.sleep(1500 * attempt);
        }
      }
    }
    throw lastError;
  }

  chatOnce(model, key, input) {
    return this.chat({
      model,
      messages: [{ role: 'system', content: TRANSLATE_PROMPT }, { role: 'user', content: input }],
      temperature: 0.2,
      reasoning_effort: 'low', // gpt-oss 는 추론 모델이다. 번역엔 길게 생각할 필요가 없다
    }, key);
  }

  /** 채팅 요청 한 번. 응답 본문(content)을 돌려준다 */
  async chat(body, key) {
    const { status, headers, data } = await this.request(CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, key);
    const model = typeof body.model === 'string' ? body.model : null;
    if (model) this.reportUsage(model, headers);

    if (status === 200) {
      const obj = parseObject(data);
      const tokens = obj?.usage?.total_tokens;
      if (model && typeof tokens === 'number') {
        this.onSpent(model, 'tokens', tokens);
        this.lastTokens = tokens;
      }
      const content = Array.isArray(obj?.choices) ? obj.choices[0]?.message?.content : undefined;
      return typeof content === 'string' ? content : '';
    }
    GroqClient.failCommon(status, headers);
    const err = parseObject(data)?.error;
    // JSON 을 시켰는데 모델이 수식 역슬래시를 그대로 써서 Groq 이 거절한 경우: 거절된 원문을 고쳐 쓴다 (다시 묻지 않는다)
    if (body.response_format != null && typeof err?.failed_generation === 'string' && this.lenientJSON) {
      const fixed = this.lenientJSON(err.failed_generation);
      if (fixed != null) return String(fixed);
    }
    throw new GroqError(redact(`Groq 오류 ${status}: ${typeof err?.message === 'string' ? err.message : ''}`, key));
  }

  /**
   * 앱을 켤 때 모델마다 남은 한도를 알아 둔다. 모델마다 하루 한도에서 1회씩 쓴다
   * (채팅은 1토큰짜리 요청, 받아쓰기는 0.3초 무음). 실패는 무시한다.
   */
  async probeLimits() {
    const key = this.getKey();
    if (!key) return;
    for (const model of [...CHAT_MODELS, VISION_MODEL]) {
      try {
        await this.chat({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }, key);
      } catch { /* 한도만 알면 된다 */ }
    }
    const silence = encodeWav(new Float32Array(4800));
    for (const model of WHISPER_MODELS) {
      try {
        await this.sendOnce(silence, model, key, 'ko', '');
      } catch { /* 한도만 알면 된다 */ }
    }
  }
}

Object.assign(GroqClient, {
  WHISPER_MODELS, CHAT_MODELS, VISION_MODEL, REASONING_MODEL, TRANSCRIBE_URL, CHAT_URL, RETRIES, TRANSLATE_PROMPT,
  translationInput, parseTranslation,
});

module.exports = {
  GroqClient, GroqError, RateLimitedError, TransientError, MESSAGES, translationInput, parseTranslation, redact,
};
