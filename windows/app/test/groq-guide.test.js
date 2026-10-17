'use strict';
// 처음 안내 창의 Groq 키 발급 애니메이션 — 어두운 테마에서 흰 판이 혼자 튀지 않아야 한다
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'renderer', 'guide');
const css = fs.readFileSync(path.join(dir, 'groq-guide.css'), 'utf8');
const js = fs.readFileSync(path.join(dir, 'groq-guide.js'), 'utf8');

function darkBlock() {
  const at = css.indexOf('@media (prefers-color-scheme: dark)');
  assert.ok(at >= 0, '어두운 테마 블록이 있어야 한다');
  return css.slice(at);
}

test('어두운 테마에서 화면 판·브라우저 머리·대화상자 색을 바꾼다', () => {
  const dark = darkBlock();
  for (const sel of ['.stage', '.browser', '.url', '.top', '.dialog', '.app', '.login', '.field', '.btn', '.appbtn']) {
    assert.match(dark, new RegExp(`\\${sel}[\\s,{]`), `${sel} 가 어두운 테마에서 다시 칠해져야 한다`);
  }
  assert.match(dark, /--ink:\s*#[0-9a-f]{3,6}/i);
  assert.match(dark, /--page:\s*#[0-9a-f]{3,6}/i);
});

test('붙여넣기 칸 글자색은 스크립트에 박지 않고 클래스로 바꾼다', () => {
  assert.doesNotMatch(js, /style\.color\s*=/);
  assert.match(js, /classList\.(toggle|add|remove)\(["']ph["']/);
});
