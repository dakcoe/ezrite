'use strict';

// 번역·화면 설명을 유료 서비스로 돌리면 하루 한도 막대 대신 서비스 이름 (맥 UsageFooter.paid).
// 남은 횟수(설명·질문)는 화면 설명이 Groq 일 때만
const test = require('node:test');
const assert = require('node:assert/strict');
const Usage = require('../lib/usage');
const { Budget } = require('../lib/budget');
const { usageFooter } = require('../lib/live');

test('유료 서비스로 돌린 기능은 막대 값 대신 서비스 이름', () => {
  const f = Usage.footer({}, new Budget(), Date.now(), { translate: 'claude', explain: 'gemini' });
  assert.equal(f.translate, 'Claude');
  assert.equal(f.explain, 'Gemini');
  assert.equal(typeof f.audio, 'number'); // 받아쓰기는 늘 Groq
  assert.equal(f.uses, undefined); // 설명이 Groq 가 아니면 남은 횟수를 보이지 않는다
});

test('Groq 이거나 지정이 없으면 예전처럼 막대와 남은 횟수', () => {
  for (const paid of [undefined, { translate: 'groq', explain: 'groq' }]) {
    const f = Usage.footer({}, new Budget(), Date.now(), paid);
    assert.equal(typeof f.translate, 'number');
    assert.equal(typeof f.explain, 'number');
    assert.match(f.uses, /^설명 \d+ · 질문 \d+$/);
  }
});

test('번역만 GPT: 번역은 이름, 화면 설명은 막대와 남은 횟수', () => {
  const f = usageFooter({}, new Budget(), Date.now(), { translate: 'openai', explain: 'groq' });
  assert.equal(f.translate, 'GPT');
  assert.equal(typeof f.explain, 'number');
  assert.ok(f.uses);
});
