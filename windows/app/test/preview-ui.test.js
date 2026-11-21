'use strict';
// 설정의 설명 표시 방식 미리보기를 실제 앱 화면에서 본다 (scripts/check-preview.js, 창은 띄우지 않는다. AI·화면 찍기 없음)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const electron = (() => { try { return require('electron'); } catch { return null; } })();

test('미리보기: 카드 폭에 맞춰 줄고, 슬라이드·표시·카드 자리, 예전 방식은 상자, 지도는 카드 속, 방식을 바꾸면 처음부터, 3.4초마다 다음 장면', { skip: !electron, timeout: 120_000 }, () => {
  const r = spawnSync(electron, [path.join(__dirname, '..', 'scripts', 'check-preview.js')], { encoding: 'utf8', timeout: 110_000 });
  const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('{'));
  assert.ok(line, `결과 없음: ${r.stderr}`);
  const out = JSON.parse(line);
  assert.equal(out.error, undefined, out.error);
  for (const [k, v] of Object.entries(out.checks)) assert.ok(v, `${k}: ${JSON.stringify(out)}`);
  assert.equal(out.ok, true);
});
