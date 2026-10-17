'use strict';

// 사용 가이드: 그림을 누르면 창 가득 크게 본다 (맥과 같다). 다시 누르거나 Esc 로 닫고, 닫으면 그 그림으로 초점을 돌려준다.
// zoomAction 은 순수 함수라 node 에서 시험한다. 화면 쪽 연결은 attachZoom (가이드 창에서만)
(function (root) {
  /** 지금 상태와 입력 → 'open' | 'close' | 'swallow'(크게 보는 동안 다른 키 막기) | null */
  function zoomAction({ open, type, key, onImage }) {
    if (open) {
      if (type === 'click') return 'close';
      if (type === 'keydown') return key === 'Escape' || key === 'Enter' || key === ' ' ? 'close' : 'swallow';
      return null;
    }
    if (!onImage) return null;
    if (type === 'click') return 'open';
    if (type === 'keydown' && (key === 'Enter' || key === ' ')) return 'open';
    return null;
  }

  /** 그림(w×h)을 상자(bw×bh) 안에 비율을 지켜 다 보이게 넣은 크기 (CSS object-fit: contain 과 같다) */
  function containSize(w, h, bw, bh) {
    if (!(w > 0 && h > 0)) return { width: 0, height: 0 };
    const k = Math.min(bw / w, bh / h);
    return { width: Math.round(w * k), height: Math.round(h * k) };
  }

  /** imgs: 크게 볼 그림들. 덮개는 한 번 만들어 쓴다 */
  function attachZoom(doc, imgs) {
    const cover = doc.createElement('div');
    cover.className = 'zoom';
    cover.setAttribute('role', 'dialog');
    cover.setAttribute('aria-label', '그림 크게 보기');
    cover.hidden = true;
    const big = doc.createElement('img');
    big.alt = '';
    cover.append(big);
    doc.body.append(cover);
    let from = null;

    const open = (img) => {
      from = img;
      big.src = img.currentSrc || img.src;
      big.alt = img.alt;
      cover.hidden = false;
      cover.tabIndex = -1;
      cover.focus();
    };
    const close = () => {
      cover.hidden = true;
      from?.focus();
      from = null;
    };
    const handle = (e, img) => {
      const a = zoomAction({ open: !cover.hidden, type: e.type, key: e.key, onImage: Boolean(img) });
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      if (a === 'open') open(img);
      else if (a === 'close') close();
    };
    for (const img of imgs) {
      img.tabIndex = 0;
      img.setAttribute('role', 'button');
      img.setAttribute('aria-label', `${img.alt} 크게 보기`);
      img.addEventListener('click', (e) => handle(e, img));
      img.addEventListener('keydown', (e) => handle(e, img));
    }
    cover.addEventListener('click', (e) => handle(e, null));
    // 크게 보는 동안에는 장 넘기기(←→)보다 먼저 받는다
    doc.addEventListener('keydown', (e) => { if (!cover.hidden) handle(e, null); }, true);
    return { open, close, isOpen: () => !cover.hidden };
  }

  const api = { zoomAction, attachZoom, containSize };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EzZoom = api;
})(typeof window !== 'undefined' ? window : globalThis);
