'use strict';
// 실제로 녹음해서 기록·저장됨 띠·녹음 듣기를 본다 (scripts/check-records.js, 창은 띄우지 않는다. 가짜 Groq·만든 소리 파일).
// m4a 로 바꾸는 데 helper 가 필요해서, 빌드한 helper 가 없으면 건너뛴다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const electron = (() => { try { return require('electron'); } catch { return null; } })();
const helper = ['release', 'debug'].map((d) => path.join(__dirname, '..', '..', 'helper', 'target', d, 'ezrite-audio.exe')).some((p) => fs.existsSync(p));

test('녹음 → 기록 폴더 · 저장됨 띠 · [기록 보기] 로 띠 내림 · m4a 전에 열어도 다 되면 재생 (1.1.4)', { skip: !electron || !helper, timeout: 150_000 }, () => {
  const r = spawnSync(electron, [path.join(__dirname, '..', 'scripts', 'check-records.js')], { encoding: 'utf8', timeout: 140_000 });
  const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('{'));
  assert.ok(line, `결과 없음: ${r.stderr}`);
  const out = JSON.parse(line);
  assert.equal(out.error, undefined, out.error);
  assert.equal(out.popupBanner?.text, '녹음 기록 저장됨');
  assert.deepEqual(out.bannerAfterOpen, { popup: null, main: null }, '[기록 보기] 를 누르면 두 창 모두 띠를 내린다');
  assert.equal(out.m4aAtOpen, false, 'm4a 를 만들기 전에 열어 본다');
  assert.doesNotMatch(out.player.duration ?? '0:00', /^0?0:00$/, 'm4a 가 생기면 플레이어가 다시 열린다');
  assert.ok(out.player.linePlays > 0, '줄마다 ▶');
  assert.equal(out.play.ok, true);
  assert.deepEqual(out.escape, ['blocked', 'blocked', 'blocked'], '저장 폴더 밖은 읽지 못한다');
  assert.equal(out.bannerAfterRename, null, '내린 띠는 이름을 바꿔도 다시 뜨지 않는다');
  assert.equal(out.ok, true);
});
