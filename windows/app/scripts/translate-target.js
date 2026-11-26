'use strict';
// 화면 번역 시험용 대상 창 (scripts/check-screentx.js 가 따로 띄운다). 사용자 화면에 보이지 않게 화면 밖(x -6000)에 둔다.
//   npx electron scripts/translate-target.js <신호 파일>
// 영어 글이 든 창을 띄우고, 신호 파일이 생기면 아래로 200px 스크롤한다 (새 문단이 나오고 몇 개는 위로 밀려 나간다).
// 시험이 첫 읽기를 본 뒤에 파일을 만든다 (정한 초에 스크롤하면 시험이 느릴 때 번역 시작 전에 스크롤해 버렸다).
// 부모(시험)가 끝나면 함께 끝난다.
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const fs = require('node:fs');

const signal = process.argv.at(-1);
const PARAS = [
  'Attention lets every position look at every other position, so distant words can influence each other directly.',
  'Before transformers, sequence models read one word at a time and struggled to remember what came long before.',
  'This simple idea made training faster and models far more capable than recurrent networks.',
  'Positional encodings tell the model where each word sits, because attention alone ignores order.',
  'Layer normalization keeps the activations in a stable range so that deep stacks can still be trained.',
  'Residual connections let gradients flow around each block and make very deep models practical.',
  'The decoder generates one token at a time and feeds each new token back as input for the next step.',
  'Beam search keeps several candidate sentences and picks the most likely one at the end.',
];
const html = `<!doctype html><meta charset="utf-8"><title>Ezrite 번역 시험</title>
<style>body { margin: 0; padding: 24px 32px; font: 17px/1.55 'Segoe UI'; background: #fff; color: #222; } h1 { font-size: 26px; margin: 0 0 16px; } p { margin: 0 0 16px; }</style>
<h1>Why Attention Changed Everything</h1>${PARAS.map((p) => `<p>${p}</p>`).join('')}`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ x: -6000, y: 100, width: 760, height: 520, show: false, title: 'Ezrite 번역 시험', webPreferences: { backgroundThrottling: false } });
  win.on('page-title-updated', (e) => e.preventDefault());
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  win.showInactive();
  const poll = setInterval(() => {
    if (!fs.existsSync(signal)) return;
    clearInterval(poll);
    win.webContents.executeJavaScript('window.scrollBy(0, 200); 0');
  }, 200);
  // 부모가 끝나면 끝낸다
  const parent = process.ppid;
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      app.exit(0);
    }
  }, 1000);
  setTimeout(() => app.exit(0), 90_000);
});
