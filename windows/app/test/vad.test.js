'use strict';

// 맥에는 VAD 시험이 없다. VAD.swift 의 규칙(숫자)을 그대로 따르는지 새로 확인한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const { VAD, VadStream } = require('../lib/vad');

const B = VAD.BLOCK_SIZE;
const block = (v) => new Float32Array(B).fill(v);

/** 블록 목록을 차례로 넣고, 발화가 나온 (블록 번호, 샘플 수)를 모은다 */
function run(vad, blocks) {
  const out = [];
  blocks.forEach((b, i) => {
    const u = vad.feed(b);
    if (u) out.push({ at: i, samples: u.length, data: u });
  });
  return out;
}
const rep = (v, n) => Array.from({ length: n }, () => block(v));

test('규칙 숫자는 맥 VAD.swift 와 같다', () => {
  assert.equal(VAD.BLOCK_SIZE, 480);
  assert.equal(VAD.BLOCK_SECS, 0.03);
  assert.equal(VAD.ONSET_BLOCKS, 3);
  assert.equal(VAD.PREROLL_BLOCKS, 10);
  assert.equal(VAD.NOISE_FACTOR, 3.0);
  assert.equal(VAD.NOISE_FLOOR_MIN, Math.fround(1e-4));
  assert.equal(VAD.NOISE_DOWN, Math.fround(0.3));
  assert.equal(VAD.NOISE_UP, Math.fround(0.0003));
  assert.equal(VAD.SHORT_SILENCE, 0.8);
  assert.equal(VAD.LONG_SILENCE, 2.0);
  assert.equal(VAD.MIN_CHUNK, 6.0);
  assert.equal(VAD.MAX_CHUNK, 12.0);
  assert.equal(VAD.MIN_UTTERANCE, 0.4);
});

test('rms: 빈 블록은 0, 상수 블록은 그 절댓값', () => {
  assert.equal(VAD.rms(new Float32Array(0)), 0);
  assert.equal(VAD.rms(block(-0.5)), 0.5);
});

test('무음만 들어오면 아무것도 내보내지 않고 flush 도 null', () => {
  const v = new VAD();
  assert.deepEqual(run(v, rep(0, 200)), []);
  assert.equal(v.inSpeech, false);
  assert.equal(v.flush(), null);
});

test('처음부터 같은 크기로 계속되는 소리는 잡음 바닥이 되어 음성으로 보지 않는다', () => {
  const v = new VAD();
  run(v, rep(0.1, 50));
  assert.equal(v.inSpeech, false);
});

test('음성 2블록은 시작으로 보지 않고, 3블록 연속이면 발화가 시작된다', () => {
  const v = new VAD();
  run(v, [...rep(0, 5), ...rep(0.1, 2), block(0)]);
  assert.equal(v.inSpeech, false);
  run(v, rep(0.1, 3));
  assert.equal(v.inSpeech, true);
});

test('1초 말 → 2초 조용하면 짧아도 끊는다 (앞 300ms 포함, 침묵 꼬리 포함)', () => {
  const v = new VAD();
  // 무음 5 + 음성 34. 시작 순간의 preroll = 무음 5 + 음성 3 = 8블록
  const out = run(v, [...rep(0, 5), ...rep(0.1, 34), ...rep(0, 100)]);
  assert.equal(out.length, 1);
  // 8 + 31(나머지 음성) + 67(0.03×67 ≥ 2.0 이 되는 침묵 블록)
  assert.equal(out[0].samples, (8 + 31 + 67) * B);
  assert.equal(out[0].at, 5 + 34 + 67 - 1);
  assert.equal(out[0].data[0], 0); // 첫 음절 앞 무음부터 들어 있다
  assert.equal(v.inSpeech, false);
});

test('6초 넘게 말한 뒤에는 0.8초만 조용해도 끊는다', () => {
  const v = new VAD();
  const out = run(v, [...rep(0, 5), ...rep(0.1, 233), ...rep(0, 100)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].samples, (8 + 230 + 27) * B); // 0.03×27 = 0.81 ≥ 0.8
});

test('6초 못 미치게 말했으면 0.8초 침묵으로는 끊지 않는다', () => {
  const v = new VAD();
  const out = run(v, [...rep(0, 5), ...rep(0.1, 100), ...rep(0, 40)]);
  assert.deepEqual(out, []);
  assert.equal(v.inSpeech, true);
});

test('계속 말하면 12초(400블록)에서 강제로 끊고, 다음 발화가 이어서 시작된다', () => {
  const v = new VAD();
  const out = run(v, [...rep(0, 5), ...rep(0.1, 800)]);
  assert.ok(out.length >= 1);
  assert.equal(out[0].samples, 400 * B);
  assert.equal(out[0].at, 5 + 2 + (400 - 8)); // 시작 블록(음성 3번째) 뒤 392블록 더
});

test('말소리가 0.4초 미만이면 잡음으로 보고 버린다', () => {
  const v = new VAD();
  // 음성 3블록(0.09초) → 2초 침묵 뒤 끊기지만 버려진다
  assert.deepEqual(run(v, [...rep(0, 5), ...rep(0.1, 3), ...rep(0, 80)]), []);
  assert.equal(v.inSpeech, false);
});

test('말소리 0.42초(14블록)면 남긴다', () => {
  const v = new VAD();
  const out = run(v, [...rep(0, 5), ...rep(0.1, 14), ...rep(0, 80)]);
  assert.equal(out.length, 1);
});

test('preroll 은 최대 10블록(300ms)', () => {
  const v = new VAD();
  const out = run(v, [...rep(0, 30), ...rep(0.1, 34), ...rep(0, 67)]);
  assert.equal(out[0].samples, (10 + 31 + 67) * B);
});

test('잡음 바닥의 3배를 넘어야 음성: 0.05 배경에 0.1 은 음성이 아니다', () => {
  const quiet = new VAD();
  run(quiet, [...rep(0.01, 20), ...rep(0.1, 3)]);
  assert.equal(quiet.inSpeech, true);

  const loud = new VAD();
  run(loud, [...rep(0.05, 20), ...rep(0.1, 3)]);
  assert.equal(loud.inSpeech, false);
});

test('flush: 모으던 발화를 내보내고 상태를 비운다', () => {
  const v = new VAD();
  run(v, [...rep(0, 5), ...rep(0.1, 20)]);
  const u = v.flush();
  assert.equal(u.length, (8 + 17) * B);
  assert.equal(v.inSpeech, false);
  assert.equal(v.flush(), null);
});

test('feed 는 일반 배열도 받는다', () => {
  const v = new VAD();
  assert.equal(v.feed(new Array(B).fill(0)), null);
});

// --- VadStream: 16kHz s16le 조각 → 발화 ---

function s16(values) {
  const b = Buffer.alloc(values.length * 2);
  values.forEach((x, i) => b.writeInt16LE(x, i * 2));
  return b;
}
const pcm = (v, blocks) => s16(new Array(blocks * B).fill(v));

function speechPcm() {
  // 무음 5블록 + 음성 34블록 + 무음 100블록 → 발화 하나 (106블록)
  return Buffer.concat([pcm(0, 5), pcm(3277, 34), pcm(0, 100)]);
}

test('VadStream: s16le 를 블록으로 잘라 발화와 녹음 안 위치(초)를 낸다', () => {
  const got = [];
  const s = new VadStream({ onUtterance: (u) => got.push(u) });
  s.push(speechPcm());
  assert.equal(got.length, 1);
  assert.equal(got[0].samples.length, 106 * B);
  // 끝 = 지금까지 읽은 샘플 / 16000, 시작 = 끝 - 길이
  const end = ((5 + 34 + 67) * B) / 16000;
  assert.ok(Math.abs(got[0].end - end) < 1e-9);
  assert.ok(Math.abs(got[0].start - (end - (106 * B) / 16000)) < 1e-9);
  assert.ok(Math.abs(got[0].samples[0 + 5 * B] - 3277 / 32768) < 1e-6);
});

test('VadStream: 홀수 바이트·블록 중간에서 끊긴 조각도 한 번에 넣은 것과 같다', () => {
  const whole = [];
  new VadStream({ onUtterance: (u) => whole.push(u) }).push(speechPcm());

  const parts = [];
  const s = new VadStream({ onUtterance: (u) => parts.push(u) });
  const buf = speechPcm();
  for (let i = 0; i < buf.length; i += 777) s.push(buf.subarray(i, i + 777));

  assert.equal(parts.length, 1);
  assert.equal(parts[0].start, whole[0].start);
  assert.equal(parts[0].end, whole[0].end);
  assert.deepEqual(parts[0].samples, whole[0].samples);
});

test('VadStream: startOffset 만큼 시각이 밀린다 (다시 연결·일시정지 뒤 이어 쓰기)', () => {
  const got = [];
  const s = new VadStream({ startOffset: 100, onUtterance: (u) => got.push(u) });
  s.push(speechPcm());
  assert.ok(Math.abs(got[0].end - (100 + ((5 + 34 + 67) * B) / 16000)) < 1e-9);
});

test('VadStream: 소리 크기는 3블록(90ms)마다 알린다', () => {
  const levels = [];
  const s = new VadStream({ onLevel: (l) => levels.push(l) });
  s.push(pcm(0, 8));
  assert.equal(levels.length, 2);
  s.push(pcm(16384, 1));
  assert.equal(levels.length, 3);
  assert.equal(levels[2], 0.5);
});

test('VadStream: finish 는 모으던 발화를 내보내고 남은 조각을 버린다', () => {
  const got = [];
  const s = new VadStream({ onUtterance: (u) => got.push(u) });
  s.push(Buffer.concat([pcm(0, 5), pcm(3277, 20), s16([1, 2, 3])]));
  assert.equal(got.length, 0);
  s.finish();
  assert.equal(got.length, 1);
  assert.equal(got[0].samples.length, 25 * B);
  assert.ok(Math.abs(got[0].end - (25 * B) / 16000) < 1e-9);
  s.finish();
  assert.equal(got.length, 1);
});

test('VadStream: 콜백이 없어도 동작하고, Buffer 가 아니면 TypeError', () => {
  const s = new VadStream();
  s.push(speechPcm());
  s.finish();
  assert.throws(() => s.push('abc'), TypeError);
});
