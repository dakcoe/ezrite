'use strict';

// Swift String 동작을 JS 로 맞추는 도우미.
// Swift 는 글자를 Character(자소 묶음) 단위로 세고 비교한다. JS 문자열은 UTF-16 단위라
// 길이·자르기·글자 판정이 다르게 나올 수 있어서, 맥 규칙에 쓰이는 곳은 여기 함수로 맞춘다.

const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

/** 자소 묶음(Swift Character) 배열 */
function graphemes(s) {
  return Array.from(segmenter.segment(String(s)), (x) => x.segment);
}

// Swift Character.isLetter = 첫 스칼라의 Alphabetic 속성, isNumber = 첫 스칼라에 숫자 종류가 있음
const LETTER = /^\p{Alphabetic}/u;
const NUMBER = /^\p{N}/u;

function isLetterOrNumber(ch) {
  return LETTER.test(ch) || NUMBER.test(ch);
}

// Swift CharacterSet.whitespaces = 일반 범주 Zs + 탭. 줄바꿈은 들어 있지 않다
const WS = '\\p{Zs}\\t';
// .whitespacesAndNewlines = 위 + 줄바꿈 문자들
const WS_NL = `${WS}\\n\\r\\u000B\\u000C\\u0085\\u2028\\u2029`;
const TRIM_WS = new RegExp(`^[${WS}]+|[${WS}]+$`, 'gu');
const TRIM_WS_NL = new RegExp(`^[${WS_NL}]+|[${WS_NL}]+$`, 'gu');

/** trimmingCharacters(in: .whitespaces) */
function trimWs(s) {
  return String(s).replace(TRIM_WS, '');
}

/** trimmingCharacters(in: .whitespacesAndNewlines) */
function trimWsNl(s) {
  return String(s).replace(TRIM_WS_NL, '');
}

/** String.suffix(n): 끝에서 n 글자 */
function suffix(s, n) {
  const g = graphemes(s);
  return g.length <= n ? String(s) : g.slice(g.length - n).join('');
}

/** String.prefix(n): 앞에서 n 글자 */
function prefix(s, n) {
  const g = graphemes(s);
  return g.length <= n ? String(s) : g.slice(0, n).join('');
}

/** Swift Int(String): 앞뒤 공백·소수점 없이 부호와 숫자만 */
function parseIntStrict(s) {
  if (typeof s !== 'string' || !/^[+-]?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/** Swift Double(String): 공백 없이 10진 실수 꼴만 */
function parseDoubleStrict(s) {
  if (typeof s !== 'string' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  graphemes, isLetterOrNumber, trimWs, trimWsNl, suffix, prefix, parseIntStrict, parseDoubleStrict,
};
