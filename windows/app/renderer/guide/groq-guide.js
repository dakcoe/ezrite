'use strict';

  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const stage = $("stage");
  // 요소 가운데로 커서를 옮긴다
  function moveTo(el, dx = 0, dy = 0) {
    const s = stage.getBoundingClientRect(), r = el.getBoundingClientRect();
    $("cursor").style.transform = `translate(${r.left - s.left + r.width / 2 + dx}px, ${r.top - s.top + r.height / 2 + dy}px)`;
  }
  async function click(el) {
    moveTo(el); await sleep(750);
    const s = stage.getBoundingClientRect(), r = el.getBoundingClientRect();
    const rp = $("ripple");
    rp.style.left = (r.left - s.left + r.width / 2) + "px"; rp.style.top = (r.top - s.top + r.height / 2) + "px";
    rp.classList.remove("go"); void rp.offsetWidth; rp.classList.add("go");
    el.classList.add("press"); await sleep(160); el.classList.remove("press");
  }
  function scene(id, url, cap) {
    ["s1", "s2", "s5"].forEach(s => $(s).classList.toggle("on", s === id));
    $("url").textContent = url;
    $("cap").innerHTML = cap;
  }
  async function type(el, text, ms = 75) {
    el.textContent = ""; el.parentElement.classList.add("focus", "caret");
    for (const ch of text) { el.textContent += ch; await sleep(ms); }
    el.parentElement.classList.remove("caret");
  }
  function reset() {
    $("d1").classList.add("hide"); $("d2").classList.add("hide"); $("newrow").classList.add("hide");
    $("typed").textContent = ""; $("name").classList.remove("focus", "caret");
    $("copied").classList.remove("on"); $("ok").classList.remove("on"); $("badge").classList.remove("done");
    $("badge").textContent = "1"; $("pasted").textContent = "gsk_… 붙여넣기"; $("pasted").classList.add("ph");
    $("cursor").style.transform = "translate(400px, 200px)";
  }

  // 단계마다 처음 모습에서 시작해 움직임을 한 번 보여준다. 다른 단계를 고르면 진행 중인 움직임은 멈춘다
  let run = 0;
  const steps = [
    async () => { scene("s1", "console.groq.com", "<b>①</b> console.groq.com 에 가입·로그인 (무료)"); },
    async (ok) => {
      scene("s2", "console.groq.com/keys", "<b>②</b> 위쪽 API Keys → Create API Key");
      await sleep(400); if (!ok()) return; await click($("create"));
    },
    async (ok) => {
      scene("s2", "console.groq.com/keys", "<b>③</b> 이름은 아무거나 → Submit");
      $("d1").classList.remove("hide");
      await sleep(300); if (!ok()) return; moveTo($("name")); await sleep(700); if (!ok()) return;
      await type($("typed"), "ezrite"); if (!ok()) return; await sleep(300); await click($("submit"));
    },
    async (ok) => {
      scene("s2", "console.groq.com/keys", "<b>④</b> Copy — 이 창을 닫으면 키를 다시 볼 수 없어요");
      $("d2").classList.remove("hide"); $("newrow").classList.remove("hide");
      await sleep(400); if (!ok()) return; await click($("copy")); if (ok()) $("copied").classList.add("on");
    },
    async (ok) => {
      scene("s5", "Ezrite", "<b>⑤</b> Ezrite 에 붙여넣고 저장");
      await sleep(400); if (!ok()) return; await click($("paste")); if (!ok()) return;
      $("pasted").textContent = "gsk_••••••••••••••••"; $("pasted").classList.remove("ph");
      await sleep(400); if (!ok()) return; await click($("save")); if (!ok()) return;
      $("ok").classList.add("on"); $("badge").classList.add("done"); $("badge").textContent = "✓";
    },
  ];
  let current = 0;
  const dots = steps.map((_, i) => {
    const b = document.createElement("button");
    b.setAttribute("aria-label", (i + 1) + "단계");
    b.onclick = () => show(i);
    $("dots").append(b);
    return b;
  });
  function show(i) {
    current = Math.max(0, Math.min(steps.length - 1, i));
    dots.forEach((d, k) => d.classList.toggle("on", k === current));
    $("prev").disabled = current === 0; $("next").disabled = current === steps.length - 1;
    const id = ++run;
    reset();
    steps[current](() => id === run);
  }
  $("prev").onclick = () => show(current - 1);
  $("next").onclick = () => show(current + 1);
  show(Number(location.hash.slice(1)) || 0);    // #2 처럼 단계를 지정해 열 수 있다 (스크린샷 확인용)

// 웹 페이지 티를 없앤다: 기본 오른쪽 클릭 메뉴·끌기 막기
document.addEventListener("contextmenu", (e) => e.preventDefault());
document.addEventListener("dragstart", (e) => e.preventDefault());
