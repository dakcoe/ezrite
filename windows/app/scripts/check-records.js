'use strict';
require('./guard'); // 오류가 나도 화면에 창을 띄우지 않고 종료 코드 1
// 실제로 녹음해서 기록이 폴더 하나에 남는지 본다 (창은 화면에 띄우지 않는다. 임시 APPDATA, 가짜 Groq, 만든 소리 파일).
//   npx electron scripts/check-records.js   → 결과 JSON 한 줄, 하나라도 틀리면 종료 코드 1
// test/records-ui.test.js 가 부른다. 확인하는 것:
//   녹음(일시정지·이어 하기 포함) → 저장 폴더/기록이름/ 안에 .txt·.m4a·.times.json 만, 녹음 원본 .pcm 은 m4a 로 바뀌고 없다
//   "녹음 기록 저장됨" 띠가 팝업·전체 창 맨 위에, [기록 보기] 로 지난 기록에서 그 기록이 열리고 소리가 재생된다
//   이름 바꾸기 → 폴더째 바뀌고 띠도 따라간다 · 재생 주소로 저장 폴더 밖(..)은 읽지 못한다
//   새 녹음을 시작하면 띠가 사라지고, 글 없이 끝내면 띠가 뜨지 않는다
// 지우기(휴지통)는 실제 휴지통을 쓰므로 여기서는 하지 않는다 (test/session-folder.test.js 가 대상을 본다)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeWav, SAMPLE_RATE } = require('../lib/wav');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-records-'));
const roaming = path.join(tmp, 'Roaming');
fs.mkdirSync(path.join(roaming, 'Ezrite'), { recursive: true });
fs.writeFileSync(path.join(roaming, 'Ezrite', 'settings.json'), JSON.stringify({ welcomed: true, theme: process.env.EZRITE_THEME || 'light' }));
const notesDir = path.join(roaming, 'Ezrite', 'notes', 'autosave');

// 말소리처럼 켜졌다 꺼지는 소리 (1.2초 소리 · 0.7초 쉼 × 4)
const wav = path.join(tmp, 'speech.wav');
{
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const on = new Float32Array(Math.round(1.2 * SAMPLE_RATE));
    for (let k = 0; k < on.length; k++) on[k] = 0.25 * Math.sin((2 * Math.PI * (180 + 40 * i) * k) / SAMPLE_RATE) * (1 + 0.3 * Math.sin(k / 400));
    parts.push(on, new Float32Array(Math.round(0.7 * SAMPLE_RATE)));
  }
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  fs.writeFileSync(wav, encodeWav(all));
}
// 저장 폴더 밖에 둔 소리 (재생 주소로 읽히면 안 된다)
fs.mkdirSync(path.join(roaming, 'Ezrite', 'notes'), { recursive: true }); // 이 폴더가 없어서 처음 실행이 ENOENT 로 죽었다
fs.writeFileSync(path.join(roaming, 'Ezrite', 'notes', 'secret.m4a'), 'x');

Object.assign(process.env, {
  APPDATA: roaming, LOCALAPPDATA: path.join(tmp, 'Local'), EZRITE_THEME: process.env.EZRITE_THEME || 'light',
  EZRITE_FAKE_GROQ: '1', EZRITE_TESTFILE: wav, EZRITE_SPEED: '2', EZRITE_UPDATE_JSON: '{"tag_name":"v0.0.1","assets":[]}',
});

const { app, BrowserWindow } = require('electron');
for (const m of ['show', 'showInactive', 'focus', 'moveTop']) BrowserWindow.prototype[m] = function noop() {};
app.setPath('userData', path.join(tmp, 'userData'));
require('../main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(150);
  }
  return null;
}
async function page(name) {
  return until(() => BrowserWindow.getAllWindows().map((w) => w.webContents).find((wc) => wc.getURL().includes(name) && !wc.isLoading()));
}
const list = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);
const bannerOf = (wc) => wc.executeJavaScript(`(() => { const b = document.querySelector('.saved-banner');
  return b && !b.classList.contains('hidden') ? { text: b.querySelector('.sb-title')?.textContent, place: b.querySelector('.sb-path')?.textContent,
    help: b.querySelector('.sb-place')?.title, firstChild: b.parentElement.firstElementChild === b || b.parentElement.classList.contains('top-banners') } : null; })()`);

app.whenReady().then(async () => {
  const r = { ok: false };
  try {
    const popup = await page('popup.html');
    const main = await page('main.html');
    const ipc = (c) => popup.executeJavaScript(c);

    // 녹음: 글이 생기면 잠깐 쉬었다 이어 하고, 끝낸다
    const firstTxt = await until(() => list(notesDir).map((n) => path.join(notesDir, n, `${n}.txt`)).find((p) => fs.existsSync(p)));
    r.txtCreated = Boolean(firstTxt);
    await ipc('window.ezrite.togglePause()');
    await wait(600);
    await ipc('window.ezrite.togglePause()');
    await wait(2500);
    await ipc('window.ezrite.stopRecord()');
    const folder = path.dirname(firstTxt);
    const name = path.basename(folder);
    await until(() => fs.existsSync(path.join(folder, `${name}.m4a`)) && !fs.existsSync(path.join(folder, `${name}.pcm`)), 30000);
    await wait(500);
    r.root = list(notesDir);
    r.folder = list(folder);
    r.name = name;

    r.popupBanner = await bannerOf(popup);
    r.mainBanner = await bannerOf(main);

    // 스크린샷 (EZRITE_RECORDS_SHOTS=<폴더> 일 때만): 저장됨 띠가 뜬 팝업과 전체 창, 바탕색 위에 불투명하게
    if (process.env.EZRITE_RECORDS_SHOTS) {
      const { flattenBGRA, hexColor } = require('../lib/png');
      const { themeColors } = require('../lib/ui');
      const { nativeImage } = require('electron');
      const theme = process.env.EZRITE_THEME || 'light';
      const c = themeColors(theme === 'dark');
      for (const [name, wc, bg] of [['popover', popup, c.popup], ['live', main, c.win]]) {
        // 숨긴 창은 다시 그리지 않아 마지막 그림이 찍힌다. 다시 그리게 하고 기다린다
        wc.setBackgroundThrottling(false);
        wc.invalidate();
        await wait(700);
        const img = await wc.capturePage();
        const { width, height } = img.getSize();
        const flat = nativeImage.createFromBitmap(flattenBGRA(img.toBitmap(), hexColor(bg)), { width, height });
        fs.writeFileSync(path.join(process.env.EZRITE_RECORDS_SHOTS, `saved-${name}-${theme}.png`), flat.toPNG());
      }
    }

    // [기록 보기] → 전체 창 지난 기록에서 그 기록, 소리 재생
    await popup.executeJavaScript("document.querySelector('.saved-banner .btn.primary').click()");
    await wait(800);
    // 기록 화면의 머리(.note-head)가 그 기록으로 열렸는지 본다. 재생기는 DOM 에 없는 <audio> 라서,
    // 소리 주소는 main 의 audioSrc 와 같은 규칙(저장 폴더 기준 상대 경로)으로 만든다
    r.history = await main.executeJavaScript(`({ tab: document.querySelector('.tab.on')?.textContent?.trim(),
      title: document.querySelector('.note-head') ? (document.querySelector('.note-head .note-date')?.textContent ?? '') : null })`);
    const rel = require('../lib/notes').audioRel(notesDir, firstTxt).split('/').map(encodeURIComponent).join('/');
    r.history.audio = `ezrite-note://audio/${rel}`;
    r.play = await main.executeJavaScript(`new Promise((res) => { const a = new Audio(${JSON.stringify(r.history.audio)}); a.muted = true;
      a.onloadedmetadata = () => res({ ok: true, duration: a.duration }); a.onerror = () => res({ ok: false, code: a.error && a.error.code });
      setTimeout(() => res({ ok: false, code: 'timeout' }), 8000); })`);
    r.escape = await main.executeJavaScript(`Promise.all(['..%2Fsecret.m4a', '..%5Csecret.m4a', '%2E%2E/secret.m4a'].map((p) => new Promise((res) => {
      const a = new Audio('ezrite-note://audio/' + p); a.onloadedmetadata = () => res('READ ' + p); a.onerror = () => res('blocked');
      setTimeout(() => res('timeout'), 5000); })))`);

    // 이름 바꾸기: 폴더째, 띠도 따라간다
    await main.executeJavaScript(`window.ezrite.history.rename(${JSON.stringify(firstTxt)}, '1주차')`);
    await wait(500);
    r.renamedRoot = list(notesDir);
    r.renamedFolder = list(path.join(notesDir, `${name} 1주차`));
    r.bannerAfterRename = await bannerOf(popup);

    // 새 녹음을 시작하면 띠가 사라지고, 글 없이 바로 끝내면 띠가 뜨지 않는다
    await ipc('window.ezrite.startRecord()');
    await wait(150);
    r.bannerWhileRecording = await bannerOf(popup);
    await ipc('window.ezrite.stopRecord()');
    await wait(1500);
    r.bannerNoText = await bannerOf(popup);

    const want = [`${name}.m4a`, `${name}.times.json`, `${name}.txt`];
    r.ok = r.txtCreated && JSON.stringify(r.root) === JSON.stringify([name]) && JSON.stringify(r.folder) === JSON.stringify(want)
      && r.popupBanner?.text === '녹음 기록 저장됨' && r.popupBanner?.place === `autosave › ${name}` && Boolean(r.mainBanner)
      && r.play.ok && r.escape.every((x) => x === 'blocked')
      && r.renamedFolder.length === 3 && r.bannerAfterRename?.place === `autosave › ${name} 1주차`
      && r.bannerWhileRecording === null && r.bannerNoText === null;
  } catch (e) {
    r.error = e.stack;
  }
  console.log(JSON.stringify(r));
  app.exit(r.ok ? 0 : 1);
});
app.on('quit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 다음에 */ } });
