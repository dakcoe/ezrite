'use strict';

// 지난 기록 화면의 녹음 듣기. 맥 PlayerTests 이식 — AVAudioPlayer 대신 가짜 <audio> 와 가짜 시계로.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Player } = require('../renderer/player');

/** <audio> 를 흉내 낸다: play/pause, currentTime, duration, 'ended' 이벤트. advance(초)로 시간을 흘린다 */
class FakeAudio {
  constructor() {
    this.src = '';
    this.duration = NaN;
    this.currentTime = 0;
    this.paused = true;
    this.listeners = {};
  }

  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }

  emit(name) { for (const fn of this.listeners[name] || []) fn(); }

  load() {}

  play() { this.paused = false; return Promise.resolve(); }

  pause() { this.paused = true; }

  removeAttribute(name) { if (name === 'src') this.src = ''; }

  /** 열린 파일 길이를 알린다 (loadedmetadata) */
  ready(duration) { this.duration = duration; this.emit('loadedmetadata'); }

  advance(secs) {
    if (this.paused) return;
    this.currentTime = Math.min(this.duration, this.currentTime + secs);
    this.emit('timeupdate');
    if (this.currentTime >= this.duration) {
      this.paused = true;
      this.emit('ended');
    }
  }
}

function setup(seconds) {
  const audio = new FakeAudio();
  const timers = [];
  const player = new Player(audio, {
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length - 1; },
    clearTimeout: (id) => { if (timers[id]) timers[id].live = false; },
  });
  player.open('ezrite-note://audio/a.m4a');
  audio.ready(seconds);
  const fire = () => timers.filter((t) => t.live).forEach((t) => { t.live = false; t.fn(); });
  return { audio, player, timers, fire };
}

test('[mac PlayerTests] 열면_멈춰_있고_누르면_재생된다', () => {
  const { player } = setup(2);
  assert.equal(player.isPlaying, false);
  assert.ok(Math.abs(player.duration - 2) < 0.2);
  player.toggle();
  assert.equal(player.isPlaying, true);
});

test('[mac PlayerTests] 멈추면_그_자리에_서고_다시_누르면_이어서_재생된다', () => {
  const { player, audio } = setup(3);
  player.toggle();
  audio.advance(0.6);
  player.toggle();
  assert.equal(player.isPlaying, false);
  const paused = player.position;
  assert.ok(paused > 0.3 && paused < 1.2);
  audio.advance(0.4);
  assert.ok(Math.abs(player.position - paused) < 0.05);
  player.toggle();
  assert.equal(player.isPlaying, true);
  audio.advance(0.3);
  assert.ok(player.position > paused + 0.1);
});

test('[mac PlayerTests] 끝까지_들으면_멈춤_상태로_돌아오고_처음부터_다시_들을_수_있다', () => {
  const { player, audio } = setup(1);
  player.toggle();
  audio.advance(1.6);
  assert.equal(player.isPlaying, false);
  assert.ok(player.position < 0.05);
  player.toggle();
  assert.equal(player.isPlaying, true);
});

test('[mac PlayerTests] 진행_막대로_원하는_위치로_옮긴다', () => {
  const { player } = setup(3);
  player.seek(2);
  assert.ok(Math.abs(player.position - 2) < 0.05);
  assert.equal(player.isPlaying, false);
  player.seek(99);
  assert.ok(player.position <= player.duration);
  player.seek(-5);
  assert.equal(player.position, 0);
});

test('[mac PlayerTests] 다른_기록을_열면_재생이_멈추고_새_기록은_처음부터다', () => {
  const { player, audio } = setup(3);
  player.toggle();
  audio.advance(1);
  player.open('ezrite-note://audio/b.m4a');
  audio.ready(2);
  assert.equal(player.isPlaying, false);
  assert.equal(player.position, 0);
  assert.ok(Math.abs(player.duration - 2) < 0.2);
});

test('[mac PlayerTests] 목록으로_돌아가면_재생이_멈춘다', () => {
  const { player } = setup(3);
  player.toggle();
  player.close();
  assert.equal(player.isPlaying, false);
  assert.equal(player.duration, 0);
});

test('[mac PlayerTests] 줄을_누르면_그_구간만_재생하고_멈춘다', () => {
  const { player, audio, timers, fire } = setup(3);
  player.playRange(1.0, 1.5);
  assert.equal(player.isPlaying, true);
  assert.ok(Math.abs(player.position - 1.0) < 0.1);
  assert.equal(timers.at(-1).ms, 500);
  audio.advance(0.5);
  fire();
  assert.equal(player.isPlaying, false);
  assert.ok(Math.abs(player.position - 1.5) < 0.15);
});

test('[mac PlayerTests] 구간_재생_중에_다른_조작을_하면_구간_끝에서_멈추지_않는다', () => {
  const { player, fire } = setup(3);
  player.playRange(0.2, 0.5);
  player.seek(1.0);
  fire();
  assert.equal(player.isPlaying, true);
});

test('바뀔 때마다 알린다 (화면의 ▶/⏸ 와 막대)', () => {
  const { player, audio } = setup(3);
  let n = 0;
  player.onChange = () => { n += 1; };
  player.toggle();
  audio.advance(0.5);
  player.toggle();
  assert.ok(n >= 3);
});
