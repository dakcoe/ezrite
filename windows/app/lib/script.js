'use strict';

// 한국어로 시켰는데 다른 문자가 섞여 나오는 일 (qwen 이 "本课程" 같은 중국어 낱말을 끼우거나, 가끔 러시아어가 튀어나온다).
// 섞인 조각만 찾아 싼 모델에게 그 조각만 옮기게 하고 제자리에 끼워 넣는다. 맥 Script.swift 이식.
// 로마자·숫자·기호는 어느 언어에서나 정상이다 (TCP, LMS 같은 약어). 그리스 문자는 수식에 쓰여서 정상으로 본다.
// 지금은 "설명해줘"(4단계)에서만 쓴다.

const { graphemes, trimWs, prefix } = require('./text');

const FOREIGN = [
  [0x3040, 0x30ff], [0x31f0, 0x31ff], // 가나
  [0x4e00, 0x9fff], [0x3400, 0x4dbf], [0xf900, 0xfaff], // 한자
  [0x0400, 0x04ff], // 키릴
  [0x0600, 0x06ff], [0x0590, 0x05ff], // 아랍, 히브리
  [0x0e00, 0x0e7f], [0x0900, 0x097f], // 태국, 데바나가리
];

/** 글자(자소 묶음) 안의 스칼라 하나라도 위 범위면 섞인 글자 */
function isForeign(ch) {
  for (const s of ch) {
    const v = s.codePointAt(0);
    if (FOREIGN.some(([a, b]) => v >= a && v <= b)) return true;
  }
  return false;
}

/** 섞여 나온 조각들 (이어 붙은 글자끼리, 중복 없이). source(화면 글자·강의 말)에 있던 글자는 빼고 본다 */
function foreignRuns(text, source) {
  // Swift Character 비교는 정규 등가라 NFC 로 비교한다. 조각은 원문 그대로 둬야 apply 에서 찾아 바꿀 수 있다
  const seen = new Set(graphemes(String(source).normalize('NFC')));
  const runs = [];
  let cur = '';
  for (const c of graphemes(String(text))) {
    if (isForeign(c) && !seen.has(c.normalize('NFC'))) {
      cur += c;
    } else if (cur) {
      runs.push(cur);
      cur = '';
    }
  }
  if (cur) runs.push(cur);
  return [...new Set(runs)];
}

/**
 * 조각만 옮겨 달라는 요청. 전공 용어는 원문(화면 글자 + 강의 말)의 영어를 쓰고 (核=kernel),
 * 그 밖의 한자는 한국 한자음으로 (超越=초월). 원문은 맥과 같이 앞 400자만 넘긴다
 */
function fixPrompt(text, runs, src = '') {
  return [
    '다음 한국어 글에 다른 언어 문자가 잘못 섞였다. 나열된 조각만 한국어로 옮겨라.',
    '조각이 전공 용어이고 아래 원문에 그 용어의 영어가 있으면 그 영어를 그대로 써라 (核=kernel, 特征值=eigenvalue).',
    '그렇지 않은 한자는 한국 한자음 독음으로 옮겨라 (超越=초월, 金融=금융). 독음이 어색하면 뜻으로 옮겨라.',
    '형식은 한 줄에 하나, `원문=번역`. 다른 말은 쓰지 마라.',
    '',
    `원문: ${prefix(src, 400)}`,
    '',
    `글: ${prefix(text, 400)}`,
    '',
    '조각:',
    runs.join('\n'),
  ].join('\n');
}

/** Swift split(separator:maxSplits: 1) — 빈 조각은 빠진다 */
function splitOnce(line, sep) {
  const i = line.indexOf(sep);
  const parts = i < 0 ? [line] : [line.slice(0, i), line.slice(i + sep.length)];
  return parts.filter((p) => p.length > 0);
}

/** 교정표(`원문=번역` 줄)대로 끼워 넣는다. 조각을 다 고치지 못했거나 고친 말에 또 섞였으면 null */
function apply(text, reply, runs) {
  const table = new Map();
  // Swift 는 "\r\n" 을 한 글자로 봐서 "\n" 으로 나누지 못한다. 여기서는 CRLF 도 줄로 나눈다
  for (const line of String(reply).split(/\r?\n/).filter((l) => l.length > 0)) {
    const parts = splitOnce(line, '=').map(trimWs);
    if (parts.length !== 2 || !runs.includes(parts[0]) || !parts[1] || foreignRuns(parts[1], '').length) continue;
    table.set(parts[0], parts[1]);
  }
  if (table.size !== runs.length) return null;
  // 긴 조각부터 바꿔야 짧은 조각이 긴 조각 일부를 먼저 먹지 않는다
  const keys = [...table.keys()].sort((a, b) => graphemes(b).length - graphemes(a).length);
  return keys.reduce((s, k) => s.split(k).join(table.get(k)), text);
}

module.exports = { foreignRuns, fixPrompt, apply };
