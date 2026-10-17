'use strict';
require('./guard'); // 오류가 나도 화면에 창을 띄우지 않고 종료 코드 1
// 팝업 아래 줄의 마우스 올림 글이 칸에 다 들어가는지 실제로 그려서 잰다 (숨긴 팝업, 화면에 띄우지 않는다).
//   npx electron scripts/check-captions.js [--shots <폴더>]   → 결과 JSON 한 줄, 하나라도 넘치면 종료 코드 1
// test/caption-fit.test.js 가 부른다. 임시 APPDATA 를 써서 사용자 설정·기록을 건드리지 않는다
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-captions-'));
fs.mkdirSync(path.join(tmp, 'Roaming', 'Ezrite'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'Roaming', 'Ezrite', 'settings.json'), JSON.stringify({ welcomed: true, theme: 'light' }));
Object.assign(process.env, {
  APPDATA: path.join(tmp, 'Roaming'), LOCALAPPDATA: path.join(tmp, 'Local'),
  EZRITE_FAKE_GROQ: '1', EZRITE_THEME: 'light', EZRITE_SHOT: path.join(tmp, 'unused.png'), // 재질 대신 단색 (찍은 그림이 불투명하게)
});

const { app, BrowserWindow } = require('electron');
const F = require('../renderer/format');
// 단일 실행 잠금·캐시는 userData 기준이다. 시험끼리(동시에 도는 다른 점검) 부딪치지 않고 사용자 폴더도 건드리지 않게 임시 폴더로
app.setPath('userData', path.join(tmp, 'userData'));
require('../main.js');

// 가장 긴 경우까지: 세 자리 남은 횟수, 이름이 긴 유료 서비스
const CASES = [
  F.usageCaption('받아쓰기', 1),
  F.usageCaption('번역', 0.82),
  F.usageCaption('화면 설명', null),
  '화면 설명 100% 남음 · 설명 약 41번, 질문 약 54번',
  '화면 설명 100% 남음 · 설명 약 999번, 질문 약 999번',
  F.paidCaption('받아쓰기', 'Gemini'),
  F.paidCaption('화면 설명', 'Gemini'),
  F.paidCaption('화면 설명', 'Claude'),
  '작은 창으로',
  'Ezrite 종료',
  // 안전장치 확인: 칸보다 조금 긴 글은 85% 까지 줄여 맞춘다
  '화면 설명 100% 남음 · 설명 약 999번, 질문 약 999번 · 오늘 기준',
];
const SHOTS = { 'popover-gauge-hover.png': CASES[3], 'popover-gauge-hover-long.png': CASES[4] };

const shotsDir = (() => { const i = process.argv.indexOf('--shots'); return i > 0 ? process.argv[i + 1] : null; })();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  let code = 1;
  try {
    let popup = null;
    for (let i = 0; i < 50 && !popup; i++) {
      popup = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('popup.html') && !w.webContents.isLoading());
      if (!popup) await wait(100);
    }
    await wait(1500);
    const js = (c) => popup.webContents.executeJavaScript(c);
    const results = [];
    for (const text of CASES) {
      const r = await js(`(() => { const r = window.Ez.showCaption(${JSON.stringify(text)});
        const c = document.querySelector('.footer .caption'); const rg = document.createRange(); rg.selectNodeContents(c);
        const text = rg.getBoundingClientRect().width; return { ...r, text: Math.ceil(text), box: c.clientWidth, fits: Math.ceil(text) <= c.clientWidth }; })()`);
      results.push({ caption: text, ...r });
    }
    if (shotsDir) {
      for (const [name, text] of Object.entries(SHOTS)) {
        await js(`window.Ez.showCaption(${JSON.stringify(text)})`);
        await wait(200);
        fs.writeFileSync(path.join(shotsDir, name), (await popup.webContents.capturePage()).toPNG());
      }
    }
    const ok = results.every((r) => r.fits);
    console.log(JSON.stringify({ ok, results }));
    code = ok ? 0 : 1;
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }));
  }
  app.exit(code);
});
app.on('quit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 다음에 */ } });
