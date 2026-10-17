'use strict';

// "녹음 기록 저장됨" 띠 (맥 1.1.3 SavedBanner). 녹음을 끝낼 때 받아 적은 글이 있었으면(기록이 남았으면) 보이고,
// 새 녹음을 시작하거나 ✕ 를 누르면 지운다 (맥 Transcriber: start 에서 savedSession = nil, stop 에서 = writer.url)

const path = require('node:path');
const { isFoldered } = require('./notes');

/**
 * 띠에 보일 것. place: "저장 폴더 이름 › 기록 폴더 이름" (예전 기록이면 파일 이름),
 * target: 탐색기에서 고를 것 (기록 폴더 또는 예전 기록 파일), help: 마우스를 올리면 보일 전체 경로
 */
function banner(txt) {
  const target = isFoldered(txt) ? path.dirname(txt) : txt;
  return {
    path: txt,
    target,
    place: `${path.basename(path.dirname(target))} › ${path.basename(target)}`,
    help: `탐색기에서 보기 — ${path.dirname(txt)}`,
  };
}

/** 다음 띠 상태. event: 'start' | 'stop'(written: 이번 녹음의 기록 파일, 글이 없었으면 null) | 'dismiss' */
function next(current, { event, written = null }) {
  if (event === 'start' || event === 'dismiss') return null;
  if (event === 'stop') return written ? banner(written) : null;
  return current;
}

module.exports = { banner, next };
