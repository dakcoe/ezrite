'use strict';
require('./guard'); // 오류가 나도 화면에 창을 띄우지 않고 종료 코드 1
// 조용하면 자동 일시정지(1.1.5)를 실제 앱 흐름에서 본다 (창은 화면에 띄우지 않는다. 임시 APPDATA, 가짜 Groq, 만든 소리 파일).
//   npx electron scripts/check-quiet.js   → 결과 JSON 한 줄, 하나라도 틀리면 종료 코드 1
// test/quiet-ui.test.js 가 부른다. 47초 소리(말 3초 - 40초 침묵 - 말 3.5초)를 4배속으로 흘려서:
//   설정 옵션에 "조용하면 자동 일시정지" 토글이 켜져 있다 (기본 켜짐)
//   쉬는 동안 팝업·전체 창 머리가 "조용함 · 자동 일시정지 MM:SS" 이고 시계가 멈춰 있다
//   말이 다시 들리면 기록에 "── a–b 말소리가 없어 자동 일시정지" 줄, 두 번째 줄의 시각(.times.json)은 쉬기 직전 자리(약 35.5초)
//   녹음 소리(m4a)는 쉰 만큼 짧다 / 토글을 끄면(settings.json 에도 남는다) 같은 소리가 끝까지 쉬지 않고 두 번째 줄은 약 43.3초
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeWav, SAMPLE_RATE } = require('../lib/wav');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-quiet-'));
const roaming = path.join(tmp, 'Roaming');
fs.mkdirSync(path.join(roaming, 'Ezrite'), { recursive: true });
const settingsFile = path.join(roaming, 'Ezrite', 'settings.json');
fs.writeFileSync(settingsFile, JSON.stringify({ welcomed: true, theme: 'light' }));
const notesDir = path.join(roaming, 'Ezrite', 'notes', 'autosave');

const wav = path.join(tmp, 'lecture.wav');
{
  const voice = (secs, f) => Float32Array.from({ length: Math.round(secs * SAMPLE_RATE) },
    (_, k) => 0.25 * Math.sin((2 * Math.PI * f * k) / SAMPLE_RATE) * (1 + 0.3 * Math.sin(k / 400)));
  // 실제 방처럼 아주 작은 잡음이 깔린 침묵 (디지털 0 이 아니다)
  const hush = (secs) => Float32Array.from({ length: Math.round(secs * SAMPLE_RATE) }, (_, k) => ((k * 7919) % 13 - 6) / 32768);
  const parts = [hush(0.5), voice(3, 200), hush(40), voice(3.5, 240)];
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  fs.writeFileSync(wav, encodeWav(all));
}

Object.assign(process.env, {
  APPDATA: roaming, LOCALAPPDATA: path.join(tmp, 'Local'), EZRITE_THEME: 'light',
  EZRITE_FAKE_GROQ: '1', EZRITE_TESTFILE: wav, EZRITE_SPEED: '4', EZRITE_UPDATE_JSON: '{"tag_name":"v0.0.1","assets":[]}',
});

const { app, BrowserWindow } = require('electron');
for (const m of ['show', 'showInactive', 'focus', 'moveTop']) BrowserWindow.prototype[m] = function noop() {};
app.setPath('userData', path.join(tmp, 'userData'));
require('../main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(50);
  }
  return null;
}
async function page(name) {
  return until(() => BrowserWindow.getAllWindows().map((w) => w.webContents).find((wc) => wc.getURL().includes(name) && !wc.isLoading()));
}
const list = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);
const head = (wc) => wc.executeJavaScript("document.querySelector('.status .line1')?.textContent ?? null");
const quietHead = /^조용함 · 자동 일시정지 \d\d:\d\d$/;
const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

/** 녹음 하나: 두 번째 줄이 생기면 끝내고, 기록 폴더의 줄·시각·m4a 길이를 돌려준다 */
async function lecture(popup, main, before) {
  const folder = await until(() => list(notesDir).map((n) => path.join(notesDir, n)).find((d) => !before.includes(d) && fs.existsSync(path.join(d, `${path.basename(d)}.txt`))));
  if (!folder) throw new Error('기록 폴더가 생기지 않음');
  const name = path.basename(folder);
  const out = { heads: [] };
  // 두 번째 줄이 생길 때까지 머리 글을 본다. 쉬는 동안(4배속이라 약 2초)이면 0.5초 뒤 한 번 더 읽어 시계가 멈췄는지
  const times = await until(async () => {
    const t = await head(popup);
    if (out.heads.length === 0 && quietHead.test(t ?? '')) {
      out.heads.push(t);
      await wait(500);
      out.heads.push(await head(popup), await head(main));
    }
    const got = readJSON(path.join(folder, `${name}.times.json`));
    return got && got.length >= 2 && got;
  });
  if (!times) throw new Error('두 번째 줄이 생기지 않음');
  await popup.executeJavaScript('window.ezrite.stopRecord()');
  const m4a = path.join(folder, `${name}.m4a`);
  await until(() => fs.existsSync(m4a) && !fs.existsSync(path.join(folder, `${name}.pcm`)));
  out.times = times;
  out.lines = fs.readFileSync(path.join(folder, `${name}.txt`), 'utf8').split(/\r?\n/).filter((l) => l.startsWith('── '));
  const rel = require('../lib/notes').audioRel(notesDir, path.join(folder, `${name}.txt`)).split('/').map(encodeURIComponent).join('/');
  out.duration = await main.executeJavaScript(`new Promise((res) => { const a = new Audio('ezrite-note://audio/${rel}'); a.muted = true;
    a.onloadedmetadata = () => res(a.duration); a.onerror = () => res(null); setTimeout(() => res(null), 8000); })`);
  out.folder = folder;
  return out;
}

app.whenReady().then(async () => {
  const r = { ok: false };
  try {
    const popup = await page('popup.html');
    const main = await page('main.html');
    const set = (patch) => main.executeJavaScript(`window.ezrite.set(${JSON.stringify(patch)})`);
    const toggle = () => main.executeJavaScript(`(() => { const c = [...document.querySelectorAll('.toggle-card')].find((x) => x.querySelector('.title')?.textContent === '조용하면 자동 일시정지');
      return c && { detail: c.querySelector('.detail')?.textContent, on: c.querySelector('input')?.checked ?? c.querySelector('[aria-checked]')?.getAttribute('aria-checked') === 'true' }; })()`);

    // 켜짐(기본): 처음 녹음은 EZRITE_TESTFILE 이 저절로 시작한다
    await set({ page: 'settings' });
    r.toggle = await until(toggle, 5000);
    r.on = await lecture(popup, main, []);

    // 끄고 같은 소리로 한 번 더
    await set({ options: { autoPauseQuiet: false } });
    r.toggleOff = await toggle();
    r.saved = readJSON(settingsFile)?.options?.autoPauseQuiet;
    await popup.executeJavaScript('window.ezrite.startRecord()');
    r.off = await lecture(popup, main, [r.on.folder]);

    const near = (v, x, d) => typeof v === 'number' && Math.abs(v - x) <= d;
    r.ok = r.toggle?.on === true && r.toggleOff?.on === false && r.saved === false
      && r.on.heads.length === 3 && r.on.heads.every((t) => t === r.on.heads[0])
      && r.on.lines.length === 1 && /^── \d\d:\d\d:\d\d–\d\d:\d\d:\d\d 말소리가 없어 자동 일시정지$/.test(r.on.lines[0])
      && near(r.on.times[1][0], 35.5, 0.4) && near(r.off.times[1][0], 43.3, 0.4)
      && r.off.heads.length === 0 && r.off.lines.length === 0
      // 녹음 소리는 마지막 줄 끝 바로 뒤에서 끝난다 (끝내기까지 걸린 몇 초만 더). 켠 쪽은 쉰 만큼(약 7.8초) 줄 시각이 당겨졌으니 그만큼 짧다
      && [r.on, r.off].every((x) => typeof x.duration === 'number' && x.duration >= x.times[1][1] && x.duration - x.times[1][1] < 4);
  } catch (e) {
    r.error = e.stack;
  }
  console.log(JSON.stringify(r));
  app.exit(r.ok ? 0 : 1);
});
app.on('quit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 다음에 */ } });
