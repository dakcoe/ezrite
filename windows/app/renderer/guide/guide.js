'use strict';

// 사용 가이드 넘기기 (맥 guide.html 스크립트). 글 속 버튼 아이콘은 앱과 같은 icons.js 로 그린다
(function () {
  for (const k of document.querySelectorAll('[data-icon]')) k.innerHTML = window.EzIcons.icon(k.dataset.icon, 14, 2); // 고정 SVG

  const slides = [...document.querySelectorAll('.slide')];
  const dots = slides.map((_, i) => {
    const b = document.createElement('button');
    b.setAttribute('aria-label', `${i + 1}장`);
    b.addEventListener('click', () => show(i));
    document.getElementById('dots').append(b);
    return b;
  });
  let cur = 0;
  function show(i) {
    cur = Math.max(0, Math.min(slides.length - 1, i));
    slides.forEach((s, k) => s.classList.toggle('on', k === cur));
    dots.forEach((d, k) => d.classList.toggle('on', k === cur));
    document.getElementById('prev').disabled = cur === 0;
    // 마지막 장에서는 처음으로
    document.getElementById('next').textContent = cur === slides.length - 1 ? '처음으로 ↺' : '계속 →';
  }
  document.getElementById('prev').addEventListener('click', () => show(cur - 1));
  document.getElementById('next').addEventListener('click', () => show(cur === slides.length - 1 ? 0 : cur + 1));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') show(cur + 1);
    if (e.key === 'ArrowLeft') show(cur - 1);
  });

  // 1장: ^ 위에 숨겨진 아이콘 목록을 두고, 순서 번호(1 ^ · 2 Ezrite · 3 팝업)를 각 자리 옆에 붙인다
  function alignTray() {
    const caret = document.getElementById('trayCaret');
    const art = caret.closest('.art');
    const a = art.getBoundingClientRect();
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left - a.left, y: r.top - a.top, w: r.width, h: r.height }; };
    const c = box(caret);
    const fly = document.getElementById('flyout');
    fly.style.left = `${Math.min(a.width - fly.offsetWidth - 8, c.x + c.w / 2 - fly.offsetWidth / 2)}px`;
    const put = (id, x, y) => { const b = document.getElementById(id); b.style.left = `${x - 13}px`; b.style.top = `${y - 13}px`; };
    put('badge1', c.x - 4, c.y - 2);
    const e = box(document.getElementById('foEzrite'));
    put('badge2', e.x - 4, e.y - 2);
    const p = box(document.getElementById('trayPop'));
    put('badge3', p.x + p.w + 2, p.y + 10);
  }
  addEventListener('resize', alignTray);
  // 그림을 누르면 창 가득 크게 본다 (zoom.js)
  window.EzZoom.attachZoom(document, document.querySelectorAll('.art img.shot'));
  document.getElementById('trayPop').addEventListener('load', alignTray);
  show(Number(location.hash.slice(1)) || 0);
  alignTray();
})();
