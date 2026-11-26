'use strict';
// 화면 번역 덮개 그리기 (실험 기능, 1.3.2 예정). 덮개 창과 그림 시험(scripts/translate-image.js)이 같은 것을 쓴다.
// 문단 자리를 바탕색으로 덮고 번역을 줄바꿈해 채운다. 자리에 안 들어가면 0.5pt 씩 줄여 원래의 60% 까지 (맥과 같다).
// 좌표·크기는 그림(창) 픽셀, block.size 는 1배 px 이고 scale 을 곱해 쓴다. 브라우저·node 둘 다에서 읽힌다 (wrap·fit 은 node 시험)
(function (root) {
  const FONT = '"Segoe UI", "Malgun Gothic", sans-serif';

  /** 줄바꿈: 공백(어절) 단위, 한 어절이 폭보다 길면 글자 단위. measure(글) → 폭 */
  function wrap(text, width, measure) {
    const out = [];
    let cur = '';
    for (const word of String(text).split(/\s+/).filter(Boolean)) {
      const t = cur ? `${cur} ${word}` : word;
      if (measure(t) <= width) {
        cur = t;
        continue;
      }
      if (cur) out.push(cur);
      if (measure(word) <= width) {
        cur = word;
        continue;
      }
      let piece = '';
      for (const ch of word) {
        if (piece && measure(piece + ch) > width) {
          out.push(piece);
          piece = ch;
        } else piece += ch;
      }
      cur = piece;
    }
    if (cur) out.push(cur);
    return out;
  }

  /**
   * 크기 맞추기. measureAt(글, 크기px) → 폭. 원래 크기부터 0.5pt 씩 줄여 덮개 안에 들어가는 첫 크기, 60% 까지.
   * 그래도 안 들어가면 60% 로 (overflow: true)
   */
  function fit(block, text, scale, measureAt) {
    const full = block.size * scale;
    const min = full * 0.6;
    // 줄이기 전에 오른쪽 빈자리(block.room, 바탕뿐인 곳)까지 넓혀 본다 (Windows 에서 더한 것)
    const widths = block.room > 0 ? [block.box.w, block.box.w + block.room] : [block.box.w];
    let last = null;
    for (let s = full; s >= min - 1e-6; s -= 0.5 * scale) {
      const lineHeight = s * block.lineGap;
      for (const width of widths) {
        const lines = wrap(text, width, (t) => measureAt(t, s));
        // 첫 줄은 원래 글자 줄에, 다음 줄은 줄 간격대로. 마지막 줄 아래(0.22×크기)가 덮개 안에 들어와야 한다
        const need = (block.baseline ?? block.box.y + s) - block.box.y + (lines.length - 1) * lineHeight + s * 0.22;
        const wide = Math.max(...lines.map((t) => measureAt(t, s)));
        last = { size: s, lines, lineHeight, width: Math.max(block.box.w, Math.min(width, Math.ceil(wide))), overflow: need > block.box.h + 0.5 * scale };
        if (!last.overflow) return last;
      }
    }
    return last ?? { size: full, lines: [text], lineHeight: full * block.lineGap, width: block.box.w, overflow: true };
  }

  const css = (c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  const fontOf = (bold, size) => `${bold ? 600 : 400} ${size}px ${FONT}`;

  /** items: [{ block, text }]. 바탕을 칠하고 글을 줄마다 쓴다. 쓴 크기 목록을 돌려준다 */
  function paint(ctx, items, scale) {
    const done = [];
    for (const { block, text } of items) {
      const measureAt = (t, s) => {
        ctx.font = fontOf(block.bold, s);
        return ctx.measureText(t).width;
      };
      const f = fit(block, text, scale, measureAt);
      const b = { ...block.box, w: f.width };
      ctx.fillStyle = css(block.bg);
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.save();
      ctx.beginPath();
      ctx.rect(b.x, b.y, b.w, b.h);
      ctx.clip();
      ctx.fillStyle = css(block.color);
      ctx.font = fontOf(block.bold, f.size);
      ctx.textBaseline = 'alphabetic';
      // 첫 줄은 원래 첫 줄의 글자 줄(baseline)에, 다음 줄은 원래 줄 간격(글자 크기 비율)대로. 단추 속 글은 가운데
      const first = block.baseline ?? b.y + b.h * 0.8;
      ctx.textAlign = block.center ? 'center' : 'left';
      const x = block.center ? b.x + b.w / 2 : b.x;
      f.lines.forEach((t, i) => ctx.fillText(t, x, first + i * f.lineHeight));
      ctx.restore();
      done.push({ size: f.size / scale, lines: f.lines.length, overflow: f.overflow, widened: f.width > block.box.w });
    }
    return done;
  }

  /** 상자 그림: 빨강 낱말·초록 줄·파랑 문단 (맥 시험 그림과 같은 색) */
  function boxes(ctx, { words, lines, blocks }) {
    const stroke = (list, color, w) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      for (const b of list) ctx.strokeRect(b.x, b.y, b.w, b.h);
    };
    stroke(words, 'rgba(230, 40, 40, 0.9)', 1);
    stroke(lines, 'rgba(20, 170, 60, 0.9)', 2);
    stroke(blocks, 'rgba(40, 90, 240, 0.9)', 3);
  }

  const api = { wrap, fit, paint, boxes, FONT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EzPaint = api;
}(typeof window !== 'undefined' ? window : globalThis));
