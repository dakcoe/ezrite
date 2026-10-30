'use strict';

// 맥판 explain.html 의 스크립트 그대로 (글꼴만 Windows 용)
const dark = matchMedia("(prefers-color-scheme: dark)").matches;
mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "neutral", securityLevel: "strict",
                     fontFamily: "'Pretendard Variable', 'Segoe UI Variable', 'Malgun Gothic', sans-serif",
                     // 주고받기 그림은 기본 간격이 넓어 카드 폭(420)에 맞추며 통째로 줄어 글씨가 작아진다.
                     // 참여자 상자와 간격을 좁혀 원래 크기에 가깝게 그리고, 글씨는 키운다
                     // useMaxWidth: false — 줄이지 않고 원래 크기로 그린다. 카드보다 넓으면 옆으로 밀어서 본다
                     sequence: { useMaxWidth: false, width: 80, height: 44, actorMargin: 20, boxMargin: 6, messageMargin: 32,
                                 actorFontSize: 16, messageFontSize: 16, noteFontSize: 15, mirrorActors: true, bottomMarginAdj: 10 } });
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls;
                                 if (text != null) e.textContent = text; return e; };
// 글 속 수식 \(…\) \[…\] $$…$$ $…$ 을 KaTeX 로 그린다. 프롬프트로 막아도 모델이 LaTeX 를 쓸 때가 있다.
// 못 그리면 원래 글 그대로. 글은 텍스트 노드로만 넣는다 (innerHTML 아님)
// 마지막 갈래: 기호 없이 쓴 LaTeX 덩어리 (Z^{(l)}=W^{(l)}a^{(l-1)}). 공백·한글 없는 덩어리에 ^{ _{ \명령 이 있을 때만
const MATH = /\\\((.+?)\\\)|\\\[(.+?)\\\]|\$\$(.+?)\$\$|\$([^$\n]*[\\^_{}][^$\n]*?)\$|([^\s가-힣$]*(?:[\^_]\{|\\[a-zA-Z]{2,})[^\s가-힣$]*)/gs;
const withMath = (e, text) => {
  let last = 0;
  for (const m of text.matchAll(MATH)) {
    e.append(document.createTextNode(text.slice(last, m.index)));
    const tex = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5], span = el("span", "math");
    try { katex.render(tex, span, { displayMode: false, throwOnError: true }); } catch { span.textContent = m[0]; }
    e.append(span);
    last = m.index + m[0].length;
  }
  e.append(document.createTextNode(text.slice(last)));
  return e;
};
// AI 가 쓴 **굵게** 를 굵은 글씨로
const rich = (tag, cls, text) => { const e = el(tag, cls);
                                   text.split(/\*\*(.+?)\*\*/s).forEach((part, i) =>
                                     i % 2 ? e.append(withMath(el("strong"), part)) : withMath(e, part));
                                   return e; };
// AI 가 JSON 에 "\times", "\frac" 를 역슬래시 하나로 쓰면 해석하면서 \t(탭) \f \b \r \n 제어 문자가 된다.
// 수식에는 제어 문자가 올 일이 없으니 원래 명령으로 되돌린다
const fixTex = t => t.replace(/\t/g, "\\t").replace(/\f/g, "\\f").replace(/\x08/g, "\\b")
                     .replace(/\r/g, "\\r").replace(/\n/g, "\\n");
// 글에 "\n" 이 글자 그대로 들어오면 줄바꿈으로, "\u03b4" 처럼 한 번 더 감싼 글자는 원래 글자(δ)로
const fixText = t => String(t).replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
                              .replace(/\\n/g, "\n");
// 문장 끝(. ? !) 뒤 빈칸에서 자른다. 0.5 처럼 숫자 사이 점은 빈칸이 없어 자르지 않는다 (맥 1.2.0)
const sentences = t => t.replace(/([.?!])\s+(?=\S)/g, "$1\u0000").split("\u0000").map(x => x.trim()).filter(Boolean);
// 긴 문단은 두 문장씩 나눈다 (모델이 문단을 나눴어도 한 문단이 140자를 넘으면 다시 나눈다)
const paragraphs = t => t.split(/\n{2,}/).map(par => {
  if (par.includes("\n") || par.length < 140) return par;
  const s = sentences(par), out = [];
  for (let i = 0; i < s.length; i += 2) out.push(s.slice(i, i + 2).join(" "));
  return out.join("\n\n");
}).join("\n\n");
// 요약: 한 문장에 한 줄. 첫 문장은 굵게 (무엇인지), 나머지는 그 아래로
const summaryBlock = t => {
  const box = el("div", "summary");
  t.split(/\n+/).flatMap(sentences).forEach((x, i) => box.append(rich("p", i ? null : "lead", x)));
  return box;
};

// 앱이 카드 높이를 내용에 맞추도록 그린 뒤 높이를 알린다
// 창 크기가 아니라 내용 높이(설명 + 대화 + 질문 칸)를 잰다. 그래야 내용이 짧을 때 창이 줄어든다
const reportHeight = () => {
  const h = ["root", "chat", "ask"].reduce((a, id) => a + document.getElementById(id).offsetHeight, 0);
  window.webkit?.messageHandlers?.height?.postMessage(h);
};

// 주고받기 그림의 칸 글씨를 키우면 그림 도구가 계산한 세로 위치가 어긋난다. 칸 한가운데로 다시 놓는다
function centerActorText(root) {
  root.querySelectorAll("text.actor").forEach(t => {
    const rect = t.parentElement?.querySelector("rect.actor") ?? t.previousElementSibling;
    if (!rect || rect.tagName !== "rect") return;
    const cy = parseFloat(rect.getAttribute("y")) + parseFloat(rect.getAttribute("height")) / 2;
    t.setAttribute("y", cy);
    t.setAttribute("dominant-baseline", "central");
    t.querySelectorAll("tspan").forEach(sp => { sp.setAttribute("y", cy); sp.removeAttribute("dy");
                                                 sp.setAttribute("dominant-baseline", "central"); });
  });
}

async function render(d) {
  try { await draw(d); } finally { requestAnimationFrame(reportHeight); }
}

async function draw(d) {
  stopPlayer();
  const root = document.getElementById("root");
  root.replaceChildren();
  chat.replaceChildren(); pendingQA = null; send.disabled = false;
  if (d.loading) {
    const l = el("div", "loading"); l.append(el("div", "spin"), el("span", null, d.loading)); root.append(l); return;
  }
  if (d.error) { root.append(el("div", "error", d.error)); }
  if (d.hint) root.append(el("p", "hint", d.hint));
  if (d.summary) root.append(summaryBlock(fixText(d.summary)));
  if (d.marks && d.marks.length) {
    const ul = el("ul", "marks");
    d.marks.forEach((m, i) => {
      const li = el("li"); li.append(el("span", "badge", String(i + 1)));
      const t = el("div"); t.append(withMath(el("div"), fixText(m.note || "")));
      li.append(t); ul.append(li);
    });
    root.append(ul);
  }
  if (d.path && d.path.steps && d.path.steps.length) {
    const r = el("div", "route");
    r.append(el("div", null, d.path.note || "그림 속 순서"));
    const c = el("div", "chips");
    d.path.steps.forEach((s, i) => { if (i) c.append(el("span", "arrow", "→")); c.append(el("span", "chip", (i + 1) + " " + s)); });
    r.append(c); root.append(r);
  }
  const boxes = [];
  for (const v of d.visuals || []) { const box = await visual(v); boxes.push(box); root.append(box); }
  if (!d.loading) { document.getElementById("ask").classList.add("on"); }
  if (d.scenes && d.scenes.length) startPlayer(d, root, boxes);
  else { post("scene", -1); boxes.forEach(b => b._anim?.play()); }
}

const post = (name, v) => window.webkit?.messageHandlers?.[name]?.postMessage(v);

// 그림 하나 (단계·표·카드·관계도). 설명과 질문 답이 함께 쓴다
let mermaidN = 0;
async function visual(v) {
  const box = el("section", "visual");
  if (v.title) box.append(el("h3", null, v.title));
  if (v.type === "steps") {
    const ol = el("ol", "steps"); v.items.forEach(it => ol.append(withMath(el("li"), fixText(it)))); box.append(ol);
  } else if (v.type === "table") {
    const t = el("table"), hr = el("tr");
    v.headers.forEach(h => hr.append(el("th", null, h))); t.append(hr);
    v.rows.forEach(r => { const tr = el("tr"); r.forEach(c => tr.append(withMath(el("td"), fixText(c)))); t.append(tr); });
    box.append(t);
  } else if (v.type === "card") {
    if (v.formula) {
      const f = el("div", "formula");
      const tex = fixTex(v.formula);
      try { katex.render(tex, f, { displayMode: true, throwOnError: true }); }
      catch { f.textContent = tex; }
      box.append(f);
    }
    if (v.body) box.append(rich("p", "body", fixText(v.body)));
    if (v.terms && v.terms.length) {
      const dl = el("dl"); v.terms.forEach(([a, b]) => dl.append(withMath(el("dt"), fixText(a)), withMath(el("dd"), fixText(b || ""))));
      box.append(dl);
    }
  } else if (v.type === "mermaid") {
    const g = el("div", "diagram"); box.append(g);
    try {
      const { svg } = await mermaid.render("m" + (mermaidN++) + Date.now(), v.code);
      g.innerHTML = svg;
      centerActorText(g);
    } catch { g.append(el("p", "fail", "그림을 그리지 못했습니다.")); }
  } else if (v.type === "anim") {
    anim(box, v);
  }
  return box;
}

// 움직이는 그림. 물체(items)는 id 로 한 번 만들고, 단계(frames)마다 나타나기·강조·잇기·자리 바꾸기·글 바꾸기만 한다.
// 자리는 layout(row·column·cycle)으로 여기서 계산한다 — AI 에게 좌표를 맡기면 겹치고 빗나간다.
// box._anim.go(k): k 단계까지 본 모습으로 (장면 재생기가 부른다), play(): 혼자 처음부터 재생
const NS = "http://www.w3.org/2000/svg";

// k 단계까지 차례로 적용한 모습. 모르는 id 는 버린다. sets[id]: 바뀐 글(label)·자리(at)·곡선(points)
function animState(frames, items, k) {
  const s = { shown: [], focus: [], links: [], sets: {}, caption: "" };
  frames.slice(0, k).forEach((f, i) => {
    const last = i === k - 1;
    for (const id of f.show || []) if (items.has(id) && !s.shown.includes(id)) s.shown.push(id);
    // 자리 바꾸기: 지금 보이는 물체를 빠짐없이 다시 늘어놓은 순서만 받는다
    const o = (f.order || []).filter(id => s.shown.includes(id));
    if (o.length === s.shown.length && new Set(o).size === o.length) s.shown = o;
    s.focus = (f.focus || []).filter(id => items.has(id));
    s.links.forEach(l => l.fresh = false);
    for (const l of f.links || []) if (l && items.has(l.from) && items.has(l.to) && l.from !== l.to)
      s.links.push({ from: l.from, to: l.to, label: l.label, fresh: last });
    for (const x of f.set || []) if (x && items.has(x.id)) {
      const m = s.sets[x.id] = { ...s.sets[x.id] };
      if (x.label != null) m.label = String(x.label);
      if (validPt(x.at)) m.at = x.at;
      if (validPts(x.points)) m.points = x.points;
    }
    s.caption = f.caption || "";
  });
  for (const id of s.focus) if (!s.shown.includes(id)) s.shown.push(id);
  return s;
}
const validPt = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const validPts = ps => Array.isArray(ps) && ps.length >= 2 && ps.every(validPt);

// 다시 보기 단추와 장면 재생기 연결 (상자 그림·그래프 공용)
function animControls(box, again, frames, go) {
  let autoplay = null;
  function play() {
    clearInterval(autoplay);
    let k = 1; go(0, false); go(1);
    autoplay = setInterval(() => { if (++k > frames.length) return clearInterval(autoplay); go(k); }, 1900);
  }
  again.onclick = play;
  box._anim = { go: k => { clearInterval(autoplay); go(k); }, play, count: frames.length };
}

// 좌표 그래프: 곡선(points)과 점(at)은 자료 값으로 받고, 화면 자리는 범위를 재서 여기서 정한다.
// set 으로 곡선·점을 옮기면 이전 자리에서 미끄러지듯 바뀐다 (점 개수가 같을 때)
function graph(box, v) {
  const stage = el("div", "anim graph"), svg = document.createElementNS(NS, "svg");
  const cap = el("p", "acap"), capText = el("span"), again = el("button", null, "↻ 다시");
  cap.append(capText, again);
  stage.append(svg);
  box.append(stage, cap);
  const frames = (v.frames || []).filter(f => f && typeof f === "object");
  const items = new Map();
  for (const it of v.items || []) {
    if (!it || it.id == null || items.has(it.id)) continue;
    const kind = validPts(it.points) ? "curve" : validPt(it.at) ? "point" : null;
    if (kind) items.set(it.id, { kind, label: String(it.label ?? ""), base: kind === "curve" ? it.points : it.at, now: null });
  }
  // 범위: 처음 모습과 모든 단계의 바뀐 자리를 함께 잰다
  const all = [];
  items.forEach(it => it.kind === "curve" ? all.push(...it.base) : all.push(it.base));
  for (const f of frames) for (const x of f.set || []) { if (validPts(x?.points)) all.push(...x.points); if (validPt(x?.at)) all.push(x.at); }
  const span = (vals) => { let lo = Math.min(...vals), hi = Math.max(...vals); if (lo === hi) { lo -= 1; hi += 1; }
                           const pad = (hi - lo) * 0.08; return [lo - pad, hi + pad]; };
  const [x0, x1] = all.length ? span(all.map(p => p[0])) : [0, 1], [y0, y1] = all.length ? span(all.map(p => p[1])) : [0, 1];
  const M = { l: 30, r: 16, t: 16, b: 30 };
  let W = 360, H = 240;
  const sx = x => M.l + (x - x0) / (x1 - x0) * (W - M.l - M.r), sy = y => H - M.b - (y - y0) / (y1 - y0) * (H - M.t - M.b);
  // 점이 셋 이상이면 부드러운 곡선(Catmull-Rom), 둘이면 직선
  const pathOf = pts => {
    const q = pts.map(p => [sx(p[0]), sy(p[1])]);
    if (q.length < 3) return `M${q[0]} L${q[1]}`;
    let d = `M${q[0]}`;
    for (let i = 0; i < q.length - 1; i++) {
      const a = q[i - 1] || q[i], b = q[i], c = q[i + 1], e = q[i + 2] || c;
      d += ` C${b[0] + (c[0] - a[0]) / 6},${b[1] + (c[1] - a[1]) / 6} ${c[0] - (e[0] - b[0]) / 6},${c[1] - (e[1] - b[1]) / 6} ${c[0]},${c[1]}`;
    }
    return d;
  };
  const axes = v.axes || {};
  let cur = -1, raf = 0;
  function draw(s, t, from) {
    // t: 0→1 옮겨 가는 정도. from: 옮기기 전 자리
    svg.replaceChildren();
    const ax = document.createElementNS(NS, "path");
    ax.setAttribute("class", "axis"); ax.setAttribute("d", `M${M.l},${M.t - 6} L${M.l},${H - M.b} L${W - M.r + 6},${H - M.b}`);
    svg.append(ax);
    const label = (x, y, text, cls, anchor) => { const e = document.createElementNS(NS, "text");
      e.setAttribute("x", x); e.setAttribute("y", y); e.setAttribute("class", cls); e.style.textAnchor = anchor;
      e.textContent = fixText(text); svg.append(e); };
    if (axes.x) label(W - M.r, H - 10, axes.x, "axname", "end");
    if (axes.y) label(M.l + 6, M.t - 4, axes.y, "axname", "start");
    const mix = (a, b) => a.map((p, i) => [p[0] + (b[i][0] - p[0]) * t, p[1] + (b[i][1] - p[1]) * t]);
    items.forEach((it, id) => {
      if (!s.shown.includes(id)) return;
      const on = s.focus.includes(id) ? " on" : "";
      const target = it.kind === "curve" ? (s.sets[id]?.points ?? it.base) : [s.sets[id]?.at ?? it.base];
      const prev = from?.[id];
      const pts = prev && prev.length === target.length ? mix(prev, target) : target;
      it.now = pts;
      const name = s.sets[id]?.label ?? it.label;
      if (it.kind === "curve") {
        const c = document.createElementNS(NS, "path"); c.setAttribute("class", "curve" + on); c.setAttribute("d", pathOf(pts)); svg.append(c);
        const end = pts.reduce((a, b) => sx(b[0]) > sx(a[0]) ? b : a);
        if (name) label(Math.min(sx(end[0]) + 4, W - 4), sy(end[1]) - 8, name, "gl" + on, "end");
      } else {
        const [px, py] = [sx(pts[0][0]), sy(pts[0][1])];
        const g = document.createElementNS(NS, "path"); g.setAttribute("class", "guide" + on);
        g.setAttribute("d", `M${M.l},${py} L${px},${py} L${px},${H - M.b}`); svg.append(g);
        const c = document.createElementNS(NS, "circle"); c.setAttribute("class", "pt" + on);
        c.setAttribute("cx", px); c.setAttribute("cy", py); c.setAttribute("r", on ? 6 : 4.5); svg.append(c);
        if (name) label(px + 8, py - 10, name, "gl" + on, "start");
      }
    });
  }
  function go(k, animate = true) {
    k = Math.max(0, Math.min(frames.length, k ?? frames.length));
    W = stage.clientWidth || 360; H = Math.min(260, Math.round(W * 0.62));
    stage.style.height = H + "px";
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const s = animState(frames, items, k);
    const from = {}; items.forEach((it, id) => { if (it.now) from[id] = it.now; });
    cancelAnimationFrame(raf);
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!animate || reduce) draw(s, 1, null);
    else {
      const t0 = performance.now(), ease = t => 1 - Math.pow(1 - t, 3);
      const step = now => { const t = Math.min(1, (now - t0) / 700); draw(s, ease(t), from); if (t < 1) raf = requestAnimationFrame(step); };
      raf = requestAnimationFrame(step);
    }
    capText.replaceChildren(); withMath(capText, fixText(s.caption));
    cur = k;
    requestAnimationFrame(reportHeight);
  }
  animControls(box, again, frames, go);
  let lastW = 0;
  new ResizeObserver(() => { const w = stage.clientWidth; if (w && w !== lastW && cur >= 0) { lastW = w; go(cur, false); } }).observe(stage);
  go(frames.length, false);
}

const MIN_W = 84;          // 상자가 이보다 좁으면 한글이 한 자씩 꺾인다 (15px 글자 4자 + 여백)

function anim(box, v) {
  if (v.layout === "graph") return graph(box, v);
  const stage = el("div", "anim"), svg = document.createElementNS(NS, "svg");
  const cap = el("p", "acap"), capText = el("span"), again = el("button", null, "↻ 다시");
  cap.append(capText, again);
  svg.innerHTML = `<defs>${["new", "old"].map(c => `<marker id="ah-${c}-${mermaidN}" viewBox="0 0 10 10" refX="9" refY="5"
    markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L10,5 L0,9" class="${c}" style="fill:none;stroke-width:2"/></marker>`).join("")}</defs><g></g>`;
  const tag = mermaidN++, links = svg.querySelector("g");
  stage.append(svg);
  box.append(stage, cap);
  const items = new Map();
  for (const it of v.items || []) {
    if (!it || it.id == null || items.has(it.id)) continue;
    const n = el("div", "aitem off"), b = el("b"); withMath(b, fixText(it.label ?? it.id)); n.append(b);
    if (it.note) n.append(withMath(el("small"), fixText(it.note)));
    stage.append(n);
    items.set(it.id, { n, b, label: String(it.label ?? it.id) });
  }
  const frames = (v.frames || []).filter(f => f && typeof f === "object");
  const layout = ["row", "column", "cycle", "layers", "grid"].includes(v.layout) ? v.layout : "row";
  const index = new Map([...items.keys()].map((id, i) => [id, i]));
  const layerOf = new Map((v.items || []).filter(it => it && items.has(it.id)).map(it => [it.id, Number.isInteger(it.layer) ? it.layer : 0]));

  const state = k => animState(frames, items, k);

  // 보이는 물체 자리 (stage 안 px). 물체가 늘면 다시 나눠 앉아서, 나타날 때 옆 물체가 비켜 준다
  function place(shown) {
    const W = stage.clientWidth || 360, n = Math.max(shown.length, 1), gap = 22, pos = {};
    const hasNote = shown.some(id => items.get(id).n.querySelector("small"));
    const h = hasNote ? 66 : 50;
    let H;
    if (layout === "layers") {
      // 층마다 한 열 (왼쪽부터). 열 안에서는 보이는 물체만 위아래 가운데 맞춤
      const layers = [...new Set(layerOf.values())].sort((a, b) => a - b);
      const cw = W / layers.length, w = Math.min(100, cw * 0.62), lh = hasNote ? 56 : 40, vg = 14;
      const stacks = layers.map(L => shown.filter(id => layerOf.get(id) === L));
      // 층이 많아 열이 좁으면 글자가 한 자씩 꺾인다. 그땐 층을 위에서 아래로 한 줄씩 놓는다
      if (w < MIN_W) {
        const wide = Math.max(1, ...stacks.map(st => st.length)), hg = 18, rg = 34;
        const rw = Math.min(120, (W - hg * (wide - 1)) / wide);
        stacks.forEach((st, r) => st.forEach((id, i) => {
          const left = (W - (st.length * rw + hg * (st.length - 1))) / 2;
          pos[id] = { x: left + i * (rw + hg), y: 12 + r * (lh + rg), w: rw, h: lh };
        }));
        return { pos, H: 24 + layers.length * (lh + rg) - rg, free: true };
      }
      const most = Math.max(1, ...stacks.map(st => st.length));
      H = most * (lh + vg) - vg + 24;
      stacks.forEach((st, c) => st.forEach((id, i) =>
        pos[id] = { x: c * cw + (cw - w) / 2, y: 12 + (H - 24 - (st.length * (lh + vg) - vg)) / 2 + i * (lh + vg), w, h: lh }));
      return { pos, H };
    }
    if (layout === "grid") {
      // 칸 자리는 물체 순서로 고정 (나타나도 옆 칸이 움직이지 않는다)
      const total = items.size, cols = Math.max(1, Math.min(10, Number.isInteger(v.cols) ? v.cols : Math.ceil(Math.sqrt(total))));
      const rows = Math.ceil(total / cols), g = 6, w = Math.min(72, (W - g * (cols - 1)) / cols), ch = 40;
      const left = (W - (cols * w + g * (cols - 1))) / 2;
      shown.forEach(id => { const i = index.get(id);
        pos[id] = { x: left + (i % cols) * (w + g), y: 10 + Math.floor(i / cols) * (ch + g), w, h: ch }; });
      return { pos, H: 20 + rows * (ch + g) - g };
    }
    if (layout === "column") {
      const w = Math.min(240, W * 0.62), step = h + 30;
      shown.forEach((id, i) => pos[id] = { x: (W - w) / 2, y: 14 + i * step, w, h });
      H = 28 + n * step - 30;
    } else if (layout === "cycle" && n > 2) {
      const w = Math.min(104, W / 3.4), r = Math.min(W / 2 - w / 2 - 8, 70 + n * 12);
      shown.forEach((id, i) => {
        const a = -Math.PI / 2 + i * 2 * Math.PI / n;
        pos[id] = { x: W / 2 + r * Math.cos(a) - w / 2, y: r + 12 + r * Math.sin(a), w, h };
      });
      H = 2 * r + h + 24;
    } else if ((W - gap * (n - 1)) / n < MIN_W) {
      // 한 줄에 다 넣으면 상자가 좁아져 글자가 한 자씩 꺾인다. 여러 줄로 나눠 놓는다
      const g = 30, per = Math.max(1, Math.floor((W + g) / (MIN_W + g))), w = Math.min(120, (W - g * (per - 1)) / per), rg = 40;
      shown.forEach((id, i) => {
        const r = Math.floor(i / per), inRow = Math.min(per, n - r * per), left = (W - (inRow * w + g * (inRow - 1))) / 2;
        pos[id] = { x: left + (i % per) * (w + g), y: 14 + r * (h + rg), w, h };
      });
      return { pos, H: 28 + Math.ceil(n / per) * (h + rg) - rg, free: true };
    } else {
      const w = Math.min(120, (W - gap * (n - 1)) / n), left = (W - (n * w + gap * (n - 1))) / 2, top = 58;
      shown.forEach((id, i) => pos[id] = { x: left + i * (w + gap), y: top, w, h });
      H = top * 2 + h;
    }
    return { pos, H };
  }

  // 상자 가장자리에서 끊는 곡선. 같은 두 물체 사이 선이 여럿이면 위아래로 번갈아 휘고, 사이에 물체가 있으면 크게 돌아간다
  function curve(a, b, bend) {
    const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const dx = cb.x - ca.x, dy = cb.y - ca.y, len = Math.hypot(dx, dy) || 1;
    const c = { x: (ca.x + cb.x) / 2 - dy / len * bend, y: (ca.y + cb.y) / 2 + dx / len * bend };
    const edge = (r, ctr, t) => {
      const ex = t.x - ctr.x, ey = t.y - ctr.y;
      const s = Math.min(ex ? (r.w / 2 + 3) / Math.abs(ex) : Infinity, ey ? (r.h / 2 + 3) / Math.abs(ey) : Infinity);
      return { x: ctr.x + ex * s, y: ctr.y + ey * s };
    };
    const p = edge(a, ca, c), q = edge(b, cb, c);
    return { d: `M${p.x},${p.y} Q${c.x},${c.y} ${q.x},${q.y}`,
             mid: { x: (p.x + 2 * c.x + q.x) / 4, y: (p.y + 2 * c.y + q.y) / 4 } };
  }

  // 줄·열 배치: 사이 틈이 좁아 곧은 화살표는 안 보인다. 상자 위(열이면 오른쪽)로 넘어가는 호로 잇는다.
  // 같은 두 물체 사이 선이 여럿이면 위·아래로 번갈아, 멀리 떨어질수록 높게 넘어간다
  function arc(a, b, o, apart) {
    const side = o % 2 ? 1 : -1, lift = 24 + 10 * (apart - 1) + 14 * Math.floor(o / 2);
    let p, q, c;
    if (layout === "column") {
      const x = r => side < 0 ? r.x + r.w + 3 : r.x - 3, sx = side < 0 ? 1 : -1;
      p = { x: x(a), y: a.y + a.h / 2 }; q = { x: x(b), y: b.y + b.h / 2 };
      c = { x: p.x + sx * lift * 2, y: (p.y + q.y) / 2 };
    } else {
      const y = r => side < 0 ? r.y - 3 : r.y + r.h + 3;
      p = { x: a.x + a.w / 2, y: y(a) }; q = { x: b.x + b.w / 2, y: y(b) };
      c = { x: (p.x + q.x) / 2, y: p.y + side * lift * 2 };
    }
    return { d: `M${p.x},${p.y} Q${c.x},${c.y} ${q.x},${q.y}`,
             mid: { x: (p.x + 2 * c.x + q.x) / 4, y: (p.y + 2 * c.y + q.y) / 4 } };
  }

  let cur = -1;
  function go(k, animate = true) {
    k = Math.max(0, Math.min(frames.length, k ?? frames.length));
    const s = state(k), { pos, H, free } = place(s.shown);
    stage.style.height = H + "px";
    items.forEach((it, id) => {
      const p = pos[id];
      it.n.classList.toggle("off", !p);
      it.n.classList.toggle("on", s.focus.includes(id));
      if (p) { it.n.classList.toggle("narrow", p.w < 80); it.n.style.width = p.w + "px"; it.n.style.height = p.h + "px";
               it.n.style.transform = `translate(${p.x}px,${p.y}px) scale(${s.focus.includes(id) ? 1.06 : 1})`; }
      const label = s.sets[id]?.label ?? it.label;
      if (it.b.dataset.t !== label) {
        const first = it.b.dataset.t == null;
        it.b.dataset.t = label; it.b.replaceChildren(); withMath(it.b, fixText(label));
        if (!first && animate) { it.n.classList.remove("changed"); void it.n.offsetWidth; it.n.classList.add("changed"); }
      }
    });
    links.replaceChildren();
    const seen = {}, order = s.shown;
    for (const l of s.links) {
      const a = pos[l.from], b = pos[l.to];
      if (!a || !b) continue;
      const key = [l.from, l.to].sort().join("\u0000"), o = seen[key] = (seen[key] ?? -1) + 1;
      const apart = Math.abs(order.indexOf(l.from) - order.indexOf(l.to));
      const { d, mid } = free || layout === "layers" || layout === "grid" ? curve(a, b, o ? (o % 2 ? 1 : -1) * 12 * o : 0)
        : layout === "cycle" && order.length > 2 ? curve(a, b, (o % 2 ? 1 : -1) * 10 * (1 + o)) : arc(a, b, o, apart);
      const cls = l.fresh ? "new" : "old";
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", d); path.setAttribute("class", cls);
      path.setAttribute("marker-end", `url(#ah-${cls}-${tag})`);
      links.append(path);
      if (l.label) {
        const t = document.createElementNS(NS, "text");
        t.setAttribute("x", mid.x); t.setAttribute("y", mid.y); t.setAttribute("class", cls); t.textContent = fixText(l.label);
        links.append(t);
      }
      // 이번 단계에 생긴 선: 그려지듯 나타나고 점 하나가 따라 흐른다 (물체가 자리를 옮긴 뒤에)
      if (l.fresh && animate && k > cur) {
        const len = path.getTotalLength();
        path.style.strokeDasharray = len; path.style.strokeDashoffset = len;
        path.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 650, delay: 250, easing: "ease-out", fill: "forwards" });
        const dot = document.createElementNS(NS, "circle"); dot.setAttribute("r", 4.5); dot.style.opacity = 0;
        links.append(dot);
        const steps = 24, kf = [...Array(steps + 1)].map((_, i) => {
          const pt = path.getPointAtLength(len * i / steps);
          return { transform: `translate(${pt.x}px,${pt.y}px)`, opacity: i === steps ? 0 : 1 };
        });
        dot.animate(kf, { duration: 650, delay: 250, easing: "ease-out", fill: "forwards" });
      }
    }
    capText.replaceChildren(); withMath(capText, fixText(s.caption));
    cur = k;
    requestAnimationFrame(reportHeight);
  }
  animControls(box, again, frames, go);
  let lastW = 0;           // 폭이 바뀔 때만 다시 놓는다 (높이는 go 가 바꾼다)
  new ResizeObserver(() => { const w = stage.clientWidth; if (w && w !== lastW && cur >= 0) { lastW = w; go(cur, false); } }).observe(stage);
  go(frames.length, false);
}

// 질문과 답: 보내면 내 질문과 "생각하는 중"을 붙이고, 앱이 answer() 로 답을 채운다
const chat = document.getElementById("chat"), q = document.getElementById("q"), send = document.getElementById("send");
let pendingQA = null;
function ask() {
  const text = q.value.trim();
  if (!text || pendingQA) return;
  stopPlayer();
  const qa = el("div", "qa");
  qa.append(el("div", "q", text));
  const l = el("div", "loading"); l.append(el("div", "spin"), el("span", null, "화면을 다시 보고 답을 만드는 중…"));
  qa.append(l);
  chat.append(qa);
  pendingQA = qa;
  q.value = ""; growInput(); send.disabled = true;
  qa.scrollIntoView({ block: "start", behavior: "smooth" });
  post("ask", text);
}
async function answer(d) {
  const qa = pendingQA; if (!qa) return;
  qa.querySelector(".loading")?.remove();
  if (d.error) qa.append(el("div", "error", d.error));
  if (d.answer) qa.append(rich("p", "a", paragraphs(fixText(d.answer))));
  if (d.marks && d.marks.length) {
    const ul = el("ul", "marks");
    d.marks.forEach((m, i) => {
      const li = el("li"); li.append(el("span", "badge", String(i + 1)));
      const t = el("div"); t.append(withMath(el("div"), fixText(m.note || "")));
      li.append(t); ul.append(li);
    });
    qa.append(ul);
  }
  for (const v of d.visuals || []) { const box = await visual(v); qa.append(box); box._anim?.play(); }
  pendingQA = null; send.disabled = false; q.focus();
}
send.onclick = ask;
// 인라인 onsubmit 대신 (CSP: 인라인 스크립트 금지)
document.getElementById("ask").addEventListener("submit", (e) => e.preventDefault());
// 입력이 길어지면 칸이 위로 커진다 (3.5줄까지, 그 뒤로는 칸 안에서 스크롤)
const MAX_INPUT = 20 * 3.5 + 18;                     // 줄 높이 × 3.5 + 위아래 안쪽 여백·테두리
function growInput() {
  q.style.height = "38px";
  const h = Math.min(Math.max(38, q.scrollHeight + 2), MAX_INPUT);
  q.style.height = h + "px";
  q.style.overflowY = q.scrollHeight + 2 > MAX_INPUT ? "auto" : "hidden";
  requestAnimationFrame(reportHeight);
}
q.addEventListener("input", growInput);
q.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(); }   // 한글 조합 중 Enter 는 글자 확정
});

// 설명 영상 재생기. 요약·짚은 곳 목록은 다 본 뒤(전체 보기)에 보여준다
let timer = null, tick = null;
function stopPlayer() { clearTimeout(timer); clearInterval(tick); timer = tick = null; }
function startPlayer(d, root, boxes) {
  stopPlayer();
  const scenes = d.scenes;
  const extras = [...root.children].filter(c => !boxes.includes(c));      // 요약, 짚은 곳 목록, 오류
  const player = el("div", "player");
  const say = el("div", "say");
  const ctrl = el("div", "ctrl");
  const prev = el("button", null, "‹"), play = el("button", null, "⏸"), next = el("button", null, "›");
  prev.title = "이전 장면"; next.title = "다음 장면"; play.title = "일시정지";
  const dots = el("div", "sdots");
  const all = el("button", "all", "전체 보기");
  const bar = el("div", "bar"), fill = el("i");
  bar.append(fill);
  const dotEls = scenes.map((_, i) => { const b = el("button"); b.onclick = () => { playing = false; show(i); }; dots.append(b); return b; });
  ctrl.append(prev, play, dots, next, all);
  player.append(say, ctrl, bar);
  root.prepend(player);
  let cur = 0, playing = true, swap = null;

  const dur = i => Math.max(3000, scenes[i].say.length * 120);
  function layout(i) {
    // 지금 장면까지 나온 그림만 보이고, 지금 그림은 단계(reveal)만큼만 보인다
    const seen = new Set(scenes.slice(0, i + 1).map(s => s.visual).filter(v => v != null));
    const curV = scenes[i].visual;
    boxes.forEach((b, k) => {
      b.classList.toggle("hidden", !seen.has(k));
      b.classList.toggle("dim", curV != null && k !== curV);
      const items = b.querySelectorAll(".steps li, table tr:not(:first-child)");
      const r = k === curV ? scenes[i].reveal : null;
      items.forEach((it, j) => it.classList.toggle("hidden", r != null && j >= r));
      if (b._anim && k === curV) b._anim.go(r ?? b._anim.count);
    });
    extras.forEach(e => e.classList.add("hidden"));
  }
  function show(i) {
    stopPlayer();
    cur = Math.max(0, Math.min(scenes.length - 1, i));
    // 자막은 살짝 사라졌다 바뀐다. 빠르게 넘기면 앞서 예약한 교체를 취소해 글이 겹치지 않게 한다
    clearTimeout(swap);
    say.classList.add("fade");
    const text = fixText(scenes[cur].say), n = String(cur + 1);
    swap = setTimeout(() => {
      say.replaceChildren(el("span", "n", n)); withMath(say, text);
      say.classList.remove("fade");
    }, 250);
    dotEls.forEach((b, k) => b.classList.toggle("on", k === cur));
    prev.disabled = cur === 0; next.disabled = false;
    play.textContent = playing ? "⏸" : "▶"; play.title = playing ? "일시정지" : "재생";
    layout(cur);
    post("scene", cur);
    requestAnimationFrame(reportHeight);
    fill.style.width = "0";
    if (!playing) return;
    const start = Date.now(), total = dur(cur);
    tick = setInterval(() => { fill.style.width = Math.min(100, (Date.now() - start) / total * 100) + "%"; }, 100);
    timer = setTimeout(() => cur + 1 < scenes.length ? show(cur + 1) : showAll(), total);
  }
  function showAll() {
    stopPlayer();
    clearTimeout(swap);
    say.classList.remove("fade");
    playing = false;
    say.replaceChildren(document.createTextNode("전체 보기 — 짚은 곳과 그림을 모두 보여줍니다"));
    dotEls.forEach(b => b.classList.remove("on"));
    play.textContent = "▶"; play.title = "재생"; next.disabled = true; prev.disabled = false;
    boxes.forEach(b => { b.classList.remove("hidden", "dim"); b.querySelectorAll(".hidden").forEach(x => x.classList.remove("hidden")); b._anim?.go(b._anim.count); });
    extras.forEach(e => e.classList.remove("hidden"));
    fill.style.width = "100%";
    cur = scenes.length;
    post("scene", -1);
    requestAnimationFrame(reportHeight);
  }
  prev.onclick = () => { playing = false; show(cur - 1); };
  next.onclick = () => { playing = false; cur + 1 < scenes.length ? show(cur + 1) : showAll(); };
  play.onclick = () => { playing = !playing; cur >= scenes.length ? (playing = true, show(0)) : show(cur); };
  all.onclick = showAll;
  show(Number(d.scene) || 0);           // d.scene: 개발용 — 그 장면부터 (스크린샷 확인)
}
