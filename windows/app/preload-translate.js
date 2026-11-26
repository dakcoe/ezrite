'use strict';

// 화면 번역 덮개 창(renderer/translate/overlay.html)용. main 이 보내는 그리기·원문 보기만 받는다. 보내는 것은 없다
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ezTranslate', {
  onDraw: (fn) => ipcRenderer.on('tx:draw', (_e, d) => fn(d)),
  onReveal: (fn) => ipcRenderer.on('tx:reveal', (_e, key) => fn(key)),
});
