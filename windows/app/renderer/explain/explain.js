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
// 긴 글이 줄바꿈 없이 오면 세 문장마다 문단을 나눈다 (모델이 문단 지시를 안 지킬 때)
const paragraphs = t => {
  if (t.includes("\n") || t.length < 180) return t;
  const s = t.split(/(?<=[.?!])\s+(?=\S)/);
  const out = [];
  for (let i = 0; i < s.length; i += 3) out.push(s.slice(i, i + 3).join(" "));
  return out.join("\n\n");
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
  if (d.summary) root.append(rich("p", "summary", fixText(d.summary)));
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
  else post("scene", -1);
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
  }
  return box;
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
  for (const v of d.visuals || []) qa.append(await visual(v));
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
    boxes.forEach(b => { b.classList.remove("hidden", "dim"); b.querySelectorAll(".hidden").forEach(x => x.classList.remove("hidden")); });
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
