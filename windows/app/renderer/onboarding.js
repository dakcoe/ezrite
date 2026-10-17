'use strict';

// 처음 쓰는 사람 안내 (맥 OnboardingView): ① 무료 Groq 키 ② 권한(마이크 설정 열기) ③ 첫 녹음.
(function () {
  const { h, icon, onState } = window.Ez;
  const root = document.getElementById('root');

  function step(n, done, title, detail, ...content) {
    return h('div', { class: 'step' },
      h('div', { class: `badge${done ? ' done' : ''}`, html: done ? icon('check', 14, 3) : null }, done ? null : String(n)),
      h('div', { class: 'body' }, h('div', { class: 'title' }, title), h('div', { class: 'detail' }, detail), content));
  }

  const guide = h('iframe', { class: 'guide', src: 'guide/groq-guide.html', title: 'Groq 키 발급 안내' });

  /** 키 칸: 붙여넣고 저장하면 main 으로만 보낸다 (화면에 남기지 않는다) */
  function keyField(hasKey) {
    const input = h('input', {
      class: 'field', type: 'password', autocomplete: 'off', spellcheck: 'false',
      placeholder: hasKey ? '저장됨' : 'gsk_… 붙여넣기',
    });
    const save = h('button', { class: 'btn', disabled: true }, '저장');
    const submit = () => {
      const v = input.value.trim();
      if (!v) return;
      input.value = '';
      save.disabled = true;
      window.ezrite.saveKey('groq', v);
    };
    input.addEventListener('input', () => { save.disabled = !input.value.trim(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    save.addEventListener('click', submit);
    return [input, save];
  }

  // 키·권한이 바뀔 때만 다시 그린다 (녹음 중 상태가 자주 와도 입력 중인 글과 안내 애니메이션이 그대로)
  let shown = '';
  onState((s) => {
    const key = JSON.stringify([s.hasKey, s.keyStatus, s.micReady]);
    if (key === shown) return;
    shown = key;
    const hasKey = s.hasKey;
    const micOk = s.micReady;
    root.replaceChildren(
      h('div', null,
        h('h1', null, 'Ezrite 시작하기'),
        h('div', { class: 'lead' }, '강의 소리를 받아 적고, 영어·일본어 강의는 한국어로 옮겨 줍니다. 세 가지만 준비하면 됩니다.')),
      step(1, hasKey, '무료 Groq 키 넣기',
        '받아쓰기에 Groq 를 씁니다. 가입하고 키를 만든 뒤 아래에 붙여넣으세요. 카드 등록 없이 무료입니다.',
        guide,
        h('div', { class: 'buttons' },
          h('button', { class: 'btn', onclick: () => window.ezrite.openKeyPage() }, '무료 키 발급받기 ↗'),
          ...keyField(hasKey)),
        s.keyStatus ? h('div', { class: 'key-status' }, s.keyStatus) : null),
      step(2, micOk, '권한 허용',
        '마이크는 내 목소리나 강의실 소리를 받을 때 씁니다. 유튜브·줌 같은 프로그램 소리는 따로 허용할 것이 없고, 화면은 저장하지 않습니다.',
        h('div', { class: 'buttons' },
          h('button', { class: 'btn', disabled: micOk, onclick: () => window.ezrite.openMicSettings() }, micOk ? '마이크 ✓' : '마이크 설정 열기'),
          h('button', { class: 'btn', disabled: true }, '프로그램 소리 ✓'))),
      step(3, false, '첫 녹음',
        '작업 표시줄 오른쪽 ^ (숨겨진 아이콘 표시) 를 눌러 나오는 목록에서 Ezrite 아이콘을 누르고 ● 버튼으로 받아 적기를 시작하세요. 아이콘을 작업 표시줄로 끌어 꺼내 두면 다음부터 바로 보입니다. ⚙ 에서 소리 출처(특정 프로그램·마이크)와 인식 언어를 고를 수 있습니다. ✨ 를 누르면 그 순간 화면이 AI 서비스로 전송됩니다.',
        h('button', { class: 'btn primary start', disabled: !hasKey, onclick: () => window.ezrite.onboardingDone() }, '시작하기')));
    // 제목 띠 + 안내 내용 높이에 창을 맞춘다
    requestAnimationFrame(() => {
      const title = document.querySelector('.titlebar').offsetHeight;
      window.ezrite.fitHeight(title + root.scrollHeight);
    });
  });
})();
