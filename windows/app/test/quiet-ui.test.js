'use strict';
// 조용하면 자동 일시정지(1.1.5)를 실제 앱 흐름에서 본다 (scripts/check-quiet.js, 창은 띄우지 않는다. 가짜 Groq·만든 소리 파일).
// 녹음 소리 길이를 m4a 로 재므로, 빌드한 helper 가 없으면 건너뛴다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const electron = (() => { try { return require('electron'); } catch { return null; } })();
const helper = ['release', 'debug'].map((d) => path.join(__dirname, '..', '..', 'helper', 'target', d, 'ezrite-audio.exe')).some((p) => fs.existsSync(p));

test('47초 소리(말-40초 침묵-말): 쉬는 동안 머리 글·멈춘 시계, 쉰 자리 줄, 줄 시각 = 파일 위치, 끄면 안 쉰다 (1.1.5)', { skip: !electron || !helper, timeout: 150_000 }, () => {
  const r = spawnSync(electron, [path.join(__dirname, '..', 'scripts', 'check-quiet.js')], { encoding: 'utf8', timeout: 140_000 });
  const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('{'));
  assert.ok(line, `결과 없음: ${r.stderr}`);
  const out = JSON.parse(line);
  assert.equal(out.error, undefined, out.error);
  assert.deepEqual([out.toggle?.on, out.toggleOff?.on, out.saved], [true, false, false], '토글은 기본 켜짐, 끄면 settings.json 에도 남는다');
  assert.equal(out.toggle.detail, '말소리가 30초 동안 없으면 잠시 멈추고, 다시 들리면 같은 기록에 이어서 녹음합니다. 쉬는 동안은 녹음 파일에 넣지 않습니다.', '맥과 같은 문구');
  assert.equal(out.on.heads.length, 3);
  assert.match(out.on.heads[0], /^조용함 · 자동 일시정지 \d\d:\d\d$/);
  assert.ok(out.on.heads.every((t) => t === out.on.heads[0]), `쉬는 동안 시계가 멈춘다: ${out.on.heads}`);
  assert.equal(out.on.lines.length, 1);
  assert.match(out.on.lines[0], /^── \d\d:\d\d:\d\d–\d\d:\d\d:\d\d 말소리가 없어 자동 일시정지$/);
  assert.ok(Math.abs(out.on.times[1][0] - 35.5) < 0.4, `켠 쪽 두 번째 줄 ${out.on.times[1][0]}초`);
  assert.ok(Math.abs(out.off.times[1][0] - 43.3) < 0.4, `끈 쪽 두 번째 줄 ${out.off.times[1][0]}초`);
  assert.deepEqual([out.off.heads, out.off.lines], [[], []]);
  for (const x of [out.on, out.off]) assert.ok(x.duration >= x.times[1][1] && x.duration - x.times[1][1] < 4, `m4a ${x.duration}초 / 마지막 줄 끝 ${x.times[1][1]}초`);
  assert.equal(out.ok, true);
});
