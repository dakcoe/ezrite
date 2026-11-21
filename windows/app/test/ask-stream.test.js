'use strict';

// 1.3.0 카드 질문의 답 (맥 AskTests 새 시험 이름 그대로): 수식 명령 보호, 닫힌 답 글, 받는 중인 답 글, 스트리밍 조각
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/explain');
const AI = require('../lib/ai');

test('[mac AskTests] 답의_수식_명령은_줄바꿈으로_바꾸지_않는다', () => {
  const json = String.raw`{"answer":"기울기 $\\nabla f$ 를 봅니다.\\n다음 줄","marks":[]}`;
  assert.equal(E.answer(json), '기울기 $\\nabla f$ 를 봅니다.\n다음 줄');
});

test('[mac AskTests] 답_글이_닫혔을_때만_깨진_JSON_대신_쓴다', () => {
  // 뒤쪽이 깨져도 답 글이 닫혔으면 그 글
  assert.equal(E.closedAnswer(String.raw`{"answer":"합성곱은 \"이름\"\n끝","marks":[{"id":3,"note":"x"}],"path":{`), '합성곱은 "이름"\n끝');
  // 답 글이 중간에 잘렸으면 null (다시 묻는다)
  assert.equal(E.closedAnswer(String.raw`{"answer":"합성곱은 \"이름\"이고`), null);
  assert.equal(E.closedAnswer('{"marks":[]'), null);
});

test('[mac AskTests] 다_오지_않은_JSON_에서_답_글을_온_만큼_꺼낸다', () => {
  assert.equal(E.partialAnswer('{"ans'), null);
  assert.equal(E.partialAnswer('{"answer":"'), null);
  assert.equal(E.partialAnswer(String.raw`{"answer": "합성곱은 \"이름\"이고\n$\\nabla`), '합성곱은 "이름"이고\n$\\nabla');
  // 반쯤 온 이스케이프는 그 앞까지
  assert.equal(E.partialAnswer('{"answer":"δ 는 δ, 끝\\'), 'δ 는 δ, 끝');
  assert.equal(E.partialAnswer(String.raw`{"answer":"값 \u03`), '값');
  // 답 글이 끝나면 뒤의 칸은 보지 않는다
  assert.equal(E.partialAnswer(String.raw`${'```'}json\n{"answer":"끝","marks":[{"note":"x`), '끝');
  // 역슬래시를 하나만 쓴 수식 명령은 글자 그대로 둔다
  assert.equal(E.partialAnswer(String.raw`{"answer":"$0\le x$ 와 $\frac{1}{2}$`), String.raw`$0\le x$ 와 $\frac{1}{2}$`);
});

test('[mac AskTests] 스트리밍_조각에서_글과_토큰을_모은다', () => {
  const c = new AI.StreamState('claude');
  assert.equal(c.take({ type: 'message_start', message: { usage: { input_tokens: 100 } } }), false);
  assert.equal(c.take({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '음' } }), false);
  assert.equal(c.take({ type: 'content_block_delta', delta: { type: 'text_delta', text: '{"answer":"안' } }), true);
  assert.equal(c.take({ type: 'content_block_delta', delta: { type: 'text_delta', text: '녕"}' } }), true);
  c.take({ type: 'message_delta', usage: { output_tokens: 20 } });
  assert.equal(c.text, '{"answer":"안녕"}');
  assert.equal(c.tokens, 120);
  assert.throws(() => c.take({ type: 'error', error: { message: 'Overloaded' } }), AI.AIFailure);

  const g = new AI.StreamState('openai');
  assert.equal(g.take({ choices: [{ delta: { content: '가' } }] }), true);
  assert.equal(g.take({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }), false);
  assert.equal(g.text, '가');
  assert.equal(g.tokens, 8);
});

// ── Windows: 실제로 받아 읽기 (가짜 fetch 가 SSE 를 조각조각 보낸다) ──

const sse = (events, { status = 200, split = 7 } = {}) => {
  const text = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
  const bytes = Buffer.from(text);
  const body = new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += split) c.enqueue(bytes.subarray(i, i + split)); // 글자·줄 중간에서 끊긴 조각
      c.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
};

function client(responses, extra = {}) {
  const calls = [];
  const spent = [];
  const costs = [];
  const ai = new AI.AIClient({
    fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return responses.shift(); },
    getKey: () => 'sk-secret', onSpent: (...a) => spent.push(a), onCost: (...a) => costs.push(a), ...extra,
  });
  return { ai, calls, spent, costs };
}

test('스트리밍 요청: stream 을 켜고, GPT 만 include_usage. 설명·질문 한도는 8000', () => {
  assert.equal(AI.EXPLAIN_MAX_TOKENS, 8000);
  const base = { model: 'm', key: 'k', prompt: 'p', json: true, maxTokens: 8000 };
  assert.equal(AI.request('claude', { ...base, stream: true }).body.stream, true);
  assert.equal(AI.request('claude', { ...base, stream: true }).body.stream_options, undefined);
  assert.deepEqual(AI.request('openai', { ...base, stream: true }).body.stream_options, { include_usage: true });
  assert.equal(AI.request('gemini', { ...base, stream: true }).body.stream_options, undefined);
  assert.equal(AI.request('gemini', base).body.stream, undefined, '스트리밍이 아니면 넣지 않는다');
});

test('스트리밍: 받는 대로 지금까지 온 글 전체를 넘기고, 끝나면 JSON 만 꺼내 토큰·비용을 알린다 (Claude)', async () => {
  const { ai, calls, spent, costs } = client([sse([
    { type: 'message_start', message: { usage: { input_tokens: 50 } } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '```json\n{"answer":"안' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '녕하세요"}\n```' } },
    { type: 'message_delta', usage: { output_tokens: 9 } },
    { type: 'message_stop' },
  ])]);
  const seen = [];
  const out = await ai.stream('claude', { model: 'claude-sonnet-5-5', prompt: 'p', json: true, maxTokens: 8000 }, (t) => seen.push(t));
  assert.equal(out, '{"answer":"안녕하세요"}');
  assert.deepEqual(seen, ['```json\n{"answer":"안', '```json\n{"answer":"안녕하세요"}\n```']);
  assert.equal(calls[0].body.stream, true);
  assert.deepEqual(spent, [['claude-sonnet-5-5', 'tokens', 59]]);
  assert.deepEqual(costs, [['claude', 'claude-sonnet-5-5', 50, 9]]);
});

test('스트리밍: OpenAI 꼴은 [DONE] 에서 끝, 마지막 조각의 usage', async () => {
  const { ai, spent } = client([sse([
    { choices: [{ delta: { content: '가' } }] },
    { choices: [{ delta: { content: '나' } }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
    '[DONE]',
    { choices: [{ delta: { content: '안 봄' } }] },
  ])]);
  assert.equal(await ai.stream('openai', { model: 'gpt-6', prompt: 'p', maxTokens: 8000 }), '가나');
  assert.deepEqual(spent, [['gpt-6', 'tokens', 8]]);
});

test('스트리밍 실패: 키 오류는 401, 그 밖은 상태 코드, 중간 오류 조각·끊김은 상태 없이 (→ Groq 로 대신). 키는 글에 남지 않는다', async () => {
  const bad = (status, body) => new Response(body, { status });
  await assert.rejects(client([bad(401, '{}')]).ai.stream('claude', { model: 'm', prompt: 'p', maxTokens: 1 }), (e) => e.status === 401 && /키가 맞지 않습니다/.test(e.message));
  await assert.rejects(client([bad(529, '{"error":{"message":"overloaded sk-secret"}}')]).ai.stream('claude', { model: 'm', prompt: 'p', maxTokens: 1 }),
    (e) => e.status === 529 && e.message === 'Claude 오류 529: overloaded ***');
  await assert.rejects(client([sse([{ choices: [{ delta: { content: '가' } }] }, { error: { message: 'boom' } }])]).ai.stream('gemini', { model: 'm', prompt: 'p', maxTokens: 1 }),
    (e) => e.status === null && e.message === 'Gemini 오류: boom');
  const broken = new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from('data: {"choices":[{"delta":{"content":"가"}}]}\n')); c.error(new Error('reset')); } }), { status: 200 });
  await assert.rejects(client([broken]).ai.stream('openai', { model: 'm', prompt: 'p', maxTokens: 1 }), (e) => e.status === null && /연결 오류/.test(e.message));
  await assert.rejects(new AI.AIClient({ getKey: () => null }).stream('claude', { model: 'm', prompt: 'p', maxTokens: 1 }), (e) => e.status === 401);
});

test('스트리밍: 생각을 끈 Claude 요청이 거절되면 오류가 알려 준 방식으로 한 번 더 (complete 와 같다)', async () => {
  const { ai, calls } = client([
    new Response('{"error":{"message":"thinking type disabled is not supported; use between_tools"}}', { status: 400 }),
    sse([{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }]),
  ]);
  assert.equal(await ai.stream('claude', { model: 'claude-sonnet-5-5', prompt: 'p', maxTokens: 1, think: false }), 'ok');
  assert.deepEqual(calls.map((c) => c.body.thinking), [{ type: 'disabled' }, { type: 'between_tools' }]);
});
