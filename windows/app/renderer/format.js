'use strict';

// 화면에 보일 글·숫자 모양. 브라우저(창)와 node:test 양쪽에서 쓴다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EzFormat = api;
})(typeof self !== 'undefined' ? self : this, () => {
  const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
  const pad = (n) => String(n).padStart(2, '0');

  /** 맥 SessionRow와 같은 "M월 d일 (E) HH:mm" */
  function sessionDate(d) {
    return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DAYS[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** 녹음 시간: 한 시간 전까지 mm:ss, 넘으면 h:mm:ss */
  function clock(t) {
    const s = Number.isFinite(t) ? Math.max(0, Math.floor(t)) : 0;
    if (s >= 3600) return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
    return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  }

  /**
   * 머리의 빨간 파형 막대 5개 높이(px). level은 0~1 막대 값(levelFromRms).
   * 맥 Waveform: 3 + 11 * amp * (0.5 + 0.5|sin(t*5 + i*0.9)|)
   */
  function waveHeights(level, t) {
    const amp = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
    const out = [];
    for (let i = 0; i < 5; i++) {
      out.push(3 + 11 * amp * (0.5 + 0.5 * Math.abs(Math.sin(t * 5 + i * 0.9))));
    }
    return out;
  }

  /** 재생 막대 시각 (맥 PlayerBar): m:ss, 한 시간 넘으면 h:mm:ss */
  function playClock(t) {
    const s = Number.isFinite(t) ? Math.max(0, Math.floor(t)) : 0;
    if (s >= 3600) return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
    return `${Math.floor(s / 60)}:${pad(s % 60)}`;
  }

  /** 머리 둘째 줄 */
  function sourceLine({ sourceLabel, language, notice }) {
    if (notice) return notice;
    return `${sourceLabel || '소리 출처 없음'} · ${language}`;
  }

  /** 받아 적은 줄 목록이 맨 아래에 있나. 위로 올려 읽는 중이면 새 줄이 와도 따라 내려가지 않는다 (맥 TranscriptList) */
  function atBottom({ scrollTop, clientHeight, scrollHeight }, slack = 24) {
    return scrollHeight - (scrollTop + clientHeight) <= slack;
  }

  /** 아래 줄 게이지에 마우스를 올렸을 때 글 (맥 UsageFooter.caption, 호출 횟수만) */
  function usageCaption(label, fraction, models) {
    if (fraction == null) return `${label} 남은 한도 — 아직 모름 (한 번 쓰면 보입니다)`;
    const pct = `${Math.round(fraction * 100)}%`;
    return `${label} 남은 한도 ${pct} (호출 ${pct}${models > 1 ? `, 모델 ${models}개 합산` : ''})`;
  }

  return { sessionDate, clock, playClock, waveHeights, sourceLine, atBottom, usageCaption };
});
