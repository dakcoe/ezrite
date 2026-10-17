'use strict';

// 트레이 팝업: 보통 크기(맥 MenuPopover)와 작은 창(맥 CompactPopover)
(function () {
  const { h, icon, F, statusHeader, explainButton, livePage, onState } = window.Ez;
  const frame = document.getElementById('frame');

  // ── 보통 크기 ──
  const gear = h('button', {
    class: 'gear', html: icon('gear', 15, 1.7),
    title: '설정 — 지난 기록은 열린 창의 탭에서 볼 수 있습니다',
    onclick: () => window.ezrite.openMain('settings'),
  });
  const header = statusHeader('popup', gear);
  const live = livePage();
  const body = h('div', { class: 'live-box' }, live.el);

  // 아래 줄: 오늘 남은 한도 게이지 3개 (받아쓰기·번역·화면 설명), 작은 창, 종료.
  // 마우스를 올리면 그 자리에 무슨 버튼·한도인지 글로 보인다
  const caption = h('div', { class: 'caption hidden' });
  const gauges = h('div', { class: 'gauges' });
  const compactBtn = h('button', { class: 'small', html: icon('pip', 13, 2.2), onclick: () => window.ezrite.set({ compact: true }) });
  const quitBtn = h('button', { class: 'small', html: icon('power', 13, 2.4), onclick: () => window.ezrite.quit() });
  const footer = h('div', { class: 'footer' }, gauges, compactBtn, quitBtn);

  const hover = (el, text) => {
    el.addEventListener('mouseenter', () => { caption.textContent = typeof text === 'function' ? text() : text; caption.classList.remove('hidden'); });
    el.addEventListener('mouseleave', () => caption.classList.add('hidden'));
  };
  hover(compactBtn, '작은 창 — 최근 한 줄과 번역만');
  hover(quitBtn, 'Ezrite 종료');

  const GAUGES = [
    { key: 'audio', icon: 'waveform', label: '받아쓰기', models: 2 },
    { key: 'translate', icon: 'charBubble', label: '번역', models: 2 },
    { key: 'explain', icon: 'sparkles', label: '화면 설명', models: 1 },
  ];
  // 맥 Usage.level: 50% 아래 노랑, 10% 아래 빨강
  const color = (f) => (f < 0.1 ? 'var(--red)' : f < 0.5 ? 'var(--yellow)' : 'var(--green)');

  function paintFooter(s) {
    const kids = GAUGES.map((g) => {
      const v = s.footer[g.key];
      const ico = h('span', { html: icon(g.icon, g.icon === 'charBubble' ? 11 : 10, 2) });
      let el;
      if (typeof v === 'string') {
        el = h('div', { class: 'gauge' }, ico, h('span', { class: 'paid' }, v));
        hover(el, `${g.label}: ${v} 사용 중 — 유료 크레딧이라 하루 한도 표시 없음`);
      } else {
        const fill = h('b');
        if (typeof v === 'number') {
          fill.style.width = `${Math.round(v * 100)}%`;
          fill.style.background = color(v);
        }
        el = h('div', { class: 'gauge' }, ico, h('div', { class: 'track' }, fill));
        hover(el, () => current?.footer.captions?.[g.key]
          ?? F.usageCaption(g.label, typeof current?.footer[g.key] === 'number' ? current.footer[g.key] : null, g.models));
      }
      return el;
    });
    if (s.footer.uses) kids.push(h('span', { class: 'gauge-uses secondary' }, s.footer.uses));
    gauges.replaceChildren(...kids, caption);
  }

  // ── 새 버전 띠 (맥 UpdateBanner): 버전, 바뀐 점(앞 세 줄), [나중에] [받기] ──
  const banner = h('div', { class: 'update-banner hidden' });
  let bannerKey = '';
  function paintBanner(s) {
    const r = s.update?.available;
    const key = JSON.stringify(r ?? null);
    if (key === bannerKey) return;
    bannerKey = key;
    banner.classList.toggle('hidden', !r);
    if (!r) {
      banner.replaceChildren();
    } else {
      const notes = r.notes ? r.notes.split('\n').slice(0, 3).join('\n') : '';
      banner.replaceChildren(
        h('div', { class: 'top' },
          h('span', { class: 'ub-icon', html: icon('download', 15) }),
          h('span', { class: 'ub-title' }, `새 버전 ${r.version}`),
          h('span', { class: 'ub-now secondary' }, `지금 ${s.update.current}`),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn', onclick: () => window.ezrite.update.skip() }, '나중에'),
          h('button', { class: 'btn primary', onclick: () => window.ezrite.update.download() }, '받기')),
        notes ? h('div', { class: 'ub-notes secondary' }, notes) : null);
    }
    requestAnimationFrame(() => window.ezrite.bannerHeight(r ? banner.offsetHeight : 0));
  }

  const full = h('div', { class: 'full' }, banner, header.el, h('div', { class: 'divider' }), body, h('div', { class: 'divider' }), footer);

  // ── 작은 창 ──
  const cDot = h('span', { class: 'dot' });
  const cOrig = h('div', { class: 'orig' });
  const cTr = h('div', { class: 'tr' });
  const cExplain = explainButton('small', 14);
  const compact = h('div', { class: 'compact' }, cDot, h('div', { class: 'lines' }, cOrig, cTr),
    cExplain,
    h('button', { class: 'small', html: icon('expand', 15, 1.6), title: '원래 크기로', onclick: () => window.ezrite.set({ compact: false }) }));

  let mode = null;
  let current = null;
  let footerKey = '';
  onState((s) => {
    current = s;
    cExplain.update(s);
    const want = s.compact ? 'compact' : 'full';
    if (mode !== want) {
      frame.replaceChildren(want === 'compact' ? compact : full);
      mode = want;
    }
    header.update(s);
    paintBanner(s);
    live.update(s);
    // 게이지는 값이 바뀔 때만 다시 그린다 (마우스를 올려 둔 설명 글이 깜박이지 않게)
    const fk = JSON.stringify(s.footer);
    if (fk !== footerKey) {
      footerKey = fk;
      paintFooter(s);
    }
    const last = [...s.entries].reverse().find((e) => e.kind !== 'gap');
    cDot.className = `dot${s.paused ? ' paused' : s.listening ? ' rec' : ''}`;
    cOrig.textContent = last?.original ?? (s.listening ? '듣고 있어요…' : '녹음하고 있지 않아요');
    cTr.textContent = last?.translation ?? ' ';
  });
})();
