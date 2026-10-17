'use strict';

// 설명 카드(renderer/explain/explain.html)용. 맥 카드 페이지가 부르는 window.webkit.messageHandlers 를
// 같은 이름으로 만들어 main 에 전한다 (내용 높이·장면 번호·질문). 그 밖의 것은 내주지 않는다
const { contextBridge, ipcRenderer } = require('electron');

const relay = (name) => ({ postMessage: (v) => ipcRenderer.send(`card:${name}`, v) });

contextBridge.exposeInMainWorld('webkit', {
  messageHandlers: { height: relay('height'), scene: relay('scene'), ask: relay('ask') },
});
