'use strict';
// 1.3.0 설명 표시 방식을 실제 창으로 본다 (scripts/check-markstyle.js, 창은 띄우지 않는다. AI·화면 찍기 없음)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const electron = (() => { try { return require('electron'); } catch { return null; } })();

test('표시 창: 열두 방식이 그려지고 예전 방식은 상자 / 카드: 발자취 목록·색 막대·지도·마우스·글 자리·접기·글자가 적은 자리', { skip: !electron, timeout: 120_000 }, () => {
  const r = spawnSync(electron, [path.join(__dirname, '..', 'scripts', 'check-markstyle.js')], { encoding: 'utf8', timeout: 110_000 });
  const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('{'));
  assert.ok(line, `결과 없음: ${r.stderr}`);
  const out = JSON.parse(line);
  assert.equal(out.error, undefined, out.error);
  for (const [k, v] of Object.entries(out.checks)) assert.ok(v, `${k}: ${JSON.stringify({ overlay: out.overlay, card: out.card })}`);
  assert.equal(out.ok, true);
});
