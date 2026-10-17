'use strict';

// "설명해줘" Groq 요청과 프롬프트. 맥 Groq.swift 의 GroqClient 확장(explainUnified·answer·fixScript·
// explainMarks·explainVisuals·visualsBody·visualsSchema·asVisualsObject)과 프롬프트를 글자 그대로 옮겼다.
// 요청은 groq.js 의 GroqClient.chat 으로 보낸다 (한도·재시도·키 가리기·lenientJSON 은 거기서).
//
// 다른 서비스(Claude·Gemini·GPT) 갈래는 lib/ai.js 와 explainer.js 에 있다 (Groq 규칙·fixScript 는 Groq 갈래에만).
// 사용자 AI 지침(GroqClient.guide)은 전역 대신 guide 인자로 받는다.

const { GroqClient, RateLimitedError, GroqError } = require('./groq');
const Script = require('./script');
const E = require('./explain');

const VISION = GroqClient.VISION_MODEL;
const REASONING = GroqClient.REASONING_MODEL;

const AUDIENCE = 'You help a university student follow a lecture. The subject can be anything '
  + '(humanities, social science, science, engineering, arts).';

const MARKS_TASK = 'Choose up to 3 text lines from the MAIN lecture material on screen (slides, document, board) that the '
  + 'lecturer is talking about right now. Ignore menus, tabs, address bars, thumbnails, captions and other '
  + 'app UI. If there is no speech, choose the most important lines.\n'
  + 'If the lecturer is walking through an ORDER inside a figure — e.g. a path through a circuit, the flow of '
  + 'a diagram, a route on a map, a cycle — also give that order as the text labels inside the figure, in '
  + 'sequence. Use only labels that sit inside the figure. Omit "path" when there is no such order.';

const MARKS_SHAPE = '"marks":[{"id":<line id>,"note":"1-2 Korean sentences explaining what this line MEANS (the idea itself, '
  + 'with the why) — not that the lecturer is explaining it"}],\n'
  + '"path":{"ids":[<label line ids in order>],"note":"one short Korean sentence about the route"}';

const VISUALS_TASK = 'Explain what is being taught right now, in Korean, for a student seeing it for the first time.';
const VISUALS_SHAPE = '"summary":"3-5 Korean sentences: what it is, why it matters, and a simple example or intuition","visuals":[0 to 2 items],"scenes":[2 to 6 scenes]';

/** 장면 대본: 설명을 짧은 영상처럼 순서대로 보여준다 */
const SCENES_GUIDE = 'Scenes play like a short explainer video, in the order the lecturer explained it (follow the speech; with no '
  + "speech, follow the screen's logical order). Each scene: {\"say\":\"1-2 Korean sentences that teach this step (meaning and reason, not just what is on screen)\", "
  + '"focus":[screen line ids to highlight, 0-2], "arrow":{"from":line id,"to":line id} or null (connect two '
  + 'related lines on screen), "visual":index into visuals or null (show that visual beside the screen), '
  + '"reveal":how many items/rows of that steps/table visual to show so far, or null}. Build visuals up gradually '
  + 'across scenes. Every scene says something new — never repeat an earlier scene. Use only line ids from the list.';

const VISUALS_GUIDE = [
  'Visual item types — pick only what genuinely helps, or none:',
  '- {"type":"steps","title":"...","items":["...", "..."]}  ordered process, procedure, argument, derivation, '
    + 'calculation, sequence of events',
  '- {"type":"table","title":"...","headers":["..."],"rows":[["..."]]}  comparison, classification, attributes',
  '- {"type":"card","title":"...","formula":"KaTeX, optional","body":"optional","terms":[["term","meaning"]]}  '
    + 'definition, key formula, glossary',
  '- {"type":"mermaid","title":"...","code":"..."}  relationships, cause and effect, hierarchy, cycle, '
    + 'interaction between actors. Use flowchart TD/LR or sequenceDiagram. Put every node label in double quotes.',
  'Rules: stay faithful to the screen and the speech, do not invent facts; check any calculation step by step; '
    + 'keep text short; formulas only in the card "formula" field.',
].join('\n');

/** Groq 모델에만 붙인다: qwen 은 줄 번호("5번 줄")를 그대로 말하고, 답 글에 LaTeX 를 써서 카드에 기호가 그대로 보인다 */
const GROQ_RULES = '\nLine ids are only for you to point at lines — never write ids or "line N" in any text the student reads. '
  + 'In text the student reads, write math in plain Unicode (δ, Σ, ², ᵀ, √, →); never LaTeX or $ (KaTeX only in a card "formula"). '
  + 'Break long text into short paragraphs of 2-3 sentences separated by \\n\\n; put derivation steps on their own lines. '
  // 한자·일본어 섞임, kernel→"코어" 같은 오역, 깨진 OCR 베끼기 예방 (맥과 같은 문장)
  + 'Write every student-facing text in Korean (Hangul) only. Never use Chinese characters or Japanese, not even for technical terms. '
  + 'Keep technical terms in their original English as written on the screen or in the speech (e.g. kernel, eigenvector, PCA), '
  + 'optionally with Hangul (커널). If a screen line looks garbled by text recognition (random symbols or Chinese characters '
  + 'inside a formula), do not copy it: write the formula correctly from the image, or describe it in words.';

const NO_KEY = 'Groq API 키가 없습니다. 설정에서 키를 입력하세요.';

/** 최근 강의 말 + 화면 글자(번호: 글자) + 사용자 AI 지침 */
function context(lines, transcript, guide = '') {
  const speech = transcript.length ? transcript.join('\n') : '(none — explain what is on screen)';
  const screen = lines.map((l) => `${l.id}: ${l.text}`).join('\n');
  const g = String(guide ?? '').trim();
  // 지침은 말투·깊이·형식을 바꾸지만 사실을 바꾸지는 않는다
  const rules = g ? `\n\nStudent's instructions (follow them for depth, style and format; never invent facts):\n${g}` : '';
  return `Recent lecture speech (oldest first):\n${speech}\n\nText lines on screen (id: text):\n${screen}${rules}`;
}

/** 설명 카드에서 이어 묻는 질문. 답은 글(answer) + 화면 짚기(marks, path) + 그림(visuals). history: [{q, a}] */
function questionPrompt(question, history, explanation, lines, transcript, guide = '') {
  const past = history.map((h) => `Q: ${h.q}\nA: ${h.a}`).join('\n\n');
  return [
    AUDIENCE,
    context(lines, transcript, guide),
    '',
    'Explanation already shown to the student:',
    explanation || '(none)',
    past ? `\nEarlier questions and answers:\n${past}\n` : '',
    `The student now asks: ${question}`,
    '',
    'Answer in Korean, clearly and thoroughly enough to actually resolve the question — explain the why, '
      + 'and work through any formula or calculation step by step. Point at the screen lines your answer refers to.',
    `Return JSON only: {"answer":"Korean answer, paragraphs separated by \\n", ${MARKS_SHAPE},`,
    '"visuals":[0 to 2 items]}',
    VISUALS_GUIDE,
  ].join('\n');
}

function marksPrompt(lines, transcript, guide = '') {
  return `${AUDIENCE}\n${context(lines, transcript, guide)}\n\n${MARKS_TASK}\nReturn JSON only: {${MARKS_SHAPE}}`;
}

function visualsPrompt(lines, transcript, guide = '') {
  return `${AUDIENCE}\n${context(lines, transcript, guide)}\n\n${VISUALS_TASK}\n`
    + `Return JSON only: {${VISUALS_SHAPE}}\n${VISUALS_GUIDE}\n${SCENES_GUIDE}`;
}

/** 화면 이미지와 글자를 보고 표시·요약·그림을 한 번에 */
function unifiedPrompt(lines, transcript, guide = '') {
  return `${AUDIENCE}\n${context(lines, transcript, guide)}\n\nDo two things.\n1. ${MARKS_TASK}\n`
    + `2. ${VISUALS_TASK}\nReturn ONE JSON object only: {${MARKS_SHAPE},\n${VISUALS_SHAPE}}\n${VISUALS_GUIDE}\n${SCENES_GUIDE}`;
}

const imageUrl = (jpeg) => `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}`;

function visionBody(prompt, jpeg) {
  return {
    model: VISION,
    messages: [{ role: 'user', content: [
      { type: 'text', text: prompt + GROQ_RULES },
      { type: 'image_url', image_url: { url: imageUrl(jpeg) } },
    ] }],
    temperature: 0.3, response_format: { type: 'json_object' }, reasoning_effort: 'none',
  };
}

/** 네 가지 그림 틀. strict 모드는 모든 칸이 required 여야 해서, 빠질 수 있는 칸은 null 을 허용한다 */
const VISUALS_SCHEMA = (() => {
  const obj = (props) => ({ type: 'object', additionalProperties: false, required: Object.keys(props).sort(), properties: props });
  const str = { type: 'string' };
  const strs = { type: 'array', items: str };
  const kind = (k) => ({ type: 'string', enum: [k] });
  const items = [
    obj({ type: kind('steps'), title: str, items: strs }),
    obj({ type: kind('table'), title: str, headers: strs, rows: { type: 'array', items: strs } }),
    obj({ type: kind('card'), title: str, formula: { type: ['string', 'null'] }, body: { type: ['string', 'null'] }, terms: { type: 'array', items: strs } }),
    obj({ type: kind('mermaid'), title: str, code: str }),
  ];
  const integer = { type: 'integer' };
  const nullInt = { type: ['integer', 'null'] };
  const scene = obj({
    say: str, focus: { type: 'array', items: integer },
    arrow: { anyOf: [obj({ from: integer, to: integer }), { type: 'null' }] },
    visual: nullInt, reveal: nullInt,
  });
  return obj({ summary: str, visuals: { type: 'array', items: { anyOf: items } }, scenes: { type: 'array', items: scene } });
})();

/** 그림·요약 요청. gpt-oss 는 엄격한 스키마(structured outputs)를 지원해서 칸 이름·구조가 반드시 맞게 온다 */
function visualsBody(prompt) {
  return {
    model: REASONING, messages: [{ role: 'user', content: prompt }], temperature: 0.2, reasoning_effort: 'medium',
    response_format: { type: 'json_schema', json_schema: { name: 'explanation', strict: true, schema: VISUALS_SCHEMA } },
  };
}

/** 맨 바깥이 목록이면 그림 목록으로 보고 {"summary": "", "visuals": [...]} 로 감싼다 */
function asVisualsObject(text) {
  try {
    const v = JSON.parse(text);
    if (Array.isArray(v)) return JSON.stringify({ summary: '', visuals: v });
  } catch { /* 그대로 */ }
  return text;
}

/** 섞임 검사에서 빼 줄 글자: 화면 글자와 강의 말에 원래 있던 글자 */
function source(lines, transcript) {
  return [...lines.map((l) => l.text), ...transcript].join(' ');
}

function key(groq) {
  const k = groq.getKey();
  if (!k) throw new GroqError(NO_KEY);
  return k;
}

/** 섞여 나온 다른 언어 조각만 20b 에게 옮기게 해서 끼워 넣는다. 못 고치면 받은 그대로 둔다 */
async function fixScript(groq, text, src) {
  const runs = Script.foreignRuns(text, src);
  const k = groq.getKey();
  if (!runs.length || !k) return text;
  try {
    const reply = await groq.chat({
      model: GroqClient.CHAT_MODELS[1], temperature: 0, reasoning_effort: 'low',
      messages: [{ role: 'user', content: Script.fixPrompt(text, runs, src) }],
    }, k);
    return Script.apply(text, reply, runs) ?? text;
  } catch {
    return text;
  }
}

/** 설명: qwen 이 화면 사진과 글자를 보고 표시·요약·그림을 한 번에. 한도에 걸리면 RateLimitedError 를 그대로 던진다 */
async function explainUnified(groq, { jpeg, lines, transcript, guide = '', onUsed = () => {} }) {
  const k = key(groq);
  const text = await groq.chat(visionBody(unifiedPrompt(lines, transcript, guide), jpeg), k);
  onUsed('explain', groq.lastTokens); // 한 번에 쓴 토큰 (맥 Usage.used — 남은 횟수 평균)
  return E.dropLineRefs(await fixScript(groq, text, source(lines, transcript)), lines);
}

/** 질문의 답 (글만 보고 답한다 — 화면 줄 번호로 짚는다). qwen 이 막혔을 때 쓴다 */
async function answerText(groq, prompt) {
  return groq.chat({
    model: REASONING, messages: [{ role: 'user', content: prompt + GROQ_RULES }],
    temperature: 0.3, response_format: { type: 'json_object' }, reasoning_effort: 'medium',
  }, key(groq));
}

const minRetry = (a, b) => {
  const xs = [a.retryAfter, b.retryAfter].filter((v) => v != null);
  return xs.length ? Math.min(...xs) : null;
};

/** 질문의 답: qwen 이 지금 화면 사진까지 보고 답한다. qwen 이 한도에 걸리면 120b 가 글자만 보고 답한다 */
async function answer(groq, prompt, { jpeg, lines, transcript, onUsed = () => {} }) {
  const k = key(groq);
  try {
    const text = await groq.chat(visionBody(prompt, jpeg), k);
    onUsed('ask', groq.lastTokens);
    return E.dropLineRefs(await fixScript(groq, text, source(lines, transcript)), lines);
  } catch (first) {
    if (!(first instanceof RateLimitedError)) throw first;
    try {
      return E.dropLineRefs(await answerText(groq, prompt), lines);
    } catch (second) {
      if (second instanceof RateLimitedError) throw new RateLimitedError(minRetry(first, second));
      throw second;
    }
  }
}

/** 화면 위 표시: 강사가 지금 말하는 줄 번호를 고른다. 이미지가 막히면(한도) 글자만으로 고른다 */
async function explainMarks(groq, { jpeg, lines, transcript, guide = '' }) {
  const k = key(groq);
  const prompt = marksPrompt(lines, transcript, guide);
  try {
    return await groq.chat({
      model: VISION,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageUrl(jpeg) } }] }],
      temperature: 0.2, response_format: { type: 'json_object' }, reasoning_effort: 'none',
    }, k);
  } catch (e) {
    if (!(e instanceof RateLimitedError)) throw e;
    return groq.chat({
      model: REASONING, messages: [{ role: 'user', content: prompt }],
      temperature: 0.2, response_format: { type: 'json_object' }, reasoning_effort: 'low',
    }, k);
  }
}

/** 엄격한 형식으로 한 번 더 묻고, 그래도 형식이 어긋나면 느슨한 JSON 으로 받아 고쳐 쓴다 */
async function visualsCall(groq, prompt, model, k) {
  const body = (p) => {
    const b = visualsBody(p);
    b.model = model;
    if (model === VISION) b.reasoning_effort = 'none'; // qwen 은 low·medium 을 받지 않는다
    return b;
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await groq.chat(body(prompt), k);
    } catch (e) {
      if (!(e instanceof GroqError) || !String(e.message).includes('expected schema')) throw e;
    }
  }
  const loose = body(`${prompt}\nReturn ONE JSON object (not an array) with the keys described above.`);
  loose.response_format = { type: 'json_object' };
  return asVisualsObject(await groq.chat(loose, k));
}

/** 설명 카드: 요약과 그림 0~2개. 120b 가 막히면 한도가 따로인 qwen 으로 */
async function explainVisuals(groq, { lines, transcript, guide = '' }) {
  const k = key(groq);
  const prompt = visualsPrompt(lines, transcript, guide) + GROQ_RULES;
  try {
    return E.dropLineRefs(await visualsCall(groq, prompt, REASONING, k), lines);
  } catch (first) {
    if (!(first instanceof RateLimitedError)) throw first;
    try {
      return E.dropLineRefs(await visualsCall(groq, prompt, VISION, k), lines);
    } catch (second) {
      if (second instanceof RateLimitedError) throw new RateLimitedError(minRetry(first, second));
      throw second;
    }
  }
}

module.exports = {
  AUDIENCE, MARKS_TASK, MARKS_SHAPE, VISUALS_TASK, VISUALS_SHAPE, SCENES_GUIDE, VISUALS_GUIDE, GROQ_RULES, VISUALS_SCHEMA,
  context, questionPrompt, marksPrompt, visualsPrompt, unifiedPrompt, visionBody, visualsBody, asVisualsObject, source,
  fixScript, explainUnified, answer, answerText, explainMarks, explainVisuals,
};
