'use strict';

// EZRITE_TESTFILE (wav 를 소리처럼 흘려 넣기) · EZRITE_FAKE_GROQ (네트워크 없는 가짜 Groq) 시험
const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeWav } = require('../lib/wav');
const { parseWav, wavFeed } = require('../lib/devfeed');
const { fakeFetch, SAMPLE_LINES } = require('../lib/fakegroq');
const { GroqClient } = require('../lib/groq');

test('16kHz mono 16bit wav 에서 PCM 부분만 꺼낸다', () => {
  const wav = encodeWav(new Float32Array([0, 0.5, -0.5]));
  const r = parseWav(wav);
  assert.equal(r.pcm.length, 6);
  assert.equal(r.pcm.readInt16LE(2), 16383);
});

test('fmt 와 data 사이에 다른 덩어리(LIST)가 있어도 건너뛴다', () => {
  const wav = encodeWav(new Float32Array([0.25]));
  const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('abcd')]);
  const odd = Buffer.concat([wav.subarray(0, 36), list, wav.subarray(36)]);
  odd.writeUInt32LE(odd.length - 8, 4);
  assert.equal(parseWav(odd).pcm.readInt16LE(0), 8191);
});

test('다른 형식은 이유를 밝혀 거절한다', () => {
  assert.throws(() => parseWav(Buffer.from('not a wav file at all, nope')), /wav 파일이 아닙니다/);
  const stereo = encodeWav(new Float32Array(4));
  stereo.writeUInt16LE(2, 22);
  assert.throws(() => parseWav(stereo), /16kHz mono 16bit/);
  const rate = encodeWav(new Float32Array(4));
  rate.writeUInt32LE(44100, 24);
  assert.throws(() => parseWav(rate), /16kHz mono 16bit/);
});

test('100ms 조각으로 흘리고, speed 배로 빨리, 파일이 끝나면 조용한 소리를 계속 흘린다', () => {
  const pcm = Buffer.alloc(16000 * 2 * 0.25, 7); // 0.25초 → 100·100·50ms
  const timers = [];
  const open = wavFeed(pcm, {
    speed: 2,
    setInterval: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length - 1; },
    clearInterval: (id) => { timers[id].cleared = true; },
  });
  const got = [];
  const h = open({ testfile: true }, { onData: (c) => got.push(c), onEnd: () => assert.fail('끝나도 끊김으로 알리지 않는다') });
  assert.equal(timers[0].ms, 50);
  for (let i = 0; i < 5; i++) timers[0].fn();
  assert.deepEqual(got.map((c) => c.length), [3200, 3200, 1600, 3200, 3200]);
  // 실제 캡처처럼 파일 뒤에도 소리(무음)가 이어져야 VAD 가 마지막 발화를 끊어 보낸다
  assert.ok(got.slice(3).every((c) => c.every((b) => b === 0)));
  assert.equal(timers[0].cleared, false);
  h.stop();
  assert.equal(timers[0].cleared, true);
});

test('파일 끝 뒤 무음으로 VAD 가 마지막 발화를 끊는다 (12초 강제 끊김 뒤 남은 꼬리)', async () => {
  const { VadStream } = require('../lib/vad');
  const loud = Buffer.alloc(16000 * 2 * 13);
  for (let i = 0; i < loud.length / 2; i++) loud.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
  const pcm = Buffer.concat([Buffer.alloc(16000 * 2 * 0.3), loud]); // 무음 0.3초 + 쉬지 않고 13초
  const timers = [];
  const open = wavFeed(pcm, { setInterval: (fn) => { timers.push(fn); return 0; }, clearInterval: () => {} });
  const cuts = [];
  const vad = new VadStream({ onUtterance: (u) => cuts.push([u.start, u.end]) });
  open({}, { onData: (c) => vad.push(c) });
  for (let i = 0; i < 133 + 25; i++) timers[0](); // 파일 13.3초 + 무음 2.5초
  assert.equal(cuts.length, 2);
  assert.ok(Math.abs(cuts[0][1] - cuts[0][0] - 12) < 0.05); // 맥과 같은 12초 강제 끊김
  assert.ok(cuts[1][1] > 13.3); // 남은 1.x초도 무음 뒤에 보내졌다
});

test('stop 하면 더 흘리지 않는다', () => {
  const timers = [];
  const open = wavFeed(Buffer.alloc(32000), {
    setInterval: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return 0; },
    clearInterval: () => { timers[0].cleared = true; },
  });
  const got = [];
  const h = open({}, { onData: (c) => got.push(c) });
  h.stop();
  assert.equal(timers[0].cleared, true);
});

test('가짜 Groq: 받아쓰기는 예시 문장을 차례로, 남은 요청 수 헤더도 준다', async () => {
  const usage = [];
  const g = new GroqClient({ fetch: fakeFetch({ delayMs: 0 }), getKey: () => 'fake', onUsage: (m, u) => usage.push([m, u]) });
  const wav = encodeWav(new Float32Array(1600));
  assert.equal(await g.transcribe(wav, { language: 'en' }), SAMPLE_LINES[0][0]);
  assert.equal(await g.transcribe(wav, { language: 'en' }), SAMPLE_LINES[1][0]);
  assert.equal(usage[0][0], 'whisper-large-v3');
  assert.ok(usage[1][1].remaining < usage[0][1].remaining);
  assert.equal(usage[0][1].limit, 2000);
});

test('가짜 Groq: 번역은 아는 문장은 예시 번역, 모르는 문장은 표시를 붙여 돌려준다', async () => {
  const g = new GroqClient({ fetch: fakeFetch({ delayMs: 0 }), getKey: () => 'fake' });
  const out = await g.translate([SAMPLE_LINES[2][0], 'unknown line'], ['before']);
  assert.deepEqual(out, [SAMPLE_LINES[2][1], '(예시 번역) unknown line']);
});

test('가짜 Groq: 실제 Groq 주소 말고는 받지 않는다', async () => {
  const f = fakeFetch({ delayMs: 0 });
  await assert.rejects(() => f('https://example.com/', {}), /가짜 Groq/);
});
