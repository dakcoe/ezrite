'use strict';

// 맥 ScriptTests.swift 6개 이식 + 추가
const test = require('node:test');
const assert = require('node:assert/strict');
const Script = require('../lib/script');

test('[mac] 한국어에_섞인_한자_조각만_찾는다', () => {
  assert.deepEqual(Script.foreignRuns('이 과정은 本课程에서 다룬 光合成입니다', ''), ['本课程', '光合成']);
});

test('[mac] 로마자_숫자_기호_그리스문자는_정상이다', () => {
  assert.deepEqual(Script.foreignRuns('TCP 3-way handshake, δ = ŷ − y, λW, √ŝ + ε, 93.6%', ''), []);
});

test('[mac] 원문에_있던_글자는_섞인_것으로_보지_않는다', () => {
  // 화면에 원래 있던 한자·가나는 답에 그대로 나와도 된다
  assert.deepEqual(Script.foreignRuns('슬라이드의 経済 는 경제라는 뜻이에요', '第3章 経済'), []);
});

test('[mac] 키릴_문자도_찾는다', () => {
  assert.deepEqual(Script.foreignRuns('결과는 привет 입니다', ''), ['привет']);
});

test('[mac] 교정표대로_제자리에_끼워_넣는다', () => {
  const fixed = Script.apply('이 과정은 本课程에서 다룬 光合成입니다', '本课程=이 강의\n光合成=광합성\n', ['本课程', '光合成']);
  assert.equal(fixed, '이 과정은 이 강의에서 다룬 광합성입니다');
});

test('[mac] 교정이_빠지거나_또_섞이면_고치지_않는다', () => {
  assert.equal(Script.apply('本课程 光合成', '本课程=이 강의', ['本课程', '光合成']), null);
  assert.equal(Script.apply('本课程', '本课程=本强의', ['本课程']), null);
});

// --- 추가 ---

test('같은 조각은 한 번만, 끝에 붙은 조각도 찾는다', () => {
  assert.deepEqual(Script.foreignRuns('本课 그리고 本课 끝本', ''), ['本课', '本']);
  assert.deepEqual(Script.foreignRuns('', ''), []);
});

test('가나·아랍·히브리·태국·데바나가리도 섞인 것으로 본다', () => {
  assert.deepEqual(Script.foreignRuns('a カナ b عربي c עברית d ไทย e हिन्दी', ''),
    ['カナ', 'عربي', 'עברית', 'ไทย', 'हिन्दी']);
});

test('apply: 긴 조각부터 바꾼다, = 앞뒤 공백은 자르고 = 가 여러 개면 첫 = 로 나눈다', () => {
  assert.equal(Script.apply('本课程 本', '本 = 본\n本课程 = 이 강의', ['本课程', '本']), '이 강의 본');
  assert.equal(Script.apply('光', '光=a=b', ['光']), 'a=b');
  assert.equal(Script.apply('光', '모르는=x\n光=', ['光']), null);
});

test('fixPrompt: 글은 앞 400글자만, 조각은 한 줄에 하나', () => {
  const p = Script.fixPrompt('가'.repeat(500), ['本', '光']);
  assert.ok(p.includes(`글: ${'가'.repeat(400)}\n`));
  assert.ok(!p.includes('가'.repeat(401)));
  assert.ok(p.endsWith('조각:\n本\n光'));
  assert.ok(p.startsWith('다음 한국어 글에 다른 언어 문자가 잘못 섞였다.'));
});

test('fixPrompt: 원문(화면 글자 + 강의 말)도 앞 400글자만 넘기고, 전공 용어는 원문의 영어로 (核=kernel)', () => {
  const p = Script.fixPrompt('커널 核 행렬', ['核'], 'kernel matrix '.repeat(50));
  assert.ok(p.includes('그 용어의 영어가 있으면 그 영어를 그대로 써라 (核=kernel, 特征值=eigenvalue)'));
  const src = p.match(/^원문: (.*)$/m)[1];
  assert.equal(src, 'kernel matrix '.repeat(50).slice(0, 400));
  // 원문 → 글 → 조각 순서
  assert.ok(p.indexOf('원문: ') < p.indexOf('글: ') && p.indexOf('글: ') < p.indexOf('조각:'));
  // 원문을 안 주면 빈 원문 줄
  assert.ok(Script.fixPrompt('가', ['本']).includes('원문: \n'));
});
