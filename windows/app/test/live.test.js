'use strict';

// 녹음 세션(소리 → VAD → Transcriber → 화면 상태) 시험. 소리 출처와 Groq 는 가짜로 대신한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Transcriber, CaptureRestarter, MESSAGES } = require('../lib/transcriber');
const { LiveSession, viewEntries, usageFooter } = require('../lib/live');

const SR = 16000;

/** 진폭 a 인 s16le 소리 secs 초 (잡음처럼 부호를 바꾼다) */
function tone(secs, a) {
  const n = Math.round(secs * SR);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round((i % 2 ? a : -a) * 32767), i * 2);
  return b;
}
const speech = (secs) => tone(secs, 0.3);
const silence = (secs) => tone(secs, 0.0005);

/** 가짜 소리 출처: 열 때마다 기록하고, 시험에서 데이터·끊김을 흘려 넣는다 */
function fakeSource({ failOpen = 0 } = {}) {
  const opened = [];
  let fails = failOpen;
  const open = (args, cb) => {
    if (fails > 0) {
      fails -= 1;
      throw new Error('열기 실패');
    }
    const h = { args, cb, stopped: false, stop() { this.stopped = true; } };
    opened.push(h);
    return h;
  };
  open.opened = opened;
  open.last = () => opened[opened.length - 1];
  return open;
}

/** 부를 때마다 차례로 글을 돌려주는 가짜 groq */
function fakeGroq(texts = ['first sentence here', 'second sentence here', 'third sentence here']) {
  const queue = [...texts];
  return {
    calls: 0,
    async transcribe() {
      this.calls += 1;
      const t = queue.shift();
      if (t instanceof Error) throw t;
      return t ?? 'more words here';
    },
    async translate(lines) {
      return lines.map((l) => `번역: ${l}`);
    },
  };
}

function setup({ hasKey = true, texts, failOpen, language = 'en', restarter } = {}) {
  const groq = fakeGroq(texts);
  const transcriber = new Transcriber({ groq, language: () => language, clock: () => new Date(2026, 9, 17, 9, 30, 0) });
  const source = fakeSource({ failOpen });
  let t = 1_000_000;
  const session = new LiveSession({
    transcriber,
    openSource: source,
    hasKey: () => hasKey,
    now: () => t,
    restarter: restarter ?? new CaptureRestarter({ sleep: async () => {} }),
  });
  const notices = [];
  session.on('notice', (m) => notices.push(m));
  return { session, transcriber, source, groq, notices, advance: (ms) => { t += ms; } };
}

test('키가 없으면 녹음을 시작하지 않고 맥과 같은 안내를 띄운다', () => {
  const { session, source } = setup({ hasKey: false });
  assert.equal(session.start({ pid: 1 }), false);
  assert.equal(session.state.listening, false);
  assert.equal(session.state.error, MESSAGES.noKey);
  assert.equal(source.opened.length, 0);
});

test('시작하면 출처를 열고, 말소리 → 침묵이면 한 줄이 생기고 번역이 붙는다', async () => {
  const { session, transcriber, source } = setup();
  const changes = [];
  session.on('change', (p) => changes.push(p));
  assert.equal(session.start({ pid: 42 }), true);
  assert.deepEqual(source.last().args, { pid: 42 });
  assert.equal(session.state.listening, true);
  assert.equal(session.state.startedAt, 1_000_000);

  source.last().cb.onData(silence(0.5));
  source.last().cb.onData(speech(1.5));
  source.last().cb.onData(silence(2.2)); // LONG_SILENCE(2초) 지나면 끊긴다
  await transcriber.idle();

  const e = session.state.entries;
  assert.equal(e.length, 1);
  assert.equal(e[0].kind, 'text');
  assert.equal(e[0].original, 'first sentence here');
  assert.equal(e[0].translation, '번역: first sentence here');
  assert.ok(changes.some((p) => p.entries));
});

test('멈추면 모으던 마지막 발화도 보낸다 (flush)', async () => {
  const { session, transcriber, source, groq } = setup();
  session.start({ pid: 1 });
  source.last().cb.onData(silence(0.3));
  source.last().cb.onData(speech(1.0)); // 아직 끊기지 않음
  assert.equal(groq.calls, 0);
  session.stop();
  await transcriber.idle();
  assert.equal(source.last().stopped, true);
  assert.equal(session.state.listening, false);
  assert.equal(groq.calls, 1);
  assert.equal(session.state.entries.length, 1);
});

test('일시정지하면 발화를 마무리하고 시간을 쌓고, 이어 하면 끊김 줄을 남긴다', async () => {
  const { session, transcriber, source, advance } = setup();
  session.start({ pid: 1 });
  advance(5000);
  session.pause();
  assert.equal(session.state.paused, true);
  assert.equal(session.state.startedAt, null);
  assert.equal(session.state.recordedBefore, 5);
  assert.equal(source.last().stopped, true);

  session.resume();
  assert.equal(source.opened.length, 2);
  assert.equal(session.state.paused, false);
  await transcriber.idle();
  const gap = session.state.entries.at(-1);
  assert.equal(gap.kind, 'gap');
  assert.match(gap.original, /^── .*일시정지 후 이어서 녹음$/);
});

test('녹음 중 출처를 바꾸면 새로 열고 바꾼 자리를 남긴다', () => {
  const { session, source } = setup();
  session.start({ pid: 1 });
  session.switchSource({ mic: 'm1' }, '기본 마이크');
  assert.equal(source.opened[0].stopped, true);
  assert.deepEqual(source.last().args, { mic: 'm1' });
  assert.match(session.state.entries.at(-1).original, /소리 출처 → 기본 마이크$/);
});

test('녹음 중이 아니면 출처·언어를 바꿔도 줄을 남기지 않는다', () => {
  const { session, source } = setup();
  session.switchSource({ mic: 'm1' }, '기본 마이크');
  session.languageChanged('English');
  assert.equal(source.opened.length, 0);
  assert.equal(session.state.entries.length, 0);
});

test('인식 언어를 바꾸면 그 자리를 남긴다', () => {
  const { session } = setup();
  session.start({ pid: 1 });
  session.languageChanged('日本語');
  assert.match(session.state.entries.at(-1).original, /인식 언어 → 日本語$/);
});

test('인식 실패는 오류 띠에 맥 문구 그대로, 다음 성공에 지워진다', async () => {
  const { session, transcriber, source } = setup({ texts: [new Error('Groq 무료 한도에 걸렸습니다. 30초 뒤 다시 눌러 주세요.'), 'next words here'] });
  session.start({ pid: 1 });
  const feed = () => {
    source.last().cb.onData(silence(0.3));
    source.last().cb.onData(speech(1.0));
    source.last().cb.onData(silence(2.2));
  };
  feed();
  await transcriber.idle();
  assert.equal(session.state.error, 'Groq 무료 한도에 걸렸습니다. 30초 뒤 다시 눌러 주세요.');
  assert.match(session.state.entries.at(-1).original, /인식 실패: Groq 무료 한도/);
  feed();
  await transcriber.idle();
  assert.equal(session.state.error, null);
});

test('소리가 끊기면 다시 붙이고 끊김·다시 연결 줄을 남긴다', async () => {
  const { session, source } = setup();
  session.start({ pid: 1 });
  await source.last().cb.onEnd('helper 종료 (code 1)');
  assert.equal(source.opened.length, 2);
  const lines = session.state.entries.map((e) => e.original);
  assert.match(lines.at(-2), /소리가 끊겼습니다 \(helper 종료 \(code 1\)\)$/);
  assert.match(lines.at(-1), /다시 연결됨$/);
  assert.equal(session.state.listening, true);
});

test('다시 붙이기를 다 실패하면 맥 문구로 알리고 멈춘다', async () => {
  const { session, source } = setup({ restarter: new CaptureRestarter({ maxRestarts: 2, sleep: async () => {} }) });
  session.start({ pid: 1 });
  const first = source.last();
  // 다음 두 번 열기는 실패
  const orig = session.openSource;
  session.openSource = () => { throw new Error('열기 실패'); };
  await first.cb.onEnd('끊김');
  session.openSource = orig;
  assert.equal(session.state.listening, false);
  assert.equal(session.state.error, MESSAGES.reconnectFailed);
});

test('멈춘 뒤 늦게 온 끊김 알림은 무시한다', async () => {
  const { session, source } = setup();
  session.start({ pid: 1 });
  const h = source.last();
  session.stop();
  await h.cb.onEnd('늦은 종료');
  assert.equal(source.opened.length, 1);
  assert.equal(session.state.entries.length, 0);
});

test('출처를 열지 못하면 오류를 띄우고 녹음 중이 아니다', () => {
  const { session } = setup({ failOpen: 1 });
  assert.equal(session.start({ pid: 1 }), false);
  assert.equal(session.state.listening, false);
  assert.equal(session.state.error, '열기 실패');
});

test('새로 시작하면 지난 줄과 오류를 비운다', async () => {
  const { session, transcriber, source } = setup();
  session.start({ pid: 1 });
  source.last().cb.onData(silence(0.3)); // 처음 블록이 큰 소리면 그게 잡음 바닥이 된다
  source.last().cb.onData(speech(1.0));
  session.stop();
  await transcriber.idle();
  assert.equal(session.state.entries.length, 1);
  session.start({ pid: 1 });
  assert.equal(session.state.entries.length, 0);
});

test('Transcriber 알림(모델 전환 등)은 notice 로 넘긴다', () => {
  const { session, transcriber, notices } = setup();
  transcriber.emit('notice', 'whisper-large-v3 한도 초과 → whisper-large-v3-turbo로 전환');
  assert.deepEqual(notices, ['whisper-large-v3 한도 초과 → whisper-large-v3-turbo로 전환']);
  void session;
});

test('화면용 줄: 녹음 위치(time)는 빼고 id·종류·원문·번역만', () => {
  const v = viewEntries([
    { id: 'a', kind: 'text', original: 'hi', translation: '안녕', time: [1, 2] },
    { id: 'b', kind: 'gap', original: '── 09:00:00 다시 연결됨', translation: null, time: null },
  ]);
  assert.deepEqual(v, [
    { id: 'a', kind: 'text', original: 'hi', translation: '안녕' },
    { id: 'b', kind: 'gap', original: '── 09:00:00 다시 연결됨', translation: null },
  ]);
});

test('아래 줄 게이지: 받아쓰기는 whisper 두 모델, 번역은 채팅 두 모델을 합친 남은 비율', () => {
  const f = usageFooter({
    'whisper-large-v3': { remaining: 1500, limit: 2000 },
    'whisper-large-v3-turbo': { remaining: 2000, limit: 2000 },
    'openai/gpt-oss-120b': { remaining: 100, limit: 1000 },
  });
  assert.equal(f.audio, 3500 / 4000);
  assert.equal(f.translate, 0.1);
  assert.equal(f.explain, 1); // 호출 수를 아직 모르면 하루 양(처음엔 가득)만으로
  const empty = usageFooter({});
  assert.deepEqual([empty.audio, empty.translate, empty.explain, empty.uses], [1, 1, 1, '설명 54 · 질문 57']);
});

test('게이지 모델 이름은 groq.js 와 같다', () => {
  const { GAUGES } = require('../lib/usage');
  const { GroqClient } = require('../lib/groq');
  assert.deepEqual(GAUGES.map((g) => g.models), [GroqClient.WHISPER_MODELS, GroqClient.CHAT_MODELS, [GroqClient.VISION_MODEL]]);
});

test('시작·끝낼 때 알린다 (기록 파일을 만들고 소리 파일을 마무리하는 자리). 키가 없어 못 시작하면 알리지 않는다', () => {
  const { session } = setup();
  const events = [];
  session.on('start', () => events.push('start'));
  session.on('stop', () => events.push('stop'));
  session.start({ pid: 1 });
  session.pause();
  session.resume();
  session.stop();
  session.stop();
  assert.deepEqual(events, ['start', 'stop']);
  const noKey = setup({ hasKey: false }).session;
  noKey.on('start', () => assert.fail('시작하지 않았다'));
  noKey.start({ pid: 1 });
});

test('출처를 못 열어 시작이 실패해도 start 뒤에 stop 이 온다 (만든 파일을 닫을 수 있게)', () => {
  const { session } = setup({ failOpen: 1 });
  const events = [];
  session.on('start', () => events.push('start'));
  session.on('stop', () => events.push('stop'));
  session.start({ pid: 1 });
  assert.deepEqual(events, ['start', 'stop']);
});

test('[mac switchSource] 녹음 중에 "내 목소리도 함께"를 바꾸면 출처를 다시 붙이고 "+ 마이크" 를 남긴다', () => {
  const opened = [];
  const openSource = (args) => { opened.push(args); return { stop() {} }; };
  const transcriber = new Transcriber({ groq: { transcribe: async () => ({}), translate: async () => [] }, language: () => 'ko', autoTranslate: () => false });
  const s = new LiveSession({ transcriber, openSource, hasKey: () => true, clock: () => new Date(2026, 9, 17, 9, 5, 0) });
  s.start({ pid: 42 });
  s.switchSource({ pid: 42, mixMic: 'DEF' }, 'chrome', true);
  s.switchSource({ pid: 42 }, 'chrome', false);
  assert.deepEqual(opened, [{ pid: 42 }, { pid: 42, mixMic: 'DEF' }, { pid: 42 }]);
  const gaps = transcriber.entries.filter((e) => e.kind === 'gap').map((e) => e.original);
  assert.deepEqual(gaps, ['── 09:05:00 소리 출처 → chrome + 마이크', '── 09:05:00 소리 출처 → chrome']);
  s.stop();
});
