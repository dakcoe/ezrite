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

const D1 = { id: 1, bounds: { x: 0, y: 0, width: 100, height: 100 } };

function rig({ provider = 'claude', model = 'claude-sonnet-5-5', ai = [], groqReplies = [], style = 'trail' } = {}) {
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
  const next = () => {
    const r = ai.shift();
    if (r instanceof Error) throw r;
    if (r === undefined) throw new Error('AI 가 예상보다 많이 불림');
    return r;
  };
  const fakeAI = {
    complete: async (p, opts) => {
      aiCalls.push({ p, opts });
      return next();
    },
    // 1.3.0 카드 질문: 받는 대로 (조각 셋으로 나눠 onText 에 지금까지 온 글 전체를 넘긴다)
    stream: async (p, opts, onText) => {
      aiCalls.push({ p, opts, stream: true });
      const r = next();
      const n = Math.ceil(r.length / 3);
      for (let i = n; i < r.length + n; i += n) onText(r.slice(0, Math.min(i, r.length)));
      return r;
    },
  };
  const cards = [];
  const overlays = [];
  const ex = new Explainer({
    groq, ai: fakeAI, onNotice: (m) => notices.push(m),
    grab: async (opts) => ({ display: opts.display ?? D1, bitmap: { width: 100, height: 100, data: Buffer.alloc(40000) }, png: () => Buffer.from('png'), jpeg: (w) => Buffer.from(`jpg${w}`) }),
    ocr: async () => OCR,
    context: () => ({ transcript: ['교환이 효율적이려면'], guide: '천천히', provider, model, style }),
    createCard: (hooks) => {
      const c = { renders: [], answers: [], shows: [], places: [], restyles: [], hooks };
      c.show = (...a) => c.shows.push(a);
      c.place = (...a) => c.places.push(a);
      c.restyle = (st) => c.restyles.push(st);
      c.render = (p) => c.renders.push(p);
      c.answer = (p) => c.answers.push(p);
      c.devAsk = () => {};
      c.partials = [];
      c.partial = (t) => c.partials.push(t);
      c.close = () => {};
      cards.push(c);
      return c;
    },
    createOverlay: (display, m) => {
      const o = { models: [m], update(x) { o.models.push(x); }, hide() {}, show() {}, close() {} };
      overlays.push(o);
      return o;
    },
    sleep: () => new Promise(() => {}),
  });
  return { ex, groqCalls, aiCalls, notices, cards, overlays };
}

test('설명: 고른 서비스에 맥과 같은 프롬프트(GROQ_RULES 없음)·그림·JSON·8000 으로 한 번 묻는다', async () => {
  const { ex, aiCalls, groqCalls, cards } = rig({ ai: [unified] });
  await ex.run();
  assert.equal(groqCalls.length, 0);
  assert.equal(aiCalls.length, 1);
  const { p, opts } = aiCalls[0];
  assert.equal(p, 'claude');
  assert.deepEqual(opts, {
    model: 'claude-sonnet-5-5', prompt: G.unifiedPrompt(LINES, ['교환이 효율적이려면'], '천천히', true),
    image: Buffer.from('jpg1280'), json: true, maxTokens: 8000, think: true,
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

test('질문: 생각 단계를 켠 채 한 번, 답을 읽으면 끝 (질문 프롬프트·그림·JSON·8000, 받는 대로)', async () => {
  const r = rig({ provider: 'openai', model: 'gpt-6.1-sol', ai: [unified, answerJSON] });
  await explained(r);
  await r.ex.ask('왜?');
  assert.equal(r.aiCalls.length, 1);
  const { opts } = r.aiCalls[0];
  assert.deepEqual(opts, {
    model: 'gpt-6.1-sol', prompt: G.questionPrompt('왜?', [], '파레토 효율 설명', LINES, ['교환이 효율적이려면'], '천천히', true),
    image: Buffer.from('jpg1280'), json: true, maxTokens: 8000, think: true,
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

// --- 1.3.0 설명 표시 방식 · 카드 자리 (화면 나누기 대신, 맥과 같다) ---

test('1.3.0 카드: 찍은 화면에 뜬 뒤, 글자를 읽으면 화면 글자가 적은 자리로 옮겨 달라고 한다 (읽은 글자 줄과 그 화면)', async () => {
  const r = rig({ ai: [unified] });
  await r.ex.run();
  assert.deepEqual(r.cards[0].shows[0], [D1, null]);
  assert.equal(r.cards[0].places.length, 1);
  const [lines, display, popup] = r.cards[0].places[0];
  assert.deepEqual(lines, LINES);
  assert.equal(display, D1);
  assert.equal(popup, null);
});

test('1.3.0 표시 방식: 카드·화면 표시에 방식이 가고, 지도용 축소 화면(560)과 다른 글자 상자가 함께 간다', async () => {
  const r = rig({ ai: [unified], style: 'minimap' });
  await r.ex.run();
  const p = r.cards[0].renders.at(-1);
  assert.equal(p.style, 'minimap');
  assert.equal(p.map.img, `data:image/jpeg;base64,${Buffer.from('jpg560').toString('base64')}`);
  assert.equal(p.map.aspect, 1);
  const m = r.overlays[0].models[0];
  assert.equal(m.style, 'minimap');
  assert.deepEqual(m.others, LINES.map((l) => l.box));
});

test('1.3.0 꼬리표: 말풍선·여백 메모·판서일 때만 장면 꼬리표를 요청한다 (다른 서비스·Groq 모두)', async () => {
  for (const [style, want] of [['pen', true], ['notes', true], ['trail', false], ['classic', false]]) {
    const r = rig({ ai: [unified], style });
    await r.ex.run();
    assert.equal(r.aiCalls[0].opts.prompt.includes(G.TAG_GUIDE), want, style);
    const g = rig({ provider: 'groq', model: '', groqReplies: [content(unified)], style });
    await g.ex.run();
    assert.equal(g.groqCalls[0].messages[0].content[0].text.includes(G.TAG_GUIDE), want, `groq ${style}`);
  }
});

test('1.3.0 카드에서 마우스를 올린 항목·카드 글 자리는 화면 표시로 (모르는 값은 버린다), 방식을 바꾸면 표시·카드 모두', async () => {
  const r = rig({ ai: [unified] });
  await r.ex.run();
  const o = r.overlays[0];
  r.cards[0].hooks.onHover('m0');
  assert.equal(o.models.at(-1).hover, 'm0');
  r.cards[0].hooks.onHover('<script>');
  assert.equal(o.models.at(-1).hover, null);
  const n = o.models.length;
  r.cards[0].hooks.onHover('');
  assert.equal(o.models.length, n, '같으면 다시 그리지 않는다');
  r.cards[0].hooks.onAnchors({ m0: { x: 40, y: 30 } });
  assert.deepEqual(o.models.at(-1).anchors, { m0: { x: 40, y: 30 } });
  r.ex.restyle('pen');
  assert.equal(o.models.at(-1).style, 'pen');
  assert.deepEqual(r.cards[0].restyles, ['pen']);
  r.ex.restyle('???');
  assert.equal(o.models.at(-1).style, 'trail');
});

// --- 1.3.0 카드 질문 (맥 ask: 받는 대로·줄 번호·깨진 JSON) ---

test('1.3.0 질문: 답 글은 오는 대로 카드에 채우고(줄 번호는 그 줄 글자로), 다 받으면 답·짚은 곳으로 바꾼다', async () => {
  const reply = JSON.stringify({ answer: '1번 줄을 보면 같아요', marks: [{ id: 1, note: '여기' }] });
  const r = rig({ ai: [unified, reply] });
  await explained(r);
  await r.ex.ask('왜?');
  assert.equal(r.aiCalls[0].stream, true);
  assert.ok(r.cards[0].partials.length >= 1);
  assert.ok(r.cards[0].partials.every((t) => !t.includes('1번 줄')), JSON.stringify(r.cards[0].partials));
  assert.equal(r.cards[0].partials.at(-1), '‘MRS_A = MRS_B’을 보면 같아요');
  assert.equal(r.cards[0].answers.at(-1).answer, '‘MRS_A = MRS_B’을 보면 같아요');
  assert.deepEqual(r.cards[0].answers.at(-1).marks, [{ note: '여기', text: 'MRS_A = MRS_B' }]);
});

test('1.3.0 질문: 수식 역슬래시 하나(\le)로 깨진 JSON 은 고쳐 읽고, 그래도 깨졌지만 답 글이 닫혔으면 그 글로 끝낸다', async () => {
  const lenient = String.raw`{"answer":"$0\le x$ 이에요","marks":[]}`;
  const r1 = rig({ ai: [unified, lenient] });
  await explained(r1);
  await r1.ex.ask('왜?');
  assert.equal(r1.aiCalls.length, 1, '다시 묻지 않는다');
  assert.equal(r1.cards[0].answers.at(-1).answer, String.raw`$0\le x$ 이에요`);
  const cut = '{"answer":"앞부분은 끝까지 왔어요","marks":[{"id":1,"note":"잘';
  const r2 = rig({ ai: [unified, cut] });
  await explained(r2);
  await r2.ex.ask('왜?');
  assert.equal(r2.aiCalls.length, 1);
  assert.equal(r2.cards[0].answers.at(-1).answer, '앞부분은 끝까지 왔어요');
  assert.deepEqual(r2.notices, []);
});

test('1.3.0 설명: 다른 서비스의 설명을 읽지 못해 생각을 끄고 다시 물을 때 카드에 "설명을 다시 만드는 중…"', async () => {
  const r = rig({ ai: [JSON.stringify({ summary: '', marks: [], visuals: [], scenes: [] }), unified] });
  await r.ex.run();
  assert.ok(r.cards[0].renders.some((p) => p.loading === '설명을 다시 만드는 중…'));
  assert.equal(r.cards[0].renders.at(-1).summary, '파레토 효율 설명');
});
