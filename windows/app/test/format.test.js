'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionDate, clock, waveHeights, sourceLine, atBottom, usageCaption, playClock } = require('../renderer/format');

test('기록 날짜는 "10월 16일 (금) 16:18" 꼴', () => {
  assert.equal(sessionDate(new Date(2026, 9, 16, 16, 18)), '10월 16일 (금) 16:18');
  assert.equal(sessionDate(new Date(2026, 0, 4, 9, 5)), '1월 4일 (일) 09:05');
});

test('녹음 시간은 한 시간 전까지 mm:ss, 넘으면 h:mm:ss', () => {
  assert.equal(clock(0), '00:00');
  assert.equal(clock(65.9), '01:05');
  assert.equal(clock(3599), '59:59');
  assert.equal(clock(3600), '1:00:00');
  assert.equal(clock(3725), '1:02:05');
});

test('음수·NaN 시간은 0으로', () => {
  assert.equal(clock(-5), '00:00');
  assert.equal(clock(Number.NaN), '00:00');
});

test('파형 막대: 5개, 소리가 없으면 3px, 커도 14px을 넘지 않는다', () => {
  const quiet = waveHeights(0, 1.23);
  assert.equal(quiet.length, 5);
  assert.ok(quiet.every((h) => h === 3));
  const loud = waveHeights(1, 1.23);
  assert.ok(loud.every((h) => h >= 3 && h <= 14));
  assert.ok(loud.some((h) => h > 3));
});

test('파형 막대: 잘못된 값은 조용한 것으로', () => {
  assert.ok(waveHeights(Number.NaN, 0).every((h) => h === 3));
  assert.ok(waveHeights(-1, 0).every((h) => h === 3));
});

test('머리 둘째 줄: "출처 · 언어", 알림이 있으면 알림', () => {
  assert.equal(sourceLine({ sourceLabel: '기본 마이크', language: 'English' }), '기본 마이크 · English');
  assert.equal(sourceLine({ sourceLabel: '', language: '한국어' }), '소리 출처 없음 · 한국어');
  assert.equal(sourceLine({ sourceLabel: 'chrome', language: 'English', notice: '받기 멈춤' }), '받기 멈춤');
});

test('자동 스크롤: 맨 아래(여유 24px 안)일 때만 새 줄을 따라간다', () => {
  assert.equal(atBottom({ scrollTop: 0, clientHeight: 300, scrollHeight: 300 }), true); // 넘치지 않음
  assert.equal(atBottom({ scrollTop: 700, clientHeight: 300, scrollHeight: 1000 }), true);
  assert.equal(atBottom({ scrollTop: 680, clientHeight: 300, scrollHeight: 1000 }), true);
  assert.equal(atBottom({ scrollTop: 600, clientHeight: 300, scrollHeight: 1000 }), false); // 위로 올려 읽는 중
});

test('게이지 설명 글 (맥 UsageFooter 와 같은 꼴)', () => {
  assert.equal(usageCaption('받아쓰기', 0.875, 2), '받아쓰기 남은 한도 88% (호출 88%, 모델 2개 합산)');
  assert.equal(usageCaption('화면 설명', 0.5, 1), '화면 설명 남은 한도 50% (호출 50%)');
  assert.equal(usageCaption('번역', null, 2), '번역 남은 한도 — 아직 모름 (한 번 쓰면 보입니다)');
});

test('재생 막대 시각은 맥 PlayerBar 처럼 m:ss, 한 시간 넘으면 h:mm:ss', () => {
  assert.equal(playClock(0), '0:00');
  assert.equal(playClock(65.9), '1:05');
  assert.equal(playClock(3725), '1:02:05');
  assert.equal(playClock(Number.NaN), '0:00');
});
