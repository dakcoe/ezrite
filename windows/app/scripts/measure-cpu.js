'use strict';
require('./guard'); // 오류가 나도 화면에 창을 띄우지 않고 종료 코드 1
// 녹음 중 CPU 재기 (맥 1.2.2 와 같은 방식). 말소리 wav 를 실제 빠르기로 흘려 받아쓰기·번역 화면까지 돌리고,
// 창 닫음 / 팝업 열림 / 작은 창 / 전체 창 열림 마다 60초 동안 Electron 모든 프로세스(브라우저·렌더러·GPU·유틸리티)의
// CPU 를 잰다. 숨긴 창은 Chromium 이 그리기를 멈추므로 "열림"은 실제로 화면에 띄워야 한다 (포커스는 뺏지 않는다).
//   npx electron scripts/measure-cpu.js [초=60]   → 결과 JSON 한 줄
// 임시 APPDATA, 가짜 Groq (네트워크에 나가지 않는다), 사용자 설정·기록은 건드리지 않는다.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeWav, SAMPLE_RATE } = require('../lib/wav');
const { parseWav } = require('../lib/devfeed');

const SECONDS = Number(process.argv.find((a) => /^\d+$/.test(a))) || 60;
const SETTLE = 5;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-cpu-'));
const roaming = path.join(tmp, 'Roaming');
fs.mkdirSync(path.join(roaming, 'Ezrite'), { recursive: true });
fs.writeFileSync(path.join(roaming, 'Ezrite', 'settings.json'),
  JSON.stringify({ welcomed: true, theme: 'light', language: 'English', options: { askBeforeRecord: false } }));

// 영어 강의 음성(promo/assets/pareto.wav, 약 21초)을 1초 쉼과 함께 이어 붙여 모든 경우를 다 잴 만큼 길게
const wav = path.join(tmp, 'lecture.wav');
{
  const voice = parseWav(fs.readFileSync(path.join(__dirname, '..', '..', 'promo', 'assets', 'pareto.wav'))).pcm; // s16le
  const gap = Buffer.alloc(SAMPLE_RATE * 2);
  const need = (SECONDS + SETTLE) * 4 + 60;
  const parts = [];
  for (let t = 0; t < need; t += voice.length / 2 / SAMPLE_RATE + 1) parts.push(voice, gap);
  const head = encodeWav(new Float32Array(0)).subarray(0, 44); // 빈 wav 의 머리를 길이만 고쳐 쓴다
  const data = Buffer.concat(parts);
  head.writeUInt32LE(36 + data.length, 4);
  head.writeUInt32LE(data.length, 40);
  fs.writeFileSync(wav, Buffer.concat([head, data]));
}

Object.assign(process.env, {
  APPDATA: roaming, LOCALAPPDATA: path.join(tmp, 'Local'), EZRITE_THEME: 'light',
  EZRITE_FAKE_GROQ: '1', EZRITE_TESTFILE: wav, EZRITE_UPDATE_JSON: '{"tag_name":"v0.0.1","assets":[]}',
});

const { app, BrowserWindow, webContents } = require('electron');
// 사용자가 쓰던 창의 포커스를 뺏지 않는다: 보이기는 showInactive 로만
BrowserWindow.prototype.focus = function noop() {};
BrowserWindow.prototype.show = function showQuietly() { this.showInactive(); };
app.setPath('userData', path.join(tmp, 'userData'));
require('../main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(100);
  }
  return null;
}
const winOf = (name) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(name));

// 창마다 보낸 IPC 수 (어느 통로가 자주 깨우는지)
const sends = new Map();
function countSends() {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.ezCounted) continue;
    wc.ezCounted = true;
    const name = path.basename(new URL(wc.getURL() || 'about:blank').pathname) || 'blank';
    const orig = wc.send.bind(wc);
    wc.send = (channel, ...args) => {
      const k = `${name}:${channel}`;
      sends.set(k, (sends.get(k) ?? 0) + 1);
      return orig(channel, ...args);
    };
  }
}

/** 프로세스별 누적 CPU 초. cumulativeCPUUsage 가 없으면 null */
const cpuTimes = () => new Map(app.getAppMetrics().map((m) => [m.pid, { type: m.type, t: m.cpu.cumulativeCPUUsage, wake: m.cpu.idleWakeupsPerSecond }]));

async function measure(label) {
  await wait(SETTLE * 1000);
  sends.clear();
  const a = cpuTimes();
  const t0 = process.hrtime.bigint();
  // 누적 값이 없을 때를 위해 1초마다 percentCPUUsage 도 더해 둔다
  const pct = new Map();
  let ticks = 0;
  app.getAppMetrics();
  for (let i = 0; i < SECONDS; i++) {
    await wait(1000);
    ticks += 1;
    for (const m of app.getAppMetrics()) pct.set(m.type, (pct.get(m.type) ?? 0) + m.cpu.percentCPUUsage);
  }
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  const b = cpuTimes();
  const byType = {};
  let total = 0;
  for (const [pid, x] of b) {
    const before = a.get(pid)?.t ?? 0;
    if (typeof x.t !== 'number') continue;
    const p = ((x.t - before) / secs) * 100; // 한 코어 = 100%
    byType[x.type] = Math.round(((byType[x.type] ?? 0) + p) * 10) / 10;
    total += p;
  }
  const sampled = {};
  for (const [k, v] of pct) sampled[k] = Math.round((v / ticks) * 10) / 10;
  const perSec = {};
  for (const [k, v] of [...sends].sort()) perSec[k] = Math.round((v / secs) * 10) / 10;
  return { label, total: Math.round(total * 10) / 10, byType, sampled, sendsPerSec: perSec };
}

app.whenReady().then(async () => {
  const r = { ok: false, seconds: SECONDS, cores: os.cpus().length, electron: process.versions.electron };
  try {
    const popupWc = await until(() => winOf('popup.html')?.webContents);
    const popup = winOf('popup.html');
    const main = winOf('main.html');
    await until(() => !popupWc.isLoading() && !main.webContents.isLoading());
    const set = (patch) => popupWc.executeJavaScript(`window.ezrite.set(${JSON.stringify(patch)})`);
    // 첫 줄이 받아 적힐 때까지 (EZRITE_TESTFILE 이 녹음을 저절로 시작한다)
    const lines = () => popupWc.executeJavaScript("document.querySelectorAll('.live .entry').length");
    if (!(await until(async () => (await lines()) > 0, 60000))) throw new Error('받아 적은 줄이 없음');
    countSends();
    r.results = [];

    popup.hide();
    main.hide();
    r.results.push(await measure('창 닫음'));

    popup.showInactive();
    countSends();
    r.results.push(await measure('팝업 열림'));

    await set({ compact: true });
    r.results.push(await measure('작은 창'));

    await set({ compact: false });
    popup.hide();
    main.setAlwaysOnTop(true); // 다른 창에 가려지면 Chromium 이 그리기를 줄여 실제보다 낮게 나온다
    main.showInactive();
    await set({ page: 'live' });
    r.results.push(await measure('전체 창 열림'));
    main.setAlwaysOnTop(false);
    main.hide();

    r.lines = await lines();
    r.ok = r.results.every((x) => x.total > 0);
  } catch (e) {
    r.error = e.stack;
  }
  console.log(JSON.stringify(r));
  app.exit(r.ok ? 0 : 1);
});
app.on('quit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 다음에 */ } });
