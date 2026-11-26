'use strict';
require('./guard'); // 오류가 나도 화면에 창을 띄우지 않고 종료 코드 1
// 화면 번역(실험 기능)을 실제 앱으로 본다. 사용자 화면·창은 건드리지 않는다:
//   번역할 창은 따로 띄운 시험 창(scripts/translate-target.js, 화면 밖 x -6000), 덮개도 그 창을 따라 화면 밖에 뜬다.
//   가짜 Groq(EZRITE_FAKE_GROQ), 임시 APPDATA·LOCALAPPDATA.
//   npx electron scripts/check-screentx.js   → 결과 JSON 한 줄, 하나라도 틀리면 종료 코드 1
// test/screentx-ui.test.js 가 부른다. 확인하는 것:
//   설정에서 켜야 단추가 보이고, 창 목록에 시험 창이 있고(이 앱 창은 없음), 가리켜 고르기 패널이 마우스 아래 창을 파랗게(Esc 면 취소),
//   누르면 그 창을 골라 덮개가 그 창 자리에 떠서 번역을 그린다
//   첫 번역 뒤 시험 창을 스크롤하면 덮개를 걷었다가 다시 읽고, 새로 나온 문단만 옮긴다 (기억)
//   멈추면 덮개가 사라진다. 기록에는 [화면 번역] 시작·읽음·옮김·끝이 남고 화면 글은 남지 않는다
// EZRITE_SCREENTX_SHOT=<폴더> 이면 덮개 그림(overlay.png)을 남긴다
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-screentx-'));
const roaming = path.join(tmp, 'Roaming');
const local = path.join(tmp, 'Local');
fs.mkdirSync(path.join(roaming, 'Ezrite'), { recursive: true });
fs.writeFileSync(path.join(roaming, 'Ezrite', 'settings.json'), JSON.stringify({ welcomed: true, options: { screenTranslate: true } }));
Object.assign(process.env, { APPDATA: roaming, LOCALAPPDATA: local, EZRITE_FAKE_GROQ: '1', EZRITE_UPDATE_JSON: '{"tag_name":"v0.0.1","assets":[]}' });
delete process.env.NODE_TEST_CONTEXT; // 기록을 켠다 (기록에 화면 글이 없는지 본다)
delete process.env.EZRITE_NO_LOG;

const { app, BrowserWindow, screen } = require('electron');
// 앱 창(팝업·전체 창)은 띄우지 않는다. 덮개 창과 창 고르기 패널만 실제로 띄운다 (둘 다 화면 밖)
const realShowInactive = BrowserWindow.prototype.showInactive;
const realShow = BrowserWindow.prototype.show;
for (const m of ['focus', 'moveTop']) BrowserWindow.prototype[m] = function noop() {};
BrowserWindow.prototype.show = function show() {
  if (this.webContents.getURL().includes('picker.html')) return realShow.call(this);
  return undefined;
};
BrowserWindow.prototype.showInactive = function showInactive() {
  if (this.webContents.getURL().includes('overlay.html')) return realShowInactive.call(this);
  return undefined;
};
app.setPath('userData', path.join(tmp, 'userData'));
require('../main.js');

// 창 고르기 패널은 화면마다 뜬다: 화면 목록을 화면 밖 가짜 화면 하나로, 마우스 자리는 시험 창 한가운데로 (사용자 화면·마우스는 안 건드린다)
let cursorDip = { x: -99999, y: -99999 };
const FAKE_DISPLAY = { id: 9999, bounds: { x: -7000, y: 0, width: 2400, height: 1200 }, workArea: { x: -7000, y: 0, width: 2400, height: 1200 }, scaleFactor: 1, rotation: 0 };
const { execFile } = require('node:child_process');
const helperExe = require('../lib/ui').helperCandidates({ packaged: false, appDir: path.join(__dirname, '..') }).find((x) => fs.existsSync(x));
const helperWindows = () => new Promise((res, rej) => execFile(helperExe, ['windows'], { encoding: 'utf8' }, (e, o) => (e ? rej(e) : res(JSON.parse(o).windows))));

const electronExe = process.execPath;
const SCROLL = path.join(tmp, 'scroll-now');
const target = spawn(electronExe, [path.join(__dirname, 'translate-target.js'), SCROLL], { stdio: 'ignore', windowsHide: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(200);
  }
  return null;
}
const logLines = () => {
  const dir = path.join(local, 'Ezrite', 'logs');
  return (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((n) => n.endsWith('.log'))
    .flatMap((n) => fs.readFileSync(path.join(dir, n), 'utf8').split(/\r?\n/).filter(Boolean)).filter((l) => l.includes('[화면 번역]'));
};
const overlayWin = () => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('overlay.html'));
/** 덮개에 칠해진 점 수 (투명하지 않은 점, 4점마다) */
async function painted(w) {
  const img = await w.webContents.capturePage();
  const bmp = img.toBitmap();
  let n = 0;
  for (let i = 3; i < bmp.length; i += 16) if (bmp[i] > 0) n++;
  return n;
}

const out = { ok: false };
app.whenReady().then(async () => {
  try {
    const popup = await until(() => BrowserWindow.getAllWindows().map((w) => w.webContents).find((wc) => wc.getURL().includes('popup.html') && !wc.isLoading()));
    const js = (s) => popup.executeJavaScript(s);
    await wait(500);
    out.button = await js("(() => { const b = document.querySelector('.tx-btn'); return b ? !b.classList.contains('hidden') : null; })()");
    // 창 목록: 시험 창이 뜰 때까지
    const wins = await until(async () => {
      const list = await js('window.ezrite.screenTx.windows()');
      return list.some((w) => w.title === 'Ezrite 번역 시험') && list;
    });
    out.listed = Boolean(wins);
    // 이 앱(이 프로세스) 창이 목록에 없어야 한다. 제목으로 보면 사용자가 켜 둔 설치본 Ezrite(다른 프로세스, 번역해도 되는 창)까지 걸린다
    const ownHwnds = new Set((await helperWindows()).filter((w) => w.pid === process.pid).map((w) => String(w.hwnd)));
    out.ownListed = (wins || []).some((w) => ownHwnds.has(w.hwnd));
    out.ownWindows = ownHwnds.size; // 시험에서는 창을 숨겨 보통 0 (helper 목록은 보이는 창만)
    const hwnd = wins.find((w) => w.title === 'Ezrite 번역 시험').hwnd;
    // 가리켜 고르기: 화면 밖 가짜 화면에 패널, 마우스를 시험 창 한가운데에 둔 것으로
    screen.getAllDisplays = () => [FAKE_DISPLAY];
    screen.getCursorScreenPoint = () => cursorDip;
    const rect = (await helperWindows()).find((w) => String(w.hwnd) === hwnd);
    // 화면 밖 점은 screenToDipPoint 와 dipToScreenPoint 가 서로 되돌려지지 않는다 (배율이 한쪽에만 걸린다).
    // 앱은 dipToScreenPoint(마우스) 로 물리 픽셀을 얻으므로, 그것이 시험 창 한가운데가 되는 DIP 점을 쓴다
    const cx = Math.round(rect.x + rect.w / 2);
    const cy = Math.round(rect.y + rect.h / 2);
    const k = screen.dipToScreenPoint({ x: cx, y: cy }).y / cy; // 가장 가까운 화면의 배율
    cursorDip = { x: Math.round(cx / k), y: Math.round(cy / k) };
    const back = screen.dipToScreenPoint(cursorDip);
    out.cursorOk = Math.abs(back.x - cx) <= 3 && Math.abs(back.y - cy) <= 3;
    const panel = async () => until(() => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('picker.html') && !w.webContents.isLoading() && w.isVisible()));
    const hl = (w) => w.webContents.executeJavaScript("(() => { const e = document.getElementById('hl'); return e.classList.contains('hidden') ? null : document.getElementById('name').textContent; })()");
    // 먼저 Esc 로 취소
    await js('window.ezrite.screenTx.pick()');
    const p1 = await panel();
    out.pickHighlight = Boolean(p1) && await until(() => hl(p1));
    p1.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    out.pickCancelled = Boolean(await until(() => p1.isDestroyed() && 'gone', 5000));
    // 다시 띄워 누르면 그 창을 고른다
    await js('window.ezrite.screenTx.pick()');
    const p2 = await panel();
    await until(() => hl(p2));
    for (const type of ['mouseDown', 'mouseUp']) p2.webContents.sendInputEvent({ type, x: 300, y: 300, button: 'left', clickCount: 1 });
    out.pickClosed = Boolean(await until(() => p2.isDestroyed() && 'gone', 5000));
    out.active = await until(() => js('new Promise((r) => window.ezrite.onState((s) => r(s.screenTx.active)))'));
    // 덮개가 뜨고 그려진다
    const ov = await until(() => { const w = overlayWin(); return w && w.isVisible() && w; });
    out.overlayShown = Boolean(ov);
    out.overlayBounds = ov?.getBounds();
    await wait(1500);
    out.paintedBefore = ov ? await painted(ov) : 0;
    // EZRITE_SCREENTX_SHOT=<폴더>: 덮개 그림을 남긴다 (투명한 곳은 그대로)
    if (process.env.EZRITE_SCREENTX_SHOT && ov) {
      fs.mkdirSync(process.env.EZRITE_SCREENTX_SHOT, { recursive: true });
      fs.writeFileSync(path.join(process.env.EZRITE_SCREENTX_SHOT, 'overlay.png'), (await ov.webContents.capturePage()).toPNG());
    }
    // 첫 읽기·옮김을 본 뒤 스크롤 → 걷었다가 다시 읽고 새 문단만 옮긴다
    await until(() => logLines().some((l) => / 옮김 — /.test(l)), 30000);
    fs.writeFileSync(SCROLL, '1');
    out.reads = await until(() => logLines().filter((l) => / 읽음 — /.test(l)).length >= 2 && logLines(), 25000);
    await wait(2500);
    out.paintedAfter = ov && ov.isVisible() ? await painted(ov) : 0;
    await js('window.ezrite.screenTx.stop()');
    out.stoppedHidden = await until(() => !overlayWin()?.isVisible());
    await wait(300);
    const lines = logLines();
    out.log = lines.map((l) => l.slice(24));
    const reads = lines.filter((l) => / 읽음 — /.test(l)).map((l) => Number(/새로 옮길 (\d+)/.exec(l)?.[1]));
    const total = lines.filter((l) => / 읽음 — /.test(l)).map((l) => Number(/문단 (\d+)/.exec(l)?.[1]));
    out.checks = {
      buttonShown: out.button === true,
      listed: out.listed && !out.ownListed,
      pickHighlights: out.cursorOk && out.pickHighlight === 'Ezrite 번역 시험', // 마우스 아래 창을 그 제목과 함께 파랗게
      pickEscCancels: out.pickCancelled,
      pickClickPicks: out.pickClosed,
      started: out.active === true,
      overlayAtTarget: Boolean(out.overlayShown && out.overlayBounds && out.overlayBounds.x < -5000),
      painted: out.paintedBefore > 500,
      reread: reads.length >= 2,
      memory: reads.length >= 2 && reads[0] > 0 && reads.at(-1) < total.at(-1), // 다시 읽을 때 아는 문단은 옮기지 않는다
      paintedAfterScroll: out.paintedAfter > 500,
      stopped: Boolean(out.stoppedHidden) && lines.some((l) => / 끝 — /.test(l)),
      noScreenText: !lines.some((l) => /Attention|transformers|예시 번역/.test(l)),
    };
    out.ok = Object.values(out.checks).every(Boolean);
  } catch (e) {
    out.error = e.stack;
  }
  console.log(JSON.stringify(out));
  try { target.kill(); } catch { /* 이미 끝남 */ }
  app.exit(out.ok ? 0 : 1);
});
app.on('quit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 다음에 */ } });
