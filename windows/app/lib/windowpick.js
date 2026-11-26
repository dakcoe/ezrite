'use strict';

// 화면 번역: 마우스로 가리켜 창 고르기의 계산 (맥 창 고르기 패널과 같다). Electron 없이 시험한다.
// windows: helper `windows` 목록 (맨 앞부터, 물리 픽셀 x·y·w·h). 이 앱 창은 빼고 넘긴다.

/** 물리 픽셀 점 아래 맨 앞 창 (없으면 null) */
function windowAt(windows, p) {
  if (!p) return null;
  return windows.find((w) => p.x >= w.x && p.x < w.x + w.w && p.y >= w.y && p.y < w.y + w.h) ?? null;
}

/**
 * 고른 창의 강조 자리를 패널(그 화면) 좌표로. toDip: 물리 사각형 {x,y,width,height} → DIP 사각형.
 * 화면 밖으로 나간 부분도 그대로 둔다 (패널이 잘라 보인다)
 */
function panelRect(win, display, toDip) {
  if (!win) return null;
  const r = toDip({ x: win.x, y: win.y, width: win.w, height: win.h });
  return {
    x: Math.round(r.x - display.bounds.x), y: Math.round(r.y - display.bounds.y), w: Math.round(r.width), h: Math.round(r.height), title: win.title ?? '',
  };
}

module.exports = { windowAt, panelRect };
