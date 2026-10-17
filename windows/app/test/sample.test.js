'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sample = require('../lib/sample');
const { sessionDate } = require('../renderer/format');

test('미리보기 상태는 맥 스크린샷처럼 기록 4개, 영어, 기본 마이크', () => {
  const s = sample.state();
  assert.equal(s.sample, true);
  assert.equal(s.language, 'English');
  assert.equal(s.sources[0].label, '기본 마이크');
  assert.deepEqual(s.sessions.map((x) => sessionDate(new Date(x.date))), [
    '10월 16일 (금) 16:18', '10월 16일 (금) 16:16', '10월 16일 (금) 16:12', '10월 16일 (금) 14:07',
  ]);
});

test('부를 때마다 새 객체 (상태를 고쳐도 다음 미리보기에 번지지 않게)', () => {
  const a = sample.state();
  a.sessions.pop();
  assert.equal(sample.state().sessions.length, 4);
});
