'use strict';
require('./guard'); // 오류가 나도 화면에 창을 띄우지 않고 종료 코드 1
// 1.3.2 앱 기록: 실제로 녹음하고 일시정지한 채 종료를 눌러 본다 (맥에서 앱이 굳었던 흐름). 창은 띄우지 않는다.
// 임시 APPDATA·LOCALAPPDATA, 가짜 Groq, 만든 소리 파일 (EZRITE_TESTFILE: 켜자마자 녹음 시작).
//   npx electron scripts/check-applog.js   → 결과 JSON 한 줄, 하나라도 틀리면 종료 코드 1
// test/applog-ui.test.js 가 부른다. 확인하는 것:
//   [녹음] 시작(출처·마이크 섞기·언어·자동 번역·조용하면 쉬기) · 누른 곳(팝업) · 일시정지 · 캡처 멈춤 걸린 시간
//   [앱] 종료 시작(일시정지 중) → 녹음 정리 → 끝냄(녹음 초·줄 수·보내는 중) → [소리 파일] 닫음 → 소리 합치기 기다림 → 끝 → 기록 닫음
//   받아 적은 글은 한 글자도 남지 않는다 (가짜 Groq 가 준 문장이 기록 파일에 없다)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeWav, SAMPLE_RATE } = require('../lib/wav');
const { SAMPLE_LINES } = require('../lib/fakegroq');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-applog-'));
const roaming = path.join(tmp, 'Roaming');
const local = path.join(tmp, 'Local');
fs.mkdirSync(path.join(roaming, 'Ezrite'), { recursive: true });
fs.writeFileSync(path.join(roaming, 'Ezrite', 'settings.json'), JSON.stringify({ welcomed: true }));

// 말소리처럼 켜졌다 꺼지는 소리 (1.2초 소리 · 0.7초 쉼 × 6)
const wav = path.join(tmp, 'speech.wav');
{
  const parts = [];
  for (let i = 0; i < 6; i++) {
    const on = new Float32Array(Math.round(1.2 * SAMPLE_RATE));
    for (let k = 0; k < on.length; k++) on[k] = 0.25 * Math.sin((2 * Math.PI * (180 + 40 * i) * k) / SAMPLE_RATE) * (1 + 0.3 * Math.sin(k / 400));
    parts.push(on, new Float32Array(Math.round(0.7 * SAMPLE_RATE)));
  }
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  fs.writeFileSync(wav, encodeWav(all));
}

Object.assign(process.env, {
  APPDATA: roaming, LOCALAPPDATA: local, EZRITE_FAKE_GROQ: '1', EZRITE_TESTFILE: wav, EZRITE_SPEED: '2',
  EZRITE_UPDATE_JSON: '{"tag_name":"v0.0.1","assets":[]}',
});
delete process.env.NODE_TEST_CONTEXT; // node --test 아래에서도 이 시험은 기록을 켠다
delete process.env.EZRITE_NO_LOG;

const { app, BrowserWindow } = require('electron');
for (const m of ['show', 'showInactive', 'focus', 'moveTop']) BrowserWindow.prototype[m] = function noop() {};
app.setPath('userData', path.join(tmp, 'userData'));
require('../main.js');

const LOGS = path.join(local, 'Ezrite', 'logs');
const LINE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} (INFO|WARN|ERR) \[[^\]]+\] .+ \((main|bg)\)$/;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(150);
  }
  return null;
}
const lines = () => (fs.existsSync(LOGS) ? fs.readdirSync(LOGS) : []).filter((n) => n.endsWith('.log'))
  .flatMap((n) => fs.readFileSync(path.join(LOGS, n), 'utf8').split(/\r?\n/).filter(Boolean));

const out = { ok: false };
let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  try {
    const all = lines();
    const body = all.map((l) => l.slice(24));
    const idx = (re) => body.findIndex((l) => re.test(l));
    out.lines = body.filter((l) => !/\[(시스템|업데이트)\]/.test(l));
    const order = [/^INFO \[앱\] 종료 시작 — 일시정지 중/, /^INFO \[녹음\] 끝냄 — 녹음 \d+\.\d초, 줄 \d+개, 보내는 중 \d+개/, /^INFO \[소리 파일\] 닫음 — 소리 \d+\.\d초/,
      /^INFO \[앱\] 녹음 정리 \d+ms/, /^INFO \[앱\] 소리 합치기 기다림 — 1개/, /^INFO \[소리 파일\] 조각 합침\(m4a\)/, /^INFO \[앱\] 소리 합치기 끝/, /^INFO \[앱\] 기록 닫음/]
      .map(idx);
    out.order = order;
    // 가짜 Groq 가 받아 적은 문장: 기록에 없어야 한다
    const said = SAMPLE_LINES.map(([t]) => t).filter((t) => t.length > 6);
    out.checks = {
      format: all.length > 0 && all.every((l) => LINE.test(l)),
      started: idx(/^INFO \[녹음\] 시작 — 출처 시험 파일, 마이크 섞기 off, 언어 한국어, 자동 번역 on, 조용하면 쉬기 on/) >= 0,
      pressed: idx(/^INFO \[녹음\] 일시정지 누름 \(팝업\)/) >= 0 && idx(/^INFO \[앱\] 종료 누름 \(팝업\)/) >= 0,
      paused: idx(/^INFO \[녹음\] 일시정지 — 녹음 \d+\.\d초에서/) >= 0 && idx(/^INFO \[녹음\] 캡처 멈춤 \d+ms/) >= 0,
      quitOrder: order.every((i) => i >= 0) && order.every((i, k) => k === 0 || i > order[k - 1]),
      noTranscript: out.entries > 0 && !said.some((t) => all.some((l) => l.includes(t))),
    };
    out.ok = Object.values(out.checks).every(Boolean);
  } catch (e) {
    out.error = e.stack;
  }
  console.log(JSON.stringify(out));
}
app.on('will-quit', () => finish());
app.on('quit', () => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 다음에 */ }
  app.exit(out.ok ? 0 : 1);
});

app.whenReady().then(async () => {
  try {
    const popup = await until(() => BrowserWindow.getAllWindows().map((w) => w.webContents).find((wc) => wc.getURL().includes('popup.html') && !wc.isLoading()));
    const state = () => popup.executeJavaScript('new Promise((r) => window.ezrite.onState(r))');
    // 받아 적은 줄이 생길 때까지 녹음 (켜자마자 시작된다)
    out.entries = await until(async () => {
      const s = await state();
      return s.entries.filter((e) => e.kind === 'text').length;
    });
    await popup.executeJavaScript('window.ezrite.togglePause()');
    await until(async () => (await state()).paused);
    await wait(500);
    // 일시정지한 채 종료 (맥에서 앱이 굳었던 흐름)
    popup.executeJavaScript('window.ezrite.quit()').catch(() => {});
    await wait(40_000); // 종료가 안 되면
    out.error = '종료되지 않음';
    finish();
    app.exit(1);
  } catch (e) {
    out.error = e.stack;
    finish();
    app.exit(1);
  }
});
