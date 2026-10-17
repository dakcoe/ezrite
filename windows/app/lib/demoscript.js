'use strict';

// 개발용 시연 대본: EZRITE_DEMO_SCRIPT=<json> 이면 녹음을 눌렀을 때 소리·VAD·Groq 받아쓰기 없이
// 대본 줄을 실제 받아쓰기처럼 차례로 띄운다 (firstDelay + i×interval 초에 줄, translationDelay 뒤에 번역).
// 녹음 파일은 무음으로 남는다. 설명해줘·질문은 그대로 실제 Groq 를 쓴다.

const fs = require('node:fs');

const SAMPLE_RATE = 16000;
const PENDING_LEAD = 0.8; // 줄이 뜨기 전 "받아 적는 중…" 을 보이는 시간(초)

function num(v, name, { min = 0, exclusive = false } = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v) || (exclusive ? v <= min : v < min)) {
    throw new Error(`${name} 는 ${exclusive ? `${min} 보다 큰` : `${min} 이상인`} 숫자여야 합니다`);
  }
  return v;
}

/** JSON 글 → { firstDelay, interval, translationDelay, lines: [{ text, ko }] }. 틀리면 무엇이 틀렸는지 알린다 */
function parseDemoScript(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON 이 아닙니다 (${e.message})`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('대본은 JSON 객체여야 합니다');
  if (!Array.isArray(raw.lines) || raw.lines.length === 0) throw new Error('lines 에 줄이 하나 이상 있어야 합니다');
  const lines = raw.lines.map((l, i) => {
    if (!l || typeof l.text !== 'string' || !l.text.trim()) throw new Error(`lines[${i}].text 가 비었습니다`);
    if (l.ko != null && typeof l.ko !== 'string') throw new Error(`lines[${i}].ko 는 글이어야 합니다`);
    return { text: l.text.trim(), ko: l.ko?.trim() || null };
  });
  return {
    firstDelay: num(raw.firstDelay, 'firstDelay'),
    interval: num(raw.interval, 'interval', { exclusive: true }),
    translationDelay: num(raw.translationDelay, 'translationDelay'),
    lines,
  };
}

function loadDemoScript(file) {
  try {
    return parseDemoScript(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`시연 대본(EZRITE_DEMO_SCRIPT)을 읽지 못했습니다: ${e.code === 'ENOENT' ? '파일이 없습니다' : e.message}`);
  }
}

/**
 * 대본 시계. 녹음 중인 시간만 흐른다 (resume ~ pause).
 * sink: { pending(on), line(text, {start,end}) → id, translate(id, ko) }
 */
class DemoScript {
  constructor(script, sink, { now = () => Date.now(), setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout } = {}) {
    Object.assign(this, { script, sink, now, st, ct });
    this.timers = [];
    this.reset();
  }

  /** 새 녹음: 첫 줄부터 */
  reset() {
    this.pause();
    this.elapsed = 0;
    const { firstDelay, interval, translationDelay } = this.script;
    this.events = [];
    this.ids = [];
    this.script.lines.forEach((l, i) => {
      const at = firstDelay + i * interval;
      this.events.push({ at: Math.max(0, at - PENDING_LEAD), run: () => this.setPending(true) });
      this.events.push({ at, run: () => {
        this.setPending(false);
        this.ids[i] = this.sink.line(l.text, { start: Math.max(0, at - interval + 0.3), end: Math.max(0, at - 0.2) });
      } });
      if (l.ko) this.events.push({ at: at + translationDelay, run: () => this.sink.translate(this.ids[i], l.ko) });
    });
    this.events.forEach((e, i) => { e.order = i; });
  }

  setPending(on) {
    if (this.pendingOn === on) return;
    this.pendingOn = on;
    this.sink.pending(on);
  }

  resume() {
    if (this.since != null) return;
    this.since = this.now();
    for (const e of this.events) {
      if (e.done) continue;
      this.timers.push(this.st(() => { e.done = true; e.run(); }, Math.max(0, (e.at - this.elapsed) * 1000)));
    }
  }

  pause() {
    for (const t of this.timers) this.ct(t);
    this.timers = [];
    if (this.since != null) this.elapsed += (this.now() - this.since) / 1000;
    this.since = null;
    if (this.pendingOn) this.setPending(false);
  }
}

/** LiveSession.openSource 자리: 열면 대본이 흐르고 무음 조각을 100ms 마다 보낸다 (녹음 시간·파일이 평소처럼 쌓이게) */
function demoSource(demo, { setInterval: si = setInterval, clearInterval: ci = clearInterval } = {}) {
  const silence = Buffer.alloc((SAMPLE_RATE * 2) / 10);
  return (_args, { onData }) => {
    demo.resume();
    const timer = si(() => onData(silence), 100);
    return { stop: () => { ci(timer); demo.pause(); } };
  };
}

/** 말소리처럼 오르내리는 가짜 소리 크기 (0..1). t: 초 */
function fakeLevel(t) {
  const syllable = Math.abs(Math.sin(t * Math.PI * 3.3));
  const phrase = 0.65 + 0.35 * Math.sin(t * 0.9) * Math.sin(t * 2.3 + 1);
  const jitter = 0.08 * Math.sin(t * 37.1) * Math.sin(t * 13.7);
  return Math.min(1, Math.max(0, 0.38 + 0.4 * syllable * phrase + jitter));
}

module.exports = { parseDemoScript, loadDemoScript, DemoScript, demoSource, fakeLevel, PENDING_LEAD };
