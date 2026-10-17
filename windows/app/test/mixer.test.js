'use strict';

// "내 목소리도 함께": 프로그램 소리에 마이크를 섞는다 (맥 AudioPipeline pushMain/pushMic/micBuf)
const test = require('node:test');
const assert = require('node:assert/strict');
const { MicMixer, MIC_LAG_MAX, mixedSource } = require('../lib/mixer');
const { mixArgs } = require('../lib/ui');

const pcm = (...xs) => {
  const b = Buffer.alloc(xs.length * 2);
  xs.forEach((v, i) => b.writeInt16LE(v, i * 2));
  return b;
};
const samples = (buf) => Array.from({ length: buf.length / 2 }, (_, i) => buf.readInt16LE(i * 2));

test('프로그램 소리 길이만큼 마이크를 같은 자리에 더한다 (길이는 프로그램 소리 그대로)', () => {
  const m = new MicMixer();
  m.pushMic(pcm(1, 2, 3, 4, 5));
  assert.deepEqual(samples(m.mix(pcm(10, 20, 30))), [11, 22, 33]);
  assert.deepEqual(samples(m.mix(pcm(10, 20, 30))), [14, 25, 30]); // 남은 마이크 2개, 모자란 곳은 0
  assert.deepEqual(samples(m.mix(pcm(7))), [7]);
});

test('마이크가 없으면 프로그램 소리 그대로', () => {
  const m = new MicMixer();
  assert.deepEqual(samples(m.mix(pcm(5, -5))), [5, -5]);
});

test('더해서 넘치면 int16 끝에서 자른다', () => {
  const m = new MicMixer();
  m.pushMic(pcm(30000, -30000, 100));
  assert.deepEqual(samples(m.mix(pcm(30000, -30000, -32768))), [32767, -32768, -32668]);
});

test('마이크가 앞서 쌓이면 200ms(3,200 샘플) 넘는 오래된 것부터 버린다 (두 시계가 어긋나 지연이 쌓이지 않게)', () => {
  assert.equal(MIC_LAG_MAX, 3200);
  const m = new MicMixer();
  const many = Buffer.alloc(5000 * 2);
  for (let i = 0; i < 5000; i++) many.writeInt16LE(i % 1000, i * 2);
  m.pushMic(many);
  assert.equal(m.queued, 3200);
  // 맨 앞은 1800 번째 샘플(800)부터
  assert.equal(samples(m.mix(pcm(0)))[0], 1800 % 1000);
});

test('마이크가 느려 모자라도 프로그램 소리는 멈추지 않고, 오래 지나도 지연이 늘지 않는다', () => {
  const m = new MicMixer();
  for (let k = 0; k < 100; k++) {
    m.pushMic(Buffer.alloc(800 * 2, 1)); // 마이크는 덩어리마다 800
    const out = m.mix(Buffer.alloc(640 * 2)); // 프로그램은 640 (시계가 25% 빠른 마이크)
    assert.equal(out.length, 640 * 2);
    assert.ok(m.queued <= MIC_LAG_MAX);
  }
});

test('파이프로 오는 덩어리가 샘플 중간에서 끊겨도 바이트를 이어 붙인다', () => {
  const m = new MicMixer();
  const mic = pcm(100, 200);
  m.pushMic(mic.subarray(0, 3));
  m.pushMic(mic.subarray(3));
  const main = pcm(1, 2);
  const a = m.mix(main.subarray(0, 1));
  const b = m.mix(main.subarray(1));
  assert.deepEqual(samples(Buffer.concat([a, b])), [101, 202]);
});

// --- 두 출처를 한 소리로 (helper 두 개) ---

function fakeOpen() {
  const opened = [];
  const open = (args, cbs) => {
    const h = { args, cbs, stopped: false, stop() { this.stopped = true; } };
    opened.push(h);
    return h;
  };
  return { opened, open };
}

test('프로그램 + 마이크를 함께 열고, 섞은 소리를 내보낸다. 끄면 둘 다 멈춘다', () => {
  const { opened, open } = fakeOpen();
  const got = [];
  const h = mixedSource(open, { pid: 42, mixMic: 'MIC' }, { onData: (c) => got.push(...samples(c)), onEnd: () => {} });
  assert.deepEqual(opened.map((o) => o.args), [{ pid: 42 }, { mic: 'MIC' }]);
  opened[1].cbs.onData(pcm(1, 1));
  opened[0].cbs.onData(pcm(10, 10, 10));
  assert.deepEqual(got, [11, 11, 10]);
  h.stop();
  assert.ok(opened[0].stopped && opened[1].stopped);
});

test('마이크만 끊기면 프로그램 소리는 계속 받고 알린다. 프로그램이 끊기면 출처가 끊긴 것으로', () => {
  const { opened, open } = fakeOpen();
  const ends = [];
  const lost = [];
  mixedSource(open, { pid: 42, mixMic: 'MIC' }, { onData: () => {}, onEnd: (m) => ends.push(m), onMicLost: (m) => lost.push(m) });
  opened[1].cbs.onEnd('mic gone');
  assert.deepEqual(lost, ['mic gone']);
  assert.deepEqual(ends, []);
  opened[0].cbs.onEnd('app gone');
  assert.deepEqual(ends, ['app gone']);
  assert.ok(opened[1].stopped);
});

test('섞지 않을 때는 하나만 연다', () => {
  const { opened, open } = fakeOpen();
  mixedSource(open, { pid: 42 }, { onData: () => {}, onEnd: () => {} });
  mixedSource(open, { mic: 'X' }, { onData: () => {}, onEnd: () => {} });
  assert.deepEqual(opened.map((o) => o.args), [{ pid: 42 }, { mic: 'X' }]);
});

// --- 어떤 마이크를 섞나 (lib/ui.js) ---

const sources = [
  { id: 'mic:DEF', kind: 'mic', label: '기본 마이크' },
  { id: 'mic:USB', kind: 'mic', label: 'USB' },
  { id: 'pid:42', kind: 'app', label: 'chrome' },
];

test('프로그램 출처 + 켬이면 기본 마이크를 섞는다. 마이크 출처면 이 옵션은 쓰지 않는다', () => {
  assert.deepEqual(mixArgs({ pid: 42 }, { includeMic: true, sources }), { pid: 42, mixMic: 'DEF' });
  assert.deepEqual(mixArgs({ pid: 42 }, { includeMic: false, sources }), { pid: 42 });
  assert.deepEqual(mixArgs({ mic: 'USB' }, { includeMic: true, sources }), { mic: 'USB' });
  assert.deepEqual(mixArgs({ pid: 42 }, { includeMic: true, sources: [sources[2]] }), { pid: 42 }); // 마이크가 없으면 섞지 않는다
  assert.deepEqual(mixArgs({ testfile: true }, { includeMic: true, sources }), { testfile: true, mixMic: 'DEF' });
  assert.equal(mixArgs(null, { includeMic: true, sources }), null);
});
