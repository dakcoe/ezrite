'use strict';
// 팝업 아래 줄의 마우스 올림 글이 실제로 그린 폭으로 칸에 다 들어가는지 (숨긴 팝업에서 잰다: scripts/check-captions.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const electron = (() => { try { return require('electron'); } catch { return null; } })();

test('가장 긴 글(세 자리 횟수·유료 서비스 이름)까지 … 없이 들어가고, 넘치는 글은 85% 까지 줄여 맞춘다', { skip: !electron, timeout: 90_000 }, () => {
  const r = spawnSync(electron, [path.join(__dirname, '..', 'scripts', 'check-captions.js')], { encoding: 'utf8', timeout: 80_000 });
  const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('{'));
  assert.ok(line, `결과 없음: ${r.stderr}`);
  const out = JSON.parse(line);
  for (const c of out.results) assert.ok(c.fits, `${c.caption}: ${c.text}px > ${c.box}px`);
  const long999 = out.results.find((c) => c.caption.includes('999번') && !c.caption.includes('오늘'));
  assert.equal(long999.scale, 1, '세 자리 횟수도 줄이지 않고 들어간다');
  const over = out.results.find((c) => c.caption.includes('오늘 기준'));
  assert.ok(over.scale < 1 && over.scale >= 0.85, `줄인 비율 ${over.scale}`);
  assert.equal(out.ok, true);
});
