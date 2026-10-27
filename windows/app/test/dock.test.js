'use strict';

// 1.2.1 설명할 때 화면 나누기 (맥 Dock.swift WindowDock). 창 목록·옮기기는 helper(windows·place)가 하고,
// 어느 창을 얼마나 줄일지는 lib/dock.js 가 정한다. 좌표는 모두 물리 픽셀
const test = require('node:test');
const assert = require('node:assert/strict');
const { WindowDock, plan, CARD_WIDTH, GAP } = require('../lib/dock');

const ME = 100;
const area = { x: 0, y: 0, w: 1920, h: 1040 }; // 작업 영역 (작업 표시줄 제외)
const bounds = { x: 0, y: 0, w: 1920, h: 1080 }; // 화면 전체
const geom = { area, bounds, reserve: CARD_WIDTH + GAP };
const win = (hwnd, pid, x, y, w, h) => ({ hwnd, pid, x, y, w, h });

test('맥과 같은 카드 자리: 폭 440 + 틈 8', () => {
  assert.equal(CARD_WIDTH, 440);
  assert.equal(GAP, 8);
});

test('화면을 가로로 s 배 누른 것처럼: x\' = 왼쪽 끝 + (x − 왼쪽 끝) × s, 너비 × s, 세로는 그대로', () => {
  const s = (1920 - 448) / 1920;
  const list = { foreground: 1, windows: [win(1, 7, -7, 0, 1934, 1047), win(2, 8, 960, 100, 800, 600)] };
  const p = plan(list, geom, ME);
  assert.deepEqual(p.map((x) => x.hwnd), [1, 2]);
  assert.deepEqual(p[0].from, { x: -7, y: 0, w: 1934, h: 1047 });
  assert.deepEqual(p[0].to, { x: Math.round(-7 * s), y: 0, w: Math.round(1934 * s), h: 1047 });
  assert.deepEqual(p[1].to, { x: Math.round(960 * s), y: 100, w: Math.round(800 * s), h: 600 });
  // 줄인 창은 카드 기둥(오른쪽 448)에 들어가지 않는다 (보이지 않는 테두리 7px 안쪽)
  for (const x of p) assert.ok(x.to.x + x.to.w <= 1920 - 448 + 7, JSON.stringify(x.to));
});

test('두 번째 화면(음수 좌표·다른 크기): 그 화면의 왼쪽 끝 기준', () => {
  const a = { x: -2560, y: -200, w: 2560, h: 1400 };
  const p = plan({ foreground: 0, windows: [win(5, 9, -2000, 0, 1000, 700)] }, { area: a, bounds: { x: -2560, y: -200, w: 2560, h: 1440 }, reserve: 672 }, ME);
  const s = (2560 - 672) / 2560;
  assert.deepEqual(p[0].to, { x: Math.round(-2560 + 560 * s), y: 0, w: Math.round(1000 * s), h: 700 });
});

test('우리 앱 창·그 화면과 겹치지 않는 창·전체 화면 창은 그대로 둔다', () => {
  const list = {
    foreground: 2,
    windows: [
      win(1, ME, 1500, 700, 340, 260), // 우리 녹음 팝업
      win(2, 7, 100, 100, 800, 600),
      win(3, 8, 2000, 0, 800, 600), // 다른 화면
      win(4, 9, 0, 0, 1920, 1080), // 맨 앞이 아닌 전체 화면 창 (영상 재생기 등)
    ],
  };
  assert.deepEqual(plan(list, geom, ME).map((x) => x.hwnd), [2]);
});

test('최대화한 창은 화면을 다 덮어도(작업 표시줄 자동 숨김) 전체 화면이 아니다 — 줄인다', () => {
  const max = { ...win(4, 9, -7, -7, 1934, 1094), max: true };
  const p = plan({ foreground: 4, windows: [max] }, geom, ME);
  assert.deepEqual(p.map((x) => x.hwnd), [4]);
  assert.equal(plan({ foreground: 4, windows: [{ ...max, max: false }] }, geom, ME), null, '최대화가 아닌데 다 덮으면 전체 화면');
});

test('맨 앞 창이 전체 화면이면 아무것도 하지 않는다 (카드는 예전처럼 위에 뜬다)', () => {
  const list = { foreground: 4, windows: [win(2, 7, 100, 100, 800, 600), win(4, 9, 0, 0, 1920, 1080)] };
  assert.equal(plan(list, geom, ME), null);
  // 맨 앞이 우리 창이면 (설명해줘를 누른 팝업) 그 뒤 창들은 줄인다
  const ours = { foreground: 1, windows: [win(1, ME, 0, 0, 1920, 1080), win(2, 7, 100, 100, 800, 600)] };
  assert.deepEqual(plan(ours, geom, ME).map((x) => x.hwnd), [2]);
});

function rig(list) {
  const placed = [];
  let lists = 0;
  const dock = new WindowDock({
    me: ME,
    list: async () => { lists++; return list; },
    place: async (items) => { placed.push(items); },
  });
  return { dock, placed, lists: () => lists };
}

test('dock → 줄이고, restore → 원래 자리·크기로. 되돌린 뒤에는 다시 할 일이 없다', async () => {
  const { dock, placed } = rig({ foreground: 2, windows: [win(2, 7, 100, 100, 800, 600)] });
  assert.equal(await dock.dock(geom), true);
  assert.equal(dock.docked, true);
  assert.deepEqual(placed[0], [{ hwnd: 2, ...plan({ foreground: 2, windows: [win(2, 7, 100, 100, 800, 600)] }, geom, ME)[0].to }]);
  await dock.restore();
  assert.deepEqual(placed[1], [{ hwnd: 2, x: 100, y: 100, w: 800, h: 600 }]);
  assert.equal(dock.docked, false);
  await dock.restore();
  assert.equal(placed.length, 2);
});

test('최대화한 창: 줄일 때는 먼저 최대화를 풀고(unmax), 되돌릴 때는 원래 배치(보통 크기 normal + 최대화)로. 되돌리기는 뒤 창부터', async () => {
  // Chromium 창(Chrome·Edge·Electron)은 최대화 상태에서 크기를 바꾸면 최대화 크기로 되돌아간다
  const maxWin = { ...win(1, 7, -8, -8, 1936, 1056), max: true, normal: [200, 100, 1400, 900] };
  const list = { foreground: 1, windows: [maxWin, win(2, 8, 100, 100, 800, 600)] };
  const { dock, placed } = rig(list);
  await dock.dock(geom);
  const to = plan(list, geom, ME);
  assert.deepEqual(placed[0], [{ hwnd: 1, ...to[0].to, unmax: true }, { hwnd: 2, ...to[1].to }]);
  await dock.restore();
  // 최대화하면 그 창이 맨 앞으로 오므로, 뒤 창부터 되돌려야 원래 겹침 순서가 된다
  assert.deepEqual(placed[1], [{ hwnd: 2, x: 100, y: 100, w: 800, h: 600 }, { hwnd: 1, x: -8, y: -8, w: 1936, h: 1056, restoreMax: [200, 100, 1400, 900] }]);
});

test('이미 붙어 있으면 다시 줄이지 않는다 (맥 docked) — 설명해줘를 또 눌러도 창이 더 작아지지 않는다', async () => {
  const r = rig({ foreground: 2, windows: [win(2, 7, 100, 100, 800, 600)] });
  await r.dock.dock(geom);
  assert.equal(await r.dock.dock(geom), true);
  assert.equal(r.lists(), 1);
  assert.equal(r.placed.length, 1);
});

test('전체 화면이면 false 이고 아무 창도 옮기지 않는다', async () => {
  const r = rig({ foreground: 4, windows: [win(4, 9, 0, 0, 1920, 1080)] });
  assert.equal(await r.dock.dock(geom), false);
  assert.equal(r.dock.docked, false);
  assert.deepEqual(r.placed, []);
});

test('줄일 창이 없어도 카드는 붙인다 (true)', async () => {
  const r = rig({ foreground: 0, windows: [] });
  assert.equal(await r.dock.dock(geom), true);
  assert.deepEqual(r.placed, []);
});

test('옮기다 실패해도(관리자 권한 창 등) 되돌릴 목록은 남겨 restore 때 원래대로 해 본다', async () => {
  const placed = [];
  let fail = true;
  const dock = new WindowDock({
    me: ME,
    list: async () => ({ foreground: 2, windows: [win(2, 7, 100, 100, 800, 600)] }),
    place: async (items) => { placed.push(items); if (fail) { fail = false; throw new Error('access denied'); } },
  });
  assert.equal(await dock.dock(geom), true);
  await dock.restore();
  assert.deepEqual(placed[1], [{ hwnd: 2, x: 100, y: 100, w: 800, h: 600 }]);
});

test('창 목록을 못 받으면(helper 오류) false, 붙지 않은 상태', async () => {
  const dock = new WindowDock({ me: ME, list: async () => { throw new Error('helper 없음'); }, place: async () => {} });
  assert.equal(await dock.dock(geom), false);
  assert.equal(dock.docked, false);
});

test('dock 과 restore 가 겹치면 순서대로 (줄이는 중에 닫아도 결국 원래대로)', async () => {
  const placed = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const dock = new WindowDock({
    me: ME,
    list: async () => { await gate; return { foreground: 2, windows: [win(2, 7, 100, 100, 800, 600)] }; },
    place: async (items) => { placed.push(items); },
  });
  const d = dock.dock(geom);
  const r = dock.restore();
  release();
  await Promise.all([d, r]);
  assert.equal(placed.length, 2);
  assert.deepEqual(placed[1], [{ hwnd: 2, x: 100, y: 100, w: 800, h: 600 }]);
  assert.equal(dock.docked, false);
});

test('idle: 줄인 창도 하는 일도 없을 때만 (끝낼 때 되돌리기를 기다릴지 정한다)', async () => {
  const { dock } = rig({ foreground: 2, windows: [win(2, 7, 100, 100, 800, 600)] });
  assert.equal(dock.idle, true);
  const d = dock.dock(geom);
  assert.equal(dock.idle, false, '줄이는 중');
  await d;
  assert.equal(dock.idle, false, '줄여 둔 상태');
  const r = dock.restore();
  assert.equal(dock.idle, false, '되돌리는 중');
  await r;
  assert.equal(dock.idle, true);
});
