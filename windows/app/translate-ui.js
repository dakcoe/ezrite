'use strict';

// 화면 번역 덮개 창 (실험 기능, 1.3.2 예정). 고른 창 바로 위에 투명한 창을 띄워 번역을 그린다.
// 클릭은 통과하고(setIgnoreMouseEvents), 포커스를 받지 않고, 작업 표시줄에 없다. 제목이 비어 있어 helper 의 창 목록·앞 창 계산에도 안 잡힌다.
// 그림은 물리 픽셀로 그린다 (canvas 크기 = 찍은 그림 크기, CSS 크기 = DIP). renderer/translate/overlay.* , preload-translate.js

const path = require('node:path');
const { BrowserWindow, screen } = require('electron');

function createOverlay({ onShown = () => {} } = {}) {
  const win = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    title: '',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload-translate.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, 'floating');
  win.on('page-title-updated', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'translate', 'overlay.html'));
  const ready = new Promise((r) => win.webContents.once('did-finish-load', r));

  const dip = (rect) => {
    const r = screen.screenToDipRect(null, { x: rect.x, y: rect.y, width: rect.w, height: rect.h });
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) };
  };

  return {
    win,
    /** rect: 찍은 창 자리(물리 픽셀), items: [{ block, text }], scale: 그림 픽셀 / 1배 px */
    async show(rect, items, scale) {
      if (win.isDestroyed()) return;
      await ready;
      win.setBounds(dip(rect));
      win.webContents.send('tx:draw', { width: rect.w, height: rect.h, scale, items });
      if (!win.isVisible()) {
        win.showInactive();
        onShown();
      }
    },
    move(rect) {
      if (!win.isDestroyed()) win.setBounds(dip(rect));
    },
    hide() {
      if (!win.isDestroyed() && win.isVisible()) win.hide();
    },
    reveal(key) {
      if (!win.isDestroyed()) win.webContents.send('tx:reveal', key);
    },
    close() {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}

/**
 * 번역할 창 고르기 패널: 화면(display) 하나를 덮는 거의 투명한 창. 마우스 아래 창을 파랗게 보여 주고 누르면 고른다 (맥과 같다).
 * 누름은 패널이 받으므로 아래 창에는 가지 않는다. 제목이 비어 있어 helper 창 목록에 안 잡힌다
 */
function createPicker(display) {
  const win = new BrowserWindow({
    ...display.bounds,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    title: '',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload-picker.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.on('page-title-updated', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'translate', 'picker.html'));
  let last = null; // 읽는 중에 온 강조는 다 읽은 뒤 보낸다 (안 그러면 마우스가 다른 창으로 갈 때까지 안 보였다)
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.setBounds(display.bounds); // 배율이 다른 화면에서도 그 화면을 꼭 맞게
    win.show();
    win.webContents.send('pick:hl', last);
  });
  return {
    win,
    display,
    /** r: 이 패널 안 좌표(DIP) { x, y, w, h, title } 또는 null */
    highlight(r) {
      last = r;
      if (!win.isDestroyed() && !win.webContents.isLoading()) win.webContents.send('pick:hl', r);
    },
    focus() {
      if (!win.isDestroyed()) win.focus();
    },
    close() {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}

module.exports = { createOverlay, createPicker };
