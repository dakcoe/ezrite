'use strict';
// 화면 번역: 번역할 창 고르기 패널. main 이 마우스 아래 창 자리(이 패널 좌표)를 보내면 파랗게, 누르면 고름, Esc·오른쪽 단추면 취소
(function () {
  const hl = document.getElementById('hl');
  const name = document.getElementById('name');
  window.ezPick.onHighlight((r) => {
    hl.classList.toggle('hidden', !r);
    if (!r) return;
    Object.assign(hl.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    name.textContent = r.title || '';
  });
  window.addEventListener('mousedown', (e) => {
    if (e.button === 0) window.ezPick.click();
    else window.ezPick.cancel();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.ezPick.cancel();
  });
  window.addEventListener('contextmenu', (e) => e.preventDefault());
}());
