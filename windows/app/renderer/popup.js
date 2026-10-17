'use strict';

// 트레이 팝업: 보통 크기(맥 MenuPopover)와 작은 창(맥 CompactPopover)
(function () {
  const { h, icon, F, statusHeader, explainButton, livePage, onState, savedBanner, updateBanner } = window.Ez;
  const frame = document.getElementById('frame');

  // ── 보통 크기 ──
  const gear = h('button', {
    class: 'gear', html: icon('gear', 15, 1.7),
    title: '설정',
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

  // 글이 칸보다 길면 글자를 85% 까지 줄여 맞춘다 (맥 minimumScaleFactor 0.85). 실제 그려진 폭으로 잰다
  const CAPTION_PX = 10.5;
  function showCaption(text) {
    caption.style.fontSize = '';
    caption.textContent = text;
    caption.classList.remove('hidden');
    // flex 칸의 scrollWidth 는 넘쳐도 칸 폭을 돌려줄 때가 있어 글자 자체의 폭을 잰다
    const textWidth = () => { const r = document.createRange(); r.selectNodeContents(caption); return r.getBoundingClientRect().width; };
    const k = F.captionScale(textWidth(), caption.clientWidth);
    if (k < 1) caption.style.fontSize = `${(CAPTION_PX * k).toFixed(2)}px`;
    return { scale: k, fits: Math.ceil(textWidth()) <= caption.clientWidth };
  }
  window.Ez.showCaption = showCaption; // 화면 확인용 (가장 긴 글이 맞는지 잰다)
  const hover = (el, text) => {
    el.addEventListener('mouseenter', () => showCaption(typeof text === 'function' ? text() : text));
    el.addEventListener('mouseleave', () => caption.classList.add('hidden'));
  };
  hover(compactBtn, '작은 창으로');
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
        hover(el, F.paidCaption(g.label, v));
      } else {
        const fill = h('b');
        if (typeof v === 'number') {
          fill.style.width = `${Math.round(v * 100)}%`;
          fill.style.background = color(v);
        }
        el = h('div', { class: 'gauge' }, ico, h('div', { class: 'track' }, fill));
        hover(el, () => current?.footer.captions?.[g.key]
          ?? F.usageCaption(g.label, typeof current?.footer[g.key] === 'number' ? current.footer[g.key] : null));
      }
      return el;
    });
    if (s.footer.uses) kids.push(h('span', { class: 'gauge-uses secondary' }, s.footer.uses));
    gauges.replaceChildren(...kids, caption);
  }

  // 새 버전 띠 (맥 UpdateBanner, 전체 창과 같은 것)
  const banner = updateBanner();

  // 저장됨 띠는 새 버전 띠 아래 (맥 MenuPopover.full). 두 띠의 높이만큼 팝업을 키운다
  const saved = savedBanner();
  const tops = h('div', { class: 'top-banners' }, banner.el, saved.el);
  const fitBanners = () => requestAnimationFrame(() => window.ezrite.bannerHeight(tops.offsetHeight));

  const full = h('div', { class: 'full' }, tops, header.el, h('div', { class: 'divider' }), body, h('div', { class: 'divider' }), footer);

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
    // 두 띠 중 하나라도 모양이 바뀌면 팝업 높이를 다시 맞춘다
    if ([banner.update(s), saved.update(s)].some(Boolean)) fitBanners();
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
