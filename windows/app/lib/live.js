'use strict';

// 녹음 세션: 소리 출처(helper capture 또는 시험용 wav) → VadStream → Transcriber 를 잇고,
// 화면에 보일 상태(녹음 중·일시정지·줄·오류)를 만든다. 맥 Transcriber.swift 의 start/stop/pause/resume/
// switchSource/reconnect 흐름을 따른다. 소리 출처를 여는 일은 바깥에서 넣어 준다 (시험은 가짜로).
//
// openSource(args, { onData(chunk: s16le Buffer), onEnd(message) }) → { stop() }
//   onEnd 는 출처가 저절로 끝났을 때만 부른다 (stop() 으로 멈춘 때는 부르지 않는다).
//
// 이벤트: change(바뀐 상태 일부) · notice(위쪽 줄에 잠깐 띄울 글) · pcm(받은 조각 — 소리 크기 막대·녹음 파일용)
//         start · stop (녹음 하나의 처음과 끝 — 기록 파일을 만들고 소리 파일을 마무리하는 자리)

const { EventEmitter } = require('node:events');
const { VadStream } = require('./vad');
const { CaptureRestarter, MESSAGES, gap, timestamp } = require('./transcriber');
const { GroqClient } = require('./groq');
const Usage = require('./usage');
const { Budget } = require('./budget');

const SAMPLE_RATE = 16000;

/** 화면으로 보낼 줄. 녹음 파일 안 위치(time)는 화면에 필요 없어 뺀다 */
function viewEntries(entries) {
  return entries.map((e) => ({ id: e.id, kind: e.kind, original: e.original, translation: e.translation ?? null }));
}

/**
 * 팝업 아래 줄 게이지 값 (맥 UsageFooter): 호출 횟수(헤더)와 하루 양(Budget) 중 덜 남은 쪽, 마우스를 올렸을 때 글,
 * 설명·질문 남은 횟수. 계산은 usage.js footer()
 */
function usageFooter(usage, budget = new Budget(), now = Date.now(), paid = {}) {
  return Usage.footer(usage, budget, now, paid);
}

class LiveSession extends EventEmitter {
  constructor({ transcriber, openSource, hasKey, restarter = new CaptureRestarter(), now = () => Date.now(), clock = () => new Date() }) {
    super();
    this.transcriber = transcriber;
    this.openSource = openSource;
    this.hasKey = hasKey;
    this.restarter = restarter;
    this.now = now;
    this.clock = clock;
    this.state = {
      listening: false, paused: false, startedAt: null, recordedBefore: 0, entries: [], inflight: 0, error: null,
    };
    this.args = null;
    this.capture = null; // { handle, vad } — 지금 열려 있는 출처
    this.offset = 0; // 녹음 파일 안 위치(초). 다시 붙이거나 이어 해도 시각이 이어지게
    this.pausedClock = '';

    const entries = () => this.set({ entries: viewEntries(transcriber.entries) });
    transcriber.on('entry', entries);
    transcriber.on('translated', entries);
    transcriber.on('gap', entries);
    transcriber.on('failure', (message) => this.set({ error: message }));
    transcriber.on('inflight', (n) => this.set({ inflight: n }));
    transcriber.on('notice', (message) => this.emit('notice', message));
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.emit('change', patch);
  }

  /** 녹음 시작. 키가 없거나 출처를 못 열면 false (오류는 state.error) */
  start(args) {
    if (this.state.listening) return false;
    if (!this.hasKey()) {
      this.set({ error: MESSAGES.noKey });
      return false;
    }
    this.transcriber.startSession();
    this.restarter.reset();
    this.args = args;
    this.offset = 0;
    this.set({
      listening: true, paused: false, startedAt: this.now(), recordedBefore: 0, entries: [], inflight: 0, error: null,
    });
    this.emit('start');
    try {
      this.open();
    } catch (e) {
      this.set({ error: e?.message ?? String(e) });
      this.stop();
      return false;
    }
    return true;
  }

  /** 끝내기. 모으던 마지막 발화는 그대로 보낸다 (보낸 결과는 멈춘 뒤에도 줄로 붙는다) */
  stop() {
    if (!this.state.listening) return;
    this.close();
    this.set({ listening: false, paused: false, startedAt: null, recordedBefore: 0 });
    this.emit('stop');
  }

  /** 듣기만 멈춘다. 이어 하면 같은 기록에 이어 쓴다 */
  pause() {
    if (!this.state.listening || this.state.paused) return;
    const ran = this.state.startedAt == null ? 0 : (this.now() - this.state.startedAt) / 1000;
    this.pausedClock = timestamp(this.clock());
    this.close();
    this.set({ paused: true, startedAt: null, recordedBefore: this.state.recordedBefore + ran });
  }

  resume(args) {
    if (!this.state.listening || !this.state.paused) return;
    if (args) this.args = args;
    this.restarter.reset();
    this.set({ paused: false, startedAt: this.now() });
    this.transcriber.addGap(gap.resumed(this.pausedClock, this.clock()));
    try {
      this.open();
    } catch (e) {
      this.set({ error: e?.message ?? String(e) });
      this.stop();
    }
  }

  /** 녹음 중에 출처(또는 마이크 섞기)를 바꾸면 출처만 새로 붙이고 바꾼 자리를 남긴다 (" + 마이크"). 일시정지 중이면 이어 할 때 새 출처로 */
  switchSource(args, label, withMic = Boolean(args?.mixMic)) {
    if (!this.state.listening) return;
    this.args = args;
    this.transcriber.addGap(gap.sourceChanged(this.clock(), label, withMic));
    if (this.state.paused) return;
    this.close();
    try {
      this.open();
    } catch (e) {
      this.set({ error: e?.message ?? String(e) });
      this.stop();
    }
  }

  /** 인식 언어는 발화를 보낼 때마다 읽으니 바로 다음 문장부터 바뀐다. 바꾼 자리만 남긴다 */
  languageChanged(label) {
    if (this.state.listening) this.transcriber.languageChanged(label);
  }

  open() {
    const vad = new VadStream({
      startOffset: this.offset,
      onUtterance: (u) => { this.transcriber.enqueue(u.samples, { start: u.start, end: u.end }); },
    });
    const capture = { vad, handle: null };
    capture.handle = this.openSource(this.args, {
      onData: (chunk) => {
        if (this.capture !== capture) return;
        vad.push(chunk);
        this.emit('pcm', chunk);
      },
      onEnd: (message) => (this.capture === capture ? this.lost(message) : Promise.resolve()),
    });
    this.capture = capture;
  }

  close() {
    const c = this.capture;
    if (!c) return;
    this.capture = null;
    c.handle?.stop();
    c.vad.finish();
    this.offset = c.vad.startOffset + c.vad.consumed / SAMPLE_RATE;
  }

  /** 출처가 저절로 끊겼다: 끊김 자리를 남기고 몇 번 다시 붙여 본다 (맥 Transcriber.reconnect) */
  async lost(message) {
    this.close();
    this.transcriber.addGap(gap.disconnected(this.clock(), message));
    const ok = await this.restarter.run({
      isActive: () => this.state.listening && !this.state.paused && !this.capture,
      restart: async () => this.open(),
    });
    if (ok === true) this.transcriber.addGap(gap.reconnected(this.clock()));
    else if (ok === false) {
      this.set({ error: MESSAGES.reconnectFailed });
      this.stop();
    }
  }
}

module.exports = { LiveSession, viewEntries, usageFooter };
