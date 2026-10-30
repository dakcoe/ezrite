'use strict';
// 1.2.4 움직이는 그림 줄바꿈 (맥 explain.html 과 같다): 가장 좁은 설명 카드(320)에서 row 6개·layers 5층이
// 한 자씩 꺾이지 않는다 (scripts/check-anim-narrow.js, 창은 띄우지 않는다. AI 없음)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const electron = (() => { try { return require('electron'); } catch { return null; } })();

test('좁은 카드: row 는 여러 줄로, layers 는 층마다 한 줄로, 상자 폭은 모두 84px 이상, 선은 곡선, 넘치지 않는다', { skip: !electron, timeout: 120_000 }, () => {
  const r = spawnSync(electron, [path.join(__dirname, '..', 'scripts', 'check-anim-narrow.js')], { encoding: 'utf8', timeout: 110_000 });
  const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('{'));
  assert.ok(line, `결과 없음: ${r.stderr}`);
  const out = JSON.parse(line);
  assert.equal(out.error, undefined, out.error);
  for (const [k, v] of Object.entries(out.checks)) assert.ok(v, k);
  assert.equal(out.ok, true);
});
