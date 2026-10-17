'use strict';
// 녹음 중 소리 크기 막대: 프로그램(pid)·마이크·섞기 모두 크기를 보내고, 말소리 크기면 막대가 눈에 띄게 올라간다
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { LevelMeter, levelFromRms } = require('../lib/audio');
const { LiveSession } = require('../lib/live');
const { mixedSource } = require('../lib/mixer');
const F = require('../renderer/format');

/** rms 가 r 인 16kHz 사인파 100ms 조각 */
function tone(r, ms = 100) {
  const n = (16000 * ms) / 1000;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / 16000) * r * Math.SQRT2 * 32767), i * 2);
  return b;
}

test('LevelMeter: 약 50ms(800샘플)마다 크기를 낸다', () => {
  const m = new LevelMeter();
  const out = [];
  for (let i = 0; i < 5; i++) { const v = m.push(tone(0.02)); if (v) out.push(...v); }
  assert.equal(out.length, 10, '100ms 조각마다 둘');
  for (const v of out) assert.ok(Math.abs(v.rms - 0.02) < 0.002 && v.level > 0.35, JSON.stringify(v));
});

function fakeTranscriber() {
  const t = new EventEmitter();
  t.entries = [];
  t.startSession = () => {};
  t.enqueue = () => {};
  t.addGap = () => {};
  return t;
}

/** 열면 100ms 마다 r 크기 소리를 보내는 가짜 helper (pid 또는 mic) */
function fakeHelper(r) {
  return (_args, { onData }) => {
    let stopped = false;
    const loop = () => { if (stopped) return; onData(tone(r)); setImmediate(loop); };
    setImmediate(loop);
    return { stop: () => { stopped = true; } };
  };
}

async function levelsFor(args, openSource) {
  const s = new LiveSession({ transcriber: fakeTranscriber(), openSource, hasKey: () => true });
  const meter = new LevelMeter();
  const levels = [];
  s.on('pcm', (chunk) => { for (const v of meter.push(chunk) ?? []) levels.push(v.level); });
  s.start(args);
  await new Promise((r) => setTimeout(r, 30));
  s.pause();
  const atPause = levels.length;
  await new Promise((r) => setTimeout(r, 30));
  const duringPause = levels.length - atPause;
  s.stop();
  return { levels, duringPause };
}

for (const [name, args, open] of [
  ['프로그램 소리 (capture --pid)', { pid: 42 }, fakeHelper(0.02)],
  ['마이크', { mic: 'm1' }, fakeHelper(0.02)],
  ['프로그램 + 마이크 섞기', { pid: 42, mixMic: 'm1' }, (a, cbs) => mixedSource((x, c) => fakeHelper(x.mic ? 0.01 : 0.02)(x, c), a, cbs)],
]) {
  test(`크기 막대: ${name} 도 크기를 보내고, 일시정지하면 멈춘다`, async () => {
    const { levels, duringPause } = await levelsFor(args, open);
    assert.ok(levels.length > 0, '크기가 온다');
    assert.ok(Math.max(...levels) > 0.35, `말소리 크기 ${Math.max(...levels)}`);
    assert.equal(duringPause, 0, '일시정지 동안은 보내지 않는다');
  });
}

test('말소리 크기(rms 0.02)는 막대를 눈에 띄게 올린다 (가장 낮은 3px 의 2배 이상)', () => {
  const level = levelFromRms(0.02);
  const hs = Array.from({ length: 20 }, (_, i) => F.waveHeights(level, i * 0.05)).flat();
  assert.ok(Math.max(...hs) >= 7, `가장 높은 막대 ${Math.max(...hs)}`);
  assert.ok(hs.reduce((a, b) => a + b) / hs.length >= 6, '평균');
  assert.ok(Math.max(...F.waveHeights(0, 0)) === 3, '조용하면 가장 낮게');
});

test('막대 그리기: 아직 붙지 않았거나 잠시 떨어진 막대(작은 창 전환)도 다시 붙으면 움직인다', () => {
  const bar = () => ({ style: {} });
  const w = { isConnected: false, children: [bar(), bar(), bar(), bar(), bar()] };
  const waves = new Set([w]);
  F.paintWaves(waves, [5, 6, 7, 8, 9]);
  assert.equal(waves.size, 1, '떨어져 있어도 버리지 않는다');
  assert.equal(w.children[0].style.height, undefined);
  w.isConnected = true;
  F.paintWaves(waves, [5, 6, 7, 8, 9]);
  assert.equal(w.children[4].style.height, '9.0px');
});

test('크기는 보이는 팝업과 전체 창 둘 다에 보내고, 팝업을 숨겼다 다시 열어도 다시 받는다', () => {
  const { levelTargets } = require('../lib/ui');
  const win = (visible) => ({ visible, destroyed: false, isVisible() { return this.visible; }, isDestroyed() { return this.destroyed; } });
  const popup = win(true);
  const main = win(true);
  assert.deepEqual(levelTargets([popup, main]), [popup, main]);
  popup.visible = false; // 트레이 아이콘으로 닫음
  assert.deepEqual(levelTargets([popup, main]), [main]);
  popup.visible = true; // 다시 엶
  assert.deepEqual(levelTargets([popup, main]), [popup, main]);
  main.destroyed = true;
  assert.deepEqual(levelTargets([popup, main, null]), [popup]);
});
