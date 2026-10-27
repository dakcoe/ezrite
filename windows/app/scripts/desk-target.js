'use strict';
require('./guard');
// 가상 데스크톱 확인(check-desktops.js)의 기준 창: "설명할 때 앞에 있던 강의 창" 자리. 사용자의 창 대신 이 창을 쓴다 (EZRITE_DOCK_ONLY).
// 데스크톱 관리자가 맡으려면 작업 표시줄에 있는 보통 창이어야 한다 (skipTaskbar 면 모든 데스크톱에 떠서 기준이 못 된다).
// 보이지 않게(불투명도 0), 클릭은 아래로 통과, 뜰 때 포커스를 가져가지 않는다 (showInactive).
// 창이 뜨면 pid 와 창 핸들을 JSON 한 줄로 쓴다. 끝내는 건 부른 쪽이 프로세스를 끝내서 한다.
const { app, BrowserWindow, screen } = require('electron');

app.whenReady().then(() => {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const w = new BrowserWindow({ show: false, title: 'Ezrite desktop test', opacity: 0, backgroundColor: '#ffffff' });
  w.setIgnoreMouseEvents(true);
  w.on('page-title-updated', (e) => e.preventDefault());
  w.setBounds({ x: d.workArea.x + 120, y: d.workArea.y + 90, width: 700, height: 500 });
  w.showInactive();
  setTimeout(() => process.stdout.write(`${JSON.stringify({ pid: process.pid, hwnd: w.getNativeWindowHandle().readBigUInt64LE(0).toString() })}\n`), 800);
  // 부른 쪽이 죽어도 남지 않게 2분 뒤에는 스스로 끝낸다
  setTimeout(() => app.exit(0), 120_000).unref();
});
