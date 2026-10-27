'use strict';

// 가상 데스크톱 (1.2.2, 맥 1.2.2 와 같은 결과). 설명해줘를 누르고 다른 데스크톱으로 넘어가도
//   - 설명 카드는 지금 보는 데스크톱에 보인다: 카드·표시·팝업은 작업 표시줄에 없는 창이라 Windows 가 원래 모든 데스크톱에 보인다
//   - ①②③ 표시는 짚은 글자가 있는 데스크톱에서만 보인다: 여기서 그 데스크톱이 지금 보이는지 지켜본다
// 우리 창은 데스크톱이 정해져 있지 않아 기준이 못 되므로, 설명할 때 그 화면 앞에 있던 다른 프로그램 창(기준 창)으로 본다.
// helper `desktop-watch --hwnd 후보들` 이 후보 가운데 데스크톱이 정해진 첫 창을 골라
// IVirtualDesktopManager.IsWindowOnCurrentVirtualDesktop(공개 API)로 0.25초마다 보고, 바뀔 때만 JSON 한 줄을 쓴다.
//   list() → helper `windows` 출력 (lib/dock.js 와 같다, 물리 픽셀)
//   spawn(args, onLine) → { kill() }  — 오래 도는 helper 를 띄워 stdout 한 줄마다 onLine

const MAX_CANDIDATES = 8;

const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** 그 화면(area, 물리 픽셀)에 걸친 다른 프로그램 창, 맨 앞부터 */
function candidates(list, area, me) {
  const windows = Array.isArray(list?.windows) ? list.windows : [];
  return windows.filter((w) => w.pid !== me && intersects(w, area)).slice(0, MAX_CANDIDATES).map((w) => w.hwnd);
}

/** helper 한 줄 → { on } | { unknown } | null(무시: 빈 줄은 살아 있음 표시) */
function readLine(line) {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return null;
  }
  if (m?.anchor === null || m?.gone === true) return { unknown: true };
  return typeof m?.on === 'boolean' ? { on: m.on } : null;
}

class DesktopWatch {
  constructor({ list, spawn, me }) {
    Object.assign(this, { list, spawn, me });
  }

  /** onChange(on). 기준 창 후보가 없거나 목록을 못 읽으면 null. 기준 창이 없거나 닫히면 늘 보이는 것으로 */
  async watch(area, onChange) {
    let list;
    try {
      list = await this.list();
    } catch {
      return null;
    }
    const hwnds = candidates(list, area, this.me);
    if (!hwnds.length) return null;
    let stopped = false;
    const proc = this.spawn(['desktop-watch', '--hwnd', hwnds.join(',')], (line) => {
      if (stopped) return;
      const m = readLine(line);
      if (m) onChange(m.unknown ? true : m.on);
    });
    return {
      stop() {
        stopped = true;
        proc.kill();
      },
    };
  }
}

module.exports = { DesktopWatch, candidates, readLine, MAX_CANDIDATES };
