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

function rig({ provider = 'claude', model = 'claude-sonnet-5-5', ai = [], groqReplies = [] } = {}) {
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
    context: () => ({ transcript: ['교환이 효율적이려면'], guide: '천천히', provider, model }),
    createCard: () => {
      const c = { renders: [], answers: [] };
      c.show = () => {};
      c.render = (p) => c.renders.push(p);
      c.answer = (p) => c.answers.push(p);
      c.devAsk = () => {};
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
    model: 'claude-sonnet-5-5', prompt: G.unifiedPrompt(LINES, ['교환이 효율적이려면'], '천천히'),
    image: Buffer.from('jpg1280'), json: true, maxTokens: 3000,
  });
  assert.ok(!opts.prompt.includes(G.GROQ_RULES.trim().slice(0, 30)));
  const last = cards[0].renders.at(-1);
  assert.equal(last.summary, '파레토 효율 설명');
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
    model: 'gpt-6.1-sol', prompt: G.questionPrompt('왜?', [], '파레토 효율 설명', LINES, ['교환이 효율적이려면'], '천천히'),
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
