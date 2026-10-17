'use strict';

// 맥 MarksView: 짚은 곳은 둥근 주황 상자 + 왼쪽 위 번호, 경로는 파란 상자 + 오른쪽 위 순서 번호와 화살표
const NS = 'http://www.w3.org/2000/svg';
const svg = document.getElementById('marks');
const HEAD = 11; // 화살촉 길이

function node(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent.append(e);
  return e;
}

function box(g, r, cls, radius) {
  node('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: radius, class: cls }, g);
}

function badge(g, x, y, label, size, cls) {
  node('circle', { cx: x, cy: y, r: size / 2, class: `dot ${cls}` }, g);
  const t = node('text', { x, y, class: size < 24 ? 'small' : '' }, g);
  t.textContent = label;
}

function arrow(g, a, b, scene) {
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const p = (s) => `${b.x - HEAD * Math.cos(angle + s)},${b.y - HEAD * Math.sin(angle + s)}`;
  node('path', { d: `M${a.x},${a.y} L${b.x},${b.y} M${p(-Math.PI / 7)} L${b.x},${b.y} L${p(Math.PI / 7)}`, class: `arrow${scene ? ' scene' : ''}` }, g);
}

/** shapes: lib/explain.js shapes() 결과. 화살표를 먼저 그려 상자·번호가 위에 오게 한다 */
function draw({ shapes, scene }) {
  const g = document.createElementNS(NS, 'g');
  for (const s of shapes) if (s.kind === 'arrow') arrow(g, s.from, s.to, scene);
  for (const s of shapes) {
    if (s.kind === 'route') {
      box(g, s.rect, 'route', 6);
      if (s.label) badge(g, s.rect.x + s.rect.w, s.rect.y, s.label, 22, 'route-dot');
    } else if (s.kind === 'focus') {
      box(g, s.rect, 'focus', 8);
      badge(g, s.rect.x, s.rect.y, s.label, 24, 'focus-dot');
    }
  }
  svg.replaceChildren(g);
}
