'use strict';

// 화면 설명·질문을 Claude·Gemini·GPT 로 (맥 ExplainUI.swift run·ask 의 Groq 아닌 갈래).
// 그 서비스에 한 번에 묻고, 실패하면(키 오류 제외) 알리고 Groq 로 대신한다. Groq 규칙(GROQ_RULES·fixScript)은 붙이지 않는다
const test = require('node:test');
const assert = require('node:assert/strict');
const { GroqClient } = require('../lib/groq');
const E = require('../lib/explain');
const G = require('../lib/groq-explain');
const { AIFailure } = require('../lib/ai');
const { Explainer } = require('../lib/explainer');

const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
const content = (text) => json({ choices: [{ message: { content: text } }], usage: { total_tokens: 10 } });
const OCR = { width: 100, height: 100, lines: [{ text: '제목', x: 10, y: 5, w: 30, h: 5 }, { text: 'MRS_A = MRS_B', x: 20, y: 50, w: 40, h: 6 }] };
const LINES = E.linesFromOcr(OCR);

const unified = JSON.stringify({ summary: '파레토 효율 설명', marks: [{ id: 1, note: '조건' }], visuals: [], scenes: [] });
const answerJSON = JSON.stringify({ answer: '왜냐하면', marks: [{ id: 1, note: '여기' }] });

function rig({ provider = 'claude', model = 'claude-sonnet-5-5', ai = [], groqReplies = [], split = false, dock = null } = {}) {
  const groqCalls = [];
  const aiCalls = [];
  const notices = [];
  const groq = new GroqClient({
    fetch: async (_u, init) => {
      groqCalls.push(JSON.parse(init.body));
      const r = groqReplies.shift();
      if (!r) throw new Error('Groq 이 예상보다 많이 불림');
      return r;
    },
    getKey: () => 'k', sleep: async () => {}, lenientJSON: E.lenientJSON,
  });
  const fakeAI = {
    complete: async (p, opts) => {
      aiCalls.push({ p, opts });
      const r = ai.shift();
      if (r instanceof Error) throw r;
      if (r === undefined) throw new Error('AI 가 예상보다 많이 불림');
      return r;
    },
  };
  const cards = [];
  const ex = new Explainer({
    groq, ai: fakeAI, onNotice: (m) => notices.push(m),
    grab: async (opts) => ({ display: opts.display ?? 'D1', bitmap: { width: 100, height: 100, data: Buffer.alloc(40000) }, png: () => Buffer.from('png'), jpeg: (w) => Buffer.from(`jpg${w}`) }),
    ocr: async () => OCR,
    context: () => ({ transcript: ['교환이 효율적이려면'], guide: '천천히', provider, model, split }),
    dock,
    createCard: () => {
      const c = { renders: [], answers: [], shows: [] };
      c.show = (...a) => c.shows.push(a);
      c.render = (p) => c.renders.push(p);
      c.answer = (p) => c.answers.push(p);
      c.devAsk = () => {};
      c.close = () => {};
      cards.push(c);
      return c;
    },
    createOverlay: () => ({ update() {}, hide() {}, show() {}, close() {} }),
    sleep: () => new Promise(() => {}),
  });
  return { ex, groqCalls, aiCalls, notices, cards };
}

test('설명: 고른 서비스에 맥과 같은 프롬프트(GROQ_RULES 없음)·그림·JSON·3000 으로 한 번 묻는다', async () => {
  const { ex, aiCalls, groqCalls, cards } = rig({ ai: [unified] });
  await ex.run();
  assert.equal(groqCalls.length, 0);
  assert.equal(aiCalls.length, 1);
  const { p, opts } = aiCalls[0];
  assert.equal(p, 'claude');
  assert.deepEqual(opts, {
    model: 'claude-sonnet-5-5', prompt: G.unifiedPrompt(LINES, ['교환이 효율적이려면'], '천천히', true),
    image: Buffer.from('jpg1280'), json: true, maxTokens: 3000, think: true,
  });
  assert.ok(!opts.prompt.includes(G.GROQ_RULES.trim().slice(0, 30)));
  const last = cards[0].renders.at(-1);
  assert.equal(last.summary, '파레토 효율 설명');
});

const empty = JSON.stringify({ summary: '', marks: [], visuals: [], scenes: [] });

test('[1.2.3] 설명: 요약이 비면(생각만 하고 본문이 없음) 생각을 끄고 한 번 더 묻는다', async () => {
  const { ex, aiCalls, groqCalls, notices, cards } = rig({ ai: [empty, unified] });
  await ex.run();
  assert.deepEqual(aiCalls.map((c) => c.opts.think), [true, false]);
  assert.equal(groqCalls.length, 0);
  assert.deepEqual(notices, []);
  assert.equal(cards[0].renders.at(-1).summary, '파레토 효율 설명');
});

test('[1.2.3] 설명: 두 번 다 요약이 비면 알리고 Groq 로 대신한다 (JSON 이 아닌 답도 빈 것으로)', async () => {
  const { ex, aiCalls, groqCalls, notices, cards } = rig({ ai: [empty, '생각만 했습니다'], groqReplies: [content(unified)] });
  await ex.run();
  assert.equal(aiCalls.length, 2);
  assert.equal(groqCalls.length, 1);
  assert.deepEqual(notices, ['Claude 설명을 읽지 못함 → Groq 로 대신했습니다']);
  assert.equal(cards[0].renders.at(-1).summary, '파레토 효율 설명');
});

test('[1.2.3] 설명: 요약도 그림도 비면(Groq 까지) 카드에 다시 눌러 달라는 오류, 화면 표시는 없다', async () => {
  const marksOnly = JSON.stringify({ summary: ' ', marks: [{ id: 1, note: '조건' }], visuals: [], scenes: [] });
  let overlays = 0;
  const r = rig({ provider: 'groq', model: '', groqReplies: [content(marksOnly)] });
  r.ex.createOverlay = () => { overlays++; return { update() {}, hide() {}, show() {}, close() {} }; };
  await r.ex.run();
  assert.deepEqual(r.cards[0].renders.at(-1), { error: '설명을 만들지 못했습니다. ✨ 를 다시 눌러 주세요.' });
  assert.equal(overlays, 0);
});

test('설명: 키 오류가 아닌 실패는 알리고 Groq 로 대신한다', async () => {
  const { ex, aiCalls, groqCalls, notices, cards } = rig({ provider: 'gemini', model: 'gemini-3.1-pro-preview', ai: [new AIFailure(429, 'quota')], groqReplies: [content(unified)] });
  await ex.run();
  assert.equal(aiCalls.length, 1);
  assert.deepEqual(notices, ['Gemini 설명 실패 → Groq 로 대신했습니다']);
  assert.equal(groqCalls[0].model, GroqClient.VISION_MODEL);
  assert.ok(groqCalls[0].messages[0].content[0].text.endsWith(G.GROQ_RULES)); // Groq 갈래는 그대로 GROQ_RULES
  assert.equal(cards[0].renders.at(-1).summary, '파레토 효율 설명');
});

test('설명: 키 오류(401)는 Groq 로 대신하지 않고 카드에 오류를 보인다', async () => {
  const { ex, groqCalls, notices, cards } = rig({ ai: [new AIFailure(401, 'Claude API 키가 맞지 않습니다. 설정에서 다시 확인하세요.')] });
  await ex.run();
  assert.equal(groqCalls.length, 0);
  assert.deepEqual(notices, []);
  assert.deepEqual(cards[0].renders.at(-1), { error: 'Claude API 키가 맞지 않습니다. 설정에서 다시 확인하세요.' });
});

test('설명: Groq 를 고르면(또는 모델이 비면) 다른 서비스를 부르지 않는다', async () => {
  for (const [provider, model] of [['groq', ''], ['openai', '']]) {
    const { ex, aiCalls, groqCalls } = rig({ provider, model, groqReplies: [content(unified)] });
    await ex.run();
    assert.equal(aiCalls.length, 0);
    assert.equal(groqCalls.length, 1);
  }
});

async function explained(r) {
  await r.ex.run();
  r.aiCalls.length = 0;
  r.groqCalls.length = 0;
}

test('질문: 생각 단계를 켠 채 한 번, 답을 읽으면 끝 (질문 프롬프트·그림·JSON·3000)', async () => {
  const r = rig({ provider: 'openai', model: 'gpt-6.1-sol', ai: [unified, answerJSON] });
  await explained(r);
  await r.ex.ask('왜?');
  assert.equal(r.aiCalls.length, 1);
  const { opts } = r.aiCalls[0];
  assert.deepEqual(opts, {
    model: 'gpt-6.1-sol', prompt: G.questionPrompt('왜?', [], '파레토 효율 설명', LINES, ['교환이 효율적이려면'], '천천히', true),
    image: Buffer.from('jpg1280'), json: true, maxTokens: 3000, think: true,
  });
  assert.equal(r.cards[0].answers.at(-1).answer, '왜냐하면');
  assert.equal(r.groqCalls.length, 0);
});

test('질문: 답을 읽지 못하면 생각 단계를 끄고 한 번 더 묻는다', async () => {
  const r = rig({ ai: [unified, '{"answer":', answerJSON] });
  await explained(r);
  await r.ex.ask('왜?');
  assert.deepEqual(r.aiCalls.map((c) => c.opts.think), [true, false]);
  assert.equal(r.cards[0].answers.at(-1).answer, '왜냐하면');
});

test('질문: 두 번 다 못 읽거나 (키 오류 아닌) 실패면 알리고 Groq 로 대신한다', async () => {
  for (const replies of [['x', 'y'], [new AIFailure(500, 'boom')]]) {
    const r = rig({ ai: [unified, ...replies], groqReplies: [content(answerJSON)] });
    await explained(r);
    await r.ex.ask('왜?');
    assert.deepEqual(r.notices, ['Claude 답변 실패 → Groq 로 대신했습니다']);
    assert.equal(r.groqCalls.length, 1);
    assert.equal(r.cards[0].answers.at(-1).answer, '왜냐하면');
  }
});

test('질문: 키 오류는 Groq 로 대신하지 않고 카드에 오류를 보인다', async () => {
  const r = rig({ ai: [unified, new AIFailure(401, 'Claude API 키가 맞지 않습니다. 설정에서 다시 확인하세요.')] });
  await explained(r);
  await r.ex.ask('왜?');
  assert.equal(r.groqCalls.length, 0);
  assert.deepEqual(r.cards[0].answers.at(-1), { error: 'Claude API 키가 맞지 않습니다. 설정에서 다시 확인하세요.' });
});

test('1.2.1 질문: 다른 서비스가 실패해 Groq 로 대신 물을 때는 움직이는 그림 안내를 뺀 가벼운 질문으로', async () => {
  const r = rig({ ai: [unified, new AIFailure(500, 'boom')], groqReplies: [content(answerJSON)] });
  await explained(r);
  await r.ex.ask('왜?');
  assert.ok(r.aiCalls[0].opts.prompt.includes('"type":"anim"'));
  const sent = r.groqCalls[0].messages[0].content[0].text;
  assert.ok(sent.startsWith(G.questionPrompt('왜?', [], '파레토 효율 설명', LINES, ['교환이 효율적이려면'], '천천히', false)));
  assert.ok(!sent.includes('"type":"anim"'));
});

// --- 1.2.1 설명할 때 화면 나누기 (맥 Explainer.run split · clear → WindowDock.restore) ---

function fakeDock(result) {
  const calls = [];
  return { calls, dock: async () => { calls.push('dock'); return result; }, restore: async () => { calls.push('restore'); } };
}

test('화면 나누기: 켜져 있으면 찍기 전에 창을 줄이고, 그 화면을 찍어 카드를 오른쪽에 붙인다. 카드를 닫으면 되돌린다', async () => {
  const dock = fakeDock('D2');
  const r = rig({ ai: [unified], split: true, dock });
  await r.ex.run();
  assert.deepEqual(dock.calls, ['dock']);
  assert.deepEqual(r.cards[0].shows[0], ['D2', null, true], '줄인 화면에 붙인 카드');
  await r.ex.clear();
  assert.deepEqual(dock.calls, ['dock', 'restore']);
});

test('화면 나누기: 붙이지 못하면(전체 화면·실패) 예전처럼 마우스 화면에 떠 있는 카드', async () => {
  for (const result of [null, Promise.reject(new Error('helper 없음'))]) {
    const dock = { calls: [], dock: async () => { dock.calls.push('dock'); return result; }, restore: async () => { dock.calls.push('restore'); } };
    const r = rig({ ai: [unified], split: true, dock });
    await r.ex.run();
    assert.deepEqual(r.cards[0].shows[0], ['D1', null, false]);
    assert.equal(r.cards[0].renders.at(-1).summary, '파레토 효율 설명', '설명은 그대로');
  }
});

test('화면 나누기: 꺼져 있으면 창을 건드리지 않는다 (닫을 때 되돌리기만 — 아무것도 안 줄였으면 할 일 없음)', async () => {
  const dock = fakeDock('D2');
  const r = rig({ ai: [unified], split: false, dock });
  await r.ex.run();
  assert.deepEqual(dock.calls, []);
  assert.deepEqual(r.cards[0].shows[0], ['D1', null, false]);
});
