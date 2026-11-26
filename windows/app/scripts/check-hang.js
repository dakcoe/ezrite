'use strict';
require('./guard'); // 오류가 나도 화면에 창을 띄우지 않고 종료 코드 1
// 1.3.2 앱 기록 + 멈춤 감시를 실제 앱으로 본다 (창은 화면에 띄우지 않는다. 임시 APPDATA·LOCALAPPDATA, 네트워크 없음).
//   npx electron scripts/check-hang.js   → 결과 JSON 한 줄, 하나라도 틀리면 종료 코드 1
// test/hang-ui.test.js 가 부른다:
//   EZRITE_SCRIPT=hang@4=5,uihang@12=5 (맥 hang@8=5 와 같은 시험): 메인 프로세스를 4초에 5초, 팝업 화면을 12초에 5초 굳힌다
//   → 기록에 "메인 프로세스가 N초째 응답 없음"·"풀림 — N초 동안 멈춰 있었음" (bg), "화면(팝업)이 …"·"풀림" (main)
//   → hang-시각.txt 두 장: 메인은 멈춘 자리(spin, hangwatch.js:줄)가, 화면은 어느 창인지가 적힌다
//   기록 파일은 %LOCALAPPDATA%\Ezrite\logs\ezrite-YYYY-MM-DD.log, 줄은 모두 같은 꼴, 시작·종료 단계가 남는다
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-hang-'));
const roaming = path.join(tmp, 'Roaming');
const local = path.join(tmp, 'Local');
fs.mkdirSync(path.join(roaming, 'Ezrite'), { recursive: true });
fs.writeFileSync(path.join(roaming, 'Ezrite', 'settings.json'), JSON.stringify({ welcomed: true }));
Object.assign(process.env, {
  APPDATA: roaming, LOCALAPPDATA: local, EZRITE_UPDATE_JSON: '{"tag_name":"v0.0.1","assets":[]}', EZRITE_SCRIPT: 'hang@4=5,uihang@12=5',
});
// node --test 아래에서 불려도 이 시험은 기록을 켠다 (평소 시험은 끈다)
delete process.env.NODE_TEST_CONTEXT;
delete process.env.EZRITE_NO_LOG;

const { app, BrowserWindow } = require('electron');
for (const m of ['show', 'showInactive', 'focus', 'moveTop']) BrowserWindow.prototype[m] = function noop() {};
app.setPath('userData', path.join(tmp, 'userData'));
require('../main.js');

const LOGS = path.join(local, 'Ezrite', 'logs');
const LINE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} (INFO|WARN|ERR) \[[^\]]+\] .+ \((main|bg)\)$/;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function read() {
  const names = fs.existsSync(LOGS) ? fs.readdirSync(LOGS) : [];
  const logs = names.filter((n) => /^ezrite-\d{4}-\d{2}-\d{2}\.log$/.test(n));
  const lines = logs.flatMap((n) => fs.readFileSync(path.join(LOGS, n), 'utf8').split(/\r?\n/).filter(Boolean));
  const hangs = names.filter((n) => /^hang-\d{8}-\d{6}\.txt$/.test(n)).map((n) => fs.readFileSync(path.join(LOGS, n), 'utf8'));
  return { names, logs, lines, hangs };
}

const out = { ok: false };
let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  try {
    const { names, logs, lines, hangs } = read();
    const has = (re) => lines.some((l) => re.test(l));
    const main = hangs.find((h) => h.includes('메인 프로세스')) ?? '';
    const ui = hangs.find((h) => h.includes('화면: 팝업')) ?? '';
    out.names = names;
    out.sample = lines.filter((l) => /\[앱\]/.test(l)).map((l) => l.slice(24));
    out.mainStack = main.split('\n').filter((l) => l.trim().startsWith('at ')).slice(0, 4).map((l) => l.trim().replace(/\(file:.*[\\/]/, '('));
    out.checks = {
      oneFile: logs.length === 1, // 오늘 파일 하나 (자정을 넘기지 않는 한)
      format: lines.length > 0 && lines.every((l) => LINE.test(l)),
      start: has(/INFO \[앱\] 시작 — 버전 \S+ \(개발\), Electron .+, pid \d+/),
      mainHang: has(/WARN \[앱\] 메인 프로세스가 \d+초째 응답 없음 \(bg\)$/),
      mainRecover: has(/WARN \[앱\] 풀림 — [4-6]\.\d초 동안 멈춰 있었음 \(bg\)$/),
      mainStack: /spin \(.*hangwatch\.js:\d+:\d+\)/.test(main) && /main\.js:\d+/.test(main),
      uiHang: has(/WARN \[앱\] 화면\(팝업\)이 \d+초째 응답 없음 \(main\)$/),
      uiRecover: has(/WARN \[앱\] 화면\(팝업\) 풀림 — [3-6]\.\d초 동안 멈춰 있었음 \(main\)$/),
      uiFile: ui.includes('Document-Policy'),
      twoHangFiles: hangs.length === 2,
      quitSteps: has(/INFO \[앱\] 종료 시작 — 녹음 안 함/) && has(/INFO \[앱\] 녹음 정리 \d+ms/) && has(/INFO \[앱\] 기록 닫음 — 종료 시작부터 \d+ms/),
      // 키 모양이 없다 (이 시험은 키가 없지만, 가리기가 깨져도 걸리게)
      noKeys: !lines.some((l) => /(gsk_|sk-ant-|sk-proj-|AIza)[A-Za-z0-9_-]{8,}/.test(l)),
    };
    out.ok = Object.values(out.checks).every(Boolean);
  } catch (e) {
    out.error = e.stack;
  }
  console.log(JSON.stringify(out));
  process.exitCode = out.ok ? 0 : 1;
}

// main.js 의 will-quit (기록 닫음) 뒤에 읽는다
app.on('will-quit', () => finish());
app.on('quit', () => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 다음에 */ }
  app.exit(out.ok ? 0 : 1);
});

app.whenReady().then(async () => {
  try {
    await wait(21_000);
    app.quit();
    await wait(15_000); // 종료가 안 되면
    finish();
    app.exit(1);
  } catch (e) {
    out.error = e.stack;
    finish();
    app.exit(1);
  }
});
