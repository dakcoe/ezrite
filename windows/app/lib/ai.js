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

// 맥과 같은 값: 번역 2000, 설명·질문 3000, 키 확인 16
const TRANSLATE_MAX_TOKENS = 2000;
const EXPLAIN_MAX_TOKENS = 3000;
const CHECK_MAX_TOKENS = 16;
// 전체 시간으로 끊는다 (연결만 붙들고 답을 안 주는 모델이 있다 — Gemini 무료 등급 일부)
const REQUEST_MS = 60_000;
const CHECK_MS = 15_000;

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
 * think=false 면 Claude 의 생각 단계를 끈다 (번역처럼 단순한 일에 출력 토큰이 몇 배로 늘지 않게)
 */
function request(p, { model, key, prompt, image = null, json = false, maxTokens, think = true }) {
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

/** obj: 응답 JSON. { text, tokens } 또는 null */
function reply(p, obj) {
  if (!isObject(obj)) return null;
  const usage = isObject(obj.usage) ? obj.usage : {};
  if (p === 'claude') {
    const text = (Array.isArray(obj.content) ? obj.content : [])
      .filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('');
    return { text, tokens: num(usage.input_tokens) + num(usage.output_tokens) };
  }
  const msg = Array.isArray(obj.choices) ? obj.choices[0]?.message?.content : undefined;
  return { text: typeof msg === 'string' ? msg : '', tokens: num(usage.total_tokens) };
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

/** 용도별 등급. 앞쪽 등급을 먼저 고른다 */
function tiers(feature) {
  if (feature === 'explain') {
    return [(m) => m.includes('-sonnet-'), (m) => m.includes('-pro'), (m) => m.startsWith('gpt-') && m.endsWith('-sol'),
      (m) => m.startsWith('gpt-') && !gptSmall(m) && !m.endsWith('-sol')];
  }
  return [(m) => m.includes('-haiku-'), (m) => m.includes('-flash'), (m) => m.startsWith('gpt-') && m.endsWith('-luna'),
    (m) => m.startsWith('gpt-') && m.endsWith('-mini')];
}

/** 버전 숫자 (claude-sonnet-5-5 → 5.5, gemini-3.1-pro → 3.1, gpt-5.4-mini → 5.4) */
function version(m) {
  const r = /\d+([.-]\d+)?/.exec(m);
  return r ? Number(r[0].replace('-', '.')) || 0 : 0;
}

/** 용도에 맞는 후보를 좋은 순서로: 등급 → 높은 버전 → 정식판(preview 아님). 키를 저장할 때 앞에서부터 실제로 불러 본다 */
function ranked(models, feature) {
  const ok = (models ?? []).filter((m) => typeof m === 'string' && !gptExcluded(m) && SHAPES.some((re) => re.test(m)));
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
 */
class AIClient {
  constructor({ fetch = globalThis.fetch, getKey, onSpent = () => {}, requestMs = REQUEST_MS, checkMs = CHECK_MS } = {}) {
    if (typeof getKey !== 'function') throw new TypeError('AIClient: getKey 함수가 필요합니다');
    Object.assign(this, { fetch, getKey, onSpent, requestMs, checkMs });
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

  /** 한 번 보내고 본문을 받는다. json 이면 코드블록을 벗긴 JSON 글 */
  async complete(p, { model, prompt, image = null, json = false, maxTokens, think = true }) {
    const label = LABEL[p];
    const key = this.getKey(p);
    if (!key) throw new AIFailure(401, `${label} API 키가 없습니다. 설정에서 키를 입력하세요.`);
    const req = request(p, { model, key, prompt, image, json, maxTokens, think });
    const res = await this.send(req, this.requestMs);
    // 응답이 없으면 Groq 로 대신하도록 상태 코드 없이 던진다
    if (!res) throw new AIFailure(null, `${label} 가 ${Math.round(this.requestMs / 1000)}초 동안 응답하지 않았습니다`);
    if (keyRejected(res.status, res.text)) {
      throw new AIFailure(401, `${label} API 키가 맞지 않습니다. 설정에서 다시 확인하세요.`);
    }
    const r = res.status === 200 ? reply(p, parseJSON(res.text)) : null;
    if (!r) throw new AIFailure(res.status, redact(`${label} 오류 ${res.status}: ${errorMessage(res.text)}`, key));
    this.onSpent(model, 'tokens', r.tokens);
    return json ? stripFences(r.text) : r.text;
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
    const res = await this.send(checkRequest(p, model, key), this.checkMs);
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
  REQUEST_MS, CHECK_MS, AIFailure, AIClient, isProvider, redact, request, checkRequest, modelsRequest, reply, stripFences,
  errorMessage, keyRejected, shouldFallback, fallsBack, modelIds, ranked, pick, version,
};
