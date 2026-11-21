'use strict';

// "설명 표시 방식" 그리기 (1.3.0, 맥 MarksRenderer.swift 를 Canvas 2D 로 옮겼다). 예전 방식(classic)은 overlay.js 의 SVG 가 그린다.
// 자료는 lib/explain.js markData: R = 글자 상자를 조금 넓힌 상자, Q = 글자 상자 그대로 ({x, y, w, h}, 표시 창 좌표),
// scenes [{ focus: [id], arrow: [from, to] | null, tag }], marks·path [id], scene(지금 장면, 전체 보기면 null),
// hover("m0"·"s2"·"p1"·"say"), anchors({ ref: {x, y} }, 카드 글의 자리), others(화면의 다른 글자 상자).
// t = 장면이 바뀐 뒤 초. 맥처럼 방식마다 정해진 시간(settle)이 지나면 다시 그리지 않는다 (CPU).
// 계산 부분(Model·arrowParts·spot …)은 node 시험(test/marks.test.js)에서도 쓴다
(function (root) {
  const ACCENT = [255, 107, 43]; // 맥 Color(1, .42, .17)
  const PEN = [217, 54, 43]; // (.85, .21, .17)
  const GRAY = [153, 153, 153]; // Color(white: .6)
  const PALETTE = [[124, 92, 255], [15, 157, 138], [229, 72, 77]]; // 카드 explain.js PALETTE 와 같은 색
  const HIGHLIGHT = [255, 214, 10]; // (1, .84, .04)
  const HL_ARROW = [240, 179, 0]; // (.94, .7, 0)
  const SHADE = [5, 8, 18]; // (.02, .03, .07)
  const rgba = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a))})`;
  const gray = (w, a = 1) => rgba([w * 255, w * 255, w * 255].map(Math.round), a);

  /** 표시가 다 그려져 멈추는 때 (초, 맥 settleTime) */
  function settleTime(style) {
    switch (style) {
      case 'spotlight': return 3.6;
      case 'flow': return 9;
      case 'minimap': return 6;
      case 'pen': case 'notes': case 'bubble': return 2.2;
      default: return 1.6;
    }
  }
  const FLOW_CYCLES = 3; // 흐르는 점은 세 바퀴 돌고 멈춘다
  const BEAT = 5.6; // 지도 방식의 점은 네 번 맥박 친 뒤 멈춘다

  const ease = (x) => { const v = Math.min(1, Math.max(0, x)); return v < 0.5 ? 2 * v * v : 1 - (-2 * v + 2) ** 2 / 2; };
  const lerp = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k });
  const inset = (r, dx, dy) => ({ x: r.x + dx, y: r.y + dy, w: r.w - 2 * dx, h: r.h - 2 * dy });
  const mid = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const containsRect = (o, c) => c.x >= o.x && c.y >= o.y && c.x + c.w <= o.x + o.w && c.y + c.h <= o.y + o.h;
  const containsPt = (o, p) => p.x >= o.x && p.x <= o.x + o.w && p.y >= o.y && p.y <= o.y + o.h;

  /** 상자 중심에서 target 쪽으로 나가는 선이 상자 테두리와 만나는 점 (맥 Explain.edgePoint) */
  function edge(r, target) {
    const c = mid(r);
    const dx = target.x - c.x;
    const dy = target.y - c.y;
    if (dx === 0 && dy === 0) return c;
    const s = Math.min(dx === 0 ? Infinity : r.w / 2 / Math.abs(dx), dy === 0 ? Infinity : r.h / 2 / Math.abs(dy));
    return { x: c.x + dx * s, y: c.y + dy * s };
  }

  /** 2차 곡선을 점 목록으로 (잘라 그리기·점 따라가기용) */
  function quadPts(p1, q, p2, n = 40) {
    const out = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      out.push({ x: (1 - t) ** 2 * p1.x + 2 * (1 - t) * t * q.x + t * t * p2.x, y: (1 - t) ** 2 * p1.y + 2 * (1 - t) * t * q.y + t * t * p2.y });
    }
    return out;
  }
  function cubicPts(p0, c1, c2, p3, n = 48) {
    const out = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const a = (1 - t) ** 3;
      const b = 3 * (1 - t) ** 2 * t;
      const c = 3 * (1 - t) * t * t;
      const d = t ** 3;
      out.push({ x: a * p0.x + b * c1.x + c * c2.x + d * p3.x, y: a * p0.y + b * c1.y + c * c2.y + d * p3.y });
    }
    return out;
  }
  /** 점 목록을 길이의 f 만큼 (맥 trimmedPath(from: 0, to: f)) */
  function trim(pts, f) {
    if (f >= 1) return pts;
    if (f <= 0 || pts.length < 2) return pts.slice(0, 1);
    const seg = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); seg.push(l); total += l; }
    let left = total * f;
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      if (left >= seg[i - 1]) { out.push(pts[i]); left -= seg[i - 1]; continue; }
      const k = seg[i - 1] ? left / seg[i - 1] : 0;
      out.push({ x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k });
      break;
    }
    return out;
  }

  /**
   * 두 상자 사이 화살표 (맥 arrowParts). 같은 높이에 나란한 두 상자(그림 속 라벨) 사이는 원래 그림의 화살표와 겹치지 않게 휜다.
   * { line: 점 목록, head: [점 셋] }
   */
  function arrowParts(a, b, { bend = 0, gap = 5, head = 11 } = {}) {
    let bd = bend;
    if (Math.abs(mid(a).y - mid(b).y) < 6) bd = Math.max(Math.abs(bd), 32) * (mid(b).x >= mid(a).x ? 1 : -1);
    const e1 = edge(a, mid(b));
    const e2 = edge(b, mid(a));
    const ang = Math.atan2(e2.y - e1.y, e2.x - e1.x);
    const p1 = { x: e1.x + Math.cos(ang) * gap, y: e1.y + Math.sin(ang) * gap };
    const p2 = { x: e2.x - Math.cos(ang) * gap, y: e2.y - Math.sin(ang) * gap };
    const len = Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y));
    const q = { x: (p1.x + p2.x) / 2 - (p2.y - p1.y) / len * bd, y: (p1.y + p2.y) / 2 + (p2.x - p1.x) / len * bd };
    const t = Math.atan2(p2.y - q.y, p2.x - q.x);
    const s = Math.PI / 7;
    return {
      line: quadPts(p1, q, p2),
      head: [{ x: p2.x - head * Math.cos(t - s), y: p2.y - head * Math.sin(t - s) }, p2, { x: p2.x - head * Math.cos(t + s), y: p2.y - head * Math.sin(t + s) }],
    };
  }

  /** 지금 무엇을 보여 주나 (맥 MarksRenderer 의 current·targets·focusNow …) */
  function Model(d) {
    const R = d.R || {};
    const Q = d.Q || {};
    const has = (id) => R[id] != null;
    const scenes = d.scenes || [];
    const current = Number.isInteger(d.scene) && d.scene >= 0 && d.scene < scenes.length ? d.scene : null;
    const inScene = (i) => Number.isInteger(i) && i >= 0 && i < scenes.length;
    const marksAll = d.marks || [];
    const markIDs = marksAll.filter(has);
    const pathIDs = (d.path || []).length && d.path.every(has) ? d.path : [];
    const targets = (i) => {
      if (!inScene(i)) return [];
      const sc = scenes[i];
      const out = [];
      for (const id of [...sc.focus, ...(sc.arrow || [])]) if (!out.includes(id) && has(id)) out.push(id);
      return out;
    };
    const arrow = (i) => (inScene(i) && scenes[i].arrow && has(scenes[i].arrow[0]) && has(scenes[i].arrow[1]) ? scenes[i].arrow : null);
    const focus = (i) => (inScene(i) ? scenes[i].focus.filter(has) : []);
    const hover = typeof d.hover === 'string' && d.hover ? d.hover : null;
    /** 카드에서 마우스를 올린 항목이 가리키는 줄 */
    function hoverIDs() {
      if (!hover) return null;
      const n = /^[msp]\d+$/.test(hover) ? Number(hover.slice(1)) : null;
      if (n == null) return hover === 'say' && current != null ? targets(current) : null;
      if (hover[0] === 'm') return n < marksAll.length ? [marksAll[n]].filter(has) : null;
      if (hover[0] === 's') return targets(n);
      return n < pathIDs.length ? [pathIDs[n]] : null;
    }
    /** "지금 하나만" 방식이 보여 줄 줄: 마우스 > 지금 장면 > (장면이 없을 때) 짚은 곳 > 없음 */
    function focusNow() {
      const h = hoverIDs();
      if (h) return h;
      if (current != null) return targets(current);
      return scenes.length ? [] : markIDs;
    }
    /** 글자 상자가 가로로 길지 않으면(그림 속 라벨) 밑줄 대신 동그라미 */
    const blob = (id) => Q[id] != null && Q[id].w < Q[id].h * 2.2;
    /** 짚은 곳 색 (색으로 짝 맞추기) */
    const colorOf = (id) => { const i = marksAll.indexOf(id); return i < 0 ? null : PALETTE[i % PALETTE.length]; };
    return { d, R, Q, has, scenes, current, markIDs, pathIDs, targets, arrow, focus, hover, hoverIDs, focusNow, blob, colorOf,
      style: d.style, anchors: d.anchors || {}, others: d.others || [] };
  }

  /** 발자취 번호: 지금(또는 마지막) 장면까지 줄마다 짚은 장면 번호들. { order: [id], nums: { id: [k] } } */
  function trailNumbers(m) {
    const upto = m.current ?? m.scenes.length - 1;
    const nums = {};
    const order = [];
    for (let k = 0; k <= Math.max(0, upto); k++) {
      for (const id of m.targets(k)) {
        if (!nums[id]) { order.push(id); nums[id] = []; }
        nums[id].push(k);
      }
    }
    return { order, nums };
  }

  /**
   * 글을 놓을 빈 자리: 줄 오른쪽 → 아래 → 위 → 왼쪽 중 다른 글자·이미 놓은 글과 겹치지 않는 첫 자리 (맥 spot).
   * 옆은 gap 만큼 띄우고(메모는 줄 끝에서 멀찍이), 위아래는 바짝 붙인다 (멀리 가면 다른 줄 위에 얹힌다)
   */
  function spot(size, r, taken, others, area, gap = 18) {
    const v = 8;
    const cands = [{ x: r.x + r.w + gap, y: r.y + r.h / 2 - size.h / 2 }, { x: r.x + r.w / 2 - size.w / 2, y: r.y + r.h + v },
      { x: r.x + r.w / 2 - size.w / 2, y: r.y - v - size.h }, { x: r.x - gap - size.w, y: r.y + r.h / 2 - size.h / 2 }];
    const bounds = { x: 6, y: 6, w: area.w - 12, h: area.h - 12 };
    const c0 = mid(r);
    for (const p of cands) {
      const c = { x: p.x, y: p.y, w: size.w, h: size.h };
      if (!containsRect(bounds, c)) continue;
      const hit = [...others, ...taken].some((o) => intersects(inset(o, -3, -3), c) && !containsPt(inset(o, 2, 2), c0));
      if (!hit) return c;
    }
    const c = cands[0];
    return { x: Math.min(c.x, bounds.x + bounds.w - size.w), y: Math.max(bounds.y, Math.min(c.y, bounds.y + bounds.h - size.h)), w: size.w, h: size.h };
  }

  // ── 그리기 (브라우저) ──

  function Painter(ctx, m, t, area) {
    const { R, Q } = m;
    const P = {};
    const path = (pts) => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); };
    const rrect = (r, rad) => { ctx.beginPath(); ctx.roundRect(r.x, r.y, r.w, r.h, rad); };
    const ellipse = (cx, cy, rx, ry = rx) => { ctx.beginPath(); ctx.ellipse(cx, cy, Math.max(0, rx), Math.max(0, ry), 0, 0, Math.PI * 2); };
    /** 밝은·어두운 화면 어디서나 보이게 가는 그림자. glow 는 주황 번짐 (맥 shadowed) */
    function shadowed(body, glow = false) {
      ctx.save();
      ctx.shadowColor = glow ? rgba(ACCENT, 0.55) : 'rgba(0,0,0,0.3)';
      ctx.shadowBlur = glow ? 12 : 3;
      body();
      ctx.restore();
    }
    function stroke(color, w, { dash = [], cap = 'round', join = 'round' } = {}) {
      ctx.strokeStyle = color; ctx.lineWidth = w; ctx.lineCap = cap; ctx.lineJoin = join; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([]);
    }
    function fill(color, rule) { ctx.fillStyle = color; ctx.fill(rule); }

    P.strokeArrow = (a, b, color, w, { bend = 0, dash = [], progress = 1 } = {}) => {
      const p = ease(progress);
      if (p <= 0) return;
      const { line, head } = arrowParts(a, b, { bend });
      shadowed(() => {
        path(trim(line, p)); stroke(color, w, { dash });
        if (p >= 0.98) { path(head); stroke(color, w); }
      });
    };
    P.underline = (id, color, w, progress) => {
      const q = Q[id];
      if (!q) return;
      const p = ease(progress);
      if (p <= 0) return;
      shadowed(() => { path([{ x: q.x, y: q.y + q.h + 3 }, { x: q.x + q.w * p, y: q.y + q.h + 3 }]); stroke(color, w, { join: 'miter' }); });
    };
    P.ring = (id, color, w) => {
      const q = Q[id];
      if (!q) return;
      const rr = Math.max(q.w, q.h) / 2 + 5;
      shadowed(() => { ellipse(q.x + q.w / 2, q.y + q.h / 2, rr); stroke(color, w); });
    };
    P.penUnderline = (id, progress) => {
      const q = Q[id];
      if (!q) return;
      path(trim(quadPts({ x: q.x - 2, y: q.y + q.h + 3 }, { x: q.x + q.w / 2, y: q.y + q.h + 7 }, { x: q.x + q.w + 2, y: q.y + q.h + 2 }), ease(progress)));
      stroke(rgba(PEN), 2.5);
    };
    P.roughCircle = (id, progress, seed = 1.7) => {
      const q = Q[id];
      if (!q || progress <= 0) return;
      const node = m.blob(id);
      const cx = q.x + q.w / 2;
      const cy = q.y + q.h / 2;
      const rx = q.w / 2 + (node ? 9 : 14);
      const ry = q.h / 2 + (node ? 9 : 4);
      const a0 = -2.2 + (seed % 1);
      const pts = [];
      for (let a = 0; a <= 2 * Math.PI + 0.55; a += 0.09) {
        const k = 1 + 0.035 * Math.sin(seed * 3 + a * 3) + 0.025 * Math.sin(seed + a * 7) + a * 0.012;
        pts.push({ x: cx + rx * k * Math.cos(a0 + a), y: cy + ry * k * Math.sin(a0 + a) });
      }
      path(trim(pts, ease(progress)));
      stroke(rgba(PEN), 3);
    };
    P.badge = (text, c, color) => {
      ctx.save();
      ctx.font = FONT(12.5, 700);
      const w = Math.max(22, ctx.measureText(text).width + 12);
      ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1;
      rrect({ x: c.x - w / 2, y: c.y - 11, w, h: 22 }, 11); fill(color);
      ctx.restore();
      ctx.save();
      ctx.font = FONT(12.5, 700); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, c.x, c.y + 0.5);
      ctx.restore();
    };
    /** 글 한 덩이 (maxWidth 를 넘으면 낱말로 줄을 나눈다). { lines, w, h } */
    P.measure = (text, font, maxWidth, lineH) => {
      ctx.save();
      ctx.font = font;
      const words = String(text).split(/(\s+)/);
      const lines = [];
      let cur = '';
      for (const wd of words) {
        const next = cur + wd;
        if (cur.trim() && ctx.measureText(next.trim()).width > maxWidth) { lines.push(cur.trim()); cur = wd.trimStart(); } else cur = next;
      }
      if (cur.trim()) lines.push(cur.trim());
      const w = Math.min(maxWidth, Math.max(0, ...lines.map((l) => ctx.measureText(l).width)));
      ctx.restore();
      return { lines, w, h: lines.length * lineH, lineH, font };
    };
    P.text = (label, box, color) => {
      ctx.save();
      ctx.font = label.font; ctx.fillStyle = color; ctx.textBaseline = 'middle';
      label.lines.forEach((l, i) => ctx.fillText(l, box.x, box.y + label.lineH * (i + 0.5), box.w + 2));
      ctx.restore();
    };
    Object.assign(P, { ctx, path, rrect, ellipse, shadowed, stroke, fill, R, Q, t, area });
    return P;
  }

  const SANS = "'Segoe UI Variable', 'Segoe UI', 'Malgun Gothic', sans-serif";
  const FONT = (size, weight) => `${weight} ${size}px ${SANS}`;
  /** 손글씨 글꼴: 나눔손글씨 펜이 있으면 31, 없으면 굵은 22 (맥 penFont 와 같다) */
  let penFontCache = null;
  function penFont() {
    if (penFontCache) return penFontCache;
    // document.fonts.check 는 설치되지 않은 시스템 글꼴에도 참이라, 대신 글자 폭이 기본 글꼴과 다른지 잰다
    let ok = false;
    try {
      const c = document.createElement('canvas').getContext('2d');
      const width = (f) => { c.font = f; return c.measureText('가나다 abc 123').width; };
      ok = ["'Nanum Pen Script'", 'NanumPen'].some((f) => width(`31px ${f}, monospace`) !== width('31px monospace'));
    } catch { /* 없음으로 */ }
    penFontCache = ok ? { font: "31px 'Nanum Pen Script', 'NanumPen'", lineH: 36 } : { font: FONT(22, 700), lineH: 28 };
    return penFontCache;
  }

  // ── 방식마다 (맥 MarksRenderer 의 함수 이름 그대로) ──

  function spotlight(P, m, previous) {
    const { ctx, R, t, area } = P;
    const ids = m.focusNow();
    if (!ids.length) return;
    const cur = ids.filter((id) => R[id]).map((id) => inset(R[id], -8, -8));
    const prev = previous.filter((id) => R[id]).map((id) => inset(R[id], -8, -8));
    const k = m.hover == null ? ease(t / 0.5) : 1;
    ctx.beginPath();
    ctx.rect(0, 0, area.w, area.h);
    cur.forEach((r, i) => { const x = lerp(prev.length ? prev[Math.min(i, prev.length - 1)] : r, r, k); ctx.roundRect(x.x, x.y, x.w, x.h, 12); });
    const alpha = m.hover != null ? 0.45 : t < 0.4 ? 0.6 * t / 0.4 : t < 2.1 ? 0.6 : Math.max(0.2, 0.6 - 0.4 * (t - 2.1) / 1.3);
    P.fill(rgba(SHADE, alpha), 'evenodd');
    const a = m.current != null && m.hover == null ? m.arrow(m.current) : null;
    if (a) P.strokeArrow(inset(R[a[0]], -8, -8), inset(R[a[1]], -8, -8), rgba(ACCENT), 3.5, { progress: (t - 0.45) / 0.6 });
  }

  function highlighter(P, m) {
    const { ctx, Q, R, t } = P;
    m.focusNow().forEach((id, k) => {
      const q = Q[id];
      if (!q) return;
      const band = m.blob(id) ? { x: q.x - 8, y: q.y + q.h * 0.28, w: q.w + 16, h: q.h * 0.44 } : { x: q.x - 3, y: q.y + q.h * 0.45, w: q.w + 6, h: q.h * 0.55 };
      const p = m.hover == null ? ease((t - k * 0.4) / 0.45) : 1;
      if (p <= 0) return;
      // 맥은 곱하기(multiply)로 섞는다. 투명한 표시 창 안에서는 아래 화면과 섞이지 않아 같은 반투명 노랑이 된다
      ctx.save();
      P.rrect({ ...band, w: band.w * p }, 3); P.fill(rgba(HIGHLIGHT, 0.55));
      ctx.restore();
    });
    const a = m.current != null && m.hover == null ? m.arrow(m.current) : null;
    if (a) P.strokeArrow(R[a[0]], R[a[1]], rgba(HL_ARROW), 5, { bend: 16, progress: (t - 0.35) / 0.6 });
  }

  function corners(P, m) {
    const { R, t } = P;
    const pop = m.hover == null ? Math.min(1, t / 0.3) : 1;
    for (const id of m.focusNow()) {
      if (!R[id]) continue;
      const r = inset(R[id], -3, -3);
      const L = 13;
      if (m.hover == null && t < 0.9) {
        const s = 1 + 0.35 * t / 0.9;
        P.rrect({ x: r.x + r.w / 2 - r.w * s / 2, y: r.y + r.h / 2 - r.h * s / 2, w: r.w * s, h: r.h * s }, 8);
        P.stroke(rgba(ACCENT, 0.9 * (1 - t / 0.9)), 2.5, { cap: 'butt', join: 'miter' });
      }
      const x0 = r.x;
      const y0 = r.y;
      const x1 = r.x + r.w;
      const y1 = r.y + r.h;
      P.shadowed(() => {
        P.ctx.beginPath();
        for (const seg of [[[x0, y0 + L], [x0, y0], [x0 + L, y0]], [[x1 - L, y0], [x1, y0], [x1, y0 + L]],
          [[x1, y1 - L], [x1, y1], [x1 - L, y1]], [[x0 + L, y1], [x0, y1], [x0, y1 - L]]]) {
          P.ctx.moveTo(...seg[0]); P.ctx.lineTo(...seg[1]); P.ctx.lineTo(...seg[2]);
        }
        P.stroke(rgba(ACCENT, pop), 3.5);
      });
    }
    const a = m.current != null && m.hover == null ? m.arrow(m.current) : null;
    if (a) {
      const op = Math.min(1, Math.max(0, (t - 0.3) / 0.3));
      const { line, head } = arrowParts(R[a[0]], R[a[1]], { gap: 9 });
      P.shadowed(() => {
        P.path(line); P.stroke(rgba(ACCENT, op), 2.5, { dash: [1, 7] });
        P.path(head); P.stroke(rgba(ACCENT, op), 2.5);
      });
    }
  }

  function hover(P, m) {
    const { R, t } = P;
    const soft = m.current != null ? m.focus(m.current) : m.scenes.length ? [] : m.markIDs;
    for (const id of soft) if (R[id]) { P.rrect(R[id], 7); P.fill(rgba(ACCENT, 0.13 * Math.min(1, t / 0.4))); }
    const a = m.current != null ? m.arrow(m.current) : null;
    if (a) P.strokeArrow(R[a[0]], R[a[1]], rgba(ACCENT, 0.55), 2);
    for (const id of m.hoverIDs() ?? []) {
      if (!R[id]) continue;
      P.shadowed(() => {
        P.rrect(R[id], 7); P.fill(rgba(ACCENT, 0.14));
        P.rrect(R[id], 7); P.stroke(rgba(ACCENT), 3, { cap: 'butt', join: 'miter' });
      }, true);
    }
  }

  function colors(P, m) {
    const { Q, R, t } = P;
    const p = Math.min(1, t / 0.45);
    const mark = (id, c) => {
      const q = Q[id];
      if (!q) return;
      if (m.blob(id)) {
        const rr = Math.max(q.w, q.h) / 2 + 6;
        P.shadowed(() => { P.ellipse(q.x + q.w / 2, q.y + q.h / 2, rr); P.stroke(rgba(c, p), 4); });
      } else {
        P.rrect(inset(q, -5, -2), 5); P.fill(rgba(c, 0.12 * p));
        P.shadowed(() => { P.rrect({ x: q.x - 3, y: q.y + q.h + 1, w: (q.w + 6) * p, h: 4 }, 2); P.fill(rgba(c)); });
      }
    };
    if (m.current != null) {
      const a = m.arrow(m.current);
      if (a) P.strokeArrow(R[a[0]], R[a[1]], gray(0.3), 2.5, { progress: t / 0.6 });
      for (const id of m.focus(m.current)) mark(id, m.colorOf(id) ?? [64, 64, 64]);
    } else {
      const ps = m.pathIDs;
      for (let k = 0; k + 1 < ps.length; k++) P.strokeArrow(R[ps[k]], R[ps[k + 1]], rgba(GRAY), 2.5, { dash: [7, 6] });
      for (const id of m.markIDs) mark(id, m.colorOf(id));
    }
  }

  function leader(P, m) {
    const { R, Q, t } = P;
    const lead = (from, id, op, k) => {
      const r = R[id];
      const q = Q[id];
      if (!r || !q) return;
      const node = m.blob(id);
      const to = node ? { x: r.x + r.w / 2, y: r.y } : { x: r.x + r.w, y: r.y + r.h / 2 };
      const line = cubicPts(from, { x: from.x - 140, y: from.y }, node ? { x: to.x, y: to.y - 110 } : { x: to.x + 130, y: to.y }, to);
      const p = ease((t - k * 0.15) / 0.6);
      P.shadowed(() => {
        P.ctx.globalAlpha = op;
        P.path(trim(line, p)); P.stroke(rgba(ACCENT), 2);
        P.ellipse(from.x, from.y, 4.5); P.fill(rgba(ACCENT));
        if (p >= 1) { P.ellipse(to.x, to.y, 4.5); P.fill(rgba(ACCENT)); }
        if (node) {
          const rr = Math.max(q.w, q.h) / 2 + 5;
          P.ellipse(q.x + q.w / 2, q.y + q.h / 2, rr); P.stroke(rgba(ACCENT), 3);
        } else {
          P.path([{ x: q.x, y: q.y + q.h + 3 }, { x: q.x + q.w, y: q.y + q.h + 3 }]); P.stroke(rgba(ACCENT), 3, { cap: 'butt' });
        }
      });
    };
    if (m.current != null) {
      const ids = m.focus(m.current);
      const a = m.anchors.say;
      if (a) ids.forEach((id, k) => lead(a, id, 1, k));
      else for (const id of ids) P.underline(id, rgba(ACCENT), 3, 1);
      const ar = m.arrow(m.current);
      if (ar) P.strokeArrow(R[ar[0]], R[ar[1]], rgba(ACCENT), 2.5, { progress: (t - 0.5) / 0.5 });
    } else {
      (m.d.marks || []).forEach((id, k) => {
        if (!R[id]) return;
        const ref = `m${k}`;
        const op = m.hover == null ? 0.5 : m.hover === ref ? 1 : 0.12;
        const a = m.anchors[ref];
        if (a) lead(a, id, op, k); else P.underline(id, rgba(ACCENT, op), 3, 1);
      });
    }
  }

  function flow(P, m) {
    const { R, Q, t, ctx } = P;
    let segs = [];
    if (m.current != null) { const a = m.arrow(m.current); if (a) segs = [[a[0], a[1]]]; } else {
      const ps = m.pathIDs;
      for (let k = 0; k + 1 < ps.length; k++) segs.push([ps[k], ps[k + 1]]);
    }
    for (const [a, b] of segs) { P.path(arrowParts(R[a], R[b], { gap: 6 }).line); P.stroke(rgba(GRAY), 2.5, { dash: [2, 7] }); }
    const sweep = m.current != null
      ? m.focus(m.current).filter((id) => m.arrow(m.current)?.[0] !== id && !m.blob(id))
      : m.markIDs.filter((id) => !m.blob(id) && !m.pathIDs.includes(id));
    for (const id of sweep) P.underline(id, rgba(m.current == null ? GRAY : ACCENT), 3.5, t / 1.0);
    if (m.current == null && !segs.length) for (const id of m.markIDs) if (m.blob(id)) P.ring(id, rgba(ACCENT, 0.6), 3);
    if (!segs.length) return;
    const per = 0.95;
    const rest = m.current == null ? 0.9 : 1.3;
    const cycle = segs.length * per + rest;
    const done = t >= FLOW_CYCLES * cycle;
    const tc = done ? cycle - 0.0001 : t % cycle;
    segs.forEach(([, b], j) => {
      const hit = tc - (j + 1) * per;
      const base = m.current == null ? 0.25 : done ? 0.9 : 0;
      const op = hit >= 0 ? Math.max(m.current == null ? 0.25 : 0.9, 1 - hit / 0.9) : base;
      const q = Q[b];
      if (op > 0 && q) {
        const rr = Math.max(q.w, q.h) / 2 + 6;
        P.ellipse(q.x + q.w / 2, q.y + q.h / 2, rr); P.stroke(rgba(ACCENT, op), 3.5);
      }
    });
    if (done) return;
    const k = Math.min(segs.length - 1, Math.floor(tc / per));
    const moving = tc < segs.length * per;
    const f = moving ? ease((tc - k * per) / per) : 1;
    const pts = trim(arrowParts(R[segs[k][0]], R[segs[k][1]], { gap: 6 }).line, Math.max(0.001, f));
    const pt = pts[pts.length - 1];
    const op = moving ? 1 : Math.max(0, 1 - (tc - segs.length * per) / 0.4);
    ctx.save();
    ctx.shadowColor = rgba(ACCENT, 0.9 * op); ctx.shadowBlur = 14;
    P.ellipse(pt.x, pt.y, 8); P.fill(rgba(ACCENT, op));
    ctx.restore();
  }

  /** 번호표: 가로로 긴 줄은 왼쪽 바깥, 그림 속 라벨은 왼쪽 위 모서리 */
  function trailBadge(P, m, id, text, color) {
    const r = P.R[id];
    if (!r) return;
    const c = m.blob(id) || r.x < 30 ? { x: r.x + 2, y: r.y + 1 } : { x: r.x - 14, y: r.y + r.h / 2 };
    P.badge(text, c, color);
  }

  function trail(P, m) {
    const { R, t } = P;
    if (!m.scenes.length) { // 질문의 답·장면 없는 설명: 짚은 곳 번호 = 카드 목록 번호
      const ps = m.pathIDs;
      for (let k = 0; k + 1 < ps.length; k++) P.strokeArrow(R[ps[k]], R[ps[k + 1]], rgba(ACCENT, 0.5), 2.2);
      m.markIDs.forEach((id, n) => {
        if (m.hover === `m${n}` && R[id]) { P.rrect(R[id], 7); P.stroke(rgba(ACCENT), 2.8, { cap: 'butt', join: 'miter' }); }
        trailBadge(P, m, id, String(n + 1), rgba(ACCENT));
      });
      return;
    }
    const upto = m.current ?? m.scenes.length - 1;
    const cur = m.current ?? (m.hover?.[0] === 's' && /^s\d+$/.test(m.hover) ? Number(m.hover.slice(1)) : -1);
    const { order, nums } = trailNumbers(m);
    for (let k = 0; k <= Math.max(0, upto); k++) {
      const a = m.arrow(k);
      if (!a) continue;
      if (k === cur) P.strokeArrow(R[a[0]], R[a[1]], rgba(ACCENT), 3.5, { progress: m.current == null ? 1 : t / 0.6 });
      else P.strokeArrow(R[a[0]], R[a[1]], m.current == null ? rgba(ACCENT, 0.45) : rgba(GRAY, 0.85), 2.2);
    }
    if (cur >= 0) {
      const s = m.current == null ? 1 : 1 + 0.12 * (1 - Math.min(1, t / 0.35));
      for (const id of m.targets(cur)) {
        const r = R[id];
        if (!r) continue;
        P.shadowed(() => {
          P.rrect({ x: r.x + r.w / 2 - r.w * s / 2, y: r.y + r.h / 2 - r.h * s / 2, w: r.w * s, h: r.h * s }, 7);
          P.stroke(rgba(ACCENT), 2.8, { cap: 'butt', join: 'miter' });
        });
      }
    }
    for (const id of order) {
      const list = nums[id];
      const on = list.includes(cur) || (m.current == null && cur < 0);
      trailBadge(P, m, id, list.map((k) => String(k + 1)).join('·'), on ? rgba(ACCENT) : rgba(GRAY));
    }
  }

  function minimap(P, m) {
    const { R, t } = P;
    const ids = m.hoverIDs() ?? (m.current != null ? m.targets(m.current) : m.scenes.length ? [] : m.markIDs);
    const beat = t < BEAT ? 0.5 + 0.5 * Math.cos(t * 2 * Math.PI / 1.4) : 1;
    for (const id of ids) {
      const r = R[id];
      if (!r) continue;
      const c = m.blob(id) ? { x: r.x + r.w / 2, y: r.y - 10 } : { x: r.x - 10, y: r.y + r.h / 2 };
      const outer = 9 * (1 + 0.5 * (1 - beat));
      P.ellipse(c.x, c.y, outer); P.fill(rgba(ACCENT, 0.35 + 0.5 * beat));
      P.shadowed(() => {
        P.ellipse(c.x, c.y, 5.5); P.fill(rgba(ACCENT));
        P.ellipse(c.x, c.y, 5.5); P.stroke('#fff', 2);
      });
    }
  }

  // ── 화면에 바로 적기 ──

  function bubble(P, m) {
    const { R, t, ctx } = P;
    const mark = (id, p) => (m.blob(id) ? P.ring(id, rgba(ACCENT, p), 3) : P.underline(id, rgba(ACCENT), 3, p));
    const taken = [];
    const say = (text, id, small, op) => {
      const r = R[id];
      if (!r) return;
      const label = P.measure(text, FONT(small ? 14.5 : 17, 600), 290, small ? 19 : 22);
      const box = spot({ w: label.w + (small ? 20 : 24), h: label.h + (small ? 8 : 16) }, r, taken, m.others, P.area);
      taken.push(box);
      const c = mid(r); // 꼬리: 상자 가장자리에서 짚은 곳 쪽으로
      const mp = { x: Math.min(Math.max(c.x, box.x + 14), box.x + box.w - 14), y: Math.min(Math.max(c.y, box.y + 10), box.y + box.h - 10) };
      const e = edge(box, c);
      const dx = e.x - mp.x;
      const dy = e.y - mp.y;
      const len = Math.max(1, Math.hypot(dx, dy));
      ctx.save();
      ctx.globalAlpha = op;
      ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 16; ctx.shadowOffsetY = 4;
      ctx.beginPath();
      ctx.roundRect(box.x, box.y, box.w, box.h, small ? box.h / 2 : 12);
      ctx.moveTo(e.x - dy / len * 7, e.y + dx / len * 7);
      ctx.lineTo(e.x + dx / len * 9, e.y + dy / len * 9);
      ctx.lineTo(e.x + dy / len * 7, e.y - dx / len * 7);
      ctx.fillStyle = gray(0.11);
      ctx.fill('nonzero');
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = op;
      P.text(label, inset(box, small ? 10 : 12, small ? 4 : 8), '#fff');
      ctx.restore();
    };
    if (m.current != null) {
      const i = m.current;
      for (const id of m.focus(i)) mark(id, t / 0.5);
      const a = m.arrow(i);
      if (a) P.strokeArrow(R[a[0]], R[a[1]], rgba(ACCENT), 2.8, { progress: (t - 0.2) / 0.6 });
      const id = m.focus(i)[0] ?? a?.[1];
      if (id != null) say(m.scenes[i].tag, id, false, Math.min(1, Math.max(0, (t - 0.25) / 0.3)));
    } else {
      const ps = m.pathIDs;
      for (let k = 0; k + 1 < ps.length; k++) P.strokeArrow(R[ps[k]], R[ps[k + 1]], rgba(GRAY), 2);
      for (const id of m.markIDs) mark(id, 1);
      const seen = new Set();
      m.scenes.forEach((sc, k) => {
        const id = m.focus(k)[0];
        if (id == null || seen.has(id)) return;
        seen.add(id);
        say(sc.tag, id, true, Math.min(1, Math.max(0, (t - k * 0.12) / 0.3)));
      });
    }
  }

  function notes(P, m) {
    const { R, t, ctx } = P;
    if (!m.scenes.length) {
      for (const id of m.markIDs) P.penUnderline(id, 1);
      const ps = m.pathIDs;
      for (let k = 0; k + 1 < ps.length; k++) P.strokeArrow(R[ps[k]], R[ps[k + 1]], rgba(PEN, 0.8), 2, { bend: 14 });
      return;
    }
    const upto = m.current ?? m.scenes.length - 1;
    const taken = [];
    const pf = penFont();
    for (let k = 0; k <= upto; k++) {
      const now = m.current === k;
      const op = now || m.current == null ? 1 : 0.45;
      const a = m.arrow(k);
      if (a) {
        P.strokeArrow(R[a[0]], R[a[1]], rgba(PEN, m.current == null ? 0.8 : now ? 1 : 0.35), now ? 2.8 : 2,
          { bend: 14, progress: now ? (t - 0.25) / 0.6 : 1 });
      }
      const id = m.focus(k)[0] ?? a?.[1];
      const r = id != null ? R[id] : null;
      if (!r) continue;
      if (now) for (const f of m.focus(k)) (m.blob(f) ? P.roughCircle(f, t / 0.6) : P.penUnderline(f, t / 0.6));
      const label = P.measure(m.scenes[k].tag, pf.font, 400, pf.lineH);
      const box = spot({ w: label.w + 6, h: label.h }, r, taken, m.others, P.area, m.blob(id) ? 14 : 48);
      taken.push(box);
      // 줄 끝에서 메모까지 점선
      const e1 = edge(r, mid(box));
      const e2 = edge(box, mid(r));
      P.path(quadPts(e1, { x: (e1.x + e2.x) / 2, y: (e1.y + e2.y) / 2 + 6 }, e2));
      P.stroke(rgba(PEN, op * 0.8), 1.6, { dash: [4, 5] });
      ctx.save();
      ctx.globalAlpha = op;
      if (now) { ctx.beginPath(); ctx.rect(box.x - 2, box.y - 6, (box.w + 4) * ease(t / 0.7), box.h + 12); ctx.clip(); }
      P.text(label, box, rgba(PEN));
      ctx.restore();
    }
  }

  function penMarks(P, m) {
    const { R, t, ctx } = P;
    if (m.current != null) {
      const i = m.current;
      const f = m.focus(i);
      f.forEach((id, k) => P.roughCircle(id, (t - k * 0.5) / 0.7, k + 1.7));
      const a = m.arrow(i);
      if (a) P.strokeArrow(inset(R[a[0]], -6, -6), inset(R[a[1]], -6, -6), rgba(PEN), 3, { bend: 26, progress: (t - f.length * 0.5) / 0.6 });
      const id = f[0] ?? a?.[1];
      const r = id != null ? R[id] : null;
      if (!r) return;
      const pf = penFont();
      const label = P.measure(m.scenes[i].tag, pf.font, 400, pf.lineH);
      const box = spot({ w: label.w + 6, h: label.h }, inset(r, -16, -8), [], m.others, P.area, 10);
      ctx.save();
      ctx.globalAlpha = Math.min(1, Math.max(0, (t - f.length * 0.5 - 0.4) / 0.4));
      P.text(label, box, rgba(PEN));
      ctx.restore();
    } else {
      m.markIDs.forEach((id, k) => P.roughCircle(id, (t - k * 0.3) / 0.7, k * 0.3 + 1.7));
      const ps = m.pathIDs;
      for (let k = 0; k + 1 < ps.length; k++) P.strokeArrow(R[ps[k]], R[ps[k + 1]], rgba(PEN, 0.55), 2.2, { bend: 18 });
    }
  }

  const DRAW = { spotlight, highlighter, corners, hover, colors, leader, flow, trail, minimap, bubble, notes, pen: penMarks };

  /** 한 장 그리기. previous: 앞 장면이 짚은 줄 (스포트라이트가 그 자리에서 미끄러져 온다) */
  function paint(ctx, data, t, area, previous = []) {
    const m = Model(data);
    const fn = DRAW[m.style];
    if (!fn) return;
    fn(Painter(ctx, m, t, area), m, previous);
  }

  /** 표시 창의 canvas 하나를 맡는다: update(data) 로 자료를 받고, 장면이 바뀌면 t 를 0 부터 settle 까지 그린다 */
  function Stage(canvas) {
    let data = null;
    let key = '';
    let start = 0;
    let previous = [];
    let raf = 0;
    const size = () => ({ w: canvas.clientWidth || innerWidth, h: canvas.clientHeight || innerHeight });
    function frame() {
      raf = 0;
      const dpr = devicePixelRatio || 1;
      const { w, h } = size();
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!data) return;
      const t = (performance.now() - start) / 1000;
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      paint(ctx, data, reduce ? Math.max(t, settleTime(data.style)) : t, { w, h }, previous);
      if (!reduce && t < settleTime(data.style)) raf = requestAnimationFrame(frame);
    }
    return {
      update(d) {
        // 장면·방식·내용이 바뀌면 처음부터 (마우스·카드 자리·글자 자리 옮김은 이어서)
        const k = d ? [d.style, d.scene, d.scenes.length, d.marks.join(','), d.path.join(',')].join('|') : '';
        if (k !== key) {
          previous = data && d ? Model(data).focusNow() : [];
          key = k;
          start = performance.now();
        }
        data = d;
        if (!raf) raf = requestAnimationFrame(frame);
      },
      clear() {
        data = null;
        key = '';
        if (!raf) raf = requestAnimationFrame(frame);
      },
    };
  }

  const api = { settleTime, ease, lerp, edge, arrowParts, trim, quadPts, Model, trailNumbers, spot, paint, Stage, FLOW_CYCLES, BEAT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Marks = api;
}(typeof window !== 'undefined' ? window : globalThis));
