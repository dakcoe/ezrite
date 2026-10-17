'use strict';
require('./guard'); // 오류가 나도 화면에 창을 띄우지 않고 종료 코드 1

// 트레이 아이콘 .ico 만들기 (16/20/24/32px 를 크기마다 SVG에서 바로 그려 넣는다 — 큰 그림을 줄이면 흐려서).
// 맥 메뉴바 아이콘(말풍선 안의 마이크)과 같은 모양.
// 실행: npx electron scripts/make-tray-icon.js   → assets/tray-dark.ico (흰 선, 어두운 작업 표시줄),
//        assets/tray-light.ico (검은 선, 밝은 작업 표시줄), assets/tray-rec.ico (녹음 중, 빨강)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();

const SIZES = [16, 20, 24, 32];
const VARIANTS = { 'tray-dark.ico': '#ffffff', 'tray-light.ico': '#000000', 'tray-rec.ico': '#ff3b30' };

/** 24 눈금. 선 굵기는 작은 크기에서 픽셀에 맞도록 조금 굵게 */
function svg(color, px) {
  const w = px <= 16 ? 2.1 : px <= 20 ? 1.9 : 1.75;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none"
    stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">
    <path d="M5.2 19.2A10.4 10.4 0 1 1 20 17.6l1.4 4.2-4.4-1.2"/>
    <rect x="9" y="5.6" width="6" height="10" rx="3"/>
    <path d="M6.6 12.6a5.4 5.4 0 0 0 10.8 0"/>
    <path d="M12 18v3.6M9.4 21.6h5.2"/>
  </svg>`;
}

/** PNG 여러 장을 .ico 한 파일로 (PNG 압축 항목, Windows Vista 이후 지원) */
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, png }, i) => {
    const o = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, o);
    head.writeUInt8(size >= 256 ? 0 : size, o + 1);
    head.writeUInt8(0, o + 2);
    head.writeUInt8(0, o + 3);
    head.writeUInt16LE(1, o + 4);
    head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(png.length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.png)]);
}

async function render(win, color, px) {
  const html = `<html><body style="margin:0;background:transparent">${svg(color, px)}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 150));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: px, height: px });
  return img.resize({ width: px, height: px }).toPNG();
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 64, height: 64, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true },
  });
  const out = path.join(__dirname, '..', 'assets');
  for (const [name, color] of Object.entries(VARIANTS)) {
    const pngs = [];
    for (const size of SIZES) pngs.push({ size, png: await render(win, color, size) });
    fs.writeFileSync(path.join(out, name), ico(pngs));
    if (process.env.EZRITE_ICON_PREVIEW) {
      pngs.forEach(({ size, png }) => fs.writeFileSync(path.join(process.env.EZRITE_ICON_PREVIEW, `${name}-${size}.png`), png));
    }
    console.log('saved', name);
  }
  app.quit();
});
