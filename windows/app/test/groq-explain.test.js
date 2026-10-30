'use strict';

// "설명해줘" Groq 요청. 맥 AskTests(프롬프트) · VisualsSchemaTests · VisualsShapeTests 이식 + 가짜 fetch 로 갈래 시험.
const test = require('node:test');
const assert = require('node:assert/strict');
const { GroqClient } = require('../lib/groq');
const G = require('../lib/groq-explain');
const E = require('../lib/explain');

const lines = [{ id: 1, text: 'MRS_A = MRS_B', box: { x: 0, y: 0, w: 0, h: 0 } }];

// --- 맥 AskTests ---

test('[mac AskTests] 사용자_지침이_있으면_설명과_질문_요청에_들어간다', () => {
  const guide = '통계학 2학년 수준으로, 수식은 풀이까지';
  assert.ok(G.unifiedPrompt(lines, [], guide).includes('통계학 2학년 수준으로'));
  assert.ok(G.visualsPrompt(lines, [], guide).includes('통계학 2학년 수준으로'));
  assert.ok(G.questionPrompt('왜 같아야 해?', [], '', lines, [], guide).includes('통계학 2학년 수준으로'));
});

test('[mac AskTests] 지침이_비어_있으면_아무것도_넣지_않는다', () => {
  assert.ok(!G.unifiedPrompt(lines, [], '   ').includes("Student's instructions"));
});

test('[1.2.4 후보] 교수님 말을 되풀이하지 않게: 말·화면 머리, 설명 과제, 규칙, 장면 say 가 맥과 같은 글', () => {
  assert.equal(G.VISUALS_TASK, 'Explain, in Korean, the idea underneath what is being taught right now — what the lecturer left unsaid: '
    + 'why it is true or needed, what it assumes, an intuition or small worked example, and the usual point of confusion. '
    + 'Use your own words; the student already has the speech and the screen.');
  assert.ok(G.VISUAL_RULES.startsWith('Rules: never contradict the screen or the speech and do not invent facts, but do add standard textbook background the lecturer skipped; check any calculation'));
  assert.ok(G.SCENES_GUIDE.includes('{"say":"1-2 Korean sentences that teach this step (meaning and reason, not just what is on screen, and not a sentence the lecturer already said)", '));
  // 질문도 같은 머리를 쓴다 (의도)
  const q = G.questionPrompt('왜?', [], '', lines, ['교수님 말']);
  assert.ok(q.includes('Recent lecture speech (oldest first) — the student just heard this and still did not fully get it, so never restate or paraphrase it:\n교수님 말'));
  assert.ok(q.includes('Text lines on screen (id: text) — the student can already read these:\n1: MRS_A = MRS_B'));
  for (const old of ['Recent lecture speech (oldest first):', 'Text lines on screen (id: text):', 'stay faithful to the screen', 'for a student seeing it for the first time']) {
    assert.ok(!G.unifiedPrompt(lines, ['x'], '', true).includes(old), old);
  }
});

test('[mac AskTests] 질문_요청에는_질문·앞의_설명·앞의_대화가_들어간다', () => {
  const p = G.questionPrompt('그럼 MRS가 다르면?', [{ q: 'MRS가 뭐야?', a: '한계대체율이에요' }], '파레토 효율 설명', lines, ['교환이 효율적이려면']);
  for (const s of ['그럼 MRS가 다르면?', '한계대체율이에요', '파레토 효율 설명', '교환이 효율적이려면', '1: MRS_A = MRS_B']) assert.ok(p.includes(s), s);
});

test('맥과 같은 프롬프트 조각 (줄 번호 금지·문단 나누기 규칙은 Groq 모델에만)', () => {
  const u = G.unifiedPrompt(lines, [], '');
  assert.ok(u.startsWith('You help a university student follow a lecture. The subject can be anything (humanities, social science, science, engineering, arts).\n'
    + 'Recent lecture speech (oldest first) — the student just heard this and still did not fully get it, so never restate or paraphrase it:\n'
    + '(none — explain what is on screen)\n\nText lines on screen (id: text) — the student can already read these:\n1: MRS_A = MRS_B\n\nDo two things.\n1. Choose up to 3 text lines'));
  assert.ok(u.includes('"scenes":[2 to 6 scenes]'));
  assert.ok(u.includes('Use flowchart TD/LR or sequenceDiagram.'));
  assert.ok(!u.includes('Line ids are only for you'));
  assert.ok(G.GROQ_RULES.includes('separated by \\n\\n')); // 글자 그대로의 \n (맥 "\\n\\n")
  // 한자 섞임·"코어" 오역·깨진 OCR 베끼기 예방 문장이 맨 끝에 맥과 같게 붙는다
  assert.ok(G.GROQ_RULES.endsWith('Write every student-facing text in Korean (Hangul) only. Never use Chinese characters or Japanese, '
    + 'not even for technical terms. Keep technical terms in their original English as written on the screen or in the speech '
    + '(e.g. kernel, eigenvector, PCA), optionally with Hangul (커널). If a screen line looks garbled by text recognition '
    + '(random symbols or Chinese characters inside a formula), do not copy it: write the formula correctly from the image, '
    + 'or describe it in words.'));
  const q = G.questionPrompt('q', [], '', lines, []);
  assert.ok(q.includes('{"answer":"Korean answer, paragraphs separated by \\n", "marks":'));
  assert.ok(q.includes('Explanation already shown to the student:\n(none)\n\nThe student now asks: q'));
});

// --- 맥 VisualsSchemaTests / VisualsShapeTests ---

test('[mac VisualsSchemaTests] 그림_요청은_네_가지_틀을_엄격한_스키마로_고정한다', () => {
  const body = G.visualsBody('p');
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  const items = body.response_format.json_schema.schema.properties.visuals.items;
  assert.deepEqual(items.anyOf.map((o) => o.properties.type.enum).flat(), ['steps', 'table', 'card', 'mermaid']);
  assert.deepEqual(body.response_format.json_schema.schema.required, ['scenes', 'summary', 'visuals']);
});

test('[mac VisualsShapeTests] 목록으로_온_답은_그림_목록으로_감싼다', () => {
  const fixed = G.asVisualsObject('[{"type":"steps","title":"흐름","items":["가","나"]}]');
  assert.equal(E.visuals(fixed).visuals.length, 1);
});

test('[mac VisualsShapeTests] 객체로_온_답은_그대로_둔다', () => {
  const o = '{"summary":"요약","visuals":[]}';
  assert.equal(G.asVisualsObject(o), o);
});

// --- 가짜 fetch 로 요청 갈래 ---

const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
const content = (text) => json({ choices: [{ message: { content: text } }], usage: { total_tokens: 10 } });

function client(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const r = responses.shift();
    if (!r) throw new Error('예상보다 많이 불림');
    return typeof r === 'function' ? r() : r;
  };
  const groq = new GroqClient({ fetch, getKey: () => 'k', sleep: async () => {}, lenientJSON: E.lenientJSON });
  return { groq, calls };
}

test('설명: qwen 에 화면 사진과 글자를 한 번에 보내고, 줄 번호 말은 그 줄 글자로 바꾼다', async () => {
  const { groq, calls } = client([content('{"summary":"1번 줄은 조건이에요","marks":[{"id":1,"note":"n"}]}')]);
  const out = await G.explainUnified(groq, { jpeg: Buffer.from('jpg'), lines, transcript: ['교환'] });
  assert.equal(calls.length, 1); // 다른 언어가 섞이지 않았으니 고치기 요청은 없다
  assert.equal(calls[0].model, 'qwen/qwen3.8-27b');
  assert.equal(calls[0].reasoning_effort, 'none');
  assert.equal(calls[0].response_format.type, 'json_object');
  assert.equal(calls[0].messages[0].content[1].image_url.url, `data:image/jpeg;base64,${Buffer.from('jpg').toString('base64')}`);
  assert.ok(calls[0].messages[0].content[0].text.endsWith(G.GROQ_RULES));
  assert.equal(E.visuals(out).summary, '‘MRS_A = MRS_B’은 조건이에요');
});

test('설명: 다른 언어 조각이 섞이면 20b 에게 그 조각만 옮기게 해서 끼워 넣는다', async () => {
  const { groq, calls } = client([content('{"summary":"이것은 정말 важный 조건이에요"}'), content('важный=중요한')]);
  const out = await G.explainUnified(groq, { jpeg: Buffer.from('j'), lines, transcript: [] });
  assert.equal(calls[1].model, 'openai/gpt-oss-20b');
  assert.equal(E.visuals(out).summary, '이것은 정말 중요한 조건이에요');
});

test('질문: qwen 이 한도에 걸리면 120b 가 글자만 보고 답한다', async () => {
  const { groq, calls } = client([json({ error: { message: 'rate' } }, 429, { 'retry-after': '20' }), content('{"answer":"답","marks":[]}')]);
  const out = await G.answer(groq, 'P', { jpeg: Buffer.from('j'), lines, transcript: [] });
  assert.equal(calls[1].model, 'openai/gpt-oss-120b');
  assert.equal(calls[1].reasoning_effort, 'medium');
  assert.ok(calls[1].messages[0].content.endsWith(G.GROQ_RULES));
  assert.equal(E.answer(out), '답');
});

test('질문: 둘 다 한도면 더 짧은 기다림으로 알린다', async () => {
  const { groq } = client([json({}, 429, { 'retry-after': '90' }), json({}, 429, { 'retry-after': '30' })]);
  await assert.rejects(() => G.answer(groq, 'P', { jpeg: Buffer.from('j'), lines, transcript: [] }), /30초 뒤/);
});

test('그림 요청: 스키마가 안 맞는다고 거절되면 한 번 더, 그래도 안 되면 느슨한 JSON 으로 받아 감싼다', async () => {
  const schemaErr = () => json({ error: { message: 'Generated JSON does not match the expected schema' } }, 400);
  const { groq, calls } = client([schemaErr(), schemaErr(), content('[{"type":"steps","title":"t","items":["a"]}]')]);
  const out = await G.explainVisuals(groq, { lines, transcript: [] });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].response_format.type, 'json_object');
  assert.ok(calls[2].messages[0].content.endsWith('Return ONE JSON object (not an array) with the keys described above.'));
  assert.equal(E.visuals(out).visuals.length, 1);
});

test('그림 요청: 120b 가 한도면 qwen 으로 (qwen 은 reasoning_effort none)', async () => {
  const { groq, calls } = client([json({}, 429), content('{"summary":"s","visuals":[]}')]);
  await G.explainVisuals(groq, { lines, transcript: [] });
  assert.equal(calls[1].model, 'qwen/qwen3.8-27b');
  assert.equal(calls[1].reasoning_effort, 'none');
});

test('표시 요청: 이미지 모델이 한도면 120b 가 글자만 보고 고른다', async () => {
  const { groq, calls } = client([json({}, 429), content('{"marks":[{"id":1}]}')]);
  const out = await G.explainMarks(groq, { jpeg: Buffer.from('j'), lines, transcript: [] });
  assert.equal(calls[1].model, 'openai/gpt-oss-120b');
  assert.equal(calls[1].reasoning_effort, 'low');
  assert.equal(E.marks(out, lines).length, 1);
});

test('수식 역슬래시로 Groq 이 거절한 JSON 은 다시 묻지 않고 고쳐 쓴다 (groq.js lenientJSON 자리)', async () => {
  const { groq, calls } = client([json({ error: { message: 'Failed to generate JSON', failed_generation: '{"summary":"오차 \\delta"}' } }, 400)]);
  const out = await G.explainUnified(groq, { jpeg: Buffer.from('j'), lines, transcript: [] });
  assert.equal(calls.length, 1);
  assert.equal(E.visuals(out).summary, '오차 \\delta');
});

test('키가 없으면 보내지 않고 맥 문구로 실패', async () => {
  const groq = new GroqClient({ fetch: async () => assert.fail('보내면 안 된다'), getKey: () => null });
  await assert.rejects(() => G.explainUnified(groq, { jpeg: Buffer.from('j'), lines, transcript: [] }), /Groq API 키가 없습니다/);
});

test('가짜 Groq (EZRITE_FAKE_GROQ): 설명 요청엔 화면 글자 줄 번호로 짚은 곳·요약·장면을 돌려준다 (네트워크 없음)', async () => {
  const { fakeFetch } = require('../lib/fakegroq');
  const groq = new GroqClient({ fetch: fakeFetch({ delayMs: 0 }), getKey: () => 'fake', lenientJSON: E.lenientJSON });
  const screen = [
    { id: 0, text: '제목', box: { x: 0, y: 0, w: 0.1, h: 0.1 } },
    { id: 3, text: 'MRS_A = MRS_B', box: { x: 0, y: 0.5, w: 0.1, h: 0.1 } },
  ];
  const out = await G.explainUnified(groq, { jpeg: Buffer.from('j'), lines: screen, transcript: [] });
  assert.deepEqual(E.marks(out, screen).map((m) => m.line.id), [0, 3]);
  assert.ok(E.visuals(out).summary);
  assert.ok(E.scenes(out, screen, E.visuals(out).visuals.length).length >= 2);
  const a = await G.answer(groq, G.questionPrompt('왜?', [], '', screen, []), { jpeg: Buffer.from('j'), lines: screen, transcript: [] });
  assert.ok(E.answer(a));
});

test('[mac Usage.used] 설명·질문 한 번에 쓴 토큰을 알린다 (남은 횟수 평균용). 120b 로 대신 답하면 알리지 않는다', async () => {
  const used = [];
  const onUsed = (use, tokens) => used.push([use, tokens]);
  const a = client([content('{"summary":"s"}'), content('{"answer":"a"}'), json({}, 429), content('{"answer":"b"}')]);
  await G.explainUnified(a.groq, { jpeg: Buffer.from('j'), lines, transcript: [], onUsed });
  await G.answer(a.groq, 'P', { jpeg: Buffer.from('j'), lines, transcript: [], onUsed });
  await G.answer(a.groq, 'P', { jpeg: Buffer.from('j'), lines, transcript: [], onUsed });
  assert.deepEqual(used, [['explain', 10], ['ask', 10]]);
});

// --- 1.2.1 움직이는 그림 (맥 ExplainTests 움직이는_그림_안내는_Groq_가_아닌_서비스에만_준다) ---

test('[mac ExplainTests] 움직이는_그림_안내는_Groq_가_아닌_서비스에만_준다', () => {
  const anim = '"type":"anim"';
  assert.ok(!G.unifiedPrompt(lines, [], '').includes(anim));
  assert.ok(G.unifiedPrompt(lines, [], '', true).includes(anim));
  assert.ok(!G.visualsPrompt(lines, [], '').includes(anim));
  assert.ok(!G.questionPrompt('q', [], '', lines, []).includes(anim));
  assert.ok(G.questionPrompt('q', [], '', lines, [], '', true).includes(anim));
  // 그림 안내 = 네 가지 틀 (+ 움직이는 그림) + 규칙. 규칙은 늘 맨 끝
  assert.equal(G.visualsGuide(false), `${G.BASE_KINDS}\n${G.VISUAL_RULES}`);
  assert.equal(G.visualsGuide(true), `${G.BASE_KINDS}\n${G.ANIM_KIND}\n${G.VISUAL_RULES}`);
  assert.ok(G.ANIM_KIND.includes('"layers": each item has "layer" 0,1,2… drawn as columns left to right'));
  assert.ok(G.ANIM_KIND.includes('Move them with "set" giving new "points" (same count) or "at"'));
  // 맥 1.2.2 Groq.swift 와 글자까지 같다: 여러 줄 글의 이음(\) 다음 줄 들여쓰기 2칸이 남아 "set". 뒤가 세 칸이다
  assert.ok(G.ANIM_KIND.includes('change cell values with "set".   "graph": "axes"'));
  // 장면 reveal 은 움직이는 그림이면 재생한 단계 수
  assert.ok(G.SCENES_GUIDE.includes('or for an anim visual how many frames have played (1 = first frame), or null}'));
});

test('1.2.1: Groq 로 가는 요청(qwen 한 번에·질문·gpt-oss 그림)과 엄격 스키마에는 움직이는 그림이 없다', async () => {
  const sent = [];
  const groq = new GroqClient({
    fetch: async (_u, init) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"summary":"s","visuals":[],"scenes":[],"answer":"a"}' } }] }), { status: 200 });
    },
    getKey: () => 'k', sleep: async () => {}, lenientJSON: E.lenientJSON,
  });
  await G.explainUnified(groq, { jpeg: Buffer.from('j'), lines, transcript: [] });
  await G.explainVisuals(groq, { lines, transcript: [] });
  await G.answer(groq, G.questionPrompt('q', [], '', lines, []), { jpeg: Buffer.from('j'), lines, transcript: [] });
  const text = (b) => JSON.stringify(b.messages);
  assert.equal(sent.length, 3);
  for (const b of sent) assert.ok(!text(b).includes('\\"type\\":\\"anim\\"'), b.model);
});
