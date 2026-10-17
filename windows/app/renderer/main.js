'use strict';

// 전체 창 (맥 MainView): 상태 머리 · 실시간 / 지난 기록 / 설정 · 아래 탭 두 개
(function () {
  const { h, icon, F, statusHeader, livePage, toggle, inputRows, onState, picker, savedBanner } = window.Ez;
  const root = document.getElementById('root');

  const gear = h('button', { class: 'gear', title: '설정' });
  gear.addEventListener('click', () => window.ezrite.set({ page: current?.page === 'settings' ? 'live' : 'settings' }));
  const header = statusHeader('window', gear);
  const live = livePage();
  const page = h('div', { class: 'content' });

  const tabLive = h('button', { class: 'tab', onclick: () => window.ezrite.set({ page: 'live' }) },
    h('span', { html: icon('textBubble', 14, 1.6) }), '실시간');
  const tabHistory = h('button', { class: 'tab', onclick: () => window.ezrite.set({ page: 'history' }) },
    h('span', { html: icon('history', 14, 1.6) }), '지난 기록');
  // 저장됨 띠는 맨 위 (맥 MainView: UpdateBanner 아래)
  const saved = savedBanner();
  root.append(saved.el, header.el, h('div', { class: 'divider' }), page, h('div', { class: 'divider' }),
    h('div', { class: 'tabs' }, tabLive, tabHistory));

  // ── 지난 기록 (맥 HistoryPage): 목록 → 누르면 그 기록의 원문·번역과 녹음 듣기 ──
  const H = window.ezrite.history;

  function historyList(s) {
    if (!s.sessions.length) return h('div', { class: 'sessions-empty' }, '아직 받아 적은 기록이 없습니다');
    return h('div', { class: 'sessions' }, s.sessions.map((x) => h('button', {
      class: 'session', onclick: () => { if (x.path) H.open(x.path); },
    },
    h('div', { class: 'head' },
      h('span', { class: 'name' }, x.title || F.sessionDate(new Date(x.date))),
      x.audio ? h('span', { class: 'wf', html: icon('waveform', 11, 2), title: '녹음 소리 있음' }) : null,
      x.live ? h('span', { class: 'live-tag' }, '진행 중') : null,
      h('span', { class: 'spacer' }),
      h('span', { class: 'chev', html: icon('chevronRight', 12, 2) })),
    h('div', { class: 'preview' }, x.title ? `${F.sessionDate(new Date(x.date))} · ${x.preview}` : x.preview))));
  }

  // 녹음 듣기: <audio> 하나를 계속 쓴다 (맥 Player)
  const audio = document.createElement('audio');
  audio.preload = 'metadata';
  const player = new window.EzPlayer.Player(audio);
  let paintBar = () => {};
  player.onChange = () => paintBar();
  let playerSrc = null;

  function smallButton(ico, title, onclick, disabled = false) {
    return h('button', { class: 'small-btn', html: icon(ico, 14, 1.7), title, onclick, disabled });
  }

  function playerBar() {
    const btn = h('button', { class: 'play-btn' });
    const pos = h('span', { class: 'clock' });
    const dur = h('span', { class: 'clock' });
    const bar = h('input', { type: 'range', min: '0', step: '0.1', value: '0', class: 'seek' });
    let dragging = false;
    btn.addEventListener('click', () => player.toggle());
    bar.addEventListener('input', () => { dragging = true; pos.textContent = F.playClock(Number(bar.value)); });
    bar.addEventListener('change', () => { dragging = false; player.seek(Number(bar.value)); });
    paintBar = () => {
      btn.innerHTML = icon(player.isPlaying ? 'pause' : 'play', 13);
      btn.title = player.isPlaying ? '일시정지' : '녹음 듣기';
      bar.max = String(Math.max(player.duration, 0.1));
      if (!dragging) {
        bar.value = String(player.position);
        pos.textContent = F.playClock(player.position);
      }
      dur.textContent = F.playClock(player.duration);
      bar.style.setProperty('--fill', `${player.duration ? (player.position / player.duration) * 100 : 0}%`);
    };
    paintBar();
    return h('div', { class: 'player' }, btn, pos, bar, dur);
  }

  function noteLines(entries, canPlay) {
    if (!entries.length) return h('div', { class: 'sessions-empty' }, '받아 적은 글이 없습니다');
    return h('div', { class: 'transcript' }, entries.map((e) => {
      if (e.kind === 'gap') return h('div', { class: 'entry gap' }, e.original);
      // 녹음이 끝난 기록만: 줄 옆 ▶ 를 누르면 그 줄의 말만 듣는다 (앞뒤 0.3초 여유)
      const play = canPlay && e.time
        ? h('button', { class: 'line-play', html: icon('playCircle', 14, 1.6), title: '듣기', onclick: () => player.playRange(e.time[0] - 0.3, e.time[1] + 0.3) })
        : null;
      return h('div', { class: `entry${play ? ' with-play' : ''}` }, play,
        h('div', { class: 'entry-text' }, h('div', { class: 'orig' }, e.original),
          e.translation ? h('div', { class: 'tr' }, e.translation) : null));
    }));
  }

  function noteDetail(s) {
    const o = s.opened;
    const busy = o.live;
    const name = h('input', {
      class: 'note-title', type: 'text', value: o.title, spellcheck: 'false', disabled: busy,
      placeholder: busy ? '녹음이 끝나면 이름을 붙일 수 있어요' : '이름 붙이기 (Enter 로 저장)',
    });
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') H.rename(o.path, name.value);
      if (e.key === 'Escape') { name.value = o.title; name.blur(); }
    });
    const head = h('div', { class: 'note-head' },
      h('button', { class: 'back', html: icon('chevronLeft', 15, 2.2), title: '목록으로', onclick: () => H.close() }),
      h('div', { class: 'note-name' }, name, h('div', { class: 'note-date' }, F.sessionDate(new Date(o.date)))),
      smallButton('share', '내보내기', () => H.exportTo(o.path), busy),
      smallButton('copy', '전체 복사', () => H.copy(o.path)),
      smallButton('folder', '탐색기에서 보기', () => H.reveal(o.path)),
      // 저장된 소리로 다시 받아 적기 (맥 Retranscriber) — 자리만. 다음 단계에서 붙인다
      smallButton('rotate', '다시 받아쓰기', () => {}, true),
      smallButton('trash', '삭제', () => H.remove(o.path), busy));
    if (o.audio !== playerSrc) {
      playerSrc = o.audio;
      if (o.audio) player.open(o.audio);
      else player.close();
    }
    const entries = o.live ? s.entries : o.entries;
    return h('div', { class: 'note-view' }, head, o.audio ? playerBar() : null, h('div', { class: 'divider' }),
      noteLines(entries, Boolean(o.audio)));
  }

  function historyPage(s) {
    if (s.opened) return noteDetail(s);
    if (playerSrc) {
      playerSrc = null;
      player.close(); // 목록으로 돌아가면 듣던 소리도 멈춘다
    }
    return historyList(s);
  }

  // ── 설정 ──
  const label = (t) => h('div', { class: 'section-label' }, t);
  function toggleCard(ico, title, detail, value, key, disabled) {
    return h('div', { class: `toggle-card${disabled ? ' disabled' : ''}` },
      h('span', { class: 'ico', html: icon(ico, 16) }),
      h('div', { class: 'body' }, h('div', { class: 'title' }, title), h('div', { class: 'detail' }, detail)),
      toggle(value, (v) => window.ezrite.set({ options: { [key]: v } }), { disabled }));
  }
  // 맥 Provider.allCases 순서. 값은 main 의 서비스 이름, 글은 보이는 이름
  const PROVIDERS = [['groq', 'Groq'], ['claude', 'Claude'], ['gemini', 'Gemini'], ['openai', 'GPT']];

  function settingsPage(s) {
    const o = s.options;
    return h('div', { class: 'settings' },
      label('입력'),
      h('div', { class: 'card' }, inputRows(s)),
      s.listening ? h('div', { class: 'note' }, '녹음 중에 바꾸면 같은 기록에 이어서 받아 적고, 바꾼 자리를 표시합니다.') : null,
      s.appAudio === false ? h('div', { class: 'note' }, '이 Windows 버전에서는 프로그램별 소리 받기를 쓸 수 없습니다. 마이크를 쓰세요.') : null,

      label('옵션'),
      toggleCard('globe', '자동 번역', '영어·일본어 강의를 한국어로 옮겨 아래 줄에 붙입니다. 쓰는 AI 는 아래 기능별 AI 에서 고릅니다.', o.autoTranslate, 'autoTranslate'),
      toggleCard('sliders', '녹음할 때마다 묻기', '녹음 버튼을 누르면 소리 출처와 인식 언어를 먼저 고릅니다.', o.askBeforeRecord, 'askBeforeRecord'),
      toggleCard('mic', '내 목소리도 함께', '프로그램 소리를 받을 때 마이크도 섞어서 받아 적습니다.', o.includeMic, 'includeMic', s.sourceId.startsWith('mic:')),
      loginCard(s),
      themeCard(s),

      label('저장 위치'),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('span', { class: 'ico', html: icon('folder', 15) }),
          h('span', { class: 'path grow', title: s.notesDir }, s.notesDir),
          h('button', { class: 'btn', disabled: s.listening, onclick: () => window.ezrite.chooseNotesFolder() }, '변경…'),
          s.notesFolder ? h('button', { class: 'btn', disabled: s.listening, onclick: () => window.ezrite.defaultNotesFolder() }, '기본값') : null),
        h('div', { class: 'sub secondary' }, s.notesFolder
          ? '이 폴더의 기록은 자동으로 지우지 않습니다. 이전 위치의 기록은 옮겨지지 않습니다.'
          : '30일 지난 기록은 자동으로 지웁니다.')),

      label('AI 서비스 키'),
      h('div', { class: 'card' }, PROVIDERS.flatMap(([p, name], i) => [
        i > 0 ? h('div', { class: 'sep' }) : null,
        keyRow(s, p, name),
      ])),
      h('div', { class: 'note' }, '받아쓰기는 Groq 를 씁니다. 다른 서비스 키를 넣으면 번역·화면 설명에 고를 수 있습니다. 키는 이 PC에만 저장됩니다.'),

      label('AI 지침'),
      h('div', { class: 'card' },
        guideInput(s),
        h('div', { class: 'sub secondary' }, '✨ 설명과 질문 답을 만들 때마다 화면, 전사된 음성과 함께 AI 에게 전합니다.')),

      label('기능별 AI'),
      h('div', { class: 'card' },
        featureRow(s, 'charBubble', '번역', 'translate'), h('div', { class: 'sep' }), featureRow(s, 'sparkles', '화면 설명', 'explain')),

      label('버전'),
      h('div', { class: 'card version' },
        h('div', { class: 'row' }, h('span', { class: 'ico', html: icon('info', 16) }),
          h('div', { class: 'grow' }, h('div', { class: 'title' }, `Ezrite ${s.version}`),
            h('div', { class: 'sub' }, versionStatus(s))),
          s.update?.checking ? h('span', { class: 'spinner' }) : null,
          h('button', { class: 'btn', disabled: Boolean(s.update?.checking), onclick: () => window.ezrite.update.check() }, '업데이트 확인'))),
      h('button', { class: 'link-btn notices', onclick: () => window.ezrite.openNotices() }, '오픈소스 고지'),

      h('div', { class: 'footer-buttons' },
        h('button', { class: 'fbtn', title: '설정 안내', onclick: () => window.ezrite.openOnboarding() },
          h('span', { html: icon('help', 14, 1.6) }), '설정 안내'),
        h('button', { class: 'fbtn', onclick: () => window.ezrite.openGuide() }, h('span', { html: icon('book', 14, 1.6) }), '사용 가이드'),
        h('button', { class: 'fbtn', title: '문의·신고', onclick: () => window.ezrite.openIssue() },
          h('span', { html: icon('report', 14, 1.6) }), '문의·신고')),
      h('button', { class: 'fbtn quit', onclick: () => window.ezrite.quit() }, h('span', { html: icon('power', 14, 1.8) }), 'Ezrite 종료'));
  }

  /** 버전 줄 아래 한 줄: 새 버전 있음 / 확인 중 / 최신 / 아직 확인 전 (맥 versionStatus) */
  function versionStatus(s) {
    const u = s.update ?? {};
    if (u.available) return `새 버전 ${u.available.version} 이 있습니다 — 팝업 위 알림에서 받기`;
    if (u.checking) return '확인하는 중…';
    if (u.checkedAt) return '최신 버전입니다';
    return `빌드 ${s.build ?? s.version}`;
  }

  /** 로그인할 때 자동 실행 (Windows 시작 프로그램). 맥판에는 없는 항목 */
  function loginCard(s) {
    const off = !s.loginItemAvailable;
    return h('div', { class: `toggle-card${off ? ' disabled' : ''}` },
      h('span', { class: 'ico', html: icon('power', 16) }),
      h('div', { class: 'body' }, h('div', { class: 'title' }, '로그인할 때 자동 실행'),
        h('div', { class: 'detail' }, off ? '설치한 앱에서만 바꿀 수 있습니다.' : 'Windows 에 로그인하면 Ezrite 가 작업 표시줄 트레이에서 바로 시작합니다.')),
      toggle(Boolean(s.openAtLogin), (v) => window.ezrite.set({ openAtLogin: v }), { disabled: off }));
  }

  // 설정 → 옵션 → 화면 테마. 고르면 열린 창이 모두 바로 바뀐다 (main 이 nativeTheme 을 바꾼다)
  const THEME_OPTIONS = [
    { value: 'system', label: '시스템 설정 따르기' },
    { value: 'light', label: '밝게' },
    { value: 'dark', label: '어둡게' },
  ];
  function themeCard(s) {
    return h('div', { class: 'toggle-card' },
      h('span', { class: 'ico', html: icon('sunMoon', 16) }),
      h('div', { class: 'body' }, h('div', { class: 'title' }, '화면 테마'),
        h('div', { class: 'detail' }, 'Ezrite 창의 밝기를 고릅니다. 트레이 아이콘은 작업 표시줄 색을 따릅니다.')),
      picker(THEME_OPTIONS, s.theme ?? 'system', (v) => window.ezrite.set({ theme: v }), { title: '화면 테마' }));
  }

  /** AI 지침 (맥 userGuide): 쓰는 대로 잠시 뒤 저장한다. 다시 그려도 쓰던 글이 남게 값은 main 상태에서 받는다 */
  let guideTimer = null;
  function guideInput(s) {
    const t = h('textarea', { placeholder: '예: 통계학 전공 2학년 수준으로 설명해 줘. 수식은 꼭 한 단계씩 풀어 줘. 용어는 영어도 같이.', maxlength: '4000' });
    t.value = s.userGuide ?? '';
    const save = () => { clearTimeout(guideTimer); window.ezrite.set({ userGuide: t.value }); };
    t.addEventListener('input', () => { clearTimeout(guideTimer); guideTimer = setTimeout(save, 400); });
    t.addEventListener('blur', save);
    return t;
  }

  // 붙여넣던 키 (다시 그려도 남게. 저장하면 지운다). 화면에만 있고 main 으로는 [저장] 때만 간다
  const drafts = {};

  /** 확인 결과 한 줄. 확인 중이면 돌아가는 표시와 경과 초 (맥 CheckLine) */
  function checkLine(text, started) {
    if (started) {
      return h('span', { class: 'check' }, h('span', { class: 'spinner small' }),
        h('span', { class: 'elapsed', 'data-started': String(started), 'data-text': text }, `${text}… ${elapsed(started)}초`));
    }
    const tone = text.startsWith('✕') ? ' bad' : text.startsWith('✓') ? ' ok' : '';
    return h('span', { class: `check${tone}` }, text);
  }
  const elapsed = (started) => Math.max(0, Math.floor((Date.now() - started) / 1000));
  // 확인 중 경과 초만 1초마다 고친다 (화면을 다시 그리지 않는다)
  setInterval(() => {
    for (const e of document.querySelectorAll('.elapsed[data-started]')) {
      e.textContent = `${e.dataset.text}… ${elapsed(Number(e.dataset.started))}초`;
    }
  }, 1000);

  /**
   * 서비스 키 한 줄 (맥 KeyRow): 이름 · 입력칸 · [저장] · 지우기, 아래에 확인 결과나 발급 링크.
   * 키가 있어도 칸에 바로 새 키를 붙여넣고 저장하면 바뀐다. Groq 는 받아쓰기에 꼭 필요해서 지우기가 없다
   */
  function keyRow(s, p, name) {
    const saved = Boolean(s.aiView?.keys?.[p]);
    const input = h('input', {
      class: 'key-field', type: 'password', autocomplete: 'off', spellcheck: 'false',
      placeholder: saved ? '저장됨 · 새 키로 바꾸기' : '키 붙여넣기', 'data-focus': `key-${p}`, 'aria-label': `${name} API 키`,
    });
    input.value = drafts[p] ?? '';
    const save = h('button', { class: 'btn', disabled: !input.value.trim() }, '저장');
    const submit = () => {
      const v = input.value.trim();
      if (!v) return;
      input.value = ''; // 키는 화면에 남기지 않는다
      delete drafts[p];
      save.disabled = true;
      window.ezrite.saveKey(p, v);
    };
    input.addEventListener('input', () => {
      drafts[p] = input.value;
      save.disabled = !input.value.trim();
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    save.addEventListener('click', submit);
    // 버튼 두 칸은 늘 같은 폭으로 잡아 둔다. 지우기가 없는 줄(Groq·키 없음)도 칸을 비워 두어 네 줄이 나란히 선다
    const trash = saved && p !== 'groq'
      ? h('button', { class: 'slot trash', html: icon('trash', 13, 1.8), title: '키 삭제', onclick: () => window.ezrite.removeKey(p) })
      : h('span', { class: 'slot' });
    const status = s.providerStatus?.[p];
    const below = status
      ? checkLine(status, s.checking?.[p])
      : !saved
        // 키가 없으면 발급 페이지로 바로 간다. Groq 는 무료라 받아쓰기를 쓰려면 이것부터 해야 한다
        ? h('button', { class: 'link', title: '키 발급받기', onclick: () => window.ezrite.openKeyPage(p) },
          p === 'groq' ? '무료 키 발급받기 ↗ (받아쓰기에 필요)' : '키 발급받기 ↗')
        : null;
    return h('div', { class: 'key-row' },
      h('div', { class: 'line' }, h('span', { class: 'name' }, name), input, save, trash),
      below);
  }

  /** 기능 하나에 쓸 서비스와 모델 (맥 FeatureRow). 키를 넣은 서비스만 고를 수 있다 */
  function featureRow(s, ico, title, feature) {
    const v = s.aiView?.[feature] ?? { providers: [{ value: 'groq', label: 'Groq' }], provider: 'groq', model: '', models: [] };
    const k = `${v.provider}.${feature}`;
    const check = v.provider !== 'groq' ? s.modelCheck?.[k] : null;
    return h('div', { class: 'feature' },
      h('div', { class: 'row' }, h('span', { class: 'ico', html: icon(ico, 16) }),
        h('span', { class: 'title grow' }, title),
        picker(v.providers, v.provider, (p) => window.ezrite.chooseAI({ feature, provider: p }), { title: `${title}에 쓸 AI 서비스` }),
        v.provider === 'groq'
          ? h('span', { class: 'sub' }, '기본 모델')
          // 무료 등급 등 계정마다 쓸 수 있는 모델이 달라서 직접 고르고, 고르면 바로 불러 본다
          : picker(v.models.length ? v.models.map((m) => ({ value: m, label: m })) : [{ value: '', label: '모델 없음' }], v.model,
            (m) => window.ezrite.chooseAI({ feature, model: m }), { title: `${title}에 쓸 모델`, disabled: !v.models.length })),
      check ? h('div', { class: 'feature-check' }, checkLine(check, s.checking?.[k])) : null);
  }

  // 설정 화면은 고르기 칸을 다시 그리면 열린 목록이 닫히므로, 바뀐 것이 있을 때만 다시 그린다
  let current = null;
  let shownKey = '';
  onState((s) => {
    current = s;
    saved.update(s);
    header.update(s);
    gear.innerHTML = icon('gear', 16, 1.6);
    gear.classList.toggle('on', s.page === 'settings');
    tabLive.classList.toggle('on', s.page === 'live');
    tabHistory.classList.toggle('on', s.page === 'history');

    // 실시간은 줄을 하나씩 붙여 그리므로 늘 갱신하고, 화면에서 떼었다 붙이지 않는다 (스크롤·선택 유지)
    if (s.page === 'live') {
      live.update(s);
      if (page.firstElementChild !== live.el) page.replaceChildren(live.el);
      shownKey = 'live';
      return;
    }
    const key = JSON.stringify([s.page,
      s.page === 'settings' ? [s.sources, s.sourceId, s.language, s.options, s.listening, s.notesDir, s.notesFolder, s.hasKey, s.update, s.openAtLogin, s.theme, s.appAudio,
        s.aiView, s.providerStatus, s.modelCheck, s.checking] : null,
      s.page === 'history' ? [s.sessions, s.opened, s.opened?.live ? s.entries : null] : null]);
    if (key === shownKey) return;
    const scroll = page.firstElementChild?.scrollTop ?? 0;
    const samePage = shownKey.startsWith(JSON.stringify([s.page]).slice(0, -1));
    shownKey = key;
    const focused = document.activeElement?.dataset?.focus ?? null;
    if (s.page === 'history') page.replaceChildren(historyPage(s));
    else page.replaceChildren(settingsPage(s));
    if (focused) {
      const el = page.querySelector(`[data-focus="${focused}"]`);
      if (el) {
        el.focus();
        el.setSelectionRange?.(el.value.length, el.value.length);
      }
    }
    if (samePage && page.firstElementChild) page.firstElementChild.scrollTop = scroll;
  });
})();
