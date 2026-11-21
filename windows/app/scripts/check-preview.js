'use strict';
require('./guard'); // 오류가 나도 화면에 창을 띄우지 않고 종료 코드 1
// 설정의 "설명 표시 방식" 미리보기를 실제 앱 화면에서 본다 (창은 화면에 띄우지 않는다. AI·화면 찍기 없음, 임시 APPDATA).
//   npx electron scripts/check-preview.js   → 결과 JSON 한 줄, 하나라도 틀리면 종료 코드 1
// test/preview-ui.test.js 가 부른다:
//   미리보기가 설정 카드 폭에 맞춰 줄어 보이고, 슬라이드·표시·카드 자리가 그려진다. 예전 방식은 상자, 지도 방식은 카드 속 지도.
//   방식을 바꾸면 처음 장면부터, 설정 화면이 다시 그려져도 같은 미리보기가 이어진다
// EZRITE_PREVIEW_SHOT=<폴더> 이면 방식마다 미리보기를 png 로 남긴다.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-preview-'));
const roaming = path.join(tmp, 'Roaming');
fs.mkdirSync(path.join(roaming, 'Ezrite'), { recursive: true });
const theme = process.env.EZRITE_THEME || 'light';
fs.writeFileSync(path.join(roaming, 'Ezrite', 'settings.json'), JSON.stringify({ welcomed: true, theme }));
Object.assign(process.env, {
  APPDATA: roaming, LOCALAPPDATA: path.join(tmp, 'Local'), EZRITE_THEME: theme, EZRITE_UPDATE_JSON: '{"tag_name":"v0.0.1","assets":[]}',
});

const { app, BrowserWindow } = require('electron');
for (const m of ['show', 'showInactive', 'focus', 'moveTop']) BrowserWindow.prototype[m] = function noop() {};
app.setPath('userData', path.join(tmp, 'userData'));
require('../main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function page(name) {
  for (let i = 0; i < 80; i++) {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes(name) && !x.webContents.isLoading());
    if (w) return w.webContents;
    await wait(100);
  }
  throw new Error(`${name} 이 열리지 않음`);
}

// 미리보기의 모습: 크기·줄임, 카드 자리 글, 지도, 표시 canvas 에 칠해진 점 수와 몇 곳의 색 (가상 화면 좌표)
const LOOK = `(async () => {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const p = document.querySelector('.mark-preview');
  if (!p) return null;
  const ink = (sel) => { const c = p.querySelector(sel), x = c.getContext('2d'); if (!c.width) return 0;
    const d = x.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 16) if (d[i] > 0) n++; return n; };
  const r = p.getBoundingClientRect(), s = p.querySelector('.mp-stage').style.transform;
  return { w: Math.round(r.width), h: Math.round(r.height), scale: s, say: p.querySelector('.mp-say').textContent,
    map: !p.querySelector('.mp-map').hidden, slide: ink('.mp-slide'), marks: ink('.mp-marks'), classic: ink('.mp-classic'),
    same: window.__preview === p };
})()`;

async function main() {
  const out = { ok: false, styles: {} };
  try {
    await app.whenReady();
    const popup = await page('popup.html');
    const wc = await page('main.html');
    const ipc = (c) => popup.executeJavaScript(c);
    wc.debugger.attach('1.3');
    // 다 그려진 모습을 바로 (숨긴 창에서는 rAF 가 거의 돌지 않는다)
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await ipc('window.ezrite.set({ page: "settings" })');
    await wait(600);
    await wc.executeJavaScript("document.querySelector('.mark-preview')?.scrollIntoView({ block: 'center' }); window.__preview = document.querySelector('.mark-preview'); 0");
    const shots = process.env.EZRITE_PREVIEW_SHOT;
    if (shots) fs.mkdirSync(shots, { recursive: true });
    for (const style of ['trail', 'classic', 'spotlight', 'minimap', 'pen', 'leader']) {
      await ipc(`window.ezrite.set({ markStyle: ${JSON.stringify(style)} })`);
      await wait(500);
      await wc.executeJavaScript("document.querySelector('.mark-preview')?.scrollIntoView({ block: 'center' }); 0");
      out.styles[style] = await wc.executeJavaScript(LOOK);
      if (shots) {
        const r = await wc.executeJavaScript("(() => { const b = document.querySelector('.mark-preview').getBoundingClientRect(); return { x: Math.floor(b.x), y: Math.floor(b.y), width: Math.ceil(b.width), height: Math.ceil(b.height) }; })()");
        wc.invalidate();
        await wait(300);
        fs.writeFileSync(path.join(shots, `preview-${style}-${theme}.png`), (await wc.capturePage(r)).toPNG());
      }
    }
    // 3.4초 뒤 다음 장면 (방식은 그대로). 바뀌는 첫 장면이 둘째여야 한다 (시험이 느려도 건너뛴 것을 놓치지 않게 0.1초마다 본다)
    const SAY = "document.querySelector('.mark-preview .mp-say').textContent";
    await ipc('window.ezrite.set({ markStyle: "trail" })'); // 방금 처음부터 시작하게
    await wait(200);
    const first = await wc.executeJavaScript(SAY);
    for (let i = 0; i < 100; i++) {
      await wait(100);
      const now = await wc.executeJavaScript(SAY);
      if (now !== first) { out.next = { say: now, from: first }; break; }
    }
    out.next ??= { say: null, from: first };
    const s = out.styles;
    const drawn = (x) => x && x.slide > 1000 && x.w > 200 && Math.abs(x.h / x.w - 400 / 760) < 0.02 && /scale\(0\.\d+\)/.test(x.scale);
    out.checks = {
      fitsCard: Object.values(s).every(drawn),
      firstScene: Object.values(s).every((x) => x.say === '먼저 입력 x 가 h, ŷ 를 거쳐 손실 L 이 된다'),
      marksDrawn: ['trail', 'spotlight', 'pen', 'leader'].every((k) => s[k].marks > 30),
      classicIsBoxes: s.classic.classic > 30 && s.classic.marks === 0,
      minimapInCard: s.minimap.map && !s.trail.map,
      sameElement: Object.values(s).every((x) => x.same),
      advances: out.next.from === '먼저 입력 x 가 h, ŷ 를 거쳐 손실 L 이 된다' && out.next.say === '역전파는 손실 L 에서 출발한다',
    };
    out.ok = Object.values(out.checks).every(Boolean);
  } catch (e) {
    out.error = e.stack;
  }
  console.log(JSON.stringify(out));
  app.exit(out.ok ? 0 : 1);
}

main();
app.on('quit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 다음에 */ } });
