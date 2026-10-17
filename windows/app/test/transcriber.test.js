'use strict';

// 맥 Transcriber.swift / Notes.sanitize / WAV.encode / AppState.languageCode 규칙 시험.
// 맥에는 이 부분 시험이 없어 모두 새로 쓴다. 네트워크는 가짜 groq 객체로 대신한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../lib/transcriber');

const { Transcriber, encodeWav, sanitize, languageCode, LANGUAGES, CaptureRestarter } = T;

// --- WAV ---

test('encodeWav: 16kHz mono 16-bit PCM 헤더 44바이트', () => {
  const w = encodeWav(new Float32Array([0, 0.5, -0.5, 2, -2]));
  assert.equal(w.length, 44 + 10);
  assert.equal(w.toString('ascii', 0, 4), 'RIFF');
  assert.equal(w.readUInt32LE(4), 36 + 10);
  assert.equal(w.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(w.readUInt32LE(16), 16);
  assert.equal(w.readUInt16LE(20), 1); // PCM
  assert.equal(w.readUInt16LE(22), 1); // mono
  assert.equal(w.readUInt32LE(24), 16000);
  assert.equal(w.readUInt32LE(28), 32000);
  assert.equal(w.readUInt16LE(32), 2);
  assert.equal(w.readUInt16LE(34), 16);
  assert.equal(w.toString('ascii', 36, 40), 'data');
  assert.equal(w.readUInt32LE(40), 10);
  // ×32767 뒤 0 쪽으로 버림(Swift Int16(Float)), 범위 밖은 ±1 로 자른다
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => w.readInt16LE(44 + i * 2)), [0, 16383, -16383, 32767, -32767]);
});

test('encodeWav: 빈 소리도 헤더만 있는 올바른 파일, 일반 배열도 받는다', () => {
  const w = encodeWav([]);
  assert.equal(w.length, 44);
  assert.equal(w.readUInt32LE(40), 0);
  assert.equal(encodeWav([1]).readInt16LE(44), 32767);
});

test('encodeWav: NaN 은 0 으로', () => {
  assert.equal(encodeWav([NaN]).readInt16LE(44), 0);
});

// --- sanitize (Notes.sanitize: 같은 구절 반복 자르기) ---

test('sanitize: 같은 구절이 3번 이상 딱 맞게 반복되면 한 번만', () => {
  assert.equal(sanitize('감사 합니다 감사 합니다 감사 합니다'), '감사 합니다');
  assert.equal(sanitize('Go. go! GO go'), 'Go.');
});

test('sanitize: 끝 쉼표는 떼고, 2번 반복·딱 안 맞는 반복은 그대로', () => {
  assert.equal(sanitize('hello, hello, hello, hello,'), 'hello');
  assert.equal(sanitize('a b a b'), 'a b a b');
  assert.equal(sanitize('a b a b a b a'), 'a b a b a b a');
});

test('sanitize: 4단어 미만은 앞뒤 공백만 자른다, 연속 공백은 한 단어로 보지 않는다', () => {
  assert.equal(sanitize('  네 네 네 '), '네 네 네');
  assert.equal(sanitize('a  a   a    a'), 'a');
  assert.equal(sanitize(''), '');
});

// --- 언어 ---

test('언어 목록과 코드: 모르는 이름은 ko', () => {
  assert.deepEqual(LANGUAGES, [
    { label: '한국어', code: 'ko' }, { label: 'English', code: 'en' }, { label: '日本語', code: 'ja' },
  ]);
  assert.equal(languageCode('English'), 'en');
  assert.equal(languageCode('日本語'), 'ja');
  assert.equal(languageCode('한국어'), 'ko');
  assert.equal(languageCode('Deutsch'), 'ko');
});

// --- 끊김 표시 줄 ---

test('끊김 표시 줄 문구는 맥과 같다', () => {
  const d = new Date(2026, 9, 17, 9, 5, 7);
  assert.equal(T.timestamp(d), '09:05:07');
  assert.equal(T.gap.sourceChanged(d, 'Chrome', true), '── 09:05:07 소리 출처 → Chrome + 마이크');
  assert.equal(T.gap.sourceChanged(d, '마이크', false), '── 09:05:07 소리 출처 → 마이크');
  assert.equal(T.gap.languageChanged(d, 'English'), '── 09:05:07 인식 언어 → English');
  assert.equal(T.gap.resumed('09:00:00', d), '── 09:00:00–09:05:07 일시정지 후 이어서 녹음');
  assert.equal(T.gap.disconnected(d, '장치 없음'), '── 09:05:07 소리가 끊겼습니다 (장치 없음)');
  assert.equal(T.gap.reconnected(d), '── 09:05:07 다시 연결됨');
  assert.equal(T.gap.recognitionFailed(d, '오류'), '── 09:05:07 인식 실패: 오류');
  assert.equal(T.MESSAGES.noKey, 'Groq API 키가 없습니다. 설정에서 키를 입력하세요.');
  assert.equal(T.MESSAGES.reconnectFailed, '소리 캡처를 다시 붙이지 못했습니다. 받아쓰기를 다시 시작하세요.');
});

// --- Transcriber 흐름 ---

const CLOCK = new Date(2026, 9, 17, 10, 0, 0);

/** 가짜 groq: transcribe 결과를 차례로 돌려준다 (값 / Error / {text, delay}) */
function fakeGroq(results, translations = []) {
  const calls = [];
  const tcalls = [];
  return {
    calls,
    tcalls,
    async transcribe(wav, opts) {
      calls.push({ wav, ...opts });
      const r = results.shift();
      if (r && r.delay) await new Promise((res) => setTimeout(res, r.delay));
      if (r instanceof Error) throw r;
      if (r && r.fallback) opts.onFallback?.('whisper-large-v3', 'whisper-large-v3-turbo');
      return typeof r === 'string' ? r : r.text;
    },
    async translate(lines, context) {
      tcalls.push({ lines, context });
      const r = translations.shift();
      if (r instanceof Error) throw r;
      if (typeof r === 'function') return r(lines);
      return r ?? lines.map((l) => `[${l}]`);
    },
  };
}

function make(groq, opts = {}) {
  const t = new Transcriber({ groq, clock: () => CLOCK, language: () => opts.lang ?? 'ko', ...opts });
  const ev = { entry: [], translated: [], gap: [], failure: [], notice: [], inflight: [], times: [] };
  for (const k of Object.keys(ev)) t.on(k, (x) => ev[k].push(x));
  t.startSession();
  return { t, ev };
}

const samples = new Float32Array(1600);

test('Transcriber: 발화를 WAV 로 보내고, 직전 줄을 prompt 로 넘긴다', async () => {
  const g = fakeGroq(['첫 문장입니다', '둘째 문장입니다']);
  const { t, ev } = make(g);
  t.enqueue(samples, { start: 1, end: 2 });
  t.enqueue(samples, { start: 2, end: 3 });
  await t.idle();
  assert.deepEqual(t.entries.map((e) => e.original), ['첫 문장입니다', '둘째 문장입니다']);
  assert.equal(g.calls[0].prompt, '');
  assert.equal(g.calls[1].prompt, '첫 문장입니다');
  assert.equal(g.calls[0].language, 'ko');
  assert.equal(g.calls[0].wav.length, 44 + 3200);
  assert.deepEqual(t.entries[0].time, [1, 2]);
  assert.equal(t.entries[0].kind, 'text');
  assert.equal(ev.entry.length, 2);
  assert.deepEqual(ev.times.at(-1), [[1, 2], [2, 3]]);
});

test('Transcriber: 앞 발화가 늦게 끝나도 순서대로 보내고 순서대로 붙인다', async () => {
  const g = fakeGroq([{ text: '먼저', delay: 30 }, '나중']);
  const { t } = make(g);
  t.enqueue(samples, { start: 0, end: 1 });
  t.enqueue(samples, { start: 1, end: 2 });
  await t.idle();
  assert.deepEqual(t.entries.map((e) => e.original), ['먼저', '나중']);
  assert.equal(g.calls[1].prompt, '먼저');
});

test('Transcriber: 언어는 발화를 넣는 순간의 값을 쓴다', async () => {
  let lang = 'en';
  const g = fakeGroq(['a', 'b']);
  const { t } = make(g, { language: () => lang, autoTranslate: () => false });
  t.enqueue(samples, { start: 0, end: 1 });
  lang = 'ja';
  t.enqueue(samples, { start: 1, end: 2 });
  await t.idle();
  assert.deepEqual(g.calls.map((c) => c.language), ['en', 'ja']);
});

test('Transcriber: 빈 결과와 바로 앞 줄 반복은 버리고, 반복 반복 구절은 잘라 붙인다', async () => {
  const g = fakeGroq(['', '이 그래프를 보면 올라가요', '이 그래프를 보면 올라가요.', '네 네 네 네', '네 네 네 네']);
  const { t } = make(g);
  for (let i = 0; i < 5; i++) t.enqueue(samples, { start: i, end: i + 1 });
  await t.idle();
  // "네 네 네 네" → sanitize → "네" (짧은 대답은 반복이어도 남긴다)
  assert.deepEqual(t.entries.map((e) => e.original), ['이 그래프를 보면 올라가요', '네', '네']);
  assert.equal(g.calls[2].prompt, '이 그래프를 보면 올라가요');
});

test('Transcriber: 인식 실패는 오류를 알리고 끊김 줄을 남긴 뒤 다음 발화는 계속', async () => {
  const g = fakeGroq([new Error('Groq 서버 일시 장애 (502) — 3번 다시 보냈지만 실패'), '다음']);
  const { t, ev } = make(g);
  t.enqueue(samples, { start: 0, end: 1 });
  t.enqueue(samples, { start: 1, end: 2 });
  await t.idle();
  assert.deepEqual(ev.failure, ['Groq 서버 일시 장애 (502) — 3번 다시 보냈지만 실패', null]);
  assert.deepEqual(t.entries.map((e) => [e.kind, e.original]), [
    ['gap', '── 10:00:00 인식 실패: Groq 서버 일시 장애 (502) — 3번 다시 보냈지만 실패'],
    ['text', '다음'],
  ]);
  assert.equal(ev.gap.length, 1);
  assert.equal(g.calls[1].prompt, ''); // 실패한 구간은 문맥이 되지 않는다
});

test('Transcriber: 모델 전환을 알린다', async () => {
  const g = fakeGroq([{ text: '됨', fallback: true }]);
  const { t, ev } = make(g);
  t.enqueue(samples, { start: 0, end: 1 });
  await t.idle();
  assert.deepEqual(ev.notice, ['whisper-large-v3 한도 초과 → whisper-large-v3-turbo로 전환']);
});

test('Transcriber: 보내 놓고 기다리는 수(inflight)를 알린다', async () => {
  const g = fakeGroq(['a', 'b']);
  const { t, ev } = make(g);
  t.enqueue(samples, { start: 0, end: 1 });
  t.enqueue(samples, { start: 1, end: 2 });
  assert.equal(t.inflight, 0); // 아직 시작 전
  await t.idle();
  assert.deepEqual(ev.inflight, [1, 0, 1, 0]);
  assert.equal(t.inflight, 0);
});

test('Transcriber: 한국어는 옮기지 않는다', async () => {
  const g = fakeGroq(['한국어 강의']);
  const { t } = make(g, { lang: 'ko' });
  t.enqueue(samples, { start: 0, end: 1 });
  await t.idle();
  assert.equal(g.tcalls.length, 0);
  assert.equal(t.entries[0].translation, null);
});

test('Transcriber: 자동 번역을 끄면 옮기지 않는다', async () => {
  const g = fakeGroq(['hello']);
  const { t } = make(g, { lang: 'en', autoTranslate: () => false });
  t.enqueue(samples, { start: 0, end: 1 });
  await t.idle();
  assert.equal(g.tcalls.length, 0);
});

test('Transcriber: 영어는 옮기고, 옮긴 줄을 알린다', async () => {
  const g = fakeGroq(['hello there']);
  const { t, ev } = make(g, { lang: 'en' });
  t.enqueue(samples, { start: 0, end: 1 });
  await t.idle();
  assert.deepEqual(g.tcalls, [{ lines: ['hello there'], context: [] }]);
  assert.equal(t.entries[0].translation, '[hello there]');
  assert.equal(ev.translated.length, 1);
  assert.equal(ev.translated[0].id, t.entries[0].id);
});

test('Transcriber: 번역은 한 번에 하나씩, 밀린 줄은 10줄씩 묶고 앞 받아 적은 줄을 문맥으로 준다', async () => {
  const lines = Array.from({ length: 13 }, (_, i) => `line number ${i}`);
  let release;
  const gate = new Promise((r) => { release = r; });
  const g = fakeGroq([...lines], [
    async (ls) => { await gate; return ls.map((l) => `t:${l}`); },
  ]);
  const { t } = make(g, { lang: 'en' });
  for (let i = 0; i < 13; i++) t.enqueue(samples, { start: i, end: i + 1 });
  // 첫 줄 번역이 붙잡혀 있는 동안 나머지 12줄이 쌓인다
  await new Promise((r) => setTimeout(r, 20));
  release();
  await t.idle();
  assert.deepEqual(g.tcalls.map((c) => c.lines.length), [1, 10, 2]);
  assert.deepEqual(g.tcalls[0].context, []);
  assert.deepEqual(g.tcalls[1].context, ['line number 0']);
  assert.deepEqual(g.tcalls[2].context, ['line number 10']);
  assert.ok(t.entries.every((e) => e.translation && e.translation.startsWith('t:') || e.translation === `[${e.original}]`));
});

test('Transcriber: 문맥은 끊김 줄을 건너뛴 바로 앞 받아 적은 줄', async () => {
  const g = fakeGroq(['before line', new Error('x'), 'after line'], [['B'], ['A']]);
  const { t } = make(g, { lang: 'en' });
  t.enqueue(samples, { start: 0, end: 1 });
  await t.idle();
  t.enqueue(samples, { start: 1, end: 2 });
  t.enqueue(samples, { start: 2, end: 3 });
  await t.idle();
  assert.deepEqual(g.tcalls[1], { lines: ['after line'], context: ['before line'] });
});

test('Transcriber: 번역 응답에서 못 찾은 줄(null)은 비워 두고, 실패는 알림만', async () => {
  const g = fakeGroq(['one', 'two'], [[null], new Error('번역 한도 초과')]);
  const { t, ev } = make(g, { lang: 'en' });
  t.enqueue(samples, { start: 0, end: 1 });
  await t.idle();
  t.enqueue(samples, { start: 1, end: 2 });
  await t.idle();
  assert.deepEqual(t.entries.map((e) => e.translation), [null, null]);
  assert.deepEqual(ev.notice, ['번역 한도 초과']);
  assert.equal(ev.translated.length, 0);
});

test('Transcriber: 번역 도중 새 세션이 시작되면 옛 결과는 버린다', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const g = fakeGroq(['old', 'new'], [async (ls) => { await gate; return ['OLD']; }, ['NEW']]);
  const { t, ev } = make(g, { lang: 'en' });
  t.enqueue(samples, { start: 0, end: 1 });
  await new Promise((r) => setTimeout(r, 10));
  t.startSession();
  t.enqueue(samples, { start: 0, end: 1 });
  await new Promise((r) => setTimeout(r, 10));
  release();
  await t.idle();
  assert.deepEqual(t.entries.map((e) => [e.original, e.translation]), [['new', 'NEW']]);
  assert.equal(ev.translated.length, 1);
});

test('Transcriber: 새 세션은 기록·문맥을 비운다', async () => {
  const g = fakeGroq(['a b c d e f', 'a b c d e f']);
  const { t } = make(g);
  t.enqueue(samples, { start: 0, end: 1 });
  await t.idle();
  t.startSession();
  t.enqueue(samples, { start: 0, end: 1 });
  await t.idle();
  assert.equal(g.calls[1].prompt, '');
  assert.equal(t.entries.length, 1); // 앞 세션과 같아도 반복으로 보지 않는다
});

test('Transcriber: languageChanged 는 바꾼 자리만 남긴다', () => {
  const { t, ev } = make(fakeGroq([]));
  t.languageChanged('English');
  assert.deepEqual(t.entries.map((e) => e.original), ['── 10:00:00 인식 언어 → English']);
  assert.equal(ev.gap.length, 1);
});

test('Transcriber: 맞춤 번역 함수를 주면 그것을 쓴다 (다른 서비스 붙일 자리)', async () => {
  const seen = [];
  const g = fakeGroq(['hi']);
  const { t } = make(g, { lang: 'en', translate: async (lines, ctx) => { seen.push([lines, ctx]); return ['안녕']; } });
  t.enqueue(samples, { start: 0, end: 1 });
  await t.idle();
  assert.deepEqual(seen, [[['hi'], []]]);
  assert.equal(g.tcalls.length, 0);
  assert.equal(t.entries[0].translation, '안녕');
});

test('Transcriber: groq 가 없으면 TypeError', () => {
  assert.throws(() => new Transcriber({}), TypeError);
});

test('Transcriber: 기본 시계·언어로도 동작한다', async () => {
  const t = new Transcriber({ groq: fakeGroq(['x']) });
  t.startSession();
  t.enqueue(samples, { start: 0, end: 1 });
  await t.idle();
  assert.equal(t.entries[0].original, 'x');
});

// --- 다시 붙이기 ---

test('CaptureRestarter: 2초 쉬고 다시 붙이기를 5번까지, 성공하면 true', async () => {
  const sleeps = [];
  const r = new CaptureRestarter({ sleep: async (ms) => sleeps.push(ms) });
  assert.equal(CaptureRestarter.MAX_RESTARTS, 5);
  assert.equal(CaptureRestarter.WAIT_MS, 2000);
  let tries = 0;
  const ok = await r.run({ isActive: () => true, restart: async () => { tries++; if (tries < 3) throw new Error('x'); } });
  assert.equal(ok, true);
  assert.equal(tries, 3);
  assert.deepEqual(sleeps, [2000, 2000, 2000]);
});

test('CaptureRestarter: 횟수는 세션 안에서 이어지고 다 쓰면 false, reset 으로 되돌린다', async () => {
  const r = new CaptureRestarter({ sleep: async () => {} });
  let tries = 0;
  const fail = async () => { tries++; throw new Error('x'); };
  assert.equal(await r.run({ isActive: () => true, restart: async () => { tries++; } }), true);
  assert.equal(await r.run({ isActive: () => true, restart: fail }), false);
  assert.equal(tries, 5);
  assert.equal(await r.run({ isActive: () => true, restart: fail }), false);
  assert.equal(tries, 5); // 남은 횟수 없음
  r.reset();
  assert.equal(await r.run({ isActive: () => true, restart: async () => {} }), true);
});

test('CaptureRestarter: 기다리는 사이 멈추면(정지·일시정지) 붙이지 않고 null', async () => {
  let active = true;
  const r = new CaptureRestarter({ sleep: async () => { active = false; } });
  let tries = 0;
  assert.equal(await r.run({ isActive: () => active, restart: async () => { tries++; } }), null);
  assert.equal(tries, 0);
  assert.equal(await new CaptureRestarter().run({ isActive: () => false, restart: async () => {} }), null);
});
