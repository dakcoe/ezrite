'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ezrite', {
  /** Windows 11 Mica·Acrylic 바탕을 쓰는지 (main.js additionalArguments) */
  material: process.argv.includes('--ezrite-material'),
  /** 상태가 바뀔 때마다 fn(state). 처음 한 번은 바로 불린다 */
  onState: (fn) => {
    ipcRenderer.on('state', (_e, s) => fn(s));
    ipcRenderer.invoke('state:get').then(fn);
  },
  onLevel: (fn) => ipcRenderer.on('level', (_e, v) => fn(v)),
  /** sourceId · language · page · compact · options{...} 일부를 바꾼다 */
  set: (patch) => ipcRenderer.invoke('state:set', patch),
  refresh: () => ipcRenderer.invoke('sources:refresh'),
  startRecord: () => ipcRenderer.invoke('record:start'),
  stopRecord: () => ipcRenderer.invoke('record:stop'),
  togglePause: () => ipcRenderer.invoke('record:pause'),
  openMain: (page) => ipcRenderer.invoke('window:main', page),
  openOnboarding: () => ipcRenderer.invoke('window:onboarding'),
  fitHeight: (h) => ipcRenderer.invoke('window:fit', h),
  quit: () => ipcRenderer.invoke('app:quit'),
  /** 설명해줘: 지금 화면과 최근 강의 말을 AI 가 짚어 설명한다 (화면 사진은 main 에서만 다룬다) */
  explain: () => ipcRenderer.invoke('explain:run'),
  /** 새 버전: [받기] 는 main 이 확인한 GitHub 주소만 연다 */
  update: {
    download: () => ipcRenderer.invoke('update:download'),
    skip: () => ipcRenderer.invoke('update:skip'),
    check: () => ipcRenderer.invoke('update:check'),
  },
  /** 팝업 위 "새 버전" 띠 높이 (그만큼 팝업이 커진다) */
  bannerHeight: (h) => ipcRenderer.invoke('popup:banner', h),
  openGuide: () => ipcRenderer.invoke('window:guide'),
  openIssue: () => ipcRenderer.invoke('open:issue'),
  openNotices: () => ipcRenderer.invoke('open:notices'),
  openMicSettings: () => ipcRenderer.invoke('open:micSettings'),
  onboardingDone: () => ipcRenderer.invoke('onboarding:done'),
  /** 키는 main 으로 보내기만 한다. 돌려받는 것은 상태의 hasKey(있다/없다)와 keyStatus 뿐 */
  saveKey: (provider, key) => ipcRenderer.invoke('key:save', provider, key),
  removeKey: (provider) => ipcRenderer.invoke('key:remove', provider),
  /** 그 서비스의 키 발급 페이지 (주소는 main 이 정한다) */
  openKeyPage: (provider = 'groq') => ipcRenderer.invoke('open:keyPage', provider),
  /** 기능별 AI 고르기: { feature: 'translate'|'explain', provider } 또는 { feature, model } */
  chooseAI: (choice) => ipcRenderer.invoke('ai:choose', choice),
  /** 녹음 기록 저장됨 띠: [기록 보기] · ✕ · 탐색기에서 보기 (어느 기록인지는 main 이 안다) */
  saved: {
    open: () => ipcRenderer.invoke('saved:open'),
    dismiss: () => ipcRenderer.invoke('saved:dismiss'),
    reveal: () => ipcRenderer.invoke('saved:reveal'),
  },
  /** 지난 기록: 경로는 main 이 저장 폴더 안의 기록인지 다시 확인한다 */
  history: {
    open: (p) => ipcRenderer.invoke('history:open', p),
    close: () => ipcRenderer.invoke('history:close'),
    rename: (p, title) => ipcRenderer.invoke('history:rename', p, title),
    remove: (p) => ipcRenderer.invoke('history:delete', p),
    exportTo: (p) => ipcRenderer.invoke('history:export', p),
    copy: (p) => ipcRenderer.invoke('history:copy', p),
    reveal: (p) => ipcRenderer.invoke('history:reveal', p),
  },
  chooseNotesFolder: () => ipcRenderer.invoke('notes:choose'),
  defaultNotesFolder: () => ipcRenderer.invoke('notes:default'),
});
