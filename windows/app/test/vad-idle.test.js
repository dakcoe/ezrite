'use strict';

// 조용하면 자동 일시정지 (1.1.5, 맥 AudioPipeline.ingest 의 idle 규칙).
// 말소리가 30초 없으면 녹음 파일에 쓰지 않고, 말이 다시 들리면 바로 앞 0.3초부터 다시 쓴다.
// 맥 시험 3개(47초 소리 → 약 39초 · 재개 발화 시각 = 파일 위치 · 끄면 안 멈춤)와 같은 것 + 꼬리·바이트.
const test = require('node:test');
const assert = require('node:assert/strict');
const { VAD, VadStream } = require('../lib/vad');

const SR = 16000;

/** 진폭 a 인 s16le 소리 secs 초 (잡음처럼 부호를 바꾼다) */
function tone(secs, a) {
  const n = Math.round(secs * SR);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round((i % 2 ? a : -a) * 32767) + (i % 7), i * 2);
  return b;
}
const speech = (secs) => tone(secs, 0.3);
const silence = (secs) => tone(secs, 0.0005);

/** 말 3초 - 침묵 40초 - 말 4초 = 47초 */
const lecture = () => Buffer.concat([silence(0.5), speech(3), silence(40), speech(3.5)]);

function stream(opts = {}) {
  const out = { written: [], utterances: [], idle: [] };
  const s = new VadStream({
    ...opts,
    onRecord: (b) => out.written.push(Buffer.from(b)),
    onUtterance: (u) => out.utterances.push(u),
    onIdle: (on) => out.idle.push(on),
  });
  out.s = s;
  out.file = () => Buffer.concat(out.written);
  out.secs = () => out.file().length / 2 / SR;
  return out;
}

/** 조각 크기를 바꿔 가며 넣는다 (helper 는 아무 길이로 흘린다) */
function feed(s, buf, step = 3333) {
  for (let i = 0; i < buf.length; i += step) s.push(buf.subarray(i, i + step));
}

test('47초 소리(말-40초 침묵-말) → 파일은 약 39초, 쉬었다가 다시 이어 간다', () => {
  const r = stream({ idleAfter: 30 });
  feed(r.s, lecture());
  r.s.finish();
  // 말이 끝나고 2초 뒤 발화가 끊기고, 그 뒤 30초가 지나면 쉰다 → 3.5+2+30 = 35.5초까지 쓴다.
  // 말이 다시 시작되면(43.5초 + 시작 판정 90ms) 0.3초 앞부터 끝까지(약 3.7초) 쓴다
  assert.ok(Math.abs(r.secs() - 39.2) < 0.2, `파일 ${r.secs()}초`);
  assert.deepEqual(r.idle, [true, false]);
  assert.equal(r.utterances.length, 2);
});

test('재개 뒤 발화 시각은 녹음 파일 안 위치와 맞는다 (기록에서 줄을 눌러 들을 때)', () => {
  const r = stream({ idleAfter: 30 });
  feed(r.s, lecture());
  r.s.finish();
  const file = r.file();
  for (const u of r.utterances) {
    const from = Math.round(u.start * SR);
    assert.equal(Math.round(u.end * SR) - from, u.samples.length);
    const got = Float32Array.from({ length: u.samples.length }, (_, i) => file.readInt16LE((from + i) * 2) / 32768);
    assert.deepEqual(got, u.samples, `${u.start.toFixed(2)}초 자리의 소리가 그 발화와 같다`);
  }
  // 두 번째 발화의 첫머리(말 시작 0.3초 앞)도 잘리지 않았다
  const second = r.utterances[1];
  assert.ok(second.start > 35 && second.start < 36, `두 번째 발화 시작 ${second.start}`);
});

test('자동 일시정지를 끄면(idleAfter 없음) 멈추지 않고 47초 다 쓴다', () => {
  const r = stream();
  const buf = lecture();
  feed(r.s, buf);
  r.s.finish();
  assert.deepEqual(r.idle, []);
  assert.deepEqual(r.file(), buf, '받은 바이트 그대로');
});

test('쉬는 동안 끝내면 남은 꼬리를 쓰지 않는다. 쉬지 않을 때는 블록이 안 된 나머지까지 쓴다', () => {
  const quiet = stream({ idleAfter: 30 });
  feed(quiet.s, Buffer.concat([silence(0.5), speech(2), silence(40), silence(0.01)]));
  const before = quiet.file().length;
  quiet.s.finish();
  assert.equal(quiet.file().length, before);
  // 0.5 + 2 + 2(발화 끊김) + 30
  assert.ok(Math.abs(quiet.secs() - 34.5) < 0.1, `파일 ${quiet.secs()}초`);

  const busy = stream({ idleAfter: 30 });
  const buf = Buffer.concat([silence(0.5), speech(2), silence(1.01)]);
  feed(busy.s, buf);
  busy.s.finish();
  assert.deepEqual(busy.file(), buf);
});

test('쉬는 동안에도 소리 크기를 알린다 (파형 갱신)', () => {
  const levels = [];
  const r = stream({ idleAfter: 30, onLevel: (l) => levels.push(l) });
  feed(r.s, Buffer.concat([silence(0.5), speech(2), silence(39.5)]));
  // 42초 = 1400블록, 3블록마다
  assert.equal(levels.length, Math.floor(Math.round(42 * SR / VAD.BLOCK_SIZE) / 3));
});

test('녹음 중 끄면 쉬던 것을 바로 이어 가고, 켜면 그때부터 다시 30초를 센다', () => {
  const r = stream({ idleAfter: 30 });
  // 맨 처음 소리는 잡음 바닥이 되므로 침묵부터. 36.48초 = 1216블록 (나머지 없이)
  feed(r.s, Buffer.concat([silence(0.48), speech(2), silence(34)]));
  assert.deepEqual(r.idle, [true]);
  const at = r.file().length;
  r.s.setIdleAfter(null);
  assert.deepEqual(r.idle, [true, false]);
  feed(r.s, silence(39.99)); // 1333블록
  assert.equal(r.file().length - at, 1333 * VAD.BLOCK_SIZE * 2, '끈 뒤로는 침묵도 다 쓴다');
  r.s.setIdleAfter(30);
  feed(r.s, silence(29));
  assert.deepEqual(r.idle, [true, false]);
  feed(r.s, silence(2));
  assert.deepEqual(r.idle, [true, false, true]);
});

test('written: 다음 스트림의 startOffset 이 될 실제로 쓴 길이', () => {
  const r = stream({ idleAfter: 30, startOffset: 10 });
  feed(r.s, lecture());
  r.s.finish();
  assert.equal(r.s.written, r.file().length / 2);
});
