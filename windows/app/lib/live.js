'use strict';

// 녹음 세션: 소리 출처(helper capture 또는 시험용 wav) → VadStream → Transcriber 를 잇고,
// 화면에 보일 상태(녹음 중·일시정지·줄·오류)를 만든다. 맥 Transcriber.swift 의 start/stop/pause/resume/
// switchSource/reconnect 흐름을 따른다. 소리 출처를 여는 일은 바깥에서 넣어 준다 (시험은 가짜로).
//
// openSource(args, { onData(chunk: s16le Buffer), onEnd(message) }) → { stop() }
//   onEnd 는 출처가 저절로 끝났을 때만 부른다 (stop() 으로 멈춘 때는 부르지 않는다).
//
// 이벤트: change(바뀐 상태 일부) · notice(위쪽 줄에 잠깐 띄울 글) · pcm(받은 조각 — 소리 크기 막대용)
//         record(녹음 파일에 쓸 조각 — 조용해서 쉬는 동안은 오지 않는다)
//         start · stop (녹음 하나의 처음과 끝 — 기록 파일을 만들고 소리 파일을 마무리하는 자리)
//
// quietAfter(): 말소리가 이만큼(초) 없으면 저절로 쉰다 (1.1.5 조용하면 자동 일시정지). null 이면 쉬지 않는다.
//   쉬는 동안(state.quietPaused) 시계가 멈추고 파일에 쓰지 않는다. 수동 일시정지(paused)와는 따로다

const { EventEmitter } = require('node:events');
const { VadStream } = require('./vad');
const { CaptureRestarter, MESSAGES, gap, timestamp } = require('./transcriber');
const { GroqClient } = require('./groq');
const Usage = require('./usage');
const { Budget } = require('./budget');
const log = require('./applog');

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
  constructor({
    transcriber, openSource, hasKey, restarter = new CaptureRestarter(), quietAfter = () => null, now = () => Date.now(), clock = () => new Date(),
  }) {
    super();
    this.transcriber = transcriber;
    this.openSource = openSource;
    this.hasKey = hasKey;
    this.restarter = restarter;
    this.quietAfter = quietAfter;
    this.now = now;
    this.clock = clock;
    this.state = {
      listening: false, paused: false, quietPaused: false, startedAt: null, recordedBefore: 0, entries: [], inflight: 0, error: null,
    };
    this.args = null;
    this.capture = null; // { handle, vad } — 지금 열려 있는 출처
    this.offset = 0; // 녹음 파일 안 위치(초). 다시 붙이거나 이어 해도 시각이 이어지게
    this.pausedClock = '';
    this.quietClock = '';

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
      log.warn('녹음', '키 없음 — 시작하지 못함');
      this.set({ error: MESSAGES.noKey });
      return false;
    }
    this.transcriber.startSession();
    this.restarter.reset();
    this.args = args;
    this.offset = 0;
    this.set({
      listening: true, paused: false, quietPaused: false, startedAt: this.now(), recordedBefore: 0, entries: [], inflight: 0, error: null,
    });
    this.emit('start');
    try {
      this.open();
    } catch (e) {
      log.error('녹음', `캡처 시작 실패: ${log.err(e)}`);
      this.set({ error: e?.message ?? String(e) });
      this.stop();
      return false;
    }
    return true;
  }

  /** 지금까지 녹음한 초 (쉰 동안은 빼고) */
  recordedSeconds() {
    const ran = this.state.startedAt == null ? 0 : (this.now() - this.state.startedAt) / 1000;
    return this.state.recordedBefore + ran;
  }

  /** 끝내기. 모으던 마지막 발화는 그대로 보낸다 (보낸 결과는 멈춘 뒤에도 줄로 붙는다) */
  stop() {
    if (!this.state.listening) return;
    const secs = this.recordedSeconds();
    this.close();
    const lines = this.transcriber.entries.filter((e) => e.kind === 'text').length;
    log.info('녹음', `끝냄 — 녹음 ${secs.toFixed(1)}초, 줄 ${lines}개, 보내는 중 ${this.transcriber.inflight}개`);
    this.set({ listening: false, paused: false, quietPaused: false, startedAt: null, recordedBefore: 0 });
    this.emit('stop');
  }

  /** 듣기만 멈춘다. 이어 하면 같은 기록에 이어 쓴다 */
  pause() {
    if (!this.state.listening || this.state.paused) return;
    const ran = this.state.startedAt == null ? 0 : (this.now() - this.state.startedAt) / 1000;
    this.pausedClock = timestamp(this.clock());
    log.info('녹음', `일시정지 — 녹음 ${(this.state.recordedBefore + ran).toFixed(1)}초에서`);
    this.close();
    this.set({ paused: true, quietPaused: false, startedAt: null, recordedBefore: this.state.recordedBefore + ran });
  }

  /** 조용해서 쉬기 시작함(true) / 말이 다시 들려 이어 감(false). 맥 Transcriber.quietChanged */
  quietChanged(quiet) {
    if (!this.state.listening || this.state.paused || quiet === this.state.quietPaused) return;
    log.info('녹음', quiet ? '자동 쉼 — 조용함' : '이어 감 — 말소리');
    if (quiet) {
      const ran = this.state.startedAt == null ? 0 : (this.now() - this.state.startedAt) / 1000;
      this.quietClock = timestamp(this.clock());
      this.set({ quietPaused: true, startedAt: null, recordedBefore: this.state.recordedBefore + ran });
    } else {
      this.set({ quietPaused: false, startedAt: this.now() });
      this.transcriber.addGap(gap.quietPaused(this.quietClock, this.clock()));
    }
  }

  /** 녹음 중에 설정을 바꿨을 때: 지금 스트림에 바로 반영한다 (끄면 쉬던 것을 이어 간다) */
  quietSettingChanged() {
    this.capture?.vad.setIdleAfter(this.quietAfter());
  }

  resume(args) {
    if (!this.state.listening || !this.state.paused) return;
    if (args) this.args = args;
    log.info('녹음', '이어서');
    this.restarter.reset();
    this.set({ paused: false, startedAt: this.now() });
    this.transcriber.addGap(gap.resumed(this.pausedClock, this.clock()));
    try {
      this.open();
    } catch (e) {
      log.error('녹음', `이어서 캡처 시작 실패: ${log.err(e)}`);
      this.set({ error: e?.message ?? String(e) });
      this.stop();
    }
  }

  /** 녹음 중에 출처(또는 마이크 섞기)를 바꾸면 출처만 새로 붙이고 바꾼 자리를 남긴다 (" + 마이크"). 일시정지 중이면 이어 할 때 새 출처로 */
  switchSource(args, label, withMic = Boolean(args?.mixMic)) {
    if (!this.state.listening) return;
    this.args = args;
    log.info('녹음', `출처 바꿈 — ${args?.pid ? '프로그램' : '마이크'}${withMic ? ' + 마이크' : ''}${this.state.paused ? ' (일시정지 중)' : ''}`);
    this.transcriber.addGap(gap.sourceChanged(this.clock(), label, withMic));
    if (this.state.paused) return;
    this.close();
    try {
      this.open();
    } catch (e) {
      log.error('녹음', `출처 바꿔 캡처 시작 실패: ${log.err(e)}`);
      this.set({ error: e?.message ?? String(e) });
      this.stop();
    }
  }

  /** 인식 언어는 발화를 보낼 때마다 읽으니 바로 다음 문장부터 바뀐다. 바꾼 자리만 남긴다 */
  languageChanged(label) {
    if (!this.state.listening) return;
    log.info('녹음', `인식 언어 바꿈 — ${label}`);
    this.transcriber.languageChanged(label);
  }

  open() {
    // 쉬던 중에 출처를 다시 붙이면 새 스트림은 쓰면서 시작한다. 쉰 자리는 여기서 끝낸다
    this.quietChanged(false);
    const capture = { vad: null, handle: null };
    const vad = new VadStream({
      startOffset: this.offset,
      idleAfter: this.quietAfter(),
      onUtterance: (u) => { this.transcriber.enqueue(u.samples, { start: u.start, end: u.end }); },
      onRecord: (b) => { if (this.capture === capture) this.emit('record', b); },
      onIdle: (quiet) => { if (this.capture === capture) this.quietChanged(quiet); },
    });
    capture.vad = vad;
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
    const t0 = Date.now();
    c.handle?.stop();
    // 블록이 안 된 마지막 나머지도 record 로 파일에 쓴다 (쉬는 중이면 쓰지 않는다). 그래서 capture 를 비우기 전에
    c.vad.finish();
    log.info('녹음', `캡처 멈춤 ${Date.now() - t0}ms`);
    this.capture = null;
    this.offset = c.vad.startOffset + c.vad.written / SAMPLE_RATE;
  }

  /** 출처가 저절로 끊겼다: 끊김 자리를 남기고 몇 번 다시 붙여 본다 (맥 Transcriber.reconnect) */
  async lost(message) {
    this.close();
    this.quietChanged(false);
    log.warn('녹음', `캡처 끊김: ${log.err(message)}`);
    this.transcriber.addGap(gap.disconnected(this.clock(), message));
    const ok = await this.restarter.run({
      isActive: () => this.state.listening && !this.state.paused && !this.capture,
      restart: async () => this.open(),
      onAttempt: (n, e) => (e ? log.warn('녹음', `다시 연결 ${n}번째 시도 실패: ${log.err(e)}`) : log.info('녹음', `다시 연결 ${n}번째 시도 성공`)),
    });
    if (ok === true) this.transcriber.addGap(gap.reconnected(this.clock()));
    else if (ok === false) {
      log.error('녹음', `다시 연결 포기 (${this.restarter.maxRestarts}번 실패)`);
      this.set({ error: MESSAGES.reconnectFailed });
      this.stop();
    }
  }
}

module.exports = { LiveSession, viewEntries, usageFooter };
