'use strict';

// 소리가 없거나 잡음뿐인 구간에서 Whisper 가 지어내는 문장을 거른다. 맥 Hallucination.swift 이식.
// 같은 구절 반복은 transcriber.sanitize 가 따로 자른다.

const { graphemes, isLetterOrNumber, trimWs } = require('./text');

/** 무음에서 자주 나오는 문장 (글자·숫자만 남긴 소문자). 자막 데이터로 학습해서 생긴 버릇이다 */
const PHRASES = Object.freeze([
  '시청해주셔서감사합니다', '시청해주셔서고맙습니다', '시청해주셔서감사드립니다',
  '구독과좋아요부탁드립니다', '구독과좋아요', '좋아요와구독', '구독좋아요알림설정',
  '다음영상에서만나요', '자막제공', '한국어자막', 'mbc뉴스', 'kbs뉴스', 'sbs뉴스', '감사합니다',
  'thankyouforwatching', 'thanksforwatching', 'pleasesubscribe', 'subtitlesby', 'thankyou',
  'ご視聴ありがとうございました', 'チャンネル登録',
].map((p) => p.normalize('NFC')));

/** 이보다 높으면 Whisper 스스로 "말소리 없음" 쪽으로 본 구간이다 (OpenAI whisper 기본값) */
const NO_SPEECH_LIMIT = 0.6;
/** 단골 문장 앞뒤로 이만큼 글자가 더 붙어도 같은 문장으로 본다 ("MBC 뉴스 김성현입니다") */
const SLACK = 8;

const PHRASE_LEN = new Map(PHRASES.map((p) => [p, graphemes(p).length]));

/**
 * 글자·숫자만 남긴 소문자 (글자 수는 Swift 처럼 자소 묶음으로 센다).
 * Swift String 비교는 정규 등가(NFC/NFD 같음)라서 JS 에선 NFC 로 맞춰 비교한다.
 */
function normalized(s) {
  const g = graphemes(String(s).toLowerCase().normalize('NFC')).filter(isLetterOrNumber);
  return { text: g.join(''), count: g.length };
}

function normalize(s) {
  return normalized(s).text;
}

function isKnown(text) {
  const n = normalized(text);
  return PHRASES.some((p) => n.text === p || (n.text.includes(p) && n.count <= PHRASE_LEN.get(p) + SLACK));
}

/** segments: [{ text, noSpeechProb }] → 남길 구간만 한 칸 띄어 잇는다 */
function keep(segments) {
  return segments
    .filter((s) => s.noSpeechProb < NO_SPEECH_LIMIT && !isKnown(s.text))
    .map((s) => trimWs(s.text))
    .filter((t) => t.length > 0)
    .join(' ');
}

/** 바로 앞 줄을 그대로 다시 낸 줄. 짧은 대답("네")은 실제로 반복되니 빼 준다 */
function isRepeat(text, previous) {
  const n = normalized(text);
  return n.count >= 6 && n.text === normalize(previous);
}

module.exports = { PHRASES, NO_SPEECH_LIMIT, SLACK, keep, isKnown, isRepeat, normalize };
