'use strict';
// 시연 녹화용 받아쓰기 대본 (EZRITE_DEMO_SCRIPT): 녹음을 누르면 정해 둔 줄이 차례로 뜬다
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseDemoScript, loadDemoScript, DemoScript, demoSource, fakeLevel, PENDING_LEAD,
} = require('../lib/demoscript');
const { parseDevEnv, sourceArgs } = require('../lib/ui');
const { Transcriber } = require('../lib/transcriber');

const GOOD = {
  firstDelay: 2, interval: 4, translationDelay: 1,
  lines: [{ text: 'First line.', ko: '첫 줄.' }, { text: 'Second line.', ko: '둘째 줄.' }, { text: 'Third line.', ko: '셋째 줄.' }],
};

// ── 가짜 시계 ──
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn, every: ms }); return id; },
    clearInterval: (id) => { timers.delete(id); },
    /** ms 만큼 흘려 보내며 그 사이 타이머를 차례로 부른다 */
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, t] = due;
        now = t.at;
        if (t.every) t.at += t.every; else timers.delete(id);
        t.fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

function recordingSink() {
  const log = [];
  let n = 0;
  return {
    log,
    pending: (on) => log.push(['pending', on]),
    line: (text, time) => { log.push(['line', text, time]); return `id${++n}`; },
    translate: (id, ko) => log.push(['ko', id, ko]),
  };
}

// ── 대본 읽기 ──

test('대본: 올바른 JSON 을 읽는다 (주석용 _note 같은 다른 키는 무시)', () => {
  const s = parseDemoScript(JSON.stringify({ _note: '메모', ...GOOD }));
  assert.deepEqual(s, GOOD);
});

test('대본: 틀린 모양은 무엇이 틀렸는지 알려 준다', () => {
  const bad = [
    ['{', /JSON/],
    ['[]', /객체/],
    [JSON.stringify({ ...GOOD, lines: [] }), /lines/],
    [JSON.stringify({ ...GOOD, lines: [{ text: '' , ko: '가' }] }), /lines\[0\]\.text/],
    [JSON.stringify({ ...GOOD, lines: [{ text: 'a', ko: 3 }] }), /lines\[0\]\.ko/],
    [JSON.stringify({ ...GOOD, interval: 0 }), /interval/],
    [JSON.stringify({ ...GOOD, firstDelay: -1 }), /firstDelay/],
    [JSON.stringify({ ...GOOD, translationDelay: 'x' }), /translationDelay/],
  ];
  for (const [text, re] of bad) assert.throws(() => parseDemoScript(text), re, text);
});

test('대본: ko 는 없어도 된다 (번역 없이 원문만)', () => {
  const s = parseDemoScript(JSON.stringify({ ...GOOD, lines: [{ text: 'Only English.' }] }));
  assert.equal(s.lines[0].ko, null);
});

test('대본 파일: 없거나 깨졌으면 EZRITE_DEMO_SCRIPT 이름과 이유를 붙인 오류', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-demo-'));
  assert.throws(() => loadDemoScript(path.join(dir, 'none.json')), /EZRITE_DEMO_SCRIPT.*읽지 못했습니다/);
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{ "lines": ');
  assert.throws(() => loadDemoScript(broken), /EZRITE_DEMO_SCRIPT.*JSON/);
  const ok = path.join(dir, 'ok.json');
  fs.writeFileSync(ok, JSON.stringify(GOOD));
  assert.deepEqual(loadDemoScript(ok), GOOD);
});

// promo/ 는 공개 소스(windows/)에 없다. 있을 때만 확인한다
const PROMO_SCRIPT = path.join(__dirname, '..', '..', 'promo', 'assets', 'demo-script.json');
test('대본 파일: promo/assets/demo-script.json 을 읽을 수 있다', { skip: !fs.existsSync(PROMO_SCRIPT) }, () => {
  const s = loadDemoScript(PROMO_SCRIPT);
  assert.ok(s.lines.length >= 5);
  assert.ok(s.lines.every((l) => l.text && l.ko));
});

// ── 시각 ──

test('시각: firstDelay + i×interval 에 줄, 그 translationDelay 뒤에 번역. 줄 앞에는 "받아 적는 중"', () => {
  const c = fakeClock();
  const sink = recordingSink();
  const d = new DemoScript(GOOD, sink, c);
  d.reset();
  d.resume();
  c.advance(2000 - PENDING_LEAD * 1000 - 1);
  assert.deepEqual(sink.log, []);
  c.advance(1);
  assert.deepEqual(sink.log, [['pending', true]]);
  c.advance(PENDING_LEAD * 1000);
  assert.deepEqual(sink.log.slice(1, 3), [['pending', false], ['line', 'First line.', sink.log[2][2]]]);
  assert.ok(sink.log[2][2].end <= 2, '줄의 녹음 위치(끝)는 그 줄이 뜬 시각 이전');
  c.advance(999);
  assert.equal(sink.log.length, 3);
  c.advance(1);
  assert.deepEqual(sink.log[3], ['ko', 'id1', '첫 줄.']);
  c.advance(4000);
  assert.deepEqual(sink.log.filter((x) => x[0] === 'line').map((x) => x[1]), ['First line.', 'Second line.']);
  c.advance(60_000);
  assert.deepEqual(sink.log.filter((x) => x[0] === 'ko').map((x) => x[2]), ['첫 줄.', '둘째 줄.', '셋째 줄.']);
  assert.equal(c.pending(), 0, '다 보여 주면 타이머가 남지 않는다');
});

test('시각: 일시정지하면 줄 타이머도 멈추고, 이어 하면 남은 만큼만 기다린다', () => {
  const c = fakeClock();
  const sink = recordingSink();
  const d = new DemoScript(GOOD, sink, c);
  d.reset();
  d.resume();
  c.advance(1500);
  d.pause();
  assert.equal(c.pending(), 0);
  c.advance(30_000);
  assert.equal(sink.log.filter((x) => x[0] === 'line').length, 0, '멈춘 동안은 아무것도 뜨지 않는다');
  d.resume();
  c.advance(499);
  assert.equal(sink.log.filter((x) => x[0] === 'line').length, 0);
  c.advance(1);
  assert.deepEqual(sink.log.filter((x) => x[0] === 'line').map((x) => x[1]), ['First line.']);
});

test('시각: 받아 적는 중에 일시정지하면 "받아 적는 중" 을 끈다', () => {
  const c = fakeClock();
  const sink = recordingSink();
  const d = new DemoScript(GOOD, sink, c);
  d.reset();
  d.resume();
  c.advance(2000 - PENDING_LEAD * 1000 + 100);
  d.pause();
  assert.deepEqual(sink.log.at(-1), ['pending', false]);
});

test('시각: 새 녹음(reset)은 첫 줄부터 다시', () => {
  const c = fakeClock();
  const sink = recordingSink();
  const d = new DemoScript(GOOD, sink, c);
  d.reset();
  d.resume();
  c.advance(7000);
  d.pause();
  d.reset();
  d.resume();
  c.advance(2000);
  assert.deepEqual(sink.log.filter((x) => x[0] === 'line').map((x) => x[1]), ['First line.', 'Second line.', 'First line.']);
});

test('출처: 열면 대본이 흐르고, 무음 조각을 100ms 마다 보낸다. 닫으면 대본도 멈춘다', () => {
  const c = fakeClock();
  const sink = recordingSink();
  const d = new DemoScript(GOOD, sink, c);
  d.reset();
  const open = demoSource(d, c);
  const chunks = [];
  const h = open({ demo: true }, { onData: (b) => chunks.push(b), onEnd: () => {} });
  c.advance(1000);
  assert.equal(chunks.length, 10);
  assert.ok(chunks.every((b) => b.length === 3200 && b.every((v) => v === 0)), '소리는 무음 (녹음 파일은 무음 m4a)');
  h.stop();
  c.advance(10_000);
  assert.equal(chunks.length, 10);
  assert.equal(sink.log.length, 0, '닫은 동안 줄이 뜨지 않는다');
});

test('소리 막대: 말하는 것처럼 오르내리고 0..1 안에 있다', () => {
  const v = Array.from({ length: 200 }, (_, i) => fakeLevel(i * 0.05));
  assert.ok(v.every((x) => x >= 0 && x <= 1));
  assert.ok(Math.max(...v) - Math.min(...v) > 0.3, '움직인다');
  assert.ok(v.reduce((a, b) => a + b) / v.length > 0.3, '대체로 말소리 높이');
});

// ── Transcriber 에 줄 넣기 ──

test('Transcriber: 대본 줄을 실제 받아쓰기와 같은 모양으로 넣고, 번역을 붙인다 (Groq 부르지 않음)', () => {
  const groq = { transcribe: () => { throw new Error('부르면 안 됨'); }, translate: () => { throw new Error('부르면 안 됨'); } };
  const t = new Transcriber({ groq, language: () => 'en' });
  const seen = [];
  t.on('entry', (e) => seen.push(['entry', e.original]));
  t.on('translated', (e) => seen.push(['translated', e.translation]));
  const e = t.addScripted('Hello.', { start: 1, end: 3 });
  assert.equal(e.kind, 'text');
  assert.deepEqual(e.time, [1, 3]);
  t.setTranslation(e.id, '안녕.');
  assert.deepEqual(seen, [['entry', 'Hello.'], ['translated', '안녕.']]);
  assert.equal(t.entries[0].translation, '안녕.');
  t.startSession();
  t.setTranslation(e.id, '늦은 번역');
  assert.equal(seen.length, 2, '새 세션이면 지난 줄 번역은 버린다');
});

// ── 켜지 않으면 아무 일도 하지 않는다 ──

test('EZRITE_DEMO_SCRIPT 가 없으면 꺼져 있고, 출처 인자는 평소와 같다', () => {
  assert.equal(parseDevEnv({}).demoScript, null);
  assert.equal(parseDevEnv({ EZRITE_DEMO_SCRIPT: '  ' }).demoScript, null);
  assert.equal(parseDevEnv({ EZRITE_DEMO_SCRIPT: 'C:\\x\\demo.json' }).demoScript, 'C:\\x\\demo.json');
  const sources = [{ id: 'app:chrome.exe', kind: 'app', pid: 42 }, { id: 'mic:1', kind: 'mic' }];
  assert.deepEqual(sourceArgs({ demoScript: null, testFile: null }, 'app:chrome.exe', sources), { pid: 42 });
  assert.equal(sourceArgs({ demoScript: null, testFile: null }, 'app:none.exe', sources), null);
  assert.deepEqual(sourceArgs({ demoScript: null, testFile: 'a.wav' }, 'app:none.exe', sources), { testfile: true });
});

test('EZRITE_DEMO_SCRIPT 가 있으면 어느 출처든(소리가 안 나는 프로그램이어도) 대본 출처로 연다', () => {
  const sources = [{ id: 'app:chrome.exe', kind: 'app', pid: 42 }];
  assert.deepEqual(sourceArgs({ demoScript: 'd.json', testFile: null }, 'app:chrome.exe', sources), { demo: true });
  assert.deepEqual(sourceArgs({ demoScript: 'd.json', testFile: null }, 'app:none.exe', []), { demo: true });
});
