'use strict';

// AIClient: 보내기·키 확인·모델 고르기 (맥 AI.complete·models·check·firstWorking). 네트워크 대신 가짜 fetch
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AIClient, AIFailure } = require('../lib/ai');

const FIX = path.join(__dirname, '..', '..', 'fixtures', 'mac-providers');
const KEYS = { claude: 'sk-ant-TESTkey123', gemini: 'AIzaTESTkey456', openai: 'sk-TESTkey789', groq: 'gsk_TESTkey000' };

const respond = (status, body) => ({ status, arrayBuffer: async () => Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });

function client(handler, opts = {}) {
  const calls = [];
  const spent = [];
  const c = new AIClient({
    fetch: async (url, init) => {
      calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
      return handler(url, init, calls.length);
    },
    getKey: (p) => (opts.noKey ? null : KEYS[p]),
    onSpent: (...a) => spent.push(a),
    ...opts,
  });
  return { c, calls, spent };
}

test('complete: Claude 실제 응답(설명)을 코드블록 벗긴 JSON 으로, 쓴 토큰을 알린다', async () => {
  const raw = JSON.parse(fs.readFileSync(path.join(FIX, 'response-claude-explain-200.json'), 'utf8'));
  const { c, calls, spent } = client(() => respond(200, raw));
  const out = await c.complete('claude', { model: 'claude-sonnet-5-5', prompt: 'p', image: Buffer.from([1]), json: true, maxTokens: 3000 });
  assert.equal(out, fs.readFileSync(path.join(FIX, 'parsed-claude-explain.txt'), 'utf8').replace(/\r\n/g, '\n'));
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].init.headers['x-api-key'], KEYS.claude);
  assert.deepEqual(spent, [['claude-sonnet-5-5', 'tokens', raw.usage.input_tokens + raw.usage.output_tokens]]);
});

test('complete: json 이 아니면 받은 글 그대로 (번역)', async () => {
  const { c } = client(() => respond(200, { choices: [{ message: { content: '1. 안녕' } }], usage: { total_tokens: 3 } }));
  assert.equal(await c.complete('openai', { model: 'gpt-5-luna', prompt: 'p', maxTokens: 2000, think: false }), '1. 안녕');
});

test('complete: 키가 없으면 401 실패 (Groq 로 대신하지 않는다)', async () => {
  const { c, calls } = client(() => respond(200, {}), { noKey: true });
  await assert.rejects(c.complete('gemini', { model: 'm', prompt: 'p', maxTokens: 9 }),
    (e) => e instanceof AIFailure && e.status === 401 && e.message === 'Gemini API 키가 없습니다. 설정에서 키를 입력하세요.');
  assert.equal(calls.length, 0);
});

test('complete: 틀린 키(401, Gemini 400 + "API key")는 키 오류, 메시지에 키가 없다', async () => {
  const bad = fs.readFileSync(path.join(FIX, 'response-claude-badkey-401.json'), 'utf8');
  const a = client(() => respond(401, bad));
  await assert.rejects(a.c.complete('claude', { model: 'm', prompt: 'p', maxTokens: 9 }),
    (e) => e.status === 401 && e.message === 'Claude API 키가 맞지 않습니다. 설정에서 다시 확인하세요.');
  const g = client(() => respond(400, { error: { code: 400, message: 'Please pass a valid API key' } }));
  await assert.rejects(g.c.complete('gemini', { model: 'm', prompt: 'p', maxTokens: 9 }), (e) => e.status === 401);
});

test('complete: 그 밖의 오류는 상태 코드와 설명. 응답에 키가 섞여 와도 가린다', async () => {
  const { c } = client(() => respond(500, { error: { message: `boom with ${KEYS.openai}` } }));
  await assert.rejects(c.complete('openai', { model: 'm', prompt: 'p', maxTokens: 9 }), (e) => {
    assert.equal(e.status, 500);
    assert.equal(e.message, 'GPT 오류 500: boom with ***');
    assert.ok(!e.message.includes(KEYS.openai));
    return true;
  });
});

test('complete: 응답이 없으면(시간 초과·네트워크) 상태 없이 실패 → Groq 로 대신한다', async () => {
  const { c } = client(() => { throw new Error(`connect ECONNRESET ${KEYS.claude}`); });
  await assert.rejects(c.complete('claude', { model: 'm', prompt: 'p', maxTokens: 9 }), (e) => {
    assert.equal(e.status, null);
    assert.equal(e.message, 'Claude 가 60초 동안 응답하지 않았습니다');
    return true;
  });
});

test('complete: 전체 시간 제한(60초)을 fetch 에 건다', async () => {
  let signal;
  const c = new AIClient({ fetch: async (u, init) => { signal = init.signal; return respond(200, { choices: [{ message: { content: 'x' } }] }); }, getKey: () => 'k' });
  await c.complete('gemini', { model: 'm', prompt: 'p', maxTokens: 9 });
  assert.ok(signal instanceof AbortSignal);
  assert.equal(c.requestMs, 60_000);
  assert.equal(c.checkMs, 15_000);
});

test('models: Claude 실제 목록을 이름순으로, Gemini 는 models/ 를 떼고, 헤더는 서비스마다', async () => {
  const raw = fs.readFileSync(path.join(FIX, 'response-claude-models.json'), 'utf8');
  const a = client(() => respond(200, raw));
  const list = await a.c.models('claude');
  assert.ok(list.includes('claude-sonnet-5-5'));
  assert.deepEqual(list, [...list].sort());
  assert.equal(a.calls[0].url, 'https://api.anthropic.com/v1/models?limit=100');
  assert.equal(a.calls[0].init.method, 'GET');
  assert.equal(a.calls[0].init.headers['anthropic-version'], '2023-06-01');

  const g = client(() => respond(200, { data: [{ id: 'models/gemini-3.8-flash' }, { id: 'models/gemini-2.5-pro' }] }));
  assert.deepEqual(await g.c.models('gemini'), ['gemini-2.5-pro', 'gemini-3.8-flash']);
  assert.equal(g.calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/openai/models');
  assert.equal(g.calls[0].init.headers.Authorization, `Bearer ${KEYS.gemini}`);

  const q = client(() => respond(200, { data: [{ id: 'whisper-large-v3' }] }));
  await q.c.models('groq');
  assert.equal(q.calls[0].url, 'https://api.groq.com/openai/v1/models');
});

test('models: 틀린 키는 "키가 맞지 않습니다"(401), 그 밖은 "확인 실패 (코드)"', async () => {
  await assert.rejects(client(() => respond(401, '{}')).c.models('openai'), (e) => e.status === 401 && e.message === '키가 맞지 않습니다');
  await assert.rejects(client(() => respond(400, '{"error":{"message":"API key not valid"}}')).c.models('gemini'), (e) => e.message === '키가 맞지 않습니다');
  await assert.rejects(client(() => respond(503, 'x')).c.models('claude'), (e) => e.status === 503 && e.message === '확인 실패 (503)');
  await assert.rejects(client(() => respond(200, {}), { noKey: true }).c.models('claude'), (e) => e.message === '키가 없습니다');
});

test('check: 되면 null, 안 되면 "코드 설명", 응답이 없으면 "15초 동안 응답 없음"', async () => {
  const ok = client(() => respond(200, { content: [{ type: 'text', text: 'OK' }] }));
  assert.equal(await ok.c.check('claude', 'claude-haiku-5-5'), null);
  assert.equal(ok.calls[0].body.thinking.type, 'disabled');
  assert.equal(ok.calls[0].body.max_tokens, 16);
  assert.equal(await client(() => respond(404, { error: { message: 'model not found' } })).c.check('openai', 'x'), '404 model not found');
  assert.equal(await client(() => { throw new Error('timeout'); }).c.check('gemini', 'x'), '15초 동안 응답 없음');
  assert.equal(await client(() => respond(200, {}), { noKey: true }).c.check('gemini', 'x'), '키가 없습니다');
});

test('firstWorking: 순위대로 최대 4개 불러 보고 처음 답하는 모델', async () => {
  const models = ['gemini-3.8-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  const { c, calls } = client((url, init, n) => (n < 3 ? respond(429, { error: { message: 'quota' } }) : respond(200, { choices: [] })));
  assert.deepEqual(await c.firstWorking('gemini', models, 'translate'), { model: 'gemini-2.5-flash', reason: null });
  assert.deepEqual(calls.map((x) => x.body.model), ['gemini-3.8-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash']);

  const none = client(() => respond(429, { error: { message: 'quota' } }));
  assert.deepEqual(await none.c.firstWorking('gemini', models, 'translate'), { model: null, reason: '429 quota' });
  assert.equal(none.calls.length, 4);
  assert.deepEqual(await none.c.firstWorking('gemini', ['nano-banana'], 'translate'), { model: null, reason: '맞는 모델이 없습니다' });
});
