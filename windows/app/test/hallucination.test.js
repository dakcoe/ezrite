'use strict';

// 맥 Tests/EzriteTests/HallucinationTests.swift 이식 + 추가 엣지 케이스
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../lib/hallucination');

const seg = (text, noSpeechProb) => ({ text, noSpeechProb });

// --- 맥 시험 이식 ---

test('[mac] 무음에서_나온_단골_문장은_버린다', () => {
  // 6초 잡음을 Groq large-v3 에 보냈을 때 실제로 돌아온 결과 (말소리 없음 확률 0.22)
  assert.equal(H.keep([seg(' 시청해주셔서 감사합니다.', 0.22)]), '');
  assert.equal(H.keep([seg('MBC 뉴스 김성현입니다.', 0.1)]), '');
  assert.equal(H.keep([seg('Thank you for watching!', 0.1)]), '');
  assert.equal(H.keep([seg('ご視聴ありがとうございました', 0.1)]), '');
});

test('[mac] 강의_문장_끝에_붙은_단골_문장만_떼어낸다', () => {
  const segs = [
    seg(' 그래서 이 값을 두 배로 하면 40이 됩니다', 0.001),
    seg(' 구독과 좋아요 부탁드립니다.', 0.3),
  ];
  assert.equal(H.keep(segs), '그래서 이 값을 두 배로 하면 40이 됩니다');
});

test('[mac] 단골_표현이_들어_있어도_긴_강의_문장은_남긴다', () => {
  const text = '오늘 수업 들어 주셔서 감사합니다 다음 시간에는 정렬 알고리즘을 보겠습니다';
  assert.equal(H.keep([seg(text, 0.02)]), text);
});

test('[mac] 말소리가_없을_확률이_높은_구간은_버린다', () => {
  const segs = [seg('사과가 3개씩 두 줄 있죠', 0.001), seg('다음 장면입니다.', 0.8)];
  assert.equal(H.keep(segs), '사과가 3개씩 두 줄 있죠');
});

test('[mac] 바로_앞_줄과_똑같은_줄은_반복으로_본다', () => {
  assert.equal(H.isRepeat('이 그래프를 보면 오른쪽으로 올라가요.', '이 그래프를 보면 오른쪽으로 올라가요'), true);
  assert.equal(H.isRepeat('그래서 답은 12가 되고', '표를 다시 볼게요'), false);
  assert.equal(H.isRepeat('네', '네'), false); // 짧은 대답은 반복될 수 있다
});

// --- 추가 ---

test('규칙 숫자는 맥과 같다', () => {
  assert.equal(H.NO_SPEECH_LIMIT, 0.6);
  assert.equal(H.SLACK, 8);
  assert.equal(H.PHRASES.length, 21);
  assert.ok(H.PHRASES.includes('thankyou'));
});

test('말소리 없음 확률 경계: 0.6 은 버리고 0.5999 는 남긴다', () => {
  assert.equal(H.keep([seg('정렬은 비교로 한다', 0.6)]), '');
  assert.equal(H.keep([seg('정렬은 비교로 한다', 0.5999)]), '정렬은 비교로 한다');
});

test('slack 경계: 단골 문장 + 8글자는 거르고 9글자는 남긴다', () => {
  // "mbc뉴스"(5글자) + 8글자 = 13
  assert.equal(H.isKnown('MBC 뉴스 가나다라마바사아'), true);
  assert.equal(H.isKnown('MBC 뉴스 가나다라마바사아자'), false);
});

test('빈 구간·공백 구간은 빠지고 나머지는 한 칸 띄어 잇는다', () => {
  const segs = [seg('  첫 문장 ', 0), seg('   ', 0), seg('', 0), seg('\t둘째\t', 0)];
  assert.equal(H.keep(segs), '첫 문장 둘째');
  assert.equal(H.keep([]), '');
});

test('맥 trimmingCharacters(.whitespaces) 처럼 줄바꿈은 자르지 않는다', () => {
  assert.equal(H.keep([seg(' 문장\n', 0)]), '문장\n');
});

test('normalize: 소문자, 글자·숫자만, NFD 한글도 NFC 와 같게 본다', () => {
  assert.equal(H.normalize('Thank You, for 2 Watching!'), 'thankyoufor2watching');
  const nfd = '감사합니다'.normalize('NFD');
  assert.equal(H.isKnown(nfd), true);
  assert.equal(H.normalize(nfd), '감사합니다');
});

test('isRepeat: 6글자 경계', () => {
  assert.equal(H.isRepeat('가나다라마바', '가나다라마바!'), true);
  assert.equal(H.isRepeat('가나다라마', '가나다라마'), false);
  assert.equal(H.isRepeat('가나다라마바', ''), false);
});
