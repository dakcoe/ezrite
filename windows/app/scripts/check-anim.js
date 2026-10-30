'use strict';
require('./guard'); // 오류가 나도 화면에 창을 띄우지 않고 종료 코드 1
// 1.2.1 설명 카드: 움직이는 그림(anim)과 요약 줄바꿈을 실제 카드 창에서 본다 (창은 화면에 띄우지 않는다. 임시 APPDATA, AI 없음 EZRITE_CARD).
//   npx electron scripts/check-anim.js   → 결과 JSON 한 줄, 하나라도 틀리면 종료 코드 1
// test/anim-ui.test.js 가 부른다. 맥 explain.html 1.2.0 과 같은 규칙:
//   row: 나타날 때 옆 물체가 비켜 앉고, order 로 자리를 바꾸고, set 으로 글이 바뀌고, links 는 화살표(이번 단계 것만 주황)
//   layers: 층마다 한 열 (왼쪽부터), 열이 84px 보다 좁으면 층마다 한 줄 (위에서부터) · grid: 칸 자리는 물체 순서로 고정 · graph: 곡선·점이 set 으로 옮겨 간다
//   장면 재생기의 reveal = 지금까지 재생한 단계 수, [↻ 다시] 는 처음 단계부터 다시
//   요약은 문장마다 한 줄(첫 문장 굵게), 질문 답은 140자 넘는 문단을 두 문장씩
// EZRITE_ANIM_SHOT=<png 경로> 이면 다 그린 카드를 찍는다.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-anim-'));
const roaming = path.join(tmp, 'Roaming');
fs.mkdirSync(path.join(roaming, 'Ezrite'), { recursive: true });
const theme = process.env.EZRITE_THEME || 'light';
fs.writeFileSync(path.join(roaming, 'Ezrite', 'settings.json'), JSON.stringify({ welcomed: true, theme }));

const it = (id, label, extra = {}) => ({ id, label, note: null, ...extra });
const CARD = {
  summary: '정렬은 수를 차례로 놓는 일입니다. 두 수를 비교해 자리를 바꿉니다! 0.5 처럼 소수점이 있어도 한 문장이에요? 마지막 문장.',
  visuals: [
    { type: 'anim', title: '두 수 바꾸기', layout: 'row', items: [it('a', '5'), it('b', '3'), it('c', '8')], frames: [
      { show: ['a', 'b', 'c'], focus: [], links: [], order: null, set: [], caption: '세 수' },
      { show: [], focus: ['a', 'b'], links: [{ from: 'a', to: 'b', label: '비교' }], order: null, set: [], caption: '5 와 3 비교' },
      { show: [], focus: ['a'], links: [], order: ['b', 'a', 'c'], set: [], caption: '자리 바꿈' },
      { show: [], focus: ['c'], links: [{ from: 'a', to: 'c', label: null }], order: null, set: [{ id: 'c', label: '9' }], caption: '값 바뀜' },
    ] },
    { type: 'anim', title: '신경망', layout: 'layers', items: [
      it('x1', 'x₁', { layer: 0 }), it('x2', 'x₂', { layer: 0 }), it('h1', 'h₁', { layer: 1 }), it('h2', 'h₂', { layer: 1 }),
      it('h3', 'h₃', { layer: 1 }), it('y', 'ŷ', { layer: 2 })], frames: [
      { show: ['x1', 'x2'], focus: [], links: [], caption: '입력' },
      { show: ['h1', 'h2', 'h3'], focus: ['h1'], links: [{ from: 'x1', to: 'h1' }, { from: 'x2', to: 'h1' }], caption: '은닉층' },
      { show: ['y'], focus: ['y'], links: [{ from: 'h1', to: 'y' }, { from: 'h2', to: 'y' }, { from: 'h3', to: 'y' }], caption: '출력' },
    ] },
    { type: 'anim', title: '행렬', layout: 'grid', cols: 3, items: ['1', '2', '3', '4', '5', '6'].map((v, i) => it(`m${i}`, v)), frames: [
      { show: ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'], focus: [], caption: '2×3' },
      { show: [], focus: ['m4'], set: [{ id: 'm4', label: '50' }], caption: '한 칸 바뀜' },
    ] },
    { type: 'anim', title: '수요와 공급', layout: 'graph', axes: { x: '수량', y: '가격' }, items: [
      { id: 'D', label: '수요', points: [[0, 10], [10, 0]] }, { id: 'S', label: '공급', points: [[0, 0], [10, 10]] },
      { id: 'E', label: '균형', at: [5, 5] }], frames: [
      { show: ['D', 'S'], focus: [], caption: '두 곡선' },
      { show: ['E'], focus: ['E'], caption: '균형점' },
      { show: [], focus: ['S'], set: [{ id: 'S', points: [[0, 2], [10, 12]] }, { id: 'E', at: [4, 6] }], caption: '공급 감소' },
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

// 그림 상자 k 의 지금 모습: 보이는 물체의 자리(stage 안)·글·강조, 선, 자막, 그래프의 곡선·점
const look = (k) => `(() => {
  const box = document.querySelectorAll('.visual')[${k}], stage = box.querySelector('.anim');
  const items = [...box.querySelectorAll('.aitem')].filter((n) => !n.classList.contains('off')).map((n) => {
    const m = /translate\\(([-\\d.]+)px,\\s*([-\\d.]+)px\\)/.exec(n.style.transform) || [];
    return { label: n.querySelector('b').textContent, x: Math.round(+m[1]), y: Math.round(+m[2]), w: Math.round(parseFloat(n.style.width)), on: n.classList.contains('on') };
  });
  const paths = [...box.querySelectorAll('svg g path')].map((p) => p.getAttribute('class'));
  return { items, paths, caption: box.querySelector('.acap span').textContent, height: stage.offsetHeight,
    curves: [...box.querySelectorAll('.graph path.curve')].map((p) => p.getAttribute('d')),
    points: [...box.querySelectorAll('.graph circle.pt')].map((c) => [Math.round(+c.getAttribute('cx')), Math.round(+c.getAttribute('cy')), c.getAttribute('class')]),
    labels: [...box.querySelectorAll('.graph text.gl')].map((t) => t.textContent), again: box.querySelector('.acap button')?.textContent };
})()`;
const go = (k, frame) => `document.querySelectorAll('.visual')[${k}]._anim.go(${frame})`;

async function main() {
  const out = { ok: false };
  try {
    await app.whenReady();
    const win = await until(() => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('explain.html') && !w.webContents.isLoading()));
    if (!win) throw new Error('설명 카드가 열리지 않음');
    const wc = win.webContents;
    if (!(await until(() => wc.executeJavaScript('document.querySelectorAll(".visual").length === 4')))) throw new Error('그림 넷이 그려지지 않음');
    const js = (s) => wc.executeJavaScript(s);
    // 그래프는 requestAnimationFrame 으로 옮겨 그리는데 숨긴 창에서는 거의 돌지 않는다.
    // "동작 줄이기"로 두면 같은 코드가 끝 모습을 바로 그린다 (맥 explain.html prefers-reduced-motion 갈래)
    wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });

    // 요약: 문장마다 한 줄, 첫 문장 굵게. 0.5 의 점에서는 자르지 않는다
    out.summary = await js(`[...document.querySelectorAll('.summary p')].map((p) => [p.className, p.textContent, getComputedStyle(p).fontWeight])`);
    // 질문 답 문단: 140자 넘는 문단은 두 문장씩, 짧은 문단과 이미 나뉜 문단은 그대로
    const long = '첫째 문장은 꽤 길게 써서 문단 길이를 충분히 늘려 둡니다. 둘째 문장도 비슷한 길이로 길게 이어 가면서 설명을 덧붙입니다. '
      + '셋째 문장에서 이야기의 방향이 조금 바뀌고 새로운 예를 듭니다. 넷째 문장은 앞의 예를 정리하며 마무리를 합니다. 다섯째 문장이 마지막으로 전체를 정리합니다.';
    out.paragraphs = await js(`[paragraphs(${JSON.stringify(long)}), paragraphs("짧은 문단. 그대로."), paragraphs("가.\\n나.")]`);
    out.longLength = long.length;

    // row: 단계마다
    out.row = [];
    for (let f = 1; f <= 4; f++) { await js(go(0, f)); out.row.push(await js(look(0))); }
    await js(go(0, 0));
    out.rowZero = await js(look(0));
    // layers·grid·graph: 다 본 모습과 첫 단계
    await js(go(1, 1)); out.layers1 = await js(look(1));
    await js(go(1, 3)); out.layers = await js(look(1));
    await js(go(2, 1)); out.grid1 = await js(look(2));
    await js(go(2, 2)); out.grid = await js(look(2));
    await js(go(3, 2)); out.graph2 = await js(look(3));
    await js(go(3, 3)); out.graph = await js(look(3));
    // [↻ 다시]: 처음 단계부터 (첫 단계 자막)
    await js(`document.querySelectorAll('.visual')[0].querySelector('.acap button').click()`);
    await wait(300);
    out.again = await js(look(0));
    // 장면 재생기: reveal 2 = 둘째 단계까지 재생한 모습. 전체 보기 = 끝 단계
    await js(`render(${JSON.stringify({ ...CARD, scenes: [{ say: '첫 장면', visual: 0, reveal: 2 }, { say: '둘째', visual: 1, reveal: 1 }] })})`);
    await wait(500);
    out.scene = await js(look(0));
    await js(`document.querySelector('.ctrl .all').click()`);
    await wait(300);
    out.sceneAll = { row: await js(look(0)), layers: await js(look(1)) };

    if (process.env.EZRITE_ANIM_SHOT) {
      await js(`render(${JSON.stringify(CARD)})`);
      await wait(400);
      for (let k = 0; k < 4; k++) await js(`document.querySelectorAll('.visual')[${k}]._anim.go()`);
      win.setBounds({ ...win.getBounds(), height: 1400 });
      await wait(1200);
      if (process.env.EZRITE_ANIM_SHOT_BOTTOM) await js(`document.getElementById('scroll').scrollTop = 1e6`);
      wc.invalidate();
      await wait(1600);
      fs.writeFileSync(process.env.EZRITE_ANIM_SHOT, (await wc.capturePage()).toPNG());
    }

    const r = out.row;
    const xs = (l) => Object.fromEntries(l.items.map((i) => [i.label, i.x]));
    out.checks = {
      summaryLines: out.summary.length === 4 && out.summary[0][0] === 'lead' && Number(out.summary[0][2]) >= 600
        && out.summary[2][1] === '0.5 처럼 소수점이 있어도 한 문장이에요?' && out.summary.slice(1).every((p) => p[0] === ''),
      paragraphs: out.longLength > 140 && out.paragraphs[0].split('\n\n').length === 3 && out.paragraphs[1] === '짧은 문단. 그대로.' && out.paragraphs[2] === '가.\n나.',
      rowAppear: out.rowZero.items.length === 0 && r[0].items.length === 3 && r[0].paths.length === 0,
      rowFocusLink: r[1].items.filter((i) => i.on).map((i) => i.label).join() === '5,3' && r[1].paths.join() === 'new' && r[1].caption === '5 와 3 비교',
      rowOrder: xs(r[2])['3'] < xs(r[2])['5'] && xs(r[1])['5'] < xs(r[1])['3'] && r[2].paths.join() === 'old',
      rowSet: r[3].items.some((i) => i.label === '9' && i.on) && !r[3].items.some((i) => i.label === '8') && r[3].paths.join() === 'old,new',
      // 1.2.4 (맥 MIN_W 84): 보통 카드 폭에서 3층(h 셋)은 열이 84px 보다 좁아져 층마다 한 줄(위에서 아래로)로 그린다
      layers: out.layers1.items.length === 2 && out.layers.items.length === 6
        && new Set(out.layers.items.filter((i) => /x/.test(i.label)).map((i) => i.y)).size === 1
        && new Set(out.layers.items.filter((i) => /h/.test(i.label)).map((i) => i.y)).size === 1
        && Math.max(...out.layers.items.filter((i) => /x/.test(i.label)).map((i) => i.y)) < Math.min(...out.layers.items.filter((i) => /h/.test(i.label)).map((i) => i.y))
        && Math.max(...out.layers.items.filter((i) => /h/.test(i.label)).map((i) => i.y)) < out.layers.items.find((i) => i.label === 'ŷ').y
        && out.layers.paths.length === 5,
      grid: out.grid1.items.length === 6 && new Set(out.grid1.items.map((i) => i.y)).size === 2 && new Set(out.grid1.items.map((i) => i.x)).size === 3
        && out.grid.items[4].label === '50' && out.grid.items[4].on && out.grid.items[4].x === out.grid1.items[4].x,
      graph: out.graph2.curves.length === 2 && out.graph2.points.length === 1 && out.graph.curves[1] !== out.graph2.curves[1]
        && out.graph.points[0][0] < out.graph2.points[0][0] && out.graph.points[0][1] < out.graph2.points[0][1]
        && out.graph.labels.join() === '수요,공급,균형',
      again: out.again.caption === '세 수' && out.again.again === '↻ 다시',
      sceneReveal: out.scene.caption === '5 와 3 비교' && out.sceneAll.row.caption === '값 바뀜' && out.sceneAll.layers.caption === '출력',
    };
    out.ok = Object.values(out.checks).every(Boolean);
  } catch (e) {
    out.error = e.message;
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  app.exit(out.ok ? 0 : 1);
}
main();
