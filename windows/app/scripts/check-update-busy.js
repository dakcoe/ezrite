'use strict';
require('./guard'); // 오류가 나도 화면에 창을 띄우지 않고 종료 코드 1
// 1.2.4 앱 안 업데이트: 녹음 중에는 [업데이트] 가 설치하지 않고 기다리라고 하는지 실제 앱 흐름에서 본다
// (창은 띄우지 않는다. 임시 APPDATA·LOCALAPPDATA, 가짜 Groq, 만든 소리 파일, 가짜 릴리스와 로컬 시험 설치 파일).
//   npx electron scripts/check-update-busy.js   → 결과 JSON 한 줄, 하나라도 틀리면 종료 코드 1
// test/update-busy-ui.test.js 가 부른다. 설치 실행(spawn)과 앱 끝내기(app.quit)는 가로채서 적기만 한다:
//   녹음 중 [업데이트] → 띠에 "녹음이 끝나면 업데이트할 수 있어요", 설치를 띄우지 않고 앱도 끄지 않는다
//   녹음을 끝내고 m4a 로 바꾼 뒤 [업데이트] → 받은(복사한) 설치 파일을 --updated /S --force-run 으로 띄우고 앱을 끝낸다
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { encodeWav, SAMPLE_RATE } = require('../lib/wav');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-update-busy-'));
const roaming = path.join(tmp, 'Roaming');
fs.mkdirSync(path.join(roaming, 'Ezrite'), { recursive: true });
fs.writeFileSync(path.join(roaming, 'Ezrite', 'settings.json'), JSON.stringify({ welcomed: true, theme: 'light', options: { askBeforeRecord: false } }));
const notesDir = path.join(roaming, 'Ezrite', 'notes', 'autosave');

// 말 3초 - 쉼 1초를 되풀이한 60초를 4배속으로 (계속 나는 소리는 잡음 바닥이 돼 말로 안 잡힌다. 쉼이 짧아 자동 일시정지도 안 걸린다)
const wav = path.join(tmp, 'lecture.wav');
fs.writeFileSync(wav, encodeWav(Float32Array.from({ length: 60 * SAMPLE_RATE }, (_, k) => {
  if (k % (4 * SAMPLE_RATE) >= 3 * SAMPLE_RATE) return ((k * 7919) % 13 - 6) / 32768; // 아주 작은 잡음이 깔린 쉼
  return 0.25 * Math.sin((2 * Math.PI * 220 * k) / SAMPLE_RATE) * (1 + 0.3 * Math.sin(k / 400));
})));

// 시험 설치 파일 (내용은 상관없다. 띄우지 않는다)
const exe = path.join(tmp, 'Ezrite-Setup-9.9.9.exe');
fs.writeFileSync(exe, 'MZ fake installer');
const RELEASE = {
  tag_name: 'v9.9.9', html_url: 'https://github.com/dakcoe/ezrite/releases/tag/v9.9.9', body: '- 시험',
  assets: [{ name: 'Ezrite-Setup-9.9.9.exe', size: 17, browser_download_url: 'https://github.com/dakcoe/ezrite/releases/download/v9.9.9/Ezrite-Setup-9.9.9.exe' }],
};
Object.assign(process.env, {
  APPDATA: roaming, LOCALAPPDATA: path.join(tmp, 'Local'), EZRITE_THEME: 'light', EZRITE_FAKE_GROQ: '1', EZRITE_TESTFILE: wav, EZRITE_SPEED: '4',
  EZRITE_UPDATE_JSON: JSON.stringify(RELEASE), EZRITE_UPDATE_EXE: exe,
});

// 설치 실행은 적기만 (main.js 를 부르기 전에 바꿔야 그 spawn 을 쓴다). helper 같은 다른 실행은 그대로
const launched = [];
const realSpawn = childProcess.spawn;
childProcess.spawn = (file, args, opts) => {
  if (String(file).endsWith('Ezrite-Setup-9.9.9.exe')) {
    launched.push({ file, args, opts });
    return { unref() {} };
  }
  return realSpawn(file, args, opts);
};

const { app, BrowserWindow } = require('electron');
for (const m of ['show', 'showInactive', 'focus', 'moveTop']) BrowserWindow.prototype[m] = function noop() {};
let quits = 0;
app.quit = () => { quits++; };
app.setPath('userData', path.join(tmp, 'userData'));
app.setVersion(require('../package.json').version); // electron 으로 바로 돌리면 앱 버전이 Electron 버전이 된다
require('../main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(100);
  }
  return null;
}
const page = (name) => until(() => BrowserWindow.getAllWindows().map((w) => w.webContents).find((x) => x.getURL().includes(name) && !x.isLoading()));
const banner = (wc) => wc.executeJavaScript(`(() => { const b = document.querySelector('.update-banner');
  if (!b || b.classList.contains('hidden')) return null;
  return { buttons: [...b.querySelectorAll('.top button')].map((x) => ({ text: x.textContent.trim(), disabled: x.disabled })),
    notes: b.querySelector('.ub-notes')?.textContent ?? null, error: b.querySelector('.ub-error span')?.textContent ?? null }; })()`);
const press = (wc) => wc.executeJavaScript("[...document.querySelectorAll('.update-banner .top button')].find((b) => b.textContent.trim() === '업데이트').click()");
const files = (d) => { const out = []; const walk = (x) => { for (const n of fs.existsSync(x) ? fs.readdirSync(x) : []) { const p = path.join(x, n); if (fs.statSync(p).isDirectory()) walk(p); else out.push(n); } }; walk(d); return out; };

app.whenReady().then(async () => {
  const r = { ok: false };
  try {
    const main = await page('main.html');
    r.banner = await until(() => banner(main));
    // EZRITE_TESTFILE 이 녹음을 저절로 시작한다. 받아 적은 줄이 생길 때까지
    if (!(await until(() => files(notesDir).some((n) => n.endsWith('.txt')), 60000))) throw new Error(`녹음이 시작되지 않음: ${JSON.stringify(files(path.join(roaming, 'Ezrite')))}`);
    await press(main);
    r.whileRecording = await until(async () => { const b = await banner(main); return b?.notes === '녹음이 끝나면 업데이트할 수 있어요' && b; }, 5000);
    r.launchedWhileRecording = launched.length;
    r.quitsWhileRecording = quits;

    await main.executeJavaScript('window.ezrite.stopRecord()');
    // m4a 로 다 바꿀 때까지 (바꾸는 중에도 설치하지 않는다)
    r.encoded = Boolean(await until(() => files(notesDir).some((n) => n.endsWith('.m4a')) && !files(notesDir).some((n) => n.endsWith('.pcm'))));
    await press(main);
    r.launched = await until(() => launched.length && launched[0], 10000);
    r.quits = quits;
    r.copied = fs.existsSync(path.join(tmp, 'Local', 'ezrite-updater', 'Ezrite-Setup-9.9.9.exe'));
    r.ok = JSON.stringify(r.banner?.buttons.map((b) => b.text)) === '["나중에","업데이트"]'
      && Boolean(r.whileRecording) && r.launchedWhileRecording === 0 && r.quitsWhileRecording === 0
      && r.encoded && r.launched?.file === path.join(tmp, 'Local', 'ezrite-updater', 'Ezrite-Setup-9.9.9.exe')
      && JSON.stringify(r.launched.args) === '["--updated","/S","--force-run"]' && r.quits === 1 && r.copied;
  } catch (e) {
    r.error = e.stack;
  }
  console.log(JSON.stringify(r));
  app.exit(r.ok ? 0 : 1);
});
app.on('quit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 다음에 */ } });
