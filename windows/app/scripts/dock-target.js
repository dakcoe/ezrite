'use strict';
require('./guard');
// 화면 나누기 확인(check-split.js)이 줄였다 되돌릴 시험용 창 둘. 사용자의 창 대신 이 프로세스의 창만 옮긴다 (EZRITE_DOCK_ONLY).
// 보이지 않게(불투명도 0), 클릭은 아래로 통과, 포커스를 가져가지 않는다 (focusable: false → WS_EX_NOACTIVATE).
//   A: 보통 창 (작업 영역 왼쪽 위 근처 700×500)   B: 최대화한 창
// 창이 뜨면 두 창의 자리·크기·최대화를 JSON 한 줄로 쓴다. 끝내는 건 부른 쪽이 프로세스를 끝내서 한다.
const { app, BrowserWindow, screen } = require('electron');

app.whenReady().then(() => {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const make = (title) => {
    const w = new BrowserWindow({ show: false, title, opacity: 0, focusable: false, skipTaskbar: true, backgroundColor: '#ffffff' });
    w.setIgnoreMouseEvents(true);
    w.on('page-title-updated', (e) => e.preventDefault());
    return w;
  };
  const a = make('Ezrite dock test A');
  a.setBounds({ x: d.workArea.x + 120, y: d.workArea.y + 90, width: 700, height: 500 });
  a.showInactive();
  const b = make('Ezrite dock test B');
  b.maximize();
  const report = () => process.stdout.write(`${JSON.stringify({
    pid: process.pid, display: d.id,
    a: { bounds: a.getBounds(), max: a.isMaximized() }, b: { bounds: b.getBounds(), max: b.isMaximized() },
  })}\n`);
  setTimeout(report, 800);
  // 부른 쪽이 죽어도 남지 않게 1분 뒤에는 스스로 끝낸다
  setTimeout(() => app.exit(0), 60_000).unref();
});
