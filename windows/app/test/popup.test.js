'use strict';
// 팝업은 바깥을 눌러도 닫히지 않는다 (맥 StatusBar: 아이콘을 다시 누를 때까지 떠 있다). 강의 창을 누르며 받아쓰기를 봐야 한다
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('팝업: 포커스를 잃어도 숨기지 않는다', () => {
  assert.doesNotMatch(main, /popup\.on\(\s*['"]blur['"]/);
});

test('팝업: 트레이 아이콘은 열기·닫기를 번갈아 한다', () => {
  const body = /function togglePopup\(\) \{([\s\S]*?)\n\}/.exec(main)?.[1] ?? '';
  assert.match(body, /popup\.isVisible\(\)\) popup\.hide\(\)/);
  assert.match(body, /else showPopup\(\)/);
});
