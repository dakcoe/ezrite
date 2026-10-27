'use strict';
// 1.2.1 설명 카드의 움직이는 그림·요약 줄바꿈을 실제 카드 창에서 본다 (scripts/check-anim.js, 창은 띄우지 않는다. AI 없음).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const electron = (() => { try { return require('electron'); } catch { return null; } })();

test('움직이는 그림: row·layers·grid·graph 단계, [↻ 다시], 장면 reveal / 요약 문장마다 한 줄 / 긴 답 두 문장씩 (1.2.1)', { skip: !electron, timeout: 120_000 }, () => {
  const r = spawnSync(electron, [path.join(__dirname, '..', 'scripts', 'check-anim.js')], { encoding: 'utf8', timeout: 110_000 });
  const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('{'));
  assert.ok(line, `결과 없음: ${r.stderr}`);
  const out = JSON.parse(line);
  assert.equal(out.error, undefined, out.error);
  for (const [k, v] of Object.entries(out.checks)) assert.ok(v, `${k}: ${JSON.stringify(out[k] ?? out)}`.slice(0, 2000));
  assert.deepEqual(out.summary.map((p) => p[1]), ['정렬은 수를 차례로 놓는 일입니다.', '두 수를 비교해 자리를 바꿉니다!', '0.5 처럼 소수점이 있어도 한 문장이에요?', '마지막 문장.']);
  assert.equal(out.ok, true);
});
