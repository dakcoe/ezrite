'use strict';

// Groq 의 오늘 남은 요청 수. 모델마다 따로 잡히고, 응답 헤더로 매번 알려 준다. 맥 Usage.swift 이식.
// 하루 토큰·음성 시간은 budget.js, 둘을 합친 게이지는 footer().

const { parseIntStrict } = require('./text');

function header(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] ?? null;
}

/** 응답 헤더 → { remaining, limit } 또는 null */
function read(headers) {
  const r = parseIntStrict(header(headers, 'x-ratelimit-remaining-requests'));
  const l = parseIntStrict(header(headers, 'x-ratelimit-limit-requests'));
  if (r === null || l === null) return null;
  return { remaining: r, limit: l };
}

/** 번갈아 쓰는 모델들의 한도를 합친 남은 비율(0~1). 아직 모르는 모델은 빼고, 다 모르면 null */
function fraction(usages) {
  const known = usages.filter(Boolean);
  const limit = known.reduce((n, u) => n + u.limit, 0);
  if (!(limit > 0)) return null;
  return known.reduce((n, u) => n + u.remaining, 0) / limit;
}

/** 50% 아래 노랑(half), 10% 아래 빨강(low) */
function level(f) {
  return f < 0.1 ? 'low' : f < 0.5 ? 'half' : 'plenty';
}

/** 게이지 값: 호출 횟수와 토큰(음성 시간) 중 덜 남은 쪽. 아는 것만으로 낸다 */
function combined(requests, amount) {
  if (requests != null && amount != null) return Math.min(requests, amount);
  return requests ?? amount ?? null;
}

// --- 팝업 아래 줄 게이지 (맥 UsageFooter) ---

// 모델 이름은 groq.js 와 같다 (여기서 groq.js 를 부르면 서로 부르게 되어 이름만 둔다)
const VISION = 'qwen/qwen3.8-27b';
const GAUGES = Object.freeze([
  { key: 'audio', label: '받아쓰기', models: ['whisper-large-v3', 'whisper-large-v3-turbo'], kind: 'audio' },
  { key: 'translate', label: '번역', models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'], kind: 'tokens' },
  // Groq 설명·질문은 qwen 한 모델로 한다 (120b 는 qwen 이 막혔을 때만)
  { key: 'explain', label: '화면 설명', models: [VISION], kind: 'tokens', together: true },
]);

const pct = (f) => `${Math.round(f * 100)}%`;

/**
 * usage: 모델 → {remaining, limit} (헤더), budget: lib/budget.js. 게이지마다 남은 비율(0~1)과 마우스를 올렸을 때 글.
 * 번갈아 쓰는 모델(받아쓰기·번역)은 합치고, 함께 써야 하는 모델(화면 설명)은 가장 적게 남은 쪽
 */
function footer(usage, budget, now = Date.now()) {
  const out = { captions: {} };
  const left = (use) => budget.usesLeft(use, VISION, now);
  for (const g of GAUGES) {
    const requests = g.together
      ? (() => { const xs = g.models.map((m) => fraction([usage[m]])).filter((v) => v != null); return xs.length ? Math.min(...xs) : null; })()
      : fraction(g.models.map((m) => usage[m]));
    const amount = g.together ? budget.lowest(g.models, g.kind, now) : budget.fraction(g.models, g.kind, now);
    const total = combined(requests, amount);
    out[g.key] = total;
    // 맥 1.1.1: 짧게. 화면 설명은 남은 횟수를 함께 (호출·토큰 세부는 빼고 덜 남은 쪽 하나만)
    out.captions[g.key] = g.key === 'explain'
      ? `${g.label} ${pct(total ?? amount)} 남음 · 설명 약 ${left('explain')}번, 질문 약 ${left('ask')}번`
      : `${g.label} 한도 ${pct(total ?? amount)} 남음`;
  }
  out.uses = `설명 ${left('explain')} · 질문 ${left('ask')}`;
  return out;
}

module.exports = { read, fraction, level, combined, footer, GAUGES };
