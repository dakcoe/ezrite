'use strict';
// 실제 앱 화면에서 새 버전 띠를 본다 (scripts/check-update.js, 창은 띄우지 않는다).
// 1.1.3 "설정에 '팝업 위 알림에서 받기' 라는데 띠가 없다" 의 재발 방지: 전체 창 세 화면 모두 맨 위에 띠, 설정에 [업데이트].
// 1.2.4 앱 안 업데이트: [업데이트] 가 실패하면 오류 한 줄과 [브라우저로 받기]
// 1.3.2 띠는 창을 늘리지 않고 내용 위에 겹쳐 뜬다 (위 8·좌우 8, 두 띠 사이 6)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const electron = (() => { try { return require('electron'); } catch { return null; } })();

test('새 버전 띠: 팝업과 전체 창(실시간·지난 기록·설정) 맨 위, 설정의 [업데이트], 실패하면 [브라우저로 받기], [나중에]·[업데이트 확인] 이 두 창에 함께', { skip: !electron, timeout: 120_000 }, () => {
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
  assert.ok(out.version.buttons.includes('업데이트'), '설정 버전 줄에 [업데이트]');
  assert.equal(out.installError, '새 버전을 받지 못했어요', '[업데이트] 실패는 띠에 맥 문구 한 줄');
  assert.deepEqual(out.fetched, ['https://github.com/dakcoe/ezrite/releases/download/v9.9.9/Ezrite-Setup-9.9.9.exe'], '앱이 직접 받으려 한 주소');
  assert.deepEqual(out.opened, ['https://github.com/dakcoe/ezrite/releases/download/v9.9.9/Ezrite-Setup-9.9.9.exe']);
  assert.deepEqual(out.afterSkip, { main: 'gone', popup: 'gone' }, '[나중에] 는 두 창 모두 닫는다');
  assert.deepEqual(out.afterCheck, { main: true, popup: true }, '[업데이트 확인] 은 닫았던 것도 두 창에 다시');
  // 1.3.2: 띠는 창 안 내용 위에 겹쳐 뜬다 (창이 커지지 않는다)
  for (const b of [out.popup, ...Object.values(out.pages)]) {
    assert.deepEqual(b.overlay, { position: 'absolute', top: 8, left: 8, right: 8, nextTop: 0, radius: '10px', shadow: true, titleOneLine: true }, '띠 겹치기');
  }
  assert.deepEqual(out.popupSize, out.popupSizeNoBanner, '띠가 있어도 팝업 크기는 그대로');
  assert.deepEqual(out.gap, { gap: 6, left: 8 }, '두 띠 사이 6');
  assert.equal(out.ok, true);
});
