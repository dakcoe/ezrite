'use strict';
// 1.3.0 설명 카드 질문을 실제 창으로 본다 (scripts/check-ask.js, 창은 띄우지 않는다. AI 없음)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const electron = (() => { try { return require('electron'); } catch { return null; } })();

test('카드 질문: 받는 중인 답은 0.08초마다, 다 받은 답이 바꿔 끼움, 넓은 수식 70%, 질문 칸을 누를 때만 포커스, 누르면 앞으로', { skip: !electron, timeout: 120_000 }, () => {
  const r = spawnSync(electron, [path.join(__dirname, '..', 'scripts', 'check-ask.js')], { encoding: 'utf8', timeout: 110_000 });
  const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('{'));
  assert.ok(line, `결과 없음: ${r.stderr}`);
  const out = JSON.parse(line);
  assert.equal(out.error, undefined, out.error);
  for (const [k, v] of Object.entries(out.checks)) assert.ok(v, `${k}: ${JSON.stringify(out)}`);
  assert.equal(out.ok, true);
});
