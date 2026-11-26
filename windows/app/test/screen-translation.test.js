'use strict';
// 화면 번역의 번역 서비스 길 (lib/translation.js translateScreen) 과 맥 3차 규칙(숫자 많은 문단·세로 조각·영어 괄호)
const test = require('node:test');
const assert = require('node:assert/strict');
const { translateScreen } = require('../lib/translation');
const { AIFailure } = require('../lib/ai');
const ST = require('../lib/screentx');

function fakes({ fail = null } = {}) {
  const calls = { groq: [], ai: [] };
  const groq = { translate: async (texts, ctx, opts) => { calls.groq.push({ texts, opts }); return texts.map((t) => `G:${t}`); } };
  const ai = {
    complete: async (p, o) => {
      calls.ai.push({ p, ...o });
      if (fail) throw fail;
      const items = o.prompt.split('\n').map((l) => /^(\d+)\. (.*)$/.exec(l)).filter(Boolean);
      return items.map(([, n, t]) => `${n}. C:${t}`).join('\n');
    },
  };
  return { calls, groq, ai };
}

test('Groq 면 화면용 지시와 120b → qwen 모델 목록 (20b 는 안 쓴다)', async () => {
  const f = fakes();
  const out = await translateScreen(['Hello', 'World'], { provider: 'groq', model: null, groq: f.groq, ai: f.ai });
  assert.deepEqual(out, ['G:Hello', 'G:World']);
  assert.deepEqual(f.calls.groq[0].opts.models, ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b']);
  assert.equal(f.calls.groq[0].opts.prompt, ST.SCREEN_PROMPT);
});

test('Claude 등: 번호 목록 바로 앞에 "모두 N개" 머리말, 출력 한도 max(2000, 문단 수×200), 생각 끔', async () => {
  const f = fakes();
  const texts = Array.from({ length: 21 }, (_, i) => `Paragraph ${i + 1}`);
  const out = await translateScreen(texts, { provider: 'claude', model: 'claude-haiku-5-5', groq: f.groq, ai: f.ai });
  assert.equal(out.length, 21);
  assert.equal(out[20], 'C:Paragraph 21');
  const c = f.calls.ai[0];
  assert.match(c.prompt, /Items to translate — all 21 of them, numbered 1 to 21:\n1\. Paragraph 1\n/);
  assert.ok(c.prompt.startsWith(ST.SCREEN_PROMPT));
  assert.equal(c.maxTokens, 4200);
  assert.equal(c.think, false);
  assert.equal((await translateScreen(['a'], { provider: 'claude', model: 'm', groq: f.groq, ai: f.ai }), f.calls.ai[1].maxTokens), 2000);
});

test('다른 서비스가 실패하면(키 오류 제외) 알리고 Groq 로 대신, 키 오류는 그대로 던진다', async () => {
  const f = fakes({ fail: new AIFailure(429, '한도') });
  const notes = [];
  const out = await translateScreen(['Hi'], { provider: 'claude', model: 'm', groq: f.groq, ai: f.ai, onNotice: (m) => notes.push(m) });
  assert.deepEqual(out, ['G:Hi']);
  assert.equal(notes.length, 1);
  const k = fakes({ fail: new AIFailure(401, '키') });
  await assert.rejects(translateScreen(['Hi'], { provider: 'claude', model: 'm', groq: k.groq, ai: k.ai }));
  assert.equal(k.calls.groq.length, 0);
});

test('숫자가 글자보다 많은 문단(그래프 눈금·날짜 줄)은 옮기지 않는다, 세로 조각은 옆 조각과 잇지 않는다', () => {
  const W = 400;
  const bitmap = { width: W, height: 300, data: Buffer.alloc(W * 300 * 4, 255) };
  const r = ST.analyze({ ocr: { lines: [
    { text: 'Jan 2015 Apr 2015 Jul 2015 Oct 2015', x: 10, y: 50, w: 300, h: 20, words: [] },
    { text: 'Revenue grew in 2015', x: 10, y: 150, w: 200, h: 20, words: [] },
  ] }, bitmap, scale: 1 });
  assert.deepEqual(r.blocks.map((b) => b.translate), [false, true]);
  const w = (text, x, y, ww, hh) => ({ text, x, y, w: ww, h: hh });
  const merged = ST.mergeSegments([
    ...ST.splitLine({ text: 'Loss', words: [w('Loss', 10, 100, 12, 60)] }),
    ...ST.splitLine({ text: 'curve', words: [w('curve', 30, 110, 60, 20)] }),
  ]);
  assert.equal(merged.length, 2);
});

test('지시: 영어 괄호는 문장 안 처음 나올 때만, 제목·메뉴·라벨에는 붙이지 않는다', () => {
  assert.match(ST.SCREEN_PROMPT, /English term in parentheses only the first time/);
  assert.match(ST.SCREEN_PROMPT, /never in titles, headings, menus, or labels/);
});
