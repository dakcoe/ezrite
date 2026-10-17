'use strict';

// 맥 UsageTests.swift 4개 + BudgetTests.swift 의 게이지 시험 1개 이식
const test = require('node:test');
const assert = require('node:assert/strict');
const Usage = require('../lib/usage');

test('[mac] 응답_헤더에서_오늘_남은_요청_수를_읽는다', () => {
  const h = new Headers({ 'x-ratelimit-limit-requests': '2000', 'x-ratelimit-remaining-requests': '1974' });
  assert.deepEqual(Usage.read(h), { remaining: 1974, limit: 2000 });
});

test('[mac] 한도_헤더가_없으면_모른다', () => {
  assert.equal(Usage.read(new Headers()), null);
});

test('[mac] 번갈아_쓰는_모델들은_한도를_합쳐서_남은_비율을_낸다', () => {
  assert.equal(Usage.fraction([{ remaining: 1500, limit: 2000 }, { remaining: 500, limit: 2000 }]), 0.5);
  assert.equal(Usage.fraction([null, { remaining: 900, limit: 1000 }]), 0.9); // 아직 모르는 모델은 빼고
  assert.equal(Usage.fraction([null, null]), null);
});

test('[mac] 절반_아래는_노랑_십분의_일_아래는_빨강', () => {
  assert.equal(Usage.level(0.8), 'plenty');
  assert.equal(Usage.level(0.5), 'plenty');
  assert.equal(Usage.level(0.49), 'half');
  assert.equal(Usage.level(0.1), 'half');
  assert.equal(Usage.level(0.09), 'low');
});

test('[mac BudgetTests] 게이지는_호출_횟수와_양_중_덜_남은_쪽을_따른다', () => {
  assert.equal(Usage.combined(0.9, 0.3), 0.3);
  assert.equal(Usage.combined(null, 0.7), 0.7);
  assert.equal(Usage.combined(0.4, null), 0.4);
  assert.equal(Usage.combined(null, null), null);
});

// --- 추가 ---

test('헤더가 정수가 아니거나 하나만 있으면 모른다 (Swift Int.init 처럼 엄격하게)', () => {
  const h = (r, l) => new Headers({ 'x-ratelimit-remaining-requests': r, 'x-ratelimit-limit-requests': l });
  assert.equal(Usage.read(h('12.5', '100')), null);
  assert.equal(Usage.read(h('abc', '100')), null);
  // HTTP 헤더 값 앞뒤 공백은 Headers 가 이미 잘라 준다 (URLSession 도 같다). 일반 객체로 오면 정수가 아니다
  assert.equal(Usage.read({ 'x-ratelimit-remaining-requests': ' 12', 'x-ratelimit-limit-requests': '100' }), null);
  assert.equal(Usage.read(h('', '100')), null);
  assert.deepEqual(Usage.read(h('+12', '100')), { remaining: 12, limit: 100 });
  assert.equal(Usage.read(new Headers({ 'x-ratelimit-limit-requests': '100' })), null);
  assert.equal(Usage.read(null), null);
});

test('일반 객체 헤더(소문자 키)도 읽는다', () => {
  assert.deepEqual(Usage.read({ 'x-ratelimit-remaining-requests': '1', 'x-ratelimit-limit-requests': '2' }),
    { remaining: 1, limit: 2 });
});

test('한도 합이 0 이면 모른다', () => {
  assert.equal(Usage.fraction([{ remaining: 0, limit: 0 }]), null);
  assert.equal(Usage.fraction([]), null);
});
