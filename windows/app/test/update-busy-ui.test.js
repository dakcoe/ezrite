'use strict';
// 1.2.4 앱 안 업데이트: 녹음 중에는 [업데이트] 가 설치하지 않고 기다리라고 한다 (scripts/check-update-busy.js, 창은 띄우지 않는다).
// 녹음을 끝내고 m4a 로 바꾼 뒤에는 설치 파일을 --updated /S --force-run 으로 띄우고 앱을 끝낸다 (실행·끝내기는 가로채 적기만)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const electron = (() => { try { return require('electron'); } catch { return null; } })();

test('앱 안 업데이트: 녹음 중엔 막고 "녹음이 끝나면 업데이트할 수 있어요", 끝난 뒤엔 설치를 띄우고 앱을 끝낸다', { skip: !electron, timeout: 150_000 }, () => {
  const r = spawnSync(electron, [path.join(__dirname, '..', 'scripts', 'check-update-busy.js')], { encoding: 'utf8', timeout: 140_000 });
  const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('{'));
  assert.ok(line, `결과 없음: ${r.stderr}`);
  const out = JSON.parse(line);
  assert.equal(out.error, undefined, out.error);
  assert.deepEqual(out.banner.buttons.map((b) => b.text), ['나중에', '업데이트']);
  assert.ok(out.whileRecording, '녹음 중 [업데이트] → 기다리라는 글');
  assert.equal(out.launchedWhileRecording, 0, '녹음 중엔 설치를 띄우지 않는다');
  assert.equal(out.quitsWhileRecording, 0, '녹음 중엔 앱을 끄지 않는다');
  assert.ok(out.encoded, '녹음을 끝내고 m4a 로 바꿨다');
  assert.deepEqual(out.launched.args, ['--updated', '/S', '--force-run']);
  assert.equal(out.quits, 1);
  assert.equal(out.ok, true);
});
