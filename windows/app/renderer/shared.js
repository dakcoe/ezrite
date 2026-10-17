'use strict';

// 팝업·전체 창이 함께 쓰는 부품: 상태 머리, 실시간 목록, 녹음 시작 말풍선, 고르기 칸, 스위치.
// 상태는 main 프로세스가 갖고 있고 'state'로 보내 준다. 여기서는 그리기만 한다.
(function () {
  const { icon } = window.EzIcons;

  // 웹 페이지 티를 없앤다: 재질 바탕 표시, 기본 오른쪽 클릭 메뉴·끌기 막기 (입력칸의 오른쪽 클릭은 둔다)
  if (window.ezrite.material) document.documentElement.classList.add('material');
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('input, textarea')) e.preventDefault();
  });
  document.addEventListener('dragstart', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());
  document.addEventListener('dragover', (e) => e.preventDefault());
  const F = window.EzFormat;

  /** 작은 DOM 도우미. 글은 늘 textContent로 넣는다 */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v; // icons.js의 고정 SVG만 넣는다
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const sourceOf = (s) => s.sources.find((x) => x.id === s.sourceId);

  // ── 소리 크기 막대: level 이벤트는 자주 오므로 마지막 값만 두고 화면 갱신 때 그린다 ──
  let level = 0;
  const waves = new Set();
  window.ezrite.onLevel((v) => { level = v.level; });
  function tick(now) {
    const hs = F.waveHeights(level, now / 1000);
    for (const w of waves) {
      if (!w.isConnected) { waves.delete(w); continue; }
      [...w.children].forEach((bar, i) => { bar.style.height = `${hs[i].toFixed(1)}px`; });
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // ── 상태 머리 ──
  /** place: 'popup' | 'window'. extra: 오른쪽 끝 버튼 (톱니) */
  // 맥처럼 짧은 이름만. 화면이 AI 서비스로 간다는 안내는 사용 가이드(STEP 06)에 있다
  const EXPLAIN_HELP = 'AI 질문하기';

  /** ✨ 설명해줘 단추. 하는 중에는 돌아가는 표시로 바뀌고 눌리지 않는다. update(s) 를 상태마다 부른다 */
  function explainButton(cls, size) {
    const b = h('button', { class: cls, title: EXPLAIN_HELP, 'aria-label': 'AI 질문하기', onclick: () => window.ezrite.explain() });
    let shown = null;
    b.update = (s) => {
      const busy = Boolean(s.explaining);
      if (busy === shown) return;
      shown = busy;
      b.disabled = busy;
      b.innerHTML = busy ? '<span class="spinner"></span>' : icon('sparkles', size);
    };
    b.update({ explaining: false });
    return b;
  }

  function statusHeader(place, extra) {
    const dot = h('span', { class: 'dot' });
    const line1Text = h('span');
    const line2 = h('div', { class: 'line2' });
    const wave = h('div', { class: 'wave hidden' }, [0, 1, 2, 3, 4].map(() => h('i')));
    waves.add(wave);
    const explain = explainButton('round', 15);
    const pause = h('button', { class: 'round hidden', onclick: () => window.ezrite.togglePause() });
    const rec = h('button', { class: 'round rec' });
    rec.addEventListener('click', () => {
      const s = current;
      if (s.listening || s.paused) window.ezrite.stopRecord();
      else if (s.options.askBeforeRecord) openChooser(rec, place);
      else window.ezrite.startRecord();
    });
    const el = h('div', { class: `status${place === 'popup' ? ' drag' : ''}` },
      h('div', { class: 'text' }, h('div', { class: 'line1' }, dot, line1Text), line2),
      wave, explain, pause, rec, extra);

    let timer = null;
    function update(s) {
      const recording = s.listening && !s.paused;
      explain.update(s);
      dot.className = `dot${s.paused ? ' paused' : s.listening ? ' rec' : ''}`;
      clearInterval(timer);
      const paint = () => {
        if (s.startedAt) {
          line1Text.textContent = `녹음 중 ${F.clock(s.recordedBefore + (Date.now() - s.startedAt) / 1000)}`;
        } else if (s.paused) {
          line1Text.textContent = `일시정지 ${F.clock(s.recordedBefore)}`;
        } else {
          line1Text.textContent = '대기 중';
        }
      };
      paint();
      line1Text.className = s.startedAt || s.paused ? 'time' : '';
      if (s.startedAt) timer = setInterval(paint, 1000);
      line2.textContent = F.sourceLine({ sourceLabel: sourceOf(s)?.label, language: s.language, notice: s.notice });
      wave.classList.toggle('hidden', !recording);
      pause.classList.toggle('hidden', !(s.listening || s.paused));
      pause.innerHTML = icon(s.paused ? 'play' : 'pause', 13);
      pause.title = s.paused ? '이어서 녹음' : '일시정지';
      const on = s.listening || s.paused;
      rec.classList.toggle('on', on);
      rec.innerHTML = icon(on ? 'stop' : 'record', on ? 13 : 16);
      rec.title = on ? '녹음 종료' : '녹음 시작';
    }
    return { el, update };
  }

  // ── 실시간 (맥 LivePage + TranscriptList) ──
  // 줄을 id 로 기억해 새 줄만 붙이고 번역만 채운다. 통째로 다시 그리면 고르던 글(선택)이 풀리고 스크롤이 튄다
  const NO_KEY = 'Groq API 키가 없습니다. 설정에서 키를 입력하세요.';

  function banner(error) {
    const links = error === NO_KEY
      ? h('div', { class: 'banner-links' },
        h('button', { class: 'link-btn', onclick: () => window.ezrite.openMain('settings') }, '키 넣기'),
        h('span', { class: 'sep-dot' }, '·'),
        h('button', { class: 'link-btn', onclick: () => window.ezrite.openOnboarding() }, '키 받는 방법 보기'),
        h('span', { class: 'sep-dot' }, '·'),
        h('button', { class: 'link-btn', onclick: () => window.ezrite.openKeyPage() }, '무료 키 발급받기 ↗'))
      : null;
    return h('div', { class: 'banner' }, h('span', { class: 'banner-icon', html: icon('warning', 13) }),
      h('div', { class: 'banner-body' }, h('span', null, error), links));
  }

  function entryRow(e) {
    if (e.kind === 'gap') return h('div', { class: 'entry gap' }, e.original);
    const row = h('div', { class: 'entry' }, h('div', { class: 'orig' }, e.original));
    if (e.translation) row.append(h('div', { class: 'tr' }, e.translation));
    return row;
  }

  function livePage() {
    const el = h('div', { class: 'live' });
    const bannerBox = h('div', { class: 'banner-box' });
    const empty = h('div', { class: 'empty' });
    const list = h('div', { class: 'transcript' });
    const pending = h('div', { class: 'pending' }, '받아 적는 중…');
    el.append(bannerBox, empty, list);
    let shownError;
    let rows = new Map(); // id → { el, translation }
    let follow = true; // 맨 아래를 보고 있나 (위로 올려 읽는 중이면 따라가지 않는다)
    list.addEventListener('scroll', () => { follow = F.atBottom(list); });

    function update(s) {
      if (s.error !== shownError) {
        shownError = s.error;
        bannerBox.replaceChildren(...(s.error ? [banner(s.error)] : []));
      }
      const has = s.entries.length > 0;
      empty.classList.toggle('hidden', has);
      list.classList.toggle('hidden', !has);
      empty.textContent = s.listening
        ? '듣고 있어요. 말소리가 들리면 여기에 적힙니다.'
        : '위의 녹음 버튼을 누르면 받아 적기 시작합니다.';

      // 새 녹음이 시작돼 줄이 비면 처음부터
      const ids = new Set(s.entries.map((e) => e.id));
      if ([...rows.keys()].some((id) => !ids.has(id))) {
        rows = new Map();
        list.replaceChildren();
        follow = true;
      }
      const stick = follow;
      for (const e of s.entries) {
        const r = rows.get(e.id);
        if (!r) {
          const row = entryRow(e);
          list.insertBefore(row, pending.isConnected ? pending : null);
          rows.set(e.id, { el: row, translation: e.translation });
        } else if (e.translation && r.translation !== e.translation) {
          r.el.querySelector('.tr')?.remove();
          r.el.append(h('div', { class: 'tr' }, e.translation));
          r.translation = e.translation;
        }
      }
      if (s.inflight > 0 && has) list.append(pending);
      else pending.remove();
      // 늘어난 높이가 자리 잡은 다음에 내려간다
      if (stick && has) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
    }
    return { el, update };
  }

  // ── 고르기 칸과 스위치 ──
  function picker(options, value, onChange, { disabled = false, title } = {}) {
    const sel = h('select', { onchange: (e) => onChange(e.target.value), title, disabled });
    for (const o of options) sel.append(h('option', { value: o.value }, o.label));
    sel.value = value ?? '';
    return h('span', { class: 'picker' }, sel, h('span', { class: 'chev', html: icon('chevronsUpDown', 12, 2.6) }));
  }

  function toggle(checked, onChange, { disabled = false } = {}) {
    return h('label', { class: 'switch' },
      h('input', { type: 'checkbox', checked, disabled, onchange: (e) => onChange(e.target.checked) }),
      h('i'));
  }

  const sourceOptions = (s) => (s.sources.length
    ? s.sources.map((x) => ({ value: x.id, label: x.missing ? `${x.label} — ${x.detail}` : x.label }))
    : [{ value: '', label: '소리 출처 없음' }]);
  const languageOptions = (s) => s.languages.map((l) => ({ value: l, label: l }));

  /** 소리 출처·인식 언어 두 줄 (설정 카드와 말풍선이 같이 쓴다) */
  function inputRows(s) {
    return [
      h('div', { class: 'row' }, h('span', { class: 'ico', html: icon('speaker', 15) }),
        h('span', { class: 'title grow' }, '소리 출처'),
        picker(sourceOptions(s), s.sourceId, (v) => window.ezrite.set({ sourceId: v }),
          { title: sourceOf(s)?.detail || '' })),
      h('div', { class: 'sep' }),
      h('div', { class: 'row' }, h('span', { class: 'ico', html: icon('charBubble', 16) }),
        h('span', { class: 'title grow' }, '인식 언어'),
        picker(languageOptions(s), s.language, (v) => window.ezrite.set({ language: v }))),
    ];
  }

  // ── 녹음 시작 말풍선 (맥 RecordChooser). 녹음 버튼 아래에 꼬리를 단다 ──
  let chooserClose = null;
  function openChooser(anchor, place) {
    chooserClose?.();
    window.ezrite.refresh();
    const host = document.body;
    const shade = h('div', { class: 'chooser-shade' });
    const box = h('div', { class: 'chooser' });
    function fill(s) {
      const rows = inputRows(s);
      if (!s.sourceId.startsWith('mic:')) {
        rows.push(h('div', { class: 'sep' }), h('div', { class: 'row' },
          h('span', { class: 'ico', html: icon('mic', 15) }),
          h('div', { class: 'grow' }, h('div', { class: 'title' }, '내 목소리도 함께'),
            h('div', { class: 'sub' }, '발표·질문하는 내 말도 같이 받아 적어요')),
          toggle(s.options.includeMic, (v) => window.ezrite.set({ options: { includeMic: v } }))));
      }
      box.replaceChildren(
        h('h3', null, '녹음 시작'),
        h('div', { class: 'card' }, rows),
        h('div', { class: 'actions' },
          h('label', null, h('input', {
            type: 'checkbox', checked: !s.options.askBeforeRecord,
            onchange: (e) => window.ezrite.set({ options: { askBeforeRecord: !e.target.checked } }),
          }), '다음부터 묻지 않기'),
          h('button', { class: 'btn', onclick: close }, '취소'),
          h('button', { class: 'btn primary', onclick: () => { close(); window.ezrite.startRecord(); } }, '시작')));
    }
    const r = anchor.getBoundingClientRect();
    const width = 300;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, r.left + r.width / 2 - width + 30));
    box.style.left = `${left}px`;
    box.style.top = `${r.bottom + 10}px`;
    box.style.setProperty('--tail', `${left + width - (r.left + r.width / 2) - 6}px`);
    fill(current);
    chooserFill = fill;
    shade.addEventListener('click', close);
    const onKey = (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter') { close(); window.ezrite.startRecord(); }
    };
    document.addEventListener('keydown', onKey);
    function close() {
      shade.remove();
      box.remove();
      document.removeEventListener('keydown', onKey);
      chooserFill = null;
      chooserClose = null;
    }
    chooserClose = close;
    host.append(shade, box);
    void place;
  }
  let chooserFill = null;

  // ── 상태 받기 ──
  let current = null;
  const listeners = [];
  function onState(fn) { listeners.push(fn); if (current) fn(current); }
  window.ezrite.onState((s) => {
    current = s;
    document.documentElement.dataset.sample = s.sample ? '1' : '';
    for (const fn of listeners) fn(s);
    chooserFill?.(s);
  });

  window.Ez = { h, icon, F, statusHeader, explainButton, livePage, picker, toggle, inputRows, onState, sourceOf, openChooser };
})();
