'use strict';
require('./guard'); // 오류가 나도 화면에 창을 띄우지 않고 종료 코드 1
// 1.3.0 설명 표시 방식을 실제 창으로 본다. 창은 화면에 띄우지 않는다 (AI·화면 찍기·사용자 설정 없음).
//   npx electron scripts/check-markstyle.js   → 결과 JSON 한 줄, 하나라도 틀리면 종료 코드 1
// test/markstyle-ui.test.js 가 부른다:
//   표시 창(overlay.html): 열두 방식이 canvas 에 그려지고, 예전 방식은 SVG 상자. 스포트라이트는 나머지를 어둡게·짚은 곳은 구멍
//   설명 카드(explain-ui createCard): 발자취 목록·색 막대·지도·점, 마우스 올린 항목·카드 글 자리를 앱에 알림, 접기·펼치기,
//   글자가 적은 자리로 옮기기, 방식 바꾸기(restyle)
// EZRITE_MARK_SHOT=<폴더> 이면 방식마다 표시 창을 흰 바탕에 그려 png 로 남긴다.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-markstyle-'));
const { app, BrowserWindow } = require('electron');
for (const m of ['show', 'showInactive', 'focus', 'moveTop']) BrowserWindow.prototype[m] = function noop() {};
app.setPath('userData', path.join(tmp, 'userData'));

const E = require('../lib/explain');
const M = require('../lib/markstyle');
const ExplainUI = require('../explain-ui');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(80);
  }
  return null;
}

// 화면 1200×700. 줄 1·2·4 는 가로로 긴 줄, 3 은 그림 속 라벨
const W = 1200;
const H = 700;
const L = (id, text, x, y, w, h) => ({ id, text, box: { x: x / W, y: y / H, w: w / W, h: h / H } });
const LINES = [L(1, '손실 L = (y - ŷ)²', 120, 140, 360, 26), L(2, '∂L/∂w = ∂L/∂ŷ · ∂ŷ/∂w', 120, 260, 420, 26),
  L(3, 'ŷ', 820, 400, 40, 34), L(4, '연쇄 법칙으로 거슬러 올라간다', 120, 520, 460, 26)];
const RESULT = JSON.stringify({
  marks: [{ id: 1, note: '출발점' }, { id: 2, note: '곱하기' }],
  path: { ids: [2, 3], note: '거꾸로' },
  summary: '역전파는 출력의 오차를 거꾸로 나눠 준다. 각 층은 받은 값에 자기 몫만 곱한다.',
  visuals: [],
  scenes: [
    { say: '출발점은 손실 L 이다, 가장 쉬운 한 칸', focus: [1], arrow: null, visual: null, reveal: null, tag: '출발점' },
    { say: '받은 값에 내 몫을 곱한다', focus: [2], arrow: { from: 2, to: 3 }, visual: null, reveal: null, tag: '넘어온 값 × 내 몫' },
    { say: '다시 처음 줄로 돌아가 본다', focus: [1], arrow: null, visual: null, reveal: null, tag: '다시' },
  ],
});

function modelFor(style, patch = {}) {
  const { model } = E.presentation(RESULT, { data: RESULT }, LINES, { style });
  return { ...model, others: LINES.map((l) => l.box), ...patch };
}

async function main() {
  const out = { ok: false, overlay: {}, card: {} };
  try {
    await app.whenReady();
    const shots = process.env.EZRITE_MARK_SHOT;
    // ── 표시 창 ──
    const ov = new BrowserWindow({ width: W, height: H, useContentSize: true, show: false, frame: false, backgroundColor: shots ? '#ffffff' : '#00000000', transparent: !shots,
      webPreferences: { contextIsolation: true, sandbox: true } });
    await ov.loadFile(path.join(__dirname, '..', 'renderer', 'explain', 'overlay.html'));
    ov.webContents.debugger.attach('1.3');
    // "동작 줄이기": 다 그려진 모습을 바로 (숨긴 창에서는 rAF 가 거의 돌지 않는다)
    await ov.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const js = (s) => ov.webContents.executeJavaScript(s);
    const size = await js('({ w: innerWidth, h: innerHeight })');
    // 그린 뒤 canvas 의 칠해진 점 수와 몇 곳의 색
    const look = (pts) => js(`(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const c = document.getElementById('canvas'), x = c.getContext('2d'), k = c.width / innerWidth;
      const d = x.getImageData(0, 0, c.width, c.height).data;
      let ink = 0; for (let i = 3; i < d.length; i += 16) if (d[i] > 0) ink++;
      const at = (p) => { const i = (Math.round(p.y * k) * c.width + Math.round(p.x * k)) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
      return { ink, px: ${JSON.stringify(pts)}.map(at), svg: document.querySelectorAll('#marks rect').length };
    })()`);
    const dim = { w: size.w, h: size.h };
    const pts = [{ x: 5, y: 5 }, { x: 300, y: 153 }, { x: 98, y: 161 }]; // 화면 구석, 줄 1 가운데, 줄 1 왼쪽 번호표 (글자 아래)
    for (const style of M.IDS) {
      const m = modelFor(style, style === 'hover' ? { hover: 's0' } : style === 'leader' ? { anchors: { say: { x: 1100, y: 80 } } } : {});
      const m0 = { ...m, scene: 0 };
      const payload = style === 'classic' ? { style, shapes: E.shapes(m0, { width: dim.w, height: dim.h }), scene: true } : { style, data: E.markData(m0, { width: dim.w, height: dim.h }) };
      await js(`draw(${JSON.stringify(payload)})`);
      out.overlay[style] = await look(pts);
      if (shots) {
        fs.mkdirSync(shots, { recursive: true });
        fs.writeFileSync(path.join(shots, `overlay-${style}.png`), (await ov.webContents.capturePage()).toPNG());
        // 전체 보기(장면 없음 = 복습 지도)도
        const all = { ...m, scene: null };
        const p2 = style === 'classic' ? { style, shapes: E.shapes(all, { width: dim.w, height: dim.h }), scene: false } : { style, data: E.markData(all, { width: dim.w, height: dim.h }) };
        await js(`draw(${JSON.stringify(p2)})`);
        await wait(100);
        fs.writeFileSync(path.join(shots, `overlay-${style}-all.png`), (await ov.webContents.capturePage()).toPNG());
      }
    }
    // 발자취 전체 보기: 같은 줄을 두 장면이 짚으면 "1·3"
    await js(`draw(${JSON.stringify({ style: 'trail', data: E.markData({ ...modelFor('trail'), scene: null }, { width: dim.w, height: dim.h }) })})`);
    out.overlay.trailAll = await look(pts);

    // ── 설명 카드 ──
    const calls = { hover: [], anchors: [], scene: [] };
    const card = ExplainUI.createCard({
      onClose() {}, onAsk() {}, onScene: (i) => calls.scene.push(i),
      onHover: (r) => calls.hover.push(r), onAnchors: (a) => calls.anchors.push(a),
    });
    const wc = card.win.webContents;
    const cj = (s) => wc.executeJavaScript(s);
    await until(() => !wc.isLoading());
    wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const display = require('electron').screen.getPrimaryDisplay();
    card.show(display, null);
    const { payload, model } = E.presentation(RESULT, { data: RESULT }, LINES, { style: 'trail' });
    payload.map = E.mapPayload(model, 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', W / H);
    card.render({ ...payload, scene: 'all' });
    await until(() => cj('!!document.querySelector(".player")'));
    await wait(400);
    out.card.trail = await cj(`({ cap: document.querySelector('.order-cap')?.textContent, badges: [...document.querySelectorAll('.order-cap + .marks .badge')].map((b) => b.textContent),
      dots: document.querySelectorAll('.marks .dot').length, chips: document.querySelectorAll('.chip').length, hov: document.body.classList.contains('hov') })`);
    if (shots) { wc.invalidate(); await wait(800); fs.writeFileSync(path.join(shots, 'card-trail.png'), (await wc.capturePage()).toPNG()); }
    // 마우스를 올리면 앱에 그 항목을 알린다 (s1: 둘째 장면)
    await cj(`document.querySelector('[data-ref="s1"]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
    await until(() => calls.hover.includes('s1'), 3000);
    out.card.hover = [...calls.hover];
    // 방식 바꾸기: 색으로 짝 맞추기 → 목록은 색 막대, 장면 번호는 짚은 곳 색
    await cj('restyle("colors")');
    await until(() => cj('document.querySelectorAll(".marks .cbar").length === 2'), 3000);
    out.card.colors = await cj(`({ bars: [...document.querySelectorAll('.marks .cbar')].map((b) => getComputedStyle(b).backgroundColor), order: !!document.querySelector('.order-cap') })`);
    // 지도: 장면 재생기 아래 축소 화면과 길 그림
    await cj('restyle("minimap")');
    await until(() => cj('!!document.querySelector(".player .mm img")'), 3000);
    out.card.minimap = await cj(`({ img: !!document.querySelector('.player .mm img'), rects: document.querySelectorAll('.mm svg rect').length, route: !!document.querySelector('.route') })`);
    // 선 긋기: 카드 글의 화면 자리를 알린다 (카드 왼쪽 가장자리, 화면 좌표)
    calls.anchors.length = 0;
    await cj('restyle("leader")');
    await until(() => calls.anchors.length > 0, 3000);
    const cb = card.win.getContentBounds();
    out.card.anchors = calls.anchors.at(-1);
    out.card.contentX = cb.x;
    // 접기 → 자막 두 줄만, 창이 줄어든다. 새 설명이 오면 저절로 펼친다
    await wait(300);
    const before = card.win.getBounds().height;
    await cj('document.getElementById("fold").click()');
    await until(() => card.win.getBounds().height < before, 3000);
    if (shots) { wc.invalidate(); await wait(800); fs.writeFileSync(path.join(shots, 'card-folded.png'), (await wc.capturePage()).toPNG()); }
    out.card.fold = { before, folded: card.win.getBounds().height, body: await cj('document.body.classList.contains("folded")'),
      ask: await cj('getComputedStyle(document.getElementById("ask")).display') };
    card.render(payload);
    await until(() => card.win.getBounds().height >= before - 1, 3000);
    out.card.fold.after = card.win.getBounds().height;
    out.card.fold.bodyAfter = await cj('document.body.classList.contains("folded")');
    // 글자가 적은 자리: 오른쪽 절반이 글자로 차 있으면 왼쪽으로
    const wa = display.workArea;
    const right = [{ id: 1, text: 'x', box: { x: 0.5, y: 0, w: 0.5, h: 1 } }];
    card.place(right, { ...display, bounds: wa, workArea: wa }, null);
    out.card.place = { x: card.win.getBounds().x, width: card.win.getBounds().width, mid: wa.x + wa.width / 2 };
    card.close();

    const o = out.overlay;
    const inked = (s) => o[s].ink > 30;
    const isAccent = ([r, g, b, a]) => a > 150 && r > 200 && g > 70 && g < 140 && b < 90;
    out.checks = {
      allStylesDraw: M.IDS.filter((s) => s !== 'classic').every(inked),
      classicIsSvg: o.classic.svg > 0 && o.classic.ink === 0,
      spotlightDimsElsewhere: o.spotlight.px[0][3] > 20, // 3.6초 뒤에도 옅게 남는다 (맥 0.2)
      spotlightHole: o.spotlight.px[1][3] === 0,
      trailBadge: isAccent(o.trail.px[2]),
      trailReview: isAccent(o.trailAll.px[2]),
      cardTrailOrder: out.card.trail.cap === '설명 순서 — 번호는 화면의 번호와 같습니다' && out.card.trail.badges.join() === '1,2,3'
        && out.card.trail.dots === 2 && out.card.trail.chips === 0 && out.card.trail.hov,
      cardHover: out.card.hover.includes('s1'),
      cardColors: out.card.colors.bars.length === 2 && out.card.colors.bars[0] === 'rgb(124, 92, 255)' && !out.card.colors.order,
      cardMinimap: out.card.minimap.img && out.card.minimap.rects >= 3 && !out.card.minimap.route,
      cardAnchors: Object.keys(out.card.anchors ?? {}).some((k) => /^m\d$/.test(k) || k === 'say') && Object.values(out.card.anchors).every((p) => p.x === out.card.contentX),
      cardFolds: out.card.fold.body && out.card.fold.folded < out.card.fold.before && out.card.fold.ask === 'none',
      cardUnfoldsOnNew: !out.card.fold.bodyAfter && out.card.fold.after >= out.card.fold.before - 1,
      cardPlacedLeft: out.card.place.x + out.card.place.width <= out.card.place.mid + 1,
    };
    out.ok = Object.values(out.checks).every(Boolean);
  } catch (e) {
    out.error = e.stack;
  }
  console.log(JSON.stringify(out));
  app.exit(out.ok ? 0 : 1);
}

main();
app.on('quit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 다음에 */ } });
