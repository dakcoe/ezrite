'use strict';
require('./guard'); // 오류가 나도 화면에 창을 띄우지 않고 종료 코드 1
// 1.2.1 설명할 때 화면 나누기를 실제 창으로 본다 (임시 APPDATA, 가짜 Groq, 화면 찍기는 흰 그림으로 바꿔 사용자 화면을 읽지 않는다).
//   npx electron scripts/check-split.js   → 결과 JSON 한 줄, 하나라도 틀리면 종료 코드 1
// test/split-ui.test.js 가 부른다. 시험용 창 둘(scripts/dock-target.js — 보이지 않고 클릭·포커스를 가져가지 않는다)만 옮긴다
// (EZRITE_DOCK_ONLY). 맥 WindowDock 과 같은 규칙:
//   설명해줘 → 창들이 가로로 s = (작업 영역 폭 − 448) / 폭 배 줄어 왼쪽으로, 카드는 오른쪽 기둥(폭 440, 높이 = 작업 영역)
//   카드를 닫으면 원래 자리·크기로 (최대화한 창은 최대화 그대로), 포커스는 건드리지 않는다
// 창 자리는 helper `windows` 로 읽는다 (물리 픽셀 — lib/dock.js plan 이 계산한 자리와 그대로 비교한다)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-split-'));
const roaming = path.join(tmp, 'Roaming');
fs.mkdirSync(path.join(roaming, 'Ezrite'), { recursive: true });
fs.writeFileSync(path.join(roaming, 'Ezrite', 'settings.json'), JSON.stringify({ welcomed: true, theme: 'light', options: { splitScreen: true } }));

const helper = ['release', 'debug'].map((d) => path.join(__dirname, '..', '..', 'helper', 'target', d, 'ezrite-audio.exe')).find((p) => fs.existsSync(p));
const listing = () => JSON.parse(execFileSync(helper, ['windows'], { encoding: 'utf8', windowsHide: true }));

// 시험용 창 프로세스. 창을 띄우면 JSON 한 줄을 쓴다
const target = spawn(process.execPath, [path.join(__dirname, 'dock-target.js')], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
const ready = new Promise((resolve) => {
  let buf = '';
  target.stdout.on('data', (d) => {
    buf += d;
    const l = buf.split(/\r?\n/).find((x) => x.startsWith('{'));
    if (l) resolve(JSON.parse(l));
  });
});

// 앱은 준비되기 전에 불러와야 한다. 설명해줘는 시험용 창이 뜬 뒤(3초)
Object.assign(process.env, {
  APPDATA: roaming, LOCALAPPDATA: path.join(tmp, 'Local'), EZRITE_THEME: 'light', EZRITE_FAKE_GROQ: '1',
  EZRITE_DOCK_ONLY: String(target.pid), EZRITE_EXPLAIN: '3',
});
const { app, BrowserWindow, desktopCapturer, nativeImage, screen } = require('electron');
for (const m of ['show', 'showInactive', 'focus', 'moveTop']) BrowserWindow.prototype[m] = function noop() {};
// 화면 찍기: 사용자 화면 대신 흰 그림 (글자 인식은 빈 결과, 가짜 Groq 가 설명을 만든다)
desktopCapturer.getSources = async ({ thumbnailSize }) => {
  const w = Math.max(1, Math.round(thumbnailSize.width / 4)), h = Math.max(1, Math.round(thumbnailSize.height / 4));
  const img = nativeImage.createFromBitmap(Buffer.alloc(w * h * 4, 255), { width: w, height: h });
  return screen.getAllDisplays().map((d) => ({ display_id: String(d.id), thumbnail: img }));
};
app.setPath('userData', path.join(tmp, 'userData'));
require('../main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(150);
  }
  return null;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const ours = (l) => ({ foreground: l.foreground, windows: l.windows.filter((w) => w.pid === target.pid) });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const out = { ok: false };
  try {
    if (!helper) throw new Error('helper 가 없음 (cargo build)');
    const t = await Promise.race([ready, wait(15000).then(() => null)]);
    if (!t) throw new Error('시험용 창이 뜨지 않음');
    await app.whenReady();
    const { plan, CARD_WIDTH, GAP } = require('../lib/dock');
    const E = require('../lib/explain');
    const before = ours(listing());
    out.before = before.windows;
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const work = d.workArea;
    const px = (r) => { const p = screen.dipToScreenRect(null, r); return { x: p.x, y: p.y, w: p.width, h: p.height }; };
    const geom = { area: px(work), bounds: px(d.bounds), reserve: Math.round((CARD_WIDTH + GAP) * d.scaleFactor) };
    const want = plan(before, geom, process.pid);
    out.want = want?.map((x) => ({ hwnd: x.hwnd, ...x.to }));

    const card = await until(() => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('explain.html')));
    if (!card) throw new Error('설명 카드가 열리지 않음');
    await until(() => card.webContents.executeJavaScript('!!document.querySelector(".summary, .error")').catch(() => false));
    out.cardText = await card.webContents.executeJavaScript('document.getElementById("root").innerText.slice(0, 80)');
    out.card = card.getBounds();
    out.cardWant = E.dockFrame(work, null);
    const docked = await until(() => {
      const now = ours(listing());
      return now.windows.every((w) => w.w < before.windows.find((b) => b.hwnd === w.hwnd).w) ? now : null;
    }, 8000) ?? ours(listing());
    out.docked = docked.windows;

    card.close(); // 사용자가 닫기를 누른 것과 같다 → clear → 되돌리기
    const restored = await until(() => { const now = ours(listing()); return same(now.windows, before.windows) ? now : null; }, 8000) ?? ours(listing());
    out.restored = restored.windows;

    const byHwnd = (l, h) => l.find((w) => w.hwnd === h);
    out.checks = {
      twoTargets: before.windows.length === 2 && before.windows.some((w) => w.max) && before.windows.some((w) => !w.max),
      cardColumn: ['x', 'y', 'width', 'height'].every((k) => near(out.card[k], out.cardWant[k], 2)),
      shrunkAsPlanned: !!want && want.length === 2 && want.every((x) => {
        const w = byHwnd(docked.windows, x.hwnd);
        return w && w.x === x.to.x && w.y === x.to.y && w.w === x.to.w && w.h === x.to.h;
      }),
      // 최대화한 창은 최대화를 풀고 줄인다 (Chromium 창은 최대화 상태로는 크기가 안 바뀐다)
      maximizedUnmaximized: docked.windows.find((w) => w.hwnd === before.windows.find((b) => b.max).hwnd)?.max === false,
      // 자리·크기·최대화·보통 크기 자리·겹침 순서(목록 순서)까지 그대로
      restored: same(restored.windows, before.windows),
      focusUntouched: docked.foreground === before.foreground && restored.foreground === before.foreground,
    };
    out.ok = Object.values(out.checks).every(Boolean);
  } catch (e) {
    out.error = e.message;
  }
  target.kill();
  process.stdout.write(`${JSON.stringify(out)}\n`);
  app.exit(out.ok ? 0 : 1);
}
main();
