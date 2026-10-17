'use strict';

// EZRITE_TESTFILE 시험용 wav 만들기: 조용한 바탕에 말소리 비슷한 소리 덩어리(약 2.5초)와 침묵(2.3초)을 번갈아 넣는다.
// 실제 말이 아니라서 진짜 Groq 로는 글이 안 나온다. EZRITE_FAKE_GROQ=1 과 같이 VAD 끊기·화면 흐름을 볼 때 쓴다.
// 사용: node scripts/make-test-wav.js <출력.wav> [덩어리 수=7]
const fs = require('fs');
const { encodeWav, SAMPLE_RATE } = require('../lib/wav');

const out = process.argv[2];
if (!out) {
  console.error('사용: node scripts/make-test-wav.js <출력.wav> [덩어리 수]');
  process.exit(2);
}
const bursts = Number(process.argv[3] || 7);

let seed = 12345;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff - 0.5;
};

const parts = [];
const quiet = (secs) => Float32Array.from({ length: Math.round(secs * SAMPLE_RATE) }, () => rand() * 0.001);
const voice = (secs) => Float32Array.from({ length: Math.round(secs * SAMPLE_RATE) }, (_, i) => {
  const t = i / SAMPLE_RATE;
  const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t); // 초당 4음절쯤의 크기 변화
  return 0.25 * syllable * (Math.sin(2 * Math.PI * 180 * t) * 0.6 + rand() * 0.4);
});

parts.push(quiet(0.6));
for (let i = 0; i < bursts; i++) parts.push(voice(2.5), quiet(2.3));

const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
let at = 0;
for (const p of parts) {
  all.set(p, at);
  at += p.length;
}
fs.writeFileSync(out, encodeWav(all));
console.log(`saved ${out} (${(all.length / SAMPLE_RATE).toFixed(1)}초)`);
