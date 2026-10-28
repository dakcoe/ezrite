'use strict';
// 1.2.3 팝업 아래 줄의 "이번 실행 AI 비용" (맥 1.2.3). Claude 는 단가표, Groq 는 0, GPT·Gemini 는 모름 → 금액 뒤 "+"
const test = require('node:test');
const assert = require('node:assert/strict');
const { price, CostMeter } = require('../lib/cost');

test('단가 ($/백만 토큰, 입력/출력): 맥과 같은 Claude 표, 먼저 맞는 것', () => {
  assert.deepEqual(price('claude', 'claude-fable-5-1'), { input: 10, output: 50 });
  assert.deepEqual(price('claude', 'claude-opus-5-5'), { input: 4, output: 20 });
  assert.deepEqual(price('claude', 'claude-opus-4-1'), { input: 5, output: 25 });
  assert.deepEqual(price('claude', 'claude-sonnet-5-5'), { input: 2, output: 10 });
  assert.deepEqual(price('claude', 'claude-sonnet-5'), { input: 2, output: 10 });
  assert.deepEqual(price('claude', 'claude-sonnet-4-5'), { input: 3, output: 15 });
  assert.deepEqual(price('claude', 'claude-haiku-5-5'), { input: 0.1, output: 0.5 });
  assert.deepEqual(price('claude', 'claude-haiku-4-5'), { input: 1, output: 5 });
  assert.deepEqual(price('groq', 'qwen/qwen3-32b'), { input: 0, output: 0 });
  assert.equal(price('openai', 'gpt-5.5'), null);
  assert.equal(price('gemini', 'gemini-3-pro'), null);
  assert.equal(price('claude', 'claude-instant-1'), null, '표에 없는 Claude 모델도 모름');
});

test('합계: 쓴 만큼 더하고, 모르는 서비스를 쓰면 "+" — 0 이고 모르는 것도 없으면 숨김(null)', () => {
  const m = new CostMeter();
  assert.equal(m.label(), null);
  m.add('groq', 'whisper-large-v3-turbo', 5000, 100);
  assert.equal(m.label(), null, 'Groq 만 썼으면 숨김');
  m.add('claude', 'claude-sonnet-5-5', 10_000, 1_000); // 0.02 + 0.01
  assert.equal(m.label(), '$0.03');
  m.add('openai', 'gpt-5.5', 1000, 1000);
  assert.equal(m.label(), '$0.03+');
  const u = new CostMeter();
  u.add('gemini', 'gemini-3-flash', 10, 10);
  assert.equal(u.label(), '$0.00+', '모르는 것만 썼어도 보인다');
  const big = new CostMeter();
  big.add('claude', 'claude-opus-5-5', 200_000, 50_000); // 0.8 + 1.0
  assert.equal(big.label(), '$1.80');
});

test('아주 적은 금액은 "<$0.01" (0 으로 보이지 않게)', () => {
  const m = new CostMeter();
  m.add('claude', 'claude-haiku-5-5', 1000, 200); // 0.0001 + 0.0001
  assert.equal(m.label(), '<$0.01');
});

test('마우스를 올리면: 이번 실행 AI 비용 (Claude 요금 기준), 모르는 서비스가 있으면 빠졌다고', () => {
  const m = new CostMeter();
  m.add('claude', 'claude-sonnet-5-5', 10_000, 1_000);
  assert.equal(m.caption(), '이번 실행 AI 비용 (Claude 요금 기준)');
  m.add('gemini', 'gemini-3-pro', 1, 1);
  assert.equal(m.caption(), '이번 실행 AI 비용 (Claude 요금 기준, GPT·Gemini 는 빠짐)');
});

test('잘못된 토큰 수는 0 으로', () => {
  const m = new CostMeter();
  m.add('claude', 'claude-sonnet-5-5', NaN, -5);
  assert.equal(m.label(), null);
});
