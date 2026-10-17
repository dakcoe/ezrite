'use strict';

// 설정에서 고른 서비스로 옮긴다. 실패하면(키 오류 제외) Groq 로 대신한다 (맥 Transcriber.swift Translation.run)
const test = require('node:test');
const assert = require('node:assert/strict');
const { translate } = require('../lib/translation');
const { AIFailure } = require('../lib/ai');
const { GroqClient } = require('../lib/groq');

function fakes({ aiOut = null, aiError = null } = {}) {
  const log = { groq: [], ai: [], notices: [] };
  const groq = { translate: async (lines, context) => { log.groq.push({ lines, context }); return lines.map((l) => `G:${l}`); } };
  const ai = {
    complete: async (p, opts) => {
      log.ai.push({ p, opts });
      if (aiError) throw aiError;
      return aiOut;
    },
  };
  return { groq, ai, log, onNotice: (m) => log.notices.push(m) };
}

test('Groq 이거나 모델이 비어 있으면 Groq 번역을 그대로 쓴다', async () => {
  for (const [provider, model] of [['groq', ''], ['groq', 'x'], ['claude', '']]) {
    const f = fakes();
    assert.deepEqual(await translate(['a'], [], { provider, model, ...f }), ['G:a']);
    assert.equal(f.log.ai.length, 0);
  }
});

test('다른 서비스: 맥과 같은 프롬프트·한도·생각 끔으로 묻고 번호 줄을 읽는다', async () => {
  const f = fakes({ aiOut: '1. 하나\n2. 둘' });
  const out = await translate(['one', 'two'], ['before'], { provider: 'claude', model: 'claude-haiku-5-5', ...f });
  assert.deepEqual(out, ['하나', '둘']);
  const { p, opts } = f.log.ai[0];
  assert.equal(p, 'claude');
  assert.deepEqual(opts, {
    model: 'claude-haiku-5-5',
    prompt: `${GroqClient.TRANSLATE_PROMPT}\n\nPrevious (do not translate): before\n1. one\n2. two`,
    json: false, maxTokens: 2000, think: false,
  });
  assert.equal(f.log.groq.length, 0);
});

test('앞줄까지 옮겨 번호가 하나 밀리면 첫 줄을 버린다 (Groq 와 같은 읽기)', async () => {
  const f = fakes({ aiOut: '1. 앞\n2. 하나\n3. 둘' });
  assert.deepEqual(await translate(['one', 'two'], ['before'], { provider: 'gemini', model: 'gemini-3.8-flash', ...f }), ['하나', '둘']);
});

test('키 오류가 아닌 실패(429·500·응답 없음)는 알리고 Groq 로 대신한다', async () => {
  for (const status of [429, 500, null]) {
    const f = fakes({ aiError: new AIFailure(status, 'x') });
    assert.deepEqual(await translate(['a'], ['c'], { provider: 'openai', model: 'gpt-5-luna', ...f }), ['G:a']);
    assert.deepEqual(f.log.notices, ['GPT 번역 실패 → Groq 로 대신했습니다']);
    assert.deepEqual(f.log.groq, [{ lines: ['a'], context: ['c'] }]);
  }
});

test('키 오류(401·403)는 Groq 로 대신하지 않고 그대로 던진다', async () => {
  for (const status of [401, 403]) {
    const f = fakes({ aiError: new AIFailure(status, 'Claude API 키가 맞지 않습니다. 설정에서 다시 확인하세요.') });
    await assert.rejects(translate(['a'], [], { provider: 'claude', model: 'm', ...f }), /키가 맞지 않습니다/);
    assert.equal(f.log.groq.length, 0);
  }
});
