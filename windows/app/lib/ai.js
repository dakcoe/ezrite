'use strict';

// 번역·화면 설명에 쓸 수 있는 AI 서비스 (맥 AI.swift 의 Provider·Feature·AI 를 옮겼다).
// 기본은 무료인 Groq, 나머지는 사용자가 키를 넣으면 쓴다. 받아쓰기는 Groq 만 쓴다.
// 요청 모양은 맥이 실제로 만든 요청(fixtures/mac-providers)과 글자 그대로 같아야 한다 (test/ai.test.js).
// 키는 로그·오류·상태 어디에도 싣지 않는다: 오류 글은 redact 로 키를 가린다.

const PROVIDERS = Object.freeze(['groq', 'claude', 'gemini', 'openai']);
const FEATURES = Object.freeze(['translate', 'explain']);

const LABEL = Object.freeze({ groq: 'Groq', claude: 'Claude', gemini: 'Gemini', openai: 'GPT' });
const KEY_PAGE = Object.freeze({
  groq: 'https://console.groq.com/keys',
  claude: 'https://console.anthropic.com/settings/keys',
  gemini: 'https://aistudio.google.com/app/apikey',
  openai: 'https://platform.openai.com/api-keys',
});

const ANTHROPIC_VERSION = '2023-06-01';
const CHAT_BASE = Object.freeze({
  groq: 'https://api.groq.com/openai/v1',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
});
const MODELS_URL = Object.freeze({
  claude: 'https://api.anthropic.com/v1/models?limit=100',
  groq: 'https://api.groq.com/openai/v1/models',
  openai: 'https://api.openai.com/v1/models',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
});

// 맥과 같은 값: 번역 2000, 설명·질문 8000 (1.3.0, 전엔 3000 — 긴 답이 잘려 JSON 이 깨졌다), 키 확인 16
const TRANSLATE_MAX_TOKENS = 2000;
const EXPLAIN_MAX_TOKENS = 8000;
const CHECK_MAX_TOKENS = 16;
// 전체 시간으로 끊는다 (연결만 붙들고 답을 안 주는 모델이 있다 — Gemini 무료 등급 일부)
const REQUEST_MS = 60_000;
const CHECK_MS = 15_000;
// 받는 대로 보여 주는 답(카드 질문)은 글이 오는 동안에도 전체 120초로 끊는다 (맥 streamTimeout)
const STREAM_MS = 120_000;

const isProvider = (p) => PROVIDERS.includes(p);

class AIFailure extends Error {
  /** status: HTTP 코드. null 이면 응답 없음(시간 초과·네트워크) */
  constructor(status, message) {
    super(message);
    this.name = 'AIFailure';
    this.status = status;
  }
}

/** 글에서 키를 모두 가린다 */
function redact(text, keys) {
  let s = String(text ?? '');
  for (const k of [].concat(keys ?? [])) if (typeof k === 'string' && k) s = s.split(k).join('***');
  return s;
}

// ── 요청 만들기 ──

/**
 * 한 번의 요청 { url, method, headers, body }. image(Buffer) 가 있으면 JPEG 로 붙이고, json 이면 JSON 으로만 답하게 한다.
 * think=false 면 Claude 의 생각 단계를 끈다 (번역처럼 단순한 일에 출력 토큰이 몇 배로 늘지 않게).
 * stream: 답을 조각(SSE)으로 받는다 (1.3.0 카드 질문). GPT 는 include_usage 를 켜야 마지막 조각에 쓴 토큰 수가 온다
 */
function request(p, { model, key, prompt, image = null, json = false, maxTokens, think = true, stream = false }) {
  const req = baseRequest(p, { model, key, prompt, image, json, maxTokens, think });
  if (stream) {
    req.body.stream = true;
    if (p === 'openai') req.body.stream_options = { include_usage: true };
  }
  return req;
}

function baseRequest(p, { model, key, prompt, image, json, maxTokens, think }) {
  if (!isProvider(p)) throw new TypeError(`모르는 서비스: ${p}`);
  const b64 = image ? Buffer.from(image).toString('base64') : null;
  if (p === 'claude') {
    const content = [];
    if (b64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
    // Claude 에는 JSON 전용 모드가 없다. 지시로 요구하고, 받을 때 코드블록을 벗긴다(stripFences)
    content.push({ type: 'text', text: json ? `${prompt}\nRespond with the JSON object only.` : prompt });
    const body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content }] };
    if (!think) body.thinking = { type: 'disabled' };
    return {
      url: 'https://api.anthropic.com/v1/messages', method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'Content-Type': 'application/json' },
      body,
    };
  }
  const content = [{ type: 'text', text: prompt }];
  if (b64) content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } });
  const body = { model, messages: [{ role: 'user', content }] };
  // GPT 의 추론 모델은 max_tokens 대신 max_completion_tokens 만 받는다
  body[p === 'openai' ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;
  if (json) body.response_format = { type: 'json_object' };
  return {
    url: `${CHAT_BASE[p]}/chat/completions`, method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body,
  };
}

/**
 * 생각을 끈 Claude 요청이 400 으로 거절됐을 때 한 번 다시 보낼 요청 (맥 AI.swift thinkingOffRetry). 아니면 null.
 * 모델마다 끄는 방법이 달라 이름으로 정하지 않고 오류 설명을 따른다:
 *   "between_tools" 가 있으면 (sonnet-5-5) thinking 만 between_tools 로
 *   "adaptive" 가 있으면 (opus-5-5: 끌 수 없다) adaptive + output_config.effort low 로
 *   그 밖의 400 (설명에 "thinking" 이 없는 것 포함)은 다시 보내지 않는다
 */
function thinkingOffRetry(req, status, text) {
  if (status !== 400 || req?.body?.thinking?.type !== 'disabled' || !req.url.startsWith('https://api.anthropic.com/')) return null;
  const msg = errorMessage(text);
  if (!msg.includes('thinking')) return null;
  let change = null;
  if (msg.includes('between_tools')) change = { thinking: { type: 'between_tools' } };
  else if (msg.includes('adaptive')) change = { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } };
  return change && { ...req, body: { ...req.body, ...change } };
}

/** 키 저장 때 모델이 실제로 답하는지 짧게 불러 보는 요청 ("Say OK") */
function checkRequest(p, model, key) {
  return request(p, { model, key, prompt: 'Say OK', image: null, json: false, maxTokens: CHECK_MAX_TOKENS, think: false });
}

function modelsRequest(p, key) {
  const headers = p === 'claude'
    ? { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }
    : { Authorization: `Bearer ${key}` };
  return { url: MODELS_URL[p], method: 'GET', headers };
}

// ── 응답 읽기 ──

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' ? v : 0);

function parseJSON(text) {
  try {
    return JSON.parse(Buffer.isBuffer(text) ? text.toString('utf8') : String(text));
  } catch {
    return undefined;
  }
}

/** obj: 응답 JSON. { text, tokens, input, output } 또는 null. input·output 은 비용 계산용 입력·출력 토큰 (1.2.3) */
function reply(p, obj) {
  if (!isObject(obj)) return null;
  const usage = isObject(obj.usage) ? obj.usage : {};
  if (p === 'claude') {
    const text = (Array.isArray(obj.content) ? obj.content : [])
      .filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('');
    const input = num(usage.input_tokens);
    const output = num(usage.output_tokens);
    return { text, tokens: input + output, input, output };
  }
  const msg = Array.isArray(obj.choices) ? obj.choices[0]?.message?.content : undefined;
  return { text: typeof msg === 'string' ? msg : '', tokens: num(usage.total_tokens), input: num(usage.prompt_tokens), output: num(usage.completion_tokens) };
}

/**
 * 스트리밍 조각(SSE 의 data 한 줄)을 모은다. Claude 와 OpenAI 꼴(GPT·Gemini·Groq) 두 가지 (맥 StreamState).
 * take(obj): 글이 늘었으면 true. 서버가 중간에 오류 조각을 보내면 던진다 (상태 코드 없이 → Groq 로 대신)
 */
class StreamState {
  constructor(p) {
    Object.assign(this, { p, text: '', input: 0, output: 0, total: 0 });
  }

  take(obj) {
    if (!isObject(obj)) return false;
    if (isObject(obj.error)) throw new AIFailure(null, `${LABEL[this.p]} 오류: ${typeof obj.error.message === 'string' ? obj.error.message : ''}`);
    const n = (d, k) => (isObject(d) && typeof d[k] === 'number' ? Math.trunc(d[k]) : null);
    if (this.p === 'claude') {
      if (obj.type === 'message_start') this.input = n(obj.message?.usage, 'input_tokens') ?? this.input;
      else if (obj.type === 'message_delta') this.output = n(obj.usage, 'output_tokens') ?? this.output;
      else if (obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta' && typeof obj.delta.text === 'string' && obj.delta.text) {
        this.text += obj.delta.text;
        return true;
      }
      return false;
    }
    if (isObject(obj.usage)) {
      this.input = n(obj.usage, 'prompt_tokens') ?? this.input;
      this.output = n(obj.usage, 'completion_tokens') ?? this.output;
      this.total = n(obj.usage, 'total_tokens') ?? this.total;
    }
    const t = Array.isArray(obj.choices) ? obj.choices[0]?.delta?.content : undefined;
    if (typeof t === 'string' && t) {
      this.text += t;
      return true;
    }
    return false;
  }

  get tokens() {
    return this.p === 'claude' ? this.input + this.output : this.total;
  }
}

/** ```json … ``` 처럼 감싸 오거나 앞뒤에 말을 붙여 온 답에서 JSON 객체만 꺼낸다 */
function stripFences(text) {
  let inner = String(text);
  const open = inner.indexOf('```');
  if (open >= 0) {
    inner = inner.slice(open + 3);
    const nl = inner.indexOf('\n');
    if (nl >= 0) inner = inner.slice(nl + 1); // ```json 줄
    const close = inner.indexOf('```');
    if (close >= 0) inner = inner.slice(0, close);
  }
  const a = inner.indexOf('{');
  const b = inner.lastIndexOf('}');
  if (a >= 0 && b >= 0 && a < b) inner = inner.slice(a, b + 1);
  return inner.trim();
}

/** 오류 응답의 설명. Gemini 는 [{"error":{…}}] 처럼 배열로 감싸 보내기도 한다 */
function errorMessage(data) {
  let obj = parseJSON(data);
  if (Array.isArray(obj)) obj = obj[0];
  const err = isObject(obj) ? obj.error : undefined;
  if (isObject(err) && typeof err.message === 'string') return err.message;
  return typeof err === 'string' ? err : '';
}

/** 키가 틀렸다는 응답인가. Gemini 는 틀린 키에 401 이 아니라 400 "Please pass a valid API key" 를 준다 */
function keyRejected(status, body) {
  if (status === 401 || status === 403) return true;
  if (status !== 400) return false;
  return /API key/i.test(Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? ''));
}

/** 키가 틀렸거나 권한이 없는 오류만 빼고는 Groq 로 대신 처리한다 (강의 중에 멈추지 않게) */
function shouldFallback(status) {
  return status !== 401 && status !== 403;
}

/** 이 오류면 Groq 로 대신하나 (서비스 실패이고 키 오류가 아님). 그 밖의 오류(코드 버그 등)는 그대로 던진다 */
const fallsBack = (e) => e instanceof AIFailure && shouldFallback(e.status);

/** 모델 목록 응답 → 이름 목록 (이름순). Gemini 는 "models/gemini-…" 처럼 앞에 붙여 온다 */
function modelIds(obj) {
  const list = isObject(obj) && Array.isArray(obj.data) ? obj.data : null;
  if (!list) return null;
  return list.map((m) => m?.id).filter((id) => typeof id === 'string').map((id) => id.replace('models/', '')).sort();
}

// ── 모델 고르기 ──

// 서비스별 기본 이름 꼴. 이 꼴(버전 + 등급)에 맞는 모델만 기본으로 고른다.
// 그림 생성(nano-banana), 음성(tts·live), 코딩용(codex), 검색용, 날짜 붙은 사본, 실험판(omni)은 빠진다
const SHAPES = [
  /^claude-(opus|sonnet|haiku)-\d+(-\d+)?$/,
  /^gemini-\d+(\.\d+)?-(pro|flash)(-preview)?$/,
  /^gpt-\d+(\.\d+)?(-mini|-nano|-[a-z]+)?$/, // 새 별칭: sol(최상위)·luna(가벼움)·terra·astra
];

const gptSmall = (m) => m.endsWith('-mini') || m.endsWith('-nano') || m.endsWith('-luna');
/** 이름 꼴(-[a-z]+)에 걸리지만 기본으로 고르면 안 되는 GPT 모델: 아주 비싼 pro, 코딩용, 검색용, 대화판 사본 */
const gptExcluded = (m) => m.startsWith('gpt-')
  && ['-pro', '-codex', '-search', '-chat', '-audio', '-realtime', '-image', '-transcribe', '-tts'].some((x) => m.endsWith(x) || m.includes(`${x}-`));

/** 용도별 등급. 앞쪽 등급을 먼저 고른다. Claude opus 는 비싸서 화면 설명의 맨 마지막 (기본은 sonnet) */
function tiers(feature) {
  if (feature === 'explain') {
    return [(m) => m.includes('-sonnet-'), (m) => m.includes('-pro'), (m) => m.startsWith('gpt-') && m.endsWith('-sol'),
      (m) => m.startsWith('gpt-') && !gptSmall(m) && !m.endsWith('-sol'), (m) => m.includes('-opus-')];
  }
  return [(m) => m.includes('-haiku-'), (m) => m.includes('-flash'), (m) => m.startsWith('gpt-') && m.endsWith('-luna'),
    (m) => m.startsWith('gpt-') && m.endsWith('-mini')];
}

/** 버전 숫자 (claude-sonnet-5-5 → 5.5, gemini-3.1-pro → 3.1, gpt-5.4-mini → 5.4) */
function version(m) {
  const r = /\d+([.-]\d+)?/.exec(m);
  return r ? Number(r[0].replace('-', '.')) || 0 : 0;
}

/** Claude 의 같은 등급(opus·sonnet·haiku)에 더 높은 버전이 있는 모델 (맥 olderClaude). 목록에서 숨긴다 */
function olderClaude(m, all) {
  const tier = /^claude-(opus|sonnet|haiku)-/.exec(m)?.[1];
  return Boolean(tier) && all.some((x) => x.startsWith(`claude-${tier}-`) && version(x) > version(m));
}

/**
 * 용도에 맞는 후보를 좋은 순서로: 등급 → 높은 버전 → 정식판(preview 아님). 키를 저장할 때 앞에서부터 실제로 불러 본다.
 * Claude 는 등급마다 가장 높은 버전만 둔다 (sonnet-5-5 가 안 되면 옛 sonnet 이 아니라 Groq 로 간다)
 */
function ranked(models, feature) {
  const all = (models ?? []).filter((m) => typeof m === 'string');
  const ok = all.filter((m) => !gptExcluded(m) && SHAPES.some((re) => re.test(m)) && !olderClaude(m, all));
  const out = [];
  for (const tier of tiers(feature)) {
    const group = ok.filter(tier).filter((m) => !out.includes(m));
    group.sort((x, y) => {
      const a = version(x);
      const b = version(y);
      if (a !== b) return b - a;
      return (x.includes('preview') ? 1 : 0) - (y.includes('preview') ? 1 : 0);
    });
    out.push(...group);
  }
  return out;
}

const pick = (models, feature) => ranked(models, feature)[0] ?? null;

// ── 보내기 ──

/**
 * 서비스 호출. fetch·getKey 는 주입한다 (시험에서는 가짜 fetch).
 *   getKey(provider) → 키 또는 null
 *   onSpent(model, 'tokens', n): 쓴 토큰 (맥 Usage.spent)
 *   onCost(provider, model, input, output): 이번 실행 AI 비용 (1.2.3, lib/cost.js)
 */
class AIClient {
  constructor({ fetch = globalThis.fetch, getKey, onSpent = () => {}, onCost = () => {}, requestMs = REQUEST_MS, checkMs = CHECK_MS,
    streamMs = STREAM_MS } = {}) {
    if (typeof getKey !== 'function') throw new TypeError('AIClient: getKey 함수가 필요합니다');
    Object.assign(this, { fetch, getKey, onSpent, onCost, requestMs, checkMs, streamMs });
  }

  /** 전체 시간 안에 끝나지 않거나 연결이 끊기면 null. { status, text } */
  async send(req, ms) {
    try {
      const res = await this.fetch(req.url, {
        method: req.method, headers: req.headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(ms),
      });
      return { status: res.status, text: Buffer.from(await res.arrayBuffer()).toString('utf8') };
    } catch {
      return null;
    }
  }

  /** 보낸다. 생각을 끈 Claude 요청이 그 모델에서 거절되면 오류가 알려 준 방식으로 한 번 더 (thinkingOffRetry) */
  async sendClaudeAware(req, ms) {
    const res = await this.send(req, ms);
    const retry = res && thinkingOffRetry(req, res.status, res.text);
    return retry ? this.send(retry, ms) : res;
  }

  /** 한 번 보내고 본문을 받는다. json 이면 코드블록을 벗긴 JSON 글 */
  async complete(p, { model, prompt, image = null, json = false, maxTokens, think = true }) {
    const label = LABEL[p];
    const key = this.getKey(p);
    if (!key) throw new AIFailure(401, `${label} API 키가 없습니다. 설정에서 키를 입력하세요.`);
    const req = request(p, { model, key, prompt, image, json, maxTokens, think });
    const res = await this.sendClaudeAware(req, this.requestMs);
    // 응답이 없으면 Groq 로 대신하도록 상태 코드 없이 던진다
    if (!res) throw new AIFailure(null, `${label} 가 ${Math.round(this.requestMs / 1000)}초 동안 응답하지 않았습니다`);
    if (keyRejected(res.status, res.text)) {
      throw new AIFailure(401, `${label} API 키가 맞지 않습니다. 설정에서 다시 확인하세요.`);
    }
    const r = res.status === 200 ? reply(p, parseJSON(res.text)) : null;
    if (!r) throw new AIFailure(res.status, redact(`${label} 오류 ${res.status}: ${errorMessage(res.text)}`, key));
    this.onSpent(model, 'tokens', r.tokens);
    this.onCost(p, model, r.input, r.output);
    return json ? stripFences(r.text) : r.text;
  }

  /**
   * complete 와 같지만 답 글을 받는 대로 onText 에 지금까지 온 글 전체를 넘긴다 (1.3.0 설명 카드 질문에 글자가 바로 보이게, 맥 AI.stream).
   * 글이 오는 동안에도 전체 시간(streamMs)으로 끊는다. 연결이 끊기면 상태 코드 없이 던진다 (Groq 로 대신)
   */
  async stream(p, { model, prompt, image = null, json = false, maxTokens, think = true }, onText = () => {}) {
    const label = LABEL[p];
    const key = this.getKey(p);
    if (!key) throw new AIFailure(401, `${label} API 키가 없습니다. 설정에서 키를 입력하세요.`);
    const req = request(p, { model, key, prompt, image, json, maxTokens, think, stream: true });
    const signal = AbortSignal.timeout(this.streamMs);
    const open = (r) => this.fetch(r.url, { method: r.method, headers: r.headers, body: JSON.stringify(r.body), signal });
    const s = new StreamState(p);
    try {
      let res = await open(req);
      if (res.status !== 200) {
        let body = await res.text();
        // 생각 끄는 방식이 틀렸다고 거절당하면 한 번 바꿔 다시 보낸다 (send 와 같다)
        const retry = thinkingOffRetry(req, res.status, body);
        if (retry) {
          res = await open(retry);
          if (res.status !== 200) body = await res.text();
        }
        if (res.status !== 200) {
          if (keyRejected(res.status, body)) throw new AIFailure(401, `${label} API 키가 맞지 않습니다. 설정에서 다시 확인하세요.`);
          throw new AIFailure(res.status, redact(`${label} 오류 ${res.status}: ${errorMessage(body)}`, key));
        }
      }
      const decoder = new TextDecoder();
      let rest = '';
      let done = false;
      const line = (l) => {
        if (!l.startsWith('data:')) return;
        const payload = l.slice(5).trim();
        if (payload === '[DONE]') { done = true; return; }
        const obj = parseJSON(payload);
        if (s.take(obj)) onText(s.text);
      };
      for await (const chunk of res.body) {
        const parts = (rest + decoder.decode(chunk, { stream: true })).split(/\r?\n/);
        rest = parts.pop();
        for (const l of parts) {
          line(l);
          if (done) break;
        }
        if (done) break;
      }
      if (!done && rest) line(rest);
    } catch (e) {
      if (e instanceof AIFailure) throw e;
      if (signal.aborted) throw new AIFailure(null, `${label} 가 ${Math.round(this.streamMs / 1000)}초 안에 답을 끝내지 않았습니다`);
      throw new AIFailure(null, redact(`${label} 연결 오류: ${e?.message ?? e}`, key));
    }
    this.onSpent(model, 'tokens', s.tokens);
    this.onCost(p, model, s.input, s.output);
    return json ? stripFences(s.text) : s.text;
  }

  /** 키 확인 겸 고를 수 있는 모델 목록 */
  async models(p) {
    const key = this.getKey(p);
    if (!key) throw new AIFailure(401, '키가 없습니다');
    const res = await this.send(modelsRequest(p, key), this.requestMs);
    if (!res) throw new AIFailure(null, '확인 실패 (응답 없음)');
    const list = res.status === 200 ? modelIds(parseJSON(res.text)) : null;
    if (!list) {
      const bad = keyRejected(res.status, res.text);
      throw new AIFailure(bad ? 401 : res.status, bad ? '키가 맞지 않습니다' : `확인 실패 (${res.status})`);
    }
    return list;
  }

  /** 실제로 답하는지 짧게 불러 본다 (무료 등급은 목록에 있어도 쓸 수 없는 모델이 많다). 되면 null, 안 되면 그 이유 */
  async check(p, model) {
    const key = this.getKey(p);
    if (!key) return '키가 없습니다';
    const res = await this.sendClaudeAware(checkRequest(p, model, key), this.checkMs);
    if (!res) return `${Math.round(this.checkMs / 1000)}초 동안 응답 없음`;
    return res.status === 200 ? null : redact(`${res.status} ${errorMessage(res.text).slice(0, 80)}`, key);
  }

  /** 앞 순위부터 불러 봐서 처음 답하는 모델 (최대 4개). 다 안 되면 마지막 이유와 함께 model null */
  async firstWorking(p, models, feature) {
    let reason = null;
    for (const m of ranked(models, feature).slice(0, 4)) {
      reason = await this.check(p, m);
      if (reason == null) return { model: m, reason: null };
    }
    return { model: null, reason: reason ?? '맞는 모델이 없습니다' };
  }
}

module.exports = {
  PROVIDERS, FEATURES, LABEL, KEY_PAGE, ANTHROPIC_VERSION, TRANSLATE_MAX_TOKENS, EXPLAIN_MAX_TOKENS, CHECK_MAX_TOKENS,
  REQUEST_MS, CHECK_MS, STREAM_MS, AIFailure, AIClient, StreamState, isProvider, redact, request, checkRequest, modelsRequest, reply, stripFences,
  errorMessage, keyRejected, shouldFallback, fallsBack, modelIds, ranked, pick, version, thinkingOffRetry, olderClaude,
};
