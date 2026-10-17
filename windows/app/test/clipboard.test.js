'use strict';

// Electron 44 부터 clipboard.writeText 가 Promise 를 돌려준다. 복사가 끝난 뒤에만 "복사함"을 알리고,
// 실패하면 처리되지 않은 rejection 대신 안내 문구를 돌려줘야 한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const { copyText } = require('../lib/ui');

test('copyText: writeText 가 끝난 뒤에 "전체 복사함" 을 돌려준다', async () => {
  let done = false;
  const clip = { writeText: (t) => new Promise((r) => setTimeout(() => { done = t === '내용'; r(); }, 5)) };
  const msg = await copyText(clip, '내용');
  assert.equal(done, true);
  assert.equal(msg, '전체 복사함');
});

test('copyText: Promise 가 거부되면 실패 안내를 돌려준다 (던지지 않는다)', async () => {
  const clip = { writeText: () => Promise.reject(new Error('잠김')) };
  assert.equal(await copyText(clip, 'x'), '복사하지 못했습니다: 잠김');
});

test('copyText: 동기로 던져도 실패 안내를 돌려준다', async () => {
  const clip = { writeText: () => { throw new Error('없음'); } };
  assert.equal(await copyText(clip, 'x'), '복사하지 못했습니다: 없음');
});

test('copyText: 예전처럼 값을 바로 돌려주는 writeText 도 받아들인다', async () => {
  const clip = { writeText: () => undefined };
  assert.equal(await copyText(clip, 'x'), '전체 복사함');
});
