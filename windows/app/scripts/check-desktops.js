'use strict';
require('./guard'); // 오류가 나도 화면에 창을 띄우지 않고 종료 코드 1
// 1.2.2 가상 데스크톱을 실제로 바꿔 가며 본다. 사용자 화면이 움직이므로 npm test 에는 넣지 않고, 사용자에게 묻고 손으로 돌린다:
//   npx electron scripts/check-desktops.js   → 결과 JSON 한 줄, 하나라도 틀리면 종료 코드 1
// 새 데스크톱을 하나 만들어(Ctrl+Win+D) 넘어갔다가(→) 돌아오고(Ctrl+Win+←), 끝나면 그 데스크톱을 지운다(Ctrl+Win+F4).
// 임시 APPDATA, 가짜 Groq. 기준 창은 시험용 창(scripts/desk-target.js, 보이지 않음)만 쓴다 (EZRITE_DOCK_ONLY).
// 화면 찍기는 글자를 그린 가짜 화면으로 바꾼다 (사용자 화면을 읽지 않는다. 카드가 실제로 보이는지만 카드 안 몇 점을 본다).
// 보는 것:
//   설명한 데스크톱: 카드·①②③ 표시가 보이고, 녹음 중 전체 창에 소리 크기가 간다
//   다른 데스크톱: 카드는 그대로 보이고(모든 데스크톱), 표시는 숨고, 그 데스크톱에 없는 전체 창에는 소리 크기를 보내지 않는다
//   돌아오면: 표시가 되살아나고 소리 크기도 다시 간다
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-desk-'));
const roaming = path.join(tmp, 'Roaming');
fs.mkdirSync(path.join(roaming, 'Ezrite'), { recursive: true });
fs.writeFileSync(path.join(roaming, 'Ezrite', 'settings.json'),
  JSON.stringify({ welcomed: true, theme: 'light', language: 'English', options: { askBeforeRecord: false } }));

// 가상 데스크톱 키 (Ctrl+Win+…). 스크립트 파일 대신 짧은 명령으로 넘긴다
const KEYS = { new: 0x44, left: 0x25, right: 0x27, close: 0x73 };
const KEY_PS = (vk) => `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class EzVd {
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static void Combo(byte k) { keybd_event(0xA2,0,0,UIntPtr.Zero); keybd_event(0x5B,0,0,UIntPtr.Zero);
    keybd_event(k,0,0,UIntPtr.Zero); keybd_event(k,0,2,UIntPtr.Zero); keybd_event(0x5B,0,2,UIntPtr.Zero); keybd_event(0xA2,0,2,UIntPtr.Zero); } }';
  [EzVd]::Combo(${vk})`;
const STATE_PS = `$k = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VirtualDesktops' -ErrorAction SilentlyContinue;
  $n = 1; $first = $true;
  if ($k -and $k.VirtualDesktopIDs -and $k.VirtualDesktopIDs.Length -ge 16) { $n = $k.VirtualDesktopIDs.Length / 16;
    if ($k.CurrentVirtualDesktop) { $first = ([guid]::new([byte[]]$k.VirtualDesktopIDs[0..15])) -eq ([guid]::new([byte[]]$k.CurrentVirtualDesktop)) } }
  '{"count":' + $n + ',"first":' + $first.ToString().ToLower() + '}'`;
const ps = (code) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', code], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim();
const key = (k) => ps(KEY_PS(KEYS[k]));
const deskState = () => JSON.parse(ps(STATE_PS).split(/\r?\n/).pop());

// 기준 창 (설명할 때 앞에 있던 강의 창 자리)
const target = spawn(process.execPath, [path.join(__dirname, 'desk-target.js')], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
const ready = new Promise((resolve) => {
  let buf = '';
  target.stdout.on('data', (d) => {
    buf += d;
    const l = buf.split(/\r?\n/).find((x) => x.startsWith('{'));
    if (l) resolve(JSON.parse(l));
  });
});

const wav = path.join(__dirname, '..', '..', 'promo', 'assets', 'pareto.wav');
Object.assign(process.env, {
  APPDATA: roaming, LOCALAPPDATA: path.join(tmp, 'Local'), EZRITE_THEME: 'light', EZRITE_FAKE_GROQ: '1',
  EZRITE_DOCK_ONLY: String(target.pid), EZRITE_TESTFILE: wav, EZRITE_EXPLAIN: '6',
  // 카드는 평소 화면 캡처에서 빠진다 (setContentProtection). 실제로 그려졌는지 화면에서 보려고 캡처에 보이게 둔다
  EZRITE_CAPTURABLE: '1',
});
const { app, BrowserWindow, desktopCapturer, screen, webContents } = require('electron');
// 사용자가 쓰던 창의 포커스를 뺏지 않는다
BrowserWindow.prototype.focus = function noop() {};
BrowserWindow.prototype.show = function showQuietly() { this.showInactive(); };
const realSources = desktopCapturer.getSources.bind(desktopCapturer);
let fakeScreen = null; // 글자를 그린 화면 (nativeImage)
desktopCapturer.getSources = async ({ thumbnailSize }) => {
  const img = (await fakeScreen).resize({ width: thumbnailSize.width, height: thumbnailSize.height });
  return screen.getAllDisplays().map((d) => ({ display_id: String(d.id), thumbnail: img }));
};
app.setPath('userData', path.join(tmp, 'userData'));
require('../main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(150);
  }
  return null;
}
const winOf = (name) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes(name));

/** 강의 슬라이드처럼 글자 줄을 그린 화면 한 장 (보이지 않는 창에서 그린다) */
async function drawScreen(d) {
  const w = new BrowserWindow({ show: false, width: d.bounds.width, height: d.bounds.height, webPreferences: { offscreen: true } });
  const html = `<body style="margin:0;background:#fff;font:600 44px Segoe UI;color:#111;padding:120px 160px">
    <p>Gradient descent lowers the loss</p><p>The learning rate sets the step size</p><p>Validation loss rises after epoch twenty</p></body>`;
  await w.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  await wait(500);
  const img = await w.webContents.capturePage();
  w.destroy();
  return img;
}

// 전체 창에 간 소리 크기 수
let levelsToMain = 0;
function countLevels(main) {
  const send = main.webContents.send.bind(main.webContents);
  main.webContents.send = (ch, ...a) => { if (ch === 'level') levelsToMain++; return send(ch, ...a); };
}

/** 카드가 실제로 화면에 그려졌나: 카드 왼쪽 가장자리 안쪽 몇 점이 카드 바탕(흰색)인지 실제 화면에서 본다 */
async function cardSeen(card) {
  const d = screen.getDisplayMatching(card.getBounds());
  const k = d.scaleFactor;
  const src = (await realSources({ types: ['screen'], thumbnailSize: { width: Math.round(d.bounds.width * k), height: Math.round(d.bounds.height * k) } }))
    .find((s) => s.display_id === String(d.id));
  if (!src) return null;
  const b = card.getContentBounds();
  let white = 0;
  const pts = [0.3, 0.5, 0.7].map((f) => ({ x: Math.round((b.x - d.bounds.x + 3) * k), y: Math.round((b.y - d.bounds.y + b.height * f) * k) }));
  for (const p of pts) {
    const px = src.thumbnail.crop({ x: p.x, y: p.y, width: 1, height: 1 }).toBitmap();
    if (px[0] > 240 && px[1] > 240 && px[2] > 240) white++;
  }
  return white === pts.length;
}

async function snapshot(tag, main) {
  const card = winOf('explain.html');
  const overlay = winOf('overlay.html');
  const before = levelsToMain;
  await wait(1500);
  return {
    tag,
    card: card && { visible: card.isVisible(), page: await card.webContents.executeJavaScript('document.visibilityState'), seen: await cardSeen(card) },
    overlay: overlay ? { visible: overlay.isVisible() } : null,
    main: { shown: main.ezShown, levelsIn1500ms: levelsToMain - before },
  };
}

async function run() {
  const out = { ok: false };
  let moved = false;
  try {
    const t = await Promise.race([ready, wait(15000).then(() => null)]);
    if (!t) throw new Error('기준 창이 뜨지 않음');
    out.desktopsBefore = deskState();
    if (out.desktopsBefore.count !== 1) throw new Error(`데스크톱이 이미 ${out.desktopsBefore.count}개 — 하나일 때만 돌린다`);
    await app.whenReady();
    fakeScreen = drawScreen(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));
    const main = await until(() => { const w = winOf('main.html'); return w && !w.webContents.isLoading() && w; });
    countLevels(main);
    main.setAlwaysOnTop(true); // 다른 창에 가려지면 Chromium 이 안 보이는 것으로 쳐서 소리 크기가 안 간다 (그건 맞는 동작)
    main.showInactive();
    await until(() => main.ezShown === true, 10000);
    // EZRITE_EXPLAIN: 6초 뒤 설명해줘 → 카드와 표시
    if (!(await until(() => winOf('overlay.html')?.isVisible() && winOf('explain.html')?.isVisible(), 40000))) throw new Error('표시·카드가 뜨지 않음');
    await wait(1000);
    out.d1 = await snapshot('설명한 데스크톱', main);

    key('new');
    moved = true;
    await wait(2500);
    out.d2 = await snapshot('새 데스크톱', main);

    key('left');
    await wait(2500);
    out.back = await snapshot('돌아옴', main);

    const s = [out.d1, out.d2, out.back];
    out.ok = s.every((x) => x.card?.visible && x.card.page === 'visible' && x.card.seen === true)
      && out.d1.overlay?.visible === true && out.d2.overlay?.visible === false && out.back.overlay?.visible === true
      && out.d1.main.levelsIn1500ms > 5 && out.d2.main.shown === false && out.d2.main.levelsIn1500ms === 0
      && out.back.main.shown === true && out.back.main.levelsIn1500ms > 5;
  } catch (e) {
    out.error = e.stack;
  }
  // 만든 데스크톱을 지운다 (그 데스크톱으로 가서 Ctrl+Win+F4)
  try {
    if (moved) {
      const s = deskState();
      if (s.count > 1) {
        if (s.first) { key('right'); await wait(1500); }
        key('close');
        await wait(1500);
      }
    }
    out.desktopsAfter = deskState();
    if (out.desktopsAfter.count !== 1) out.ok = false;
  } catch (e) {
    out.cleanupError = e.message;
    out.ok = false;
  }
  target.kill();
  console.log(JSON.stringify(out));
  app.exit(out.ok ? 0 : 1);
}

run();
app.on('quit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 다음에 */ } });
