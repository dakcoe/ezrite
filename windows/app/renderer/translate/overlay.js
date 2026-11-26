'use strict';
// 화면 번역 덮개: main 이 보낸 문단들을 그린다. 마우스를 올린 문단(reveal)은 빼고 그려 원문이 보이게 한다
(function () {
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  let last = null;
  let hidden = null;

  function draw() {
    if (!last) return;
    if (canvas.width !== last.width || canvas.height !== last.height) {
      canvas.width = last.width;
      canvas.height = last.height;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    window.EzPaint.paint(ctx, last.items.filter((it) => it.block.key !== hidden), last.scale);
  }

  window.ezTranslate.onDraw((d) => {
    last = d;
    draw();
  });
  window.ezTranslate.onReveal((key) => {
    hidden = key;
    draw();
  });
}());
