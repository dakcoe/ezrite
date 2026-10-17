'use strict';

// "설명해줘" 한 번의 흐름 (맥 Explainer). 화면 찍기·글자 읽기·카드·표시 창은 가짜로, Groq 은 가짜 fetch 로.
const test = require('node:test');
const assert = require('node:assert/strict');
const { GroqClient } = require('../lib/groq');
const E = require('../lib/explain');
const { Explainer, LOADING_READ, LOADING_MAKE, ANSWER_FAILED } = require('../lib/explainer');

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const content = (text) => json({ choices: [{ message: { content: text } }], usage: { total_tokens: 10 } });

/** 화면 100×100. 줄 0 = "제목", 줄 1 = "MRS_A = MRS_B" */
const OCR = { width: 100, height: 100, lines: [{ text: '제목', x: 10, y: 5, w: 30, h: 5 }, { text: 'MRS_A = MRS_B', x: 20, y: 50, w: 40, h: 6 }] };
const bitmap = (v) => ({ width: 100, height: 100, data: Buffer.alloc(100 * 100 * 4, v) });

function rig({ replies = [], grab, ocr, context, devQuestion = null, sleep, watch } = {}) {
  const calls = [];
  const fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    const r = replies.shift();
    if (!r) throw new Error('예상보다 많이 불림');
    return typeof r === 'function' ? r() : r;
  };
  const groq = new GroqClient({ fetch, getKey: () => 'k', sleep: async () => {}, lenientJSON: E.lenientJSON });
  const grabs = [];
  const cards = [];
  const overlays = [];
  const ex = new Explainer({
    groq,
    grab: grab ?? (async (opts) => {
      grabs.push(opts);
      return { display: opts.display ?? 'D1', bitmap: bitmap(0), png: () => Buffer.from('png'), jpeg: () => Buffer.from('jpg') };
    }),
    ocr: ocr ?? (async () => OCR),
    context: context ?? (() => ({ transcript: ['교환이 효율적이려면'], guide: '' })),
    popupFrame: () => ({ x: 1, y: 2, width: 3, height: 4 }),
    createCard: (hooks) => {
      const c = { hooks, shows: [], renders: [], answers: [], devAsks: [], closed: false };
      c.show = (display, avoid) => c.shows.push({ display, avoid });
      c.render = (p) => c.renders.push(p);
      c.answer = (p) => c.answers.push(p);
      c.devAsk = (q) => c.devAsks.push(q);
      c.close = () => { c.closed = true; };
      cards.push(c);
      return c;
    },
    createOverlay: (display, model) => {
      const o = { display, models: [model], hidden: 0, shown: 0, closed: false };
      o.update = (m) => o.models.push(m);
      o.hide = () => { o.hidden++; };
      o.show = () => { o.shown++; };
      o.close = () => { o.closed = true; };
      overlays.push(o);
      return o;
    },
    sleep: sleep ?? (() => new Promise(() => {})), // 기본: 화면 지켜보기는 멈춰 둔다
    devQuestion,
    askDelay: 0,
    ...(watch === undefined ? {} : { watch }),
  });
  return { ex, calls, grabs, cards, overlays };
}

const unified = JSON.stringify({ summary: '파레토 효율 설명', marks: [{ id: 1, note: '조건' }], visuals: [], scenes: [] });

test('설명: 화면 읽기 → 만드는 중 → qwen 한 번으로 카드와 화면 표시', async () => {
  const { ex, calls, grabs, cards, overlays } = rig({ replies: [content(unified)] });
  const busy = [];
  ex.on('busy', (b) => busy.push(b));
  await ex.run();
  assert.deepEqual(busy, [true, false]);
  assert.equal(grabs[0].full, true);
  const card = cards[0];
  assert.deepEqual(card.shows[0], { display: 'D1', avoid: { x: 1, y: 2, width: 3, height: 4 } });
  assert.deepEqual(card.renders.slice(0, 2), [{ loading: LOADING_READ }, { loading: LOADING_MAKE }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, GroqClient.VISION_MODEL);
  assert.ok(calls[0].messages[0].content[0].text.includes('1: MRS_A = MRS_B'));
  assert.ok(calls[0].messages[0].content[0].text.includes('교환이 효율적이려면'));
  const last = card.renders.at(-1);
  assert.equal(last.summary, '파레토 효율 설명');
  assert.deepEqual(last.marks, [{ note: '조건', text: 'MRS_A = MRS_B' }]);
  assert.equal(overlays.length, 1);
  assert.equal(overlays[0].display, 'D1');
  assert.deepEqual(E.allLines(overlays[0].models[0]).map((l) => l.id), [1]);
});

test('설명: 한 번에 받은 답이 비면 표시와 그림을 두 모델에 나눠 묻는다', async () => {
  const { ex, calls, cards } = rig({
    replies: [content('{"summary":"","marks":[]}'), content('{"marks":[{"id":1,"note":"n"}]}'), content('{"summary":"따로 받은 요약","visuals":[],"scenes":[]}')],
  });
  await ex.run();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.slice(1).map((c) => c.model).sort(), [GroqClient.REASONING_MODEL, GroqClient.VISION_MODEL].sort());
  const last = cards[0].renders.at(-1);
  assert.equal(last.summary, '따로 받은 요약');
  assert.equal(last.marks.length, 1);
});

test('설명: 화면을 못 찍으면 카드에 오류만 (Groq 은 부르지 않는다)', async () => {
  const { ex, calls, cards } = rig({ grab: async () => { throw new Error('화면을 찾지 못했습니다'); } });
  await ex.run();
  assert.equal(calls.length, 0);
  assert.deepEqual(cards[0].renders.at(-1), { error: '화면을 찾지 못했습니다' });
  assert.equal(ex.busy, false);
});

test('설명: 이미 하는 중이면 또 누른 것은 무시한다', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { ex, calls } = rig({ replies: [content(unified)], ocr: async () => { await gate; return OCR; } });
  const first = ex.run();
  await ex.run();
  release();
  await first;
  assert.equal(calls.length, 1);
});

test('카드의 장면이 바뀌면 화면 표시도 그 장면, -1 이면 전체 표시', async () => {
  const data = JSON.stringify({ summary: 's', marks: [{ id: 1 }], visuals: [], scenes: [{ say: '하나', focus: [0] }, { say: '둘', focus: [1] }] });
  const { ex, cards, overlays } = rig({ replies: [content(data)] });
  await ex.run();
  assert.equal(overlays[0].models[0].scene, 0);
  cards[0].hooks.onScene(1);
  assert.equal(overlays[0].models.at(-1).scene, 1);
  cards[0].hooks.onScene(-1);
  assert.equal(overlays[0].models.at(-1).scene, null);
});

test('질문: 같은 화면을 다시 찍어 앞의 설명·앞의 대화와 함께 묻고, 화면 표시를 답이 짚은 곳으로', async () => {
  const { ex, calls, grabs, cards, overlays } = rig({
    replies: [content(unified), content('{"answer":"한계대체율이에요","marks":[{"id":0,"note":"제목"}]}'), content('{"answer":"둘째 답"}')],
  });
  await ex.run();
  await ex.ask('MRS가 뭐야?');
  assert.equal(grabs[1].display, 'D1');
  const p1 = calls[1].messages[0].content[0].text;
  assert.ok(p1.includes('Explanation already shown to the student:\n파레토 효율 설명'));
  assert.ok(p1.includes('The student now asks: MRS가 뭐야?'));
  assert.deepEqual(cards[0].answers[0], { answer: '한계대체율이에요', marks: [{ note: '제목', text: '제목' }], visuals: [] });
  assert.ok(overlays[0].closed);
  assert.deepEqual(E.allLines(overlays[1].models[0]).map((l) => l.id), [0]);
  await ex.ask('그럼?');
  assert.ok(calls[2].messages[0].content[0].text.includes('Q: MRS가 뭐야?\nA: 한계대체율이에요'));
  assert.equal(overlays[1].closed, true); // 짚은 곳이 없는 답이면 표시를 지운다
});

test('질문: 답 글을 못 읽으면 맥 문구, 요청이 실패하면 그 오류', async () => {
  const { ex, cards } = rig({ replies: [content(unified), content('{"marks":[]}'), json({ error: { message: 'bad' } }, 400)] });
  await ex.run();
  await ex.ask('왜?');
  assert.deepEqual(cards[0].answers[0], { error: ANSWER_FAILED });
  await ex.ask('왜?');
  assert.ok(cards[0].answers[1].error);
});

test('카드를 닫으면 화면 표시도 지우고, 다음 설명은 새 카드', async () => {
  const { ex, cards, overlays } = rig({ replies: [content(unified), content(unified)] });
  await ex.run();
  cards[0].hooks.onClose();
  assert.ok(overlays[0].closed);
  await ex.run();
  assert.equal(cards.length, 2);
});

test('개발용 EZRITE_ASK: 설명이 뜬 뒤 그 질문을 한 번 묻는다', async () => {
  const { ex, cards } = rig({ replies: [content(unified), content(unified)], devQuestion: '왜 같아야 해?' });
  await ex.run();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(cards[0].devAsks, ['왜 같아야 해?']);
  await ex.run();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(cards[0].devAsks, ['왜 같아야 해?']);
});

test('개발용 EZRITE_CARD: AI 없이 카드에 바로 띄운다', () => {
  const { ex, calls, cards } = rig();
  ex.demo({ summary: '데모' });
  assert.equal(calls.length, 0);
  assert.deepEqual(cards[0].shows[0], { display: null, avoid: null });
  assert.deepEqual(cards[0].renders, [{ summary: '데모' }]);
});

test('지켜보기: 표시 자리가 바뀌면 글자를 다시 읽어 옮기고, 사라지면 숨기고, 다시 보이면 되살린다', async () => {
  const screens = [
    // 0: 설명 때 화면
    { v: 0, ocr: OCR },
    // 1: 그대로 → 글자를 다시 읽지 않는다
    { v: 0, ocr: null },
    // 2: 스크롤 → 같은 줄이 아래로
    { v: 255, ocr: { ...OCR, lines: [OCR.lines[0], { ...OCR.lines[1], y: 70 }] } },
    // 3: 슬라이드 넘김 → 숨김
    { v: 0, ocr: { width: 100, height: 100, lines: [{ text: '다른 슬라이드', x: 0, y: 0, w: 50, h: 5 }] } },
    // 4: 돌아옴 → 되살림
    { v: 255, ocr: { ...OCR, lines: [OCR.lines[0], { ...OCR.lines[1], y: 70 }] } },
  ];
  let shot = 0;
  let ocrs = 0;
  let ticks = 0;
  const sleeps = [];
  const r = rig({
    replies: [content(unified)],
    grab: async (opts) => {
      const s = screens[Math.min(shot++, screens.length - 1)];
      return { display: 'D1', full: opts.full, bitmap: bitmap(s.v), png: () => s, jpeg: () => Buffer.from('j') };
    },
    ocr: async (png) => { ocrs++; return png.ocr ?? OCR; },
    sleep: async (ms) => {
      sleeps.push(ms);
      if (++ticks > 4) r.ex.clear();
    },
  });
  await r.ex.run();
  await r.ex.watching;
  const o = r.overlays[0];
  assert.equal(ocrs, 4); // 설명 1 + 바뀐 화면 3 (그대로인 화면은 읽지 않는다)
  assert.ok(Math.abs(E.allLines(o.models.at(-1))[0].box.y - 0.7) < 1e-9);
  assert.equal(o.hidden, 1);
  assert.equal(o.shown, 1);
  assert.deepEqual(sleeps.slice(0, 4), [400, 400, 400, 600]);
  assert.ok(o.closed);
});

test('지켜보기 끔(EZRITE_CAPTURABLE 녹화용): 표시를 그린 뒤 화면을 다시 찍지 않는다 — 찍을 때마다 카드·표시가 깜박이지 않게', async () => {
  let ticks = 0;
  const { ex, grabs, overlays } = rig({ replies: [content(unified)], watch: false, sleep: async () => { ticks++; } });
  await ex.run();
  await ex.watching;
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.equal(grabs.length, 1, '설명할 때 한 번만 찍는다');
  assert.equal(ticks, 0);
  assert.equal(overlays.length, 1);
  assert.equal(overlays[0].hidden, 0);
});

test('지켜보기 기본값은 켬', async () => {
  let ticks = 0;
  const { ex, grabs } = rig({ replies: [content(unified)], sleep: async () => { ticks++; if (ticks > 2) ex.hideMarks(); await new Promise((r) => setImmediate(r)); } });
  await ex.run();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.ok(grabs.length > 1, '표시 자리를 다시 찍는다');
  ex.hideMarks();
});

test('설명: 한국어 OCR 팩이 없고 글자가 깨졌으면 카드에 한 줄 안내를 붙인다', async () => {
  const { OCR_KO_HINT } = require('../lib/explain');
  const garbled = { width: 100, height: 100, koAvailable: false, lines: ['LH 7t Ol 2 E-I', 'O| xl ?? 2t', 'S| 4 ol0', '7H LI E- ?'].map((text, i) => ({ text, x: 1, y: i * 10, w: 50, h: 6 })) };
  const { ex, cards } = rig({ replies: [content(unified)], ocr: async () => garbled });
  await ex.run();
  assert.equal(cards[0].renders.at(-1).hint, OCR_KO_HINT);
  const ok = rig({ replies: [content(unified)] });
  await ok.ex.run();
  assert.equal(ok.cards[0].renders.at(-1).hint, undefined);
});
