'use strict';

// 설명할 때 화면 나누기 (1.2.1, 맥 Dock.swift WindowDock). 설명 카드가 슬라이드를 가리지 않게, 그 화면의 창들을
// 같은 비율로 왼쪽에 줄여 넣고 오른쪽 빈 자리에 카드를 붙인다.
// 화면을 가로로 s 배 누른 것처럼 x' = 왼쪽 끝 + (x − 왼쪽 끝) × s, 너비' = 너비 × s (세로는 그대로).
// 창 안 내용은 앱이 다시 배치한다. 카드를 닫거나 앱을 끄면 모두 원래 자리·크기로 돌려 놓는다.
// 맨 앞 창이 전체 화면이면 그대로 둔다 (카드는 예전처럼 위에 뜬다).
//
// 창 목록·옮기기는 helper 가 한다 (main.js 가 넣어 준다). 좌표는 모두 물리 픽셀:
//   list() → { foreground: hwnd, windows: [{ hwnd, pid, x, y, w, h, max, normal? }] }
//            (보이는 최상위 창, 맨 앞부터. max: 최대화, normal: 최대화한 창의 보통 크기 자리 — 되돌릴 때 그대로 돌려준다)
//   place([{ hwnd, x, y, w, h, unmax?, restoreMax? }])  — 포커스·겹침 순서는 건드리지 않고 자리·크기만.
//            unmax: 먼저 최대화를 푼다 (활성화 없이). restoreMax: 그 보통 크기 자리로 두고 다시 최대화 (이때는 그 창이 앞으로 온다)

const CARD_WIDTH = 440; // 맥 WindowDock.cardWidth
const GAP = 8; // 맥 leftArea: 화면너비 − cardWidth − 8

const covers = (r, b) => r.x <= b.x && r.y <= b.y && r.x + r.w >= b.x + b.w && r.y + r.h >= b.y + b.h;
const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const rect = (w) => ({ x: w.x, y: w.y, w: w.w, h: w.h });
// 전체 화면: 화면을 다 덮고 최대화가 아닌 창 (슬라이드 쇼·F11·영상). 작업 표시줄을 자동으로 숨기면 최대화한 창도 다 덮는다
const fullscreen = (w, bounds) => !w.max && covers(rect(w), bounds);

/**
 * 어느 창을 어디로 옮길지. 맨 앞 창(우리 창 제외)이 전체 화면이면 null.
 * geom: { area: 작업 영역, bounds: 화면 전체, reserve: 오른쪽에 비울 폭(카드 + 틈) }. me: 우리 프로세스 id
 */
function plan(list, { area, bounds, reserve }, me) {
  const windows = Array.isArray(list?.windows) ? list.windows : [];
  const front = windows.find((w) => w.hwnd === list.foreground);
  if (front && front.pid !== me && fullscreen(front, bounds)) return null;
  const s = (area.w - reserve) / area.w;
  const out = [];
  for (const w of windows) {
    const r = rect(w);
    if (w.pid === me || !intersects(r, area) || fullscreen(w, bounds)) continue;
    out.push({
      hwnd: w.hwnd, from: r, to: { x: Math.round(area.x + (r.x - area.x) * s), y: r.y, w: Math.round(r.w * s), h: r.h },
      max: Boolean(w.max), normal: w.normal ?? null,
    });
  }
  return out;
}

class WindowDock {
  constructor({ list, place, me }) {
    Object.assign(this, { list, place, me });
    this.saved = [];
    this.docked = false;
    this.queue = Promise.resolve(); // dock·restore 는 차례로 (줄이는 중에 카드를 닫아도 결국 원래대로)
    this.pending = 0;
  }

  /** 줄인 창도, 하고 있는 일도 없다 (끝낼 때 되돌리기를 기다릴지) */
  get idle() {
    return !this.docked && this.pending === 0;
  }

  serial(fn) {
    this.pending++;
    const run = this.queue.then(fn).finally(() => { this.pending--; });
    this.queue = run.catch(() => {});
    return run;
  }

  /** 줄이고 카드를 옆에 붙여도 되면 true (전체 화면·창 목록 실패면 false). 이미 붙어 있으면 그대로 true */
  dock(geom) {
    return this.serial(async () => {
      if (this.docked) return true;
      let list;
      try {
        list = await this.list();
      } catch {
        return false;
      }
      const p = plan(list, geom, this.me);
      if (!p) return false;
      // 옮기다 일부 실패해도(관리자 권한 창) 되돌릴 목록은 남긴다 — 원래 자리로 보내는 건 해 봐도 해가 없다
      this.saved = p;
      this.docked = true;
      // 최대화한 창은 먼저 최대화를 푼다 (Chromium 창은 최대화 상태에서 크기를 바꾸면 최대화 크기로 되돌아간다)
      if (p.length) await this.place(p.map((x) => ({ hwnd: x.hwnd, ...x.to, ...(x.max ? { unmax: true } : {}) }))).catch(() => {});
      return true;
    });
  }

  /** 줄였던 창들을 원래대로 */
  restore() {
    return this.serial(async () => {
      const saved = this.saved;
      this.saved = [];
      this.docked = false;
      // 최대화했던 창은 원래 배치(보통 크기 + 최대화)로. 최대화하면 그 창이 맨 앞으로 오므로 뒤 창부터 되돌려 겹침 순서를 지킨다
      const back = saved.slice().reverse().map((x) => ({ hwnd: x.hwnd, ...x.from, ...(x.max && x.normal ? { restoreMax: x.normal } : {}) }));
      if (back.length) await this.place(back).catch(() => {});
    });
  }
}

module.exports = { WindowDock, plan, CARD_WIDTH, GAP };
