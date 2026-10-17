'use strict';

// 받아쓰기 흐름의 규칙 부분. 맥 Transcriber.swift(+ Notes.sanitize, AppState.languageCode) 이식.
//
// 발화를 순서대로 하나씩 Groq 에 보내고(앞 문장이 끝나야 다음 문장의 prompt 가 정해진다),
// 결과를 다듬어 줄로 쌓고, 한국어가 아니면 밀린 줄을 묶어서 번역한다.
// 캡처 켜고 끄기·저장 파일·화면은 여기 없다. 바깥에서 이벤트를 받아 붙인다:
//   entry(줄) · translated(줄) · gap(끊김 줄) · failure(오류 글 또는 null) · notice(알림 글)
//   inflight(보내 놓고 기다리는 수) · times([[시작, 끝]...], .times.json 용)
// ('error' 는 EventEmitter 에서 듣는 쪽이 없으면 던져지므로 'failure' 라는 이름을 쓴다)

const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const Hallucination = require('./hallucination');
const { encodeWav } = require('./wav');
const { isLetterOrNumber, graphemes, trimWs } = require('./text');

const TRANSLATE_BATCH = 10;

const LANGUAGES = Object.freeze([
  Object.freeze({ label: '한국어', code: 'ko' }),
  Object.freeze({ label: 'English', code: 'en' }),
  Object.freeze({ label: '日本語', code: 'ja' }),
]);

function languageCode(label) {
  return LANGUAGES.find((l) => l.label === label)?.code ?? 'ko';
}

const MESSAGES = Object.freeze({
  noKey: 'Groq API 키가 없습니다. 설정에서 키를 입력하세요.',
  reconnectFailed: '소리 캡처를 다시 붙이지 못했습니다. 받아쓰기를 다시 시작하세요.',
});

/** Whisper 가 같은 구절을 반복 생성하는 환각을 잘라낸다 (KMP 로 주기 검출). 맥 Notes.sanitize */
function sanitize(text) {
  // Swift split(separator: " ") 은 빈 조각을 버린다
  const words = String(text).split(' ').filter((w) => w.length > 0);
  const n = words.length;
  if (n < 4) return trimWs(text);
  const norm = words.map((w) => graphemes(w).filter(isLetterOrNumber).join('').toLowerCase());
  const f = new Array(n).fill(0);
  let k = 0;
  for (let i = 1; i < n; i++) {
    while (k > 0 && norm[k] !== norm[i]) k = f[k - 1];
    if (norm[k] === norm[i]) k += 1;
    f[i] = k;
  }
  const period = n - f[n - 1];
  if (period < n && n % period === 0 && n / period >= 3) {
    let s = words.slice(0, period).join(' ');
    while (s.endsWith(',')) s = s.slice(0, -1);
    return trimWs(s);
  }
  return trimWs(text);
}

const pad = (v) => String(v).padStart(2, '0');

/** Notes.timestamp: HH:mm:ss (내 컴퓨터 시각) */
function timestamp(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 기록에 남기는 끊김 표시 줄 (`── ` 로 시작) */
const gap = Object.freeze({
  sourceChanged: (d, label, withMic) => `── ${timestamp(d)} 소리 출처 → ${label}${withMic ? ' + 마이크' : ''}`,
  languageChanged: (d, label) => `── ${timestamp(d)} 인식 언어 → ${label}`,
  resumed: (pausedClock, d) => `── ${pausedClock}–${timestamp(d)} 일시정지 후 이어서 녹음`,
  disconnected: (d, message) => `── ${timestamp(d)} 소리가 끊겼습니다 (${message})`,
  reconnected: (d) => `── ${timestamp(d)} 다시 연결됨`,
  recognitionFailed: (d, message) => `── ${timestamp(d)} 인식 실패: ${message}`,
});

class Transcriber extends EventEmitter {
  /**
   * groq: transcribe(wav, {language, prompt, onFallback}), translate(lines, context) 를 가진 객체
   * translate(lines, context): 다른 번역 서비스를 붙일 자리 (맥 Translation.run). 기본은 groq.translate
   * language(): 지금 인식 언어 코드 — 발화를 넣는 순간 읽으니 바로 다음 문장부터 바뀐다
   * autoTranslate(): 자동 번역 켬/끔
   * clock(): 끊김 줄 시각
   */
  constructor({
    groq, translate, language = () => 'ko', autoTranslate = () => true, clock = () => new Date(),
  } = {}) {
    super();
    if (!groq || typeof groq.transcribe !== 'function') throw new TypeError('Transcriber: groq 가 필요합니다');
    this.groq = groq;
    this.translateFn = translate ?? ((lines, context) => groq.translate(lines, context));
    this.language = language;
    this.autoTranslate = autoTranslate;
    this.clock = clock;
    this.sendChain = Promise.resolve();
    this.translating = null; // 진행 중인 번역 묶음 (Promise)
    this.session = 0;
    this._inflight = 0;
    this.startSession();
  }

  /** 새 받아쓰기를 시작할 때. 기록·문맥·번역 대기열을 비운다 */
  startSession() {
    this.session += 1;
    this._entries = [];
    this.lastText = '';
    this.untranslated = [];
    this.times = [];
  }

  get entries() {
    return this._entries;
  }

  get inflight() {
    return this._inflight;
  }

  /** 발화 하나를 순서대로 보낸다. time: {start, end} — 녹음 파일 안 위치(초) */
  enqueue(samples, time) {
    const language = this.language();
    const next = this.sendChain.then(() => this.send(samples, time, language));
    this.sendChain = next;
    return next;
  }

  /** 보낸 발화와 번역이 다 끝날 때까지 기다린다 */
  async idle() {
    for (;;) {
      const chain = this.sendChain;
      await chain;
      if (this.translating) await this.translating;
      if (chain === this.sendChain && !this.translating) return;
    }
  }

  setInflight(n) {
    this._inflight = n;
    this.emit('inflight', n);
  }

  async send(samples, time, language) {
    this.setInflight(this._inflight + 1);
    try {
      const raw = await this.groq.transcribe(encodeWav(samples), {
        language,
        prompt: this.lastText,
        onFallback: (from, to) => this.emit('notice', `${from} 한도 초과 → ${to}로 전환`),
      });
      const text = sanitize(raw);
      if (!text || Hallucination.isRepeat(text, this.lastText)) return;
      this.lastText = text;
      this.emit('failure', null);
      const entry = { id: randomUUID(), kind: 'text', original: text, translation: null, time: [time.start, time.end] };
      this._entries.push(entry);
      this.emit('entry', entry);
      this.times.push([time.start, time.end]);
      this.emit('times', this.times.slice());
      // 한국어 강의는 옮기지 않는다
      if (this.autoTranslate() && language !== 'ko') {
        this.untranslated.push(entry.id);
        this.pumpTranslation();
      }
    } catch (e) {
      // 이 구간은 잃었다. 어디부터 다시 들어야 하는지 알 수 있게 자리를 남긴다
      const message = e?.message ?? String(e);
      this.emit('failure', message);
      this.addGap(gap.recognitionFailed(this.clock(), message));
    } finally {
      this.setInflight(this._inflight - 1);
    }
  }

  /** 밀린 줄을 묶어서 한 번에 옮긴다. 한 묶음이 끝나면 그동안 쌓인 줄로 다음 묶음을 보낸다 */
  pumpTranslation() {
    if (this.translating || this.untranslated.length === 0) return;
    const ids = this.untranslated.splice(0, TRANSLATE_BATCH);
    const byId = new Map(this._entries.map((e, i) => [e.id, i]));
    if (!ids.every((id) => byId.has(id))) {
      this.pumpTranslation(); // 새 세션이 시작돼 사라진 줄
      return;
    }
    const lines = ids.map((id) => this._entries[byId.get(id)].original);
    // 첫 줄 바로 앞의 받아 적은 한 줄 (끊긴 문장 잇기용)
    const before = this._entries.slice(0, byId.get(ids[0]));
    const prev = before.filter((e) => e.kind === 'text').at(-1);
    const context = prev ? [prev.original] : [];
    const session = this.session;

    this.translating = (async () => {
      let result = [];
      try {
        result = (await this.translateFn(lines, context)) ?? [];
      } catch (e) {
        this.emit('notice', e?.message ?? String(e));
      }
      this.translating = null;
      if (session === this.session) {
        ids.forEach((id, i) => {
          const t = result[i];
          const entry = this._entries.find((e) => e.id === id);
          if (t != null && entry) {
            entry.translation = t;
            this.emit('translated', entry);
          }
        });
      }
      this.pumpTranslation();
    })();
  }

  /** 시연 대본(EZRITE_DEMO_SCRIPT) 줄: Groq 없이 받아쓴 줄과 같은 모양으로 넣는다 */
  addScripted(text, time) {
    const entry = { id: randomUUID(), kind: 'text', original: text, translation: null, time: [time.start, time.end] };
    this._entries.push(entry);
    this.lastText = text;
    this.emit('entry', entry);
    this.times.push([time.start, time.end]);
    this.emit('times', this.times.slice());
    return entry;
  }

  /** 시연 대본 번역. 다른 세션의 줄이면 버린다 */
  setTranslation(id, text) {
    const entry = this._entries.find((e) => e.id === id);
    if (!entry) return;
    entry.translation = text;
    this.emit('translated', entry);
  }

  addGap(line) {
    const entry = { id: randomUUID(), kind: 'gap', original: line, translation: null, time: null };
    this._entries.push(entry);
    this.emit('gap', entry);
    return entry;
  }

  /** 인식 언어를 바꾼 자리만 남긴다 */
  languageChanged(label) {
    return this.addGap(gap.languageChanged(this.clock(), label));
  }
}

/**
 * 소리 캡처가 끊겼을 때 다시 붙이기 (맥 Transcriber.reconnect 의 반복 규칙).
 * 횟수는 받아쓰기 시작·이어 하기 때 reset 한다.
 * run → true(다시 붙음) / false(횟수를 다 씀: MESSAGES.reconnectFailed 를 띄우고 멈출 것) / null(그 사이 멈춤)
 */
class CaptureRestarter {
  constructor({ maxRestarts = 5, waitMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.maxRestarts = maxRestarts;
    this.waitMs = waitMs;
    this.sleep = sleep;
    this.restarts = 0;
  }

  reset() {
    this.restarts = 0;
  }

  async run({ isActive, restart }) {
    if (!isActive()) return null; // 일시정지로 멈춘 스트림은 다시 붙이지 않는다
    while (this.restarts < this.maxRestarts) {
      if (!isActive()) return null;
      this.restarts += 1;
      await this.sleep(this.waitMs);
      if (!isActive()) return null;
      try {
        await restart();
        return true;
      } catch {
        // 다음 번에 다시
      }
    }
    return false;
  }
}
CaptureRestarter.MAX_RESTARTS = 5;
CaptureRestarter.WAIT_MS = 2000;

module.exports = {
  Transcriber, CaptureRestarter, encodeWav, sanitize, languageCode, LANGUAGES, TRANSLATE_BATCH, MESSAGES, gap, timestamp,
};
