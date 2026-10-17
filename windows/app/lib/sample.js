'use strict';

// EZRITE_PREVIEW 화면에 채울 예시 상태. 맥 스크린샷(design/mac/*.png)과 같은 모습이 되게 한다.
// 실제 기록·키·한도가 아니라 모양 확인용이다.

const SESSIONS = [
  [16, 18, "It's a feature that allows you to see the screen. But isn't that an API? Yes, it is. There is a free API that allows you to use it."],
  [16, 16, "I'm a baby who changed the voice-over program. I changed it like this. This is a bit... It's a bit... If you press this, the screen changes and the text follows along with it."],
  [16, 12, "It's basically a memo app. If you look here, it's made like this. I've distributed it in open source."],
  [14, 7, "I'm just writing down what I'm saying with a microphone. It doesn't matter if I close all the windows. It's just a program that keeps running."],
];

function state() {
  return {
    sample: true,
    language: 'English',
    sources: [{ id: 'mic:preview', label: '기본 마이크', detail: '예시', kind: 'mic' }],
    sessions: SESSIONS.map(([hh, mm, preview]) => ({
      date: new Date(2026, 9, 16, hh, mm).getTime(),
      title: '',
      audio: true,
      live: false,
      preview,
    })),
    footer: { audio: 1, translate: 'Claude', explain: 'Claude', uses: null },
    hasKey: true,
    micReady: true,
  };
}

module.exports = { state };
