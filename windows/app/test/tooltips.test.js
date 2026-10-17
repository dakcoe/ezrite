'use strict';
// 단추 풍선 도움말은 짧은 기능 이름만 (맥과 같은 문구). 꾸밈말·설명·괄호는 넣지 않는다
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const R = path.join(__dirname, '..', 'renderer');
const files = ['shared.js', 'popup.js', 'main.js', 'explain/explain.js'].map((f) => path.join(R, f));
const src = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

/** 소스에 글자로 적힌 title 들: title: '…' · .title = … ? '…' : '…' · smallButton(아이콘, '…', …) */
function titles() {
  const out = new Set();
  for (const m of src.matchAll(/title: '([^']*)'/g)) out.add(m[1]);
  for (const m of src.matchAll(/\.title = [^;\n]*/g)) for (const q of m[0].matchAll(/['"]([^'"]+)['"]/g)) out.add(q[1]);
  for (const m of src.matchAll(/EXPLAIN_HELP = '([^']*)'/g)) out.add(m[1]);
  for (const m of src.matchAll(/smallButton\('[^']*', '([^']*)'/g)) out.add(m[1]);
  return out;
}

test('맥과 같은 짧은 이름을 쓴다', () => {
  const t = titles();
  for (const want of ['AI 질문하기', '녹음 시작', '녹음 종료', '일시정지', '이어서 녹음', '설정', '원래 크기로',
    '내보내기', '전체 복사', '탐색기에서 보기', '다시 받아쓰기', '삭제', '듣기', '설정 안내', '문의·신고', '키 삭제',
    '이전 장면', '다음 장면', '재생']) {
    assert.ok(t.has(want), want);
  }
});

test('풍선 도움말에 꾸밈말·설명·괄호가 없고 8자를 넘지 않는다', () => {
  for (const s of titles()) {
    assert.doesNotMatch(s, /[—(]|\s-\s/, s);
    assert.ok([...s].length <= 8, `${s} (${[...s].length}자)`);
  }
});

test('설명해줘 단추 도움말에서 화면 전송 안내를 뺐다 — 같은 안내는 사용 가이드에 남아 있다', () => {
  assert.doesNotMatch(src, /API 키를 발급한 회사/);
  const guide = fs.readFileSync(path.join(R, 'guide', 'guide.html'), 'utf8');
  assert.match(guide, /화면이 AI 서비스\(Groq\)로 전송/);
});
