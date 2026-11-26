'use strict';

// 화면 번역의 창 고르기 패널(renderer/translate/picker.html)용: 강조할 자리를 받고, 누름·취소만 보낸다
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ezPick', {
  onHighlight: (fn) => ipcRenderer.on('pick:hl', (_e, r) => fn(r)),
  click: () => ipcRenderer.send('pick:click'),
  cancel: () => ipcRenderer.send('pick:cancel'),
});
