'use strict';
// 처음 안내 창 (맥 OnboardingView): 첫 녹음 단계 끝에 화면 전송 안내 한 문장
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'onboarding.js'), 'utf8');

test('첫 녹음 단계 설명이 화면 전송 안내로 끝난다', () => {
  const m = /step\(3, false, '첫 녹음',\s*'([^']*)'/.exec(src);
  assert.ok(m, '첫 녹음 단계');
  assert.ok(m[1].endsWith(' ✨ 를 누르면 그 순간 화면이 AI 서비스로 전송됩니다.'), m[1]);
});
