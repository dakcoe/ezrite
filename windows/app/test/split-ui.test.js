'use strict';
// 1.2.1 설명할 때 화면 나누기를 실제 창으로 본다 (scripts/check-split.js). 시험용 창 둘(보이지 않고 클릭·포커스를 가져가지 않음)만
// 옮긴다 — 사용자의 다른 창은 건드리지 않는다 (EZRITE_DOCK_ONLY). 창 자리는 helper 로 읽으므로 빌드한 helper 가 없으면 건너뛴다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const electron = (() => { try { return require('electron'); } catch { return null; } })();
const helper = ['release', 'debug'].map((d) => path.join(__dirname, '..', '..', 'helper', 'target', d, 'ezrite-audio.exe')).some((p) => fs.existsSync(p));

test('화면 나누기: 보통 창·최대화한 창이 계획대로 줄고 카드는 오른쪽 기둥, 카드를 닫으면 자리·최대화·겹침 순서까지 원래대로 (1.2.1)', { skip: !electron || !helper, timeout: 120_000 }, () => {
  const r = spawnSync(electron, [path.join(__dirname, '..', 'scripts', 'check-split.js')], { encoding: 'utf8', timeout: 110_000 });
  const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('{'));
  assert.ok(line, `결과 없음: ${r.stderr}`);
  const out = JSON.parse(line);
  assert.equal(out.error, undefined, out.error);
  for (const [k, v] of Object.entries(out.checks)) {
    assert.ok(v, `${k}: ${JSON.stringify({ before: out.before, want: out.want, docked: out.docked, restored: out.restored, card: out.card, cardWant: out.cardWant })}`);
  }
  assert.equal(out.ok, true);
});
