'use strict';
// 화면 번역 흐름 (lib/screentranslate.js): 읽기 → 아는 번역은 바로 덮기 → 새 문단만 옮기기, 바뀌면 걷고 그대로이면 다시 읽기,
// 창 이동은 덮개만 따라가기, 앞 창에 걸친 문단은 안 덮기, 마우스 올린 문단은 원문, 창이 닫히면 멈춤. 시험 그림은 test/fixtures/screentx
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ScreenTranslate, sigDiff } = require('../lib/screentranslate');
const { decodePNG } = require('../lib/png');

const F = path.join(__dirname, 'fixtures', 'screentx');
const OCR = JSON.parse(fs.readFileSync(path.join(F, 'ocr.json'), 'utf8'));
const BMP = { slide: decodePNG(fs.readFileSync(path.join(F, 'slide.png'))), dark: decodePNG(fs.readFileSync(path.join(F, 'dark.png'))) };
const sig = (v) => new Array(108).fill(v);
const tick = () => new Promise((r) => setImmediate(r));
async function settle() {
  for (let i = 0; i < 20; i++) await tick();
}

function rig({ page = 'slide', fail = false, reply = null } = {}) {
  const calls = { grab: 0, translate: [], shown: [], hidden: 0, moved: [], revealed: [], timers: [] };
  let onLine = null;
  let killed = false;
  let cursor = null;
  const st = {
    page,
    rect: { x: 100, y: 50, w: 1800, h: 1200 },
  };
  const tx = new ScreenTranslate({
    grab: async () => {
      calls.grab += 1;
      return { rect: { ...st.rect }, bitmap: BMP[st.page], file: st.page };
    },
    ocr: async (file) => OCR[file],
    translate: async (texts) => {
      calls.translate.push(texts);
      if (fail) throw new Error('Groq 오류 503');
      if (reply) return reply(texts, calls.translate.length);
      return texts.map((t) => `번역:${t.length}`);
    },
    watch: (_hwnd, fn) => {
      onLine = fn;
      return { kill: () => { killed = true; } };
    },
    overlay: {
      show: (rect, items) => calls.shown.push({ rect, keys: items.map((i) => i.block.key) }),
      hide: () => { calls.hidden += 1; },
      move: (rect) => calls.moved.push(rect),
      reveal: (key) => calls.revealed.push(key),
    },
    cursor: () => cursor,
    scaleOf: () => 2,
    ownPid: 7,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn, ms) => { calls.timers.push(ms); calls.retry = fn; return 1; },
    clearTimeout: () => {},
  });
  const line = (patch = {}) => onLine({ ...st.rect, sig: sig(10), front: [], ...patch });
  return { tx, calls, st, line, killed: () => killed, setCursor: (p) => { cursor = p; } };
}

test('시작: 읽고 새 문단을 한 번에(12개씩) 옮겨 덮는다. 코드·한국어는 안 보낸다', async () => {
  const r = rig();
  r.tx.start({ hwnd: '1', title: '슬라이드' });
  await settle();
  assert.equal(r.calls.grab, 1);
  assert.equal(r.calls.translate.length, 1);
  assert.equal(r.calls.translate[0].length, 5);
  const last = r.calls.shown.at(-1);
  assert.equal(last.keys.length, 5);
  assert.deepEqual(last.rect, { x: 100, y: 50, w: 1800, h: 1200 });
});

test('바뀜: 칸 평균 차가 2.5 를 넘으면 덮개를 걷고, 한 번 그대로이면 다시 읽는다. 아는 문단은 다시 옮기지 않는다', async () => {
  const r = rig();
  r.tx.start({ hwnd: '1', title: '' });
  await settle();
  r.line(); // 첫 줄 (기준)
  const hidden = r.calls.hidden;
  r.line({ sig: sig(14) }); // 바뀜
  assert.equal(r.calls.hidden, hidden + 1);
  assert.equal(r.calls.grab, 1, '바뀌는 중에는 읽지 않는다');
  r.line({ sig: sig(14) }); // 그대로 → 다시 읽기
  await settle();
  assert.equal(r.calls.grab, 2);
  assert.equal(r.calls.translate.length, 1, '같은 그림이면 기억으로 덮고 다시 옮기지 않는다');
  assert.equal(r.calls.shown.at(-1).keys.length, 5);
  // 다른 화면(스크롤해 새 글)이 나오면 새 문단만
  r.st.page = 'dark';
  r.line({ sig: sig(40) });
  r.line({ sig: sig(40) });
  await settle();
  assert.equal(r.calls.translate.length, 2);
  assert.equal(r.calls.translate[1].length, 10);
  assert.ok(sigDiff(sig(10), sig(12)) < 2.5 && sigDiff(sig(10), sig(13)) > 2.5);
});

test('창만 옮기면 다시 읽지 않고 덮개만 따라간다', async () => {
  const r = rig();
  r.tx.start({ hwnd: '1', title: '' });
  await settle();
  r.line();
  r.st.rect = { ...r.st.rect, x: 400, y: 80 };
  r.line();
  await settle();
  assert.equal(r.calls.grab, 1);
  assert.deepEqual(r.calls.moved.at(-1), { x: 400, y: 80, w: 1800, h: 1200 });
});

test('앞에 있는 창에 걸친 문단은 덮지 않는다 (이 앱 창은 빼고 센다)', async () => {
  const r = rig();
  r.tx.start({ hwnd: '1', title: '' });
  await settle();
  r.line();
  // 제목 자리(그림 y≈116~190, 창 위치 +50)를 다른 앱 창이 가림
  r.line({ front: [[0, 150, 3000, 260, 99]] });
  assert.equal(r.calls.shown.at(-1).keys.length, 4);
  // 이 앱의 창(pid 7)은 가린 것으로 치지 않는다
  r.line({ front: [[0, 150, 3000, 260, 7]] });
  assert.equal(r.calls.shown.at(-1).keys.length, 5);
});

test('마우스를 올린 문단만 원문 (바뀔 때만 알린다)', async () => {
  const r = rig();
  r.tx.start({ hwnd: '1', title: '' });
  await settle();
  r.setCursor({ x: 100 + 300, y: 50 + 150 }); // 제목 위
  r.tx.hover();
  r.tx.hover();
  r.setCursor({ x: 5000, y: 5000 });
  r.tx.hover();
  assert.equal(r.calls.revealed.length, 2);
  assert.match(r.calls.revealed[0], /^Gradient Descent/);
  assert.equal(r.calls.revealed[1], null);
});

test('창이 닫히면 멈추고 이유를 알린다. 최소화하면 걷었다가 다시 열리면 새로 읽는다', async () => {
  const r = rig();
  const changes = [];
  r.tx.on('change', (s) => changes.push(s));
  r.tx.start({ hwnd: '1', title: '' });
  await settle();
  r.line();
  r.line({ min: true });
  r.line();
  await settle();
  assert.equal(r.calls.grab, 2);
  r.line({ gone: true });
  assert.equal(r.tx.active, false);
  assert.equal(r.killed(), true);
  assert.equal(changes.at(-1).reason, '창이 닫혔습니다');
});

test('옮기기가 실패해도 멈추지 않고 알린다 (덮개 없음)', async () => {
  const r = rig({ fail: true });
  const notices = [];
  r.tx.on('notice', (m) => notices.push(m));
  r.tx.start({ hwnd: '1', title: '' });
  await settle();
  assert.equal(r.tx.active, true);
  assert.deepEqual(notices, ['화면 번역을 하지 못했습니다']);
  assert.ok(r.calls.shown.every((s) => s.keys.length === 0));
});

test('안전장치: 4개 이상 묶음에서 절반 넘게 원문 그대로면 한 번 더 묻고, 또 그러면 원문 그대로인 것은 기억에 넣지 않는다', async () => {
  // 처음 두 번은 다 영어 그대로 (20b 가 그랬다)
  const r = rig({ reply: (texts) => texts.map((t) => t) });
  r.tx.start({ hwnd: '1', title: '' });
  await settle();
  assert.equal(r.calls.translate.length, 2, '한 번 더 물었다');
  assert.equal(r.tx.memory.size, 0, '원문 그대로는 기억하지 않는다 (다음에 다시 옮긴다)');
  assert.deepEqual(r.calls.timers, [3000], '다 실패한 묶음 → 3초 쉬고 다시');
  // 두 번째에 제대로 오면 그것을 쓴다
  const r2 = rig({ reply: (texts, n) => texts.map((t) => (n === 1 ? t : `번역:${t.length}`)) });
  r2.tx.start({ hwnd: '1', title: '' });
  await settle();
  assert.equal(r2.calls.translate.length, 2);
  assert.equal(r2.tx.memory.size, 5);
});

test('연달아 실패하면 3·6·12·24·30초로 쉬는 시간을 늘리고, 성공하면 처음부터', async () => {
  const r = rig({ fail: true });
  r.tx.start({ hwnd: '1', title: '' });
  await settle();
  for (let i = 0; i < 5; i++) {
    r.tx.retryUntil = 0; // 쉬는 시간이 지났다
    r.calls.retry();
    await settle();
  }
  assert.deepEqual(r.calls.timers, [3000, 6000, 12000, 24000, 30000, 30000]);
  // 쉬는 동안 다시 읽어도(스크롤 등) 옮기지 않는다
  const n = r.calls.translate.length;
  r.tx.retryUntil = Date.now() + 10_000;
  await r.tx.read();
  assert.equal(r.calls.translate.length, n);
});
