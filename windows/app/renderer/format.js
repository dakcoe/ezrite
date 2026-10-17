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
  function usageCaption(label, fraction) {
    if (fraction == null) return `${label} 한도 아직 모름`;
    return `${label} 한도 ${Math.round(fraction * 100)}% 남음`;
  }

  /** 유료 서비스로 돌린 게이지 */
  function paidCaption(label, service) {
    return `${label}: ${service} 사용 (유료, 한도 표시 없음)`;
  }

  /** 글 폭이 칸보다 크면 글자를 줄일 비율 (85% 까지만. 그래도 넘치면 … 로 자른다) */
  function captionScale(textWidth, boxWidth) {
    if (!(textWidth > boxWidth) || !(boxWidth > 0)) return 1;
    return Math.max(0.85, (boxWidth - 1) / textWidth); // 1px 여유: 반올림으로 넘치지 않게
  }

  /**
   * 녹음 막대 그리기. 아직 화면에 붙지 않았거나 잠시 떨어진 막대(작은 창 전환)는 건너뛰기만 한다.
   * 예전에는 떨어진 막대를 목록에서 지워서, 다시 붙어도 영영 움직이지 않았다
   */
  function paintWaves(waves, heights) {
    for (const w of waves) {
      if (!w.isConnected) continue;
      [...w.children].forEach((bar, i) => { bar.style.height = `${heights[i].toFixed(1)}px`; });
    }
  }

  return { paintWaves, sessionDate, clock, playClock, waveHeights, sourceLine, atBottom, usageCaption, paidCaption, captionScale };
});
