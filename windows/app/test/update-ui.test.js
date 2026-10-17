'use strict';
// 실제 앱 화면에서 새 버전 띠를 본다 (scripts/check-update.js, 창은 띄우지 않는다).
// 1.1.3 "설정에 '팝업 위 알림에서 받기' 라는데 띠가 없다" 의 재발 방지: 전체 창 세 화면 모두 맨 위에 띠, 설정에 [받기]
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const electron = (() => { try { return require('electron'); } catch { return null; } })();

test('새 버전 띠: 팝업과 전체 창(실시간·지난 기록·설정) 맨 위, 설정의 [받기], [나중에]·[업데이트 확인] 이 두 창에 함께', { skip: !electron, timeout: 120_000 }, () => {
  const r = spawnSync(electron, [path.join(__dirname, '..', 'scripts', 'check-update.js')], { encoding: 'utf8', timeout: 110_000 });
  const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('{'));
  assert.ok(line, `결과 없음: ${r.stderr}`);
  const out = JSON.parse(line);
  assert.equal(out.error, undefined, out.error);
  assert.equal(out.popup?.title, '새 버전 9.9.9', '팝업');
  for (const p of ['live', 'history', 'settings']) {
    const b = out.pages[p];
    assert.ok(b, `전체 창 ${p} 에 띠가 없음`);
    assert.equal(b.title, '새 버전 9.9.9', p);
    assert.equal(b.first, true, `${p}: 띠가 창 맨 위가 아님`);
    assert.equal(b.top, true, `${p}: 새 버전 띠가 저장됨 띠 위가 아님`);
    assert.deepEqual(b.buttons.filter((x) => x.region === 'drag' || x.covered), [], `${p}: 누를 수 없는 단추`);
  }
  assert.equal(out.version.sub, '새 버전 9.9.9가 있습니다');
  assert.ok(out.version.buttons.includes('받기'), '설정 버전 줄에 [받기]');
  assert.deepEqual(out.opened, ['https://github.com/dakcoe/ezrite/releases/download/v9.9.9/Ezrite-Setup-9.9.9.exe']);
  assert.deepEqual(out.afterSkip, { main: 'gone', popup: 'gone' }, '[나중에] 는 두 창 모두 닫는다');
  assert.deepEqual(out.afterCheck, { main: true, popup: true }, '[업데이트 확인] 은 닫았던 것도 두 창에 다시');
  assert.equal(out.ok, true);
});
