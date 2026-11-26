'use strict';
// 1.3.2 앱 기록: 녹음 → 일시정지 → 종료 (맥에서 앱이 굳었던 흐름)를 실제 앱으로 (scripts/check-applog.js, 가짜 Groq, 창은 띄우지 않는다).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const electron = (() => { try { return require('electron'); } catch { return null; } })();

test('앱 기록: 녹음 시작·누른 곳·일시정지·종료 단계가 순서대로 남고, 받아 적은 글은 남지 않는다', { skip: !electron, timeout: 120_000 }, () => {
  const r = spawnSync(electron, [path.join(__dirname, '..', 'scripts', 'check-applog.js')], { encoding: 'utf8', timeout: 110_000 });
  const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('{'));
  assert.ok(line, `결과 없음: ${r.stderr}`);
  const out = JSON.parse(line);
  assert.equal(out.error, undefined, out.error);
  for (const [k, v] of Object.entries(out.checks)) assert.equal(v, true, `${k}: ${JSON.stringify(out.lines)}`);
  assert.equal(out.ok, true);
});
