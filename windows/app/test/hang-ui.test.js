'use strict';
// 1.3.2 멈춤 감시를 실제 앱으로 본다 (scripts/check-hang.js, EZRITE_SCRIPT=hang@4=5,uihang@12=5, 창은 띄우지 않는다).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const electron = (() => { try { return require('electron'); } catch { return null; } })();

test('멈춤 감시: 메인·팝업 화면이 3초 넘게 굳으면 WARN, 풀리면 걸린 시간, hang-시각.txt 에 멈춘 자리, 종료 단계까지 기록', { skip: !electron, timeout: 120_000 }, () => {
  const r = spawnSync(electron, [path.join(__dirname, '..', 'scripts', 'check-hang.js')], { encoding: 'utf8', timeout: 110_000 });
  const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('{'));
  assert.ok(line, `결과 없음: ${r.stderr}`);
  const out = JSON.parse(line);
  assert.equal(out.error, undefined, out.error);
  for (const [k, v] of Object.entries(out.checks)) assert.equal(v, true, `${k}: ${JSON.stringify(out.sample)} ${JSON.stringify(out.mainStack)}`);
  assert.equal(out.ok, true);
});
