'use strict';
require('./guard'); // 오류가 나도 화면에 창을 띄우지 않고 종료 코드 1
// 1.2.4 움직이는 그림 줄바꿈 (맥 explain.html 과 같다): 설명 카드가 가장 좁을 때(최소 폭 320) 상자가 좁아져
// 한글이 한 자씩 꺾이지 않는지 본다. 창은 화면에 띄우지 않는다 (임시 APPDATA, AI 없음 EZRITE_CARD).
//   npx electron scripts/check-anim-narrow.js   → 결과 JSON 한 줄, 하나라도 틀리면 종료 코드 1
// test/anim-narrow-ui.test.js 가 부른다:
//   row 6개 → 한 줄에 다 넣지 않고 여러 줄로, 상자 폭은 모두 84px(MIN_W) 이상
//   layers 5층 → 열 대신 층을 위에서 아래로 한 줄씩, 상자 폭은 모두 84px 이상, 선은 곡선
// EZRITE_ANIM_SHOT=<png 경로> 이면 다 그린 카드를 찍는다.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-anim-narrow-'));
const roaming = path.join(tmp, 'Roaming');
fs.mkdirSync(path.join(roaming, 'Ezrite'), { recursive: true });
const theme = process.env.EZRITE_THEME || 'light';
fs.writeFileSync(path.join(roaming, 'Ezrite', 'settings.json'), JSON.stringify({ welcomed: true, theme }));

const it = (id, label, extra = {}) => ({ id, label, note: null, ...extra });
const ROW = ['토큰화', '임베딩', '어텐션', '피드포워드', '정규화', '출력층'];
const LAYERS = [['입력', 0], ['은닉 하나', 1], ['은닉 둘', 1], ['은닉 셋', 2], ['은닉 넷', 3], ['출력', 4]];
const CARD = {
  summary: '좁은 카드에서 움직이는 그림이 한 자씩 꺾이지 않는지 봅니다.',
  marks: [],
  visuals: [
    { type: 'anim', title: '처리 단계 여섯', layout: 'row', items: ROW.map((l, i) => it(`r${i}`, l)), frames: [
      { show: ROW.map((_, i) => `r${i}`), focus: ['r0'], links: [{ from: 'r0', to: 'r1', label: null }], caption: '여섯 단계' },
      { show: [], focus: ['r5'], links: [{ from: 'r4', to: 'r5', label: '다음' }], caption: '끝 단계' },
    ] },
    { type: 'anim', title: '다섯 층 신경망', layout: 'layers', items: LAYERS.map(([l, layer], i) => it(`n${i}`, l, { layer })), frames: [
      { show: LAYERS.map((_, i) => `n${i}`), focus: ['n0'], links: [{ from: 'n0', to: 'n1', label: null }, { from: 'n0', to: 'n2', label: null }], caption: '앞으로 전달' },
      { show: [], focus: ['n5'], links: [{ from: 'n4', to: 'n5', label: null }], caption: '출력' },
    ] },
  ],
};
Object.assign(process.env, { APPDATA: roaming, LOCALAPPDATA: path.join(tmp, 'Local'), EZRITE_THEME: theme, EZRITE_CARD: JSON.stringify(CARD) });

const { app, BrowserWindow } = require('electron');
for (const m of ['show', 'showInactive', 'focus', 'moveTop']) BrowserWindow.prototype[m] = function noop() {};
app.setPath('userData', path.join(tmp, 'userData'));
require('../main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(100);
  }
  return null;
}

// 그림 상자 k: 보이는 물체의 자리·폭과 글이 몇 줄로 꺾였는지, 선 모양
const look = (k) => `(() => {
  const box = document.querySelectorAll('.visual')[${k}], stage = box.querySelector('.anim');
  const items = [...box.querySelectorAll('.aitem')].filter((n) => !n.classList.contains('off')).map((n) => {
    const m = /translate\\(([-\\d.]+)px,\\s*([-\\d.]+)px\\)/.exec(n.style.transform) || [];
    const b = n.querySelector('b'), lh = parseFloat(getComputedStyle(b).lineHeight) || 18;
    return { label: b.textContent, x: Math.round(+m[1]), y: Math.round(+m[2]), w: Math.round(parseFloat(n.style.width)), lines: Math.round(b.getBoundingClientRect().height / lh) };
  });
  const bottom = Math.max(0, ...[...box.querySelectorAll('.aitem')].filter((n) => !n.classList.contains('off')).map((n) => {
    const m = /translate\\(([-\\d.]+)px,\\s*([-\\d.]+)px\\)/.exec(n.style.transform) || [];
    return +m[2] + parseFloat(n.style.height); }));
  return { stageWidth: stage.clientWidth, stageHeight: stage.offsetHeight, bottom: Math.round(bottom), items,
    paths: [...box.querySelectorAll('svg g path')].map((p) => p.getAttribute('d')) };
})()`;

async function main() {
  const out = { ok: false };
  try {
    await app.whenReady();
    const win = await until(() => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('explain.html') && !w.webContents.isLoading()));
    if (!win) throw new Error('설명 카드가 열리지 않음');
    const wc = win.webContents;
    const js = (s) => wc.executeJavaScript(s);
    if (!(await until(() => js('document.querySelectorAll(".visual").length === 2')))) throw new Error('그림 둘이 그려지지 않음');
    // 숨긴 창에서는 높이·자리 옮김 애니메이션이 거의 돌지 않는다. "동작 줄이기"로 끝 모습을 바로 그리게 한다 (check-anim 과 같다)
    wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    // 카드를 가장 좁게 (createCard minWidth 320) 하고 다시 그린다
    win.setBounds({ ...win.getBounds(), width: 320, height: 1400 });
    await wait(300);
    await js(`render(${JSON.stringify(CARD)})`);
    await wait(400);
    for (const k of [0, 1]) await js(`document.querySelectorAll('.visual')[${k}]._anim.go()`);
    await wait(300);
    out.width = win.getBounds().width;
    out.row = await js(look(0));
    out.layers = await js(look(1));
    out.overflowX = await js("(() => { const s = document.getElementById('scroll') || document.scrollingElement; return s.scrollWidth - s.clientWidth; })()");

    if (process.env.EZRITE_ANIM_SHOT) {
      wc.invalidate();
      await wait(1600);
      fs.writeFileSync(process.env.EZRITE_ANIM_SHOT, (await wc.capturePage()).toPNG());
    }

    const MIN_W = 84;
    const rows = (l) => new Set(l.items.map((i) => i.y)).size;
    out.checks = {
      narrow: out.width === 320 && out.row.stageWidth < 6 * MIN_W + 5 * 22, // 한 줄에 여섯은 못 들어가는 폭
      rowWide: out.row.items.length === 6 && out.row.items.every((i) => i.w >= MIN_W),
      rowWrapped: rows(out.row) >= 2,
      layersWide: out.layers.items.length === 6 && out.layers.items.every((i) => i.w >= MIN_W),
      layersTopDown: rows(out.layers) === 5, // 층마다 한 줄
      curves: out.row.paths.length === 2 && out.layers.paths.length === 3,
      noOneCharLines: [...out.row.items, ...out.layers.items].every((i) => i.lines <= 2),
      fitsStage: out.row.stageHeight >= out.row.bottom && out.layers.stageHeight >= out.layers.bottom, // 상자가 그림 칸 밖으로 넘치지 않는다
      noSideScroll: out.overflowX <= 0,
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
