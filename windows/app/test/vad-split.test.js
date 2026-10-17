'use strict';

// 12초 강제 끊김을 "마지막 1초 안에서 가장 조용한 블록 뒤"에서 하는 규칙 (맥과 같은 규칙)

const test = require('node:test');
const assert = require('node:assert/strict');
const { VAD, VadStream } = require('../lib/vad');

const SR = VAD.SAMPLE_RATE;
const BLOCK = VAD.BLOCK_SIZE;

/** 블록 단위 진폭 목록으로 s16 신호를 만든다. 1000Hz 사인이라 블록마다 RMS 가 똑같다 */
function signal(amps) {
  const out = new Int16Array(amps.length * BLOCK);
  amps.forEach((a, b) => {
    for (let i = 0; i < BLOCK; i++) {
      const n = b * BLOCK + i;
      out[n] = Math.round(a * 32767 * Math.sin((2 * Math.PI * 1000 * n) / SR));
    }
  });
  return out;
}

/** 신호를 VadStream 에 넣고 내보낸 발화들을 샘플 위치(정수)와 함께 돌려준다 */
function run(sig, chunkBytes = 3000) {
  const out = [];
  const s = new VadStream({
    onUtterance: ({ samples, start, end }) => out.push({
      samples, start: Math.round(start * SR), end: Math.round(end * SR),
    }),
  });
  const bytes = Buffer.from(sig.buffer, sig.byteOffset, sig.byteLength);
  for (let i = 0; i < bytes.length; i += chunkBytes) s.push(bytes.subarray(i, i + chunkBytes));
  s.finish();
  return out;
}

/** 조각들이 빠짐·겹침 없이 이어지고, 이어 붙이면 원래 소리와 샘플 단위로 같은지 */
function assertSeamless(sig, chunks) {
  for (let k = 0; k < chunks.length; k++) {
    const c = chunks[k];
    assert.equal(c.end - c.start, c.samples.length, `조각 ${k} 길이와 시각이 맞지 않음`);
    if (k > 0) assert.equal(c.start, chunks[k - 1].end, `조각 ${k - 1}과 ${k} 사이에 빠지거나 겹친 샘플`);
    for (let i = 0; i < c.samples.length; i++) {
      const want = sig[c.start + i] / 32768;
      if (c.samples[i] !== want) assert.fail(`조각 ${k}의 ${i}번째 샘플이 원래 소리와 다름`);
    }
  }
}

const SILENT = 40; // 앞쪽 무음 1.2초 (잡음 바닥이 자리 잡게)

test('① 12초 넘게 이어지는 소리: 조각을 이어 붙이면 원래 소리와 샘플 단위로 같다', () => {
  // 크기가 조금씩 달라지는 30초 소리 (가장 조용한 블록이 매번 다른 자리에 생기게)
  const amps = [
    ...Array(SILENT).fill(0),
    ...Array.from({ length: 1000 }, (_, i) => 0.25 + 0.05 * Math.sin(i * 0.37) + 0.03 * Math.sin(i * 1.91)),
    ...Array(100).fill(0),
  ];
  const sig = signal(amps);
  const chunks = run(sig);
  assert.ok(chunks.length >= 3, `30초면 3조각 이상이어야 함 (${chunks.length})`);
  assertSeamless(sig, chunks);
  // 소리 구간(앞 300ms preroll 포함)을 처음부터 끝까지 덮는다
  // 블록 SILENT 부터 소리 → 3블록째(SILENT+2)에 시작 판정 → 그때 preroll 10블록 = SILENT-7 부터
  assert.equal(chunks[0].start, (SILENT + VAD.ONSET_BLOCKS - VAD.PREROLL_BLOCKS) * BLOCK);
  assert.ok(chunks.at(-1).end >= (SILENT + 1000) * BLOCK, '마지막 소리까지 내보내야 함');
  for (const c of chunks.slice(0, -1)) {
    assert.ok(c.samples.length <= VAD.MAX_CHUNK * SR + BLOCK, '강제 끊김 조각은 12초 근처를 넘지 않음');
    assert.ok(c.samples.length >= (VAD.MAX_CHUNK - 1.0) * SR - BLOCK, '강제 끊김 조각은 마지막 1초 안에서 끊김');
  }
});

test('② 마지막 1초 안에 조용한 블록이 하나 있으면 그 블록 바로 뒤에서 끊긴다', () => {
  // 발화는 블록 33(=40-10+3, preroll 시작)부터 모이고 400블록째(블록 432)에 12초가 된다.
  // 마지막 33블록(400~432) 안의 410번 블록만 조용하게 둔다.
  const QUIET = 410;
  const amps = [...Array(SILENT).fill(0), ...Array(600).fill(0.3), ...Array(100).fill(0)];
  amps[QUIET] = 0.05;
  const sig = signal(amps);
  const chunks = run(sig);
  assert.equal(chunks[0].end, (QUIET + 1) * BLOCK, '조용한 블록까지 포함하고 그 뒤에서 끊겨야 함');
  assertSeamless(sig, chunks);
});

test('③ 조용한 블록이 없어도(전부 같은 크기) 12초 근처에서 끊기고 빠지는 샘플이 없다', () => {
  const amps = [...Array(SILENT).fill(0), ...Array(900).fill(0.3), ...Array(100).fill(0)];
  const sig = signal(amps);
  const chunks = run(sig);
  assert.ok(chunks.length >= 3);
  const first = chunks[0].samples.length / SR;
  assert.ok(Math.abs(first - VAD.MAX_CHUNK) < 0.05, `첫 조각 ${first}초`);
  assertSeamless(sig, chunks);
  assert.ok(chunks.at(-1).end >= (SILENT + 900) * BLOCK);
});

test('넘긴 블록은 다음 발화를 "말하는 중"으로 시작하고, 음성 블록 수 × 30ms 로 센다', () => {
  const vad = new VAD();
  const loud = Float32Array.from({ length: BLOCK }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 1000 * i) / SR));
  const quiet = Float32Array.from(loud, (v) => v / 6);
  for (let i = 0; i < SILENT; i++) assert.equal(vad.feed(new Float32Array(BLOCK)), null);
  let out = null;
  let fed = 0;
  // 조용한 블록을 12초 직전 20블록 앞에 하나 둔다
  while (!out) {
    fed += 1;
    out = vad.feed(fed === 380 ? quiet : loud);
    assert.ok(fed < 500, '12초 근처에서 끊겨야 함');
  }
  assert.ok(vad.inSpeech, '넘긴 블록으로 바로 발화 중이어야 함');
  const kept = vad.heldSamples / BLOCK;
  assert.ok(kept > 0 && kept <= VAD.SPLIT_SEARCH_BLOCKS);
  assert.ok(Math.abs(vad.speechSecs - kept * VAD.BLOCK_SECS) < 1e-9);
  assert.equal(vad.silenceSecs, 0);
});

test('넘긴 블록 끝의 무음 3블록은 무음 시간으로 이어서 세어, 이어지는 무음 64블록째에 2초 끊김이 난다', () => {
  const vad = new VAD();
  const loud = Float32Array.from({ length: BLOCK }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 1000 * i) / SR));
  const zero = () => new Float32Array(BLOCK);
  for (let i = 0; i < SILENT; i++) vad.feed(zero());
  while (vad.utterance.length < 399) vad.feed(loud);
  // 396번 블록을 가장 조용하게, 그 뒤 397·398 은 무음으로 표시해 두고 무음 블록(399번)을 넣는다
  vad.levels[396] = -1;
  vad.speechFlags[397] = false;
  vad.speechFlags[398] = false;
  vad.feed(zero());
  assert.equal(vad.heldSamples / BLOCK, 3, '397~399 세 블록을 넘김');
  assert.ok(Math.abs(vad.silenceSecs - 3 * VAD.BLOCK_SECS) < 1e-9, '넘긴 끝 무음 3블록을 이어서 셈');
  // 2.0초 = 67블록 (66블록은 1.98초). 이미 3블록이 있으니 63블록까지는 아직 발화 중
  for (let i = 0; i < 63; i++) vad.feed(zero());
  assert.ok(vad.inSpeech, '63블록째까지는 끊기지 않음');
  vad.feed(zero());
  assert.ok(!vad.inSpeech, '64블록째에 2초 무음으로 끊김');
});

test('0.8초·2초 무음 끊김은 그대로이고 꼬리 무음을 자르지 않는다', () => {
  // 3초 말하고 2.1초 쉬면 2초 무음 끊김: 조각 끝에 무음이 그대로 붙어 있다
  const amps = [...Array(SILENT).fill(0), ...Array(100).fill(0.3), ...Array(70).fill(0)];
  const sig = signal(amps);
  const chunks = run(sig);
  assert.equal(chunks.length, 1);
  const tail = chunks[0].samples.slice(-BLOCK * 10);
  assert.ok(tail.every((v) => v === 0), '끝 300ms 는 무음 그대로');
  assertSeamless(sig, chunks);
});
