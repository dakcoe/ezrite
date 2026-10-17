'use strict';
require('./guard'); // 오류가 나도 화면에 창을 띄우지 않고 종료 코드 1
// 새 버전 띠를 실제 앱 화면에서 본다 (창은 화면에 띄우지 않는다. 임시 APPDATA, 가짜 릴리스 EZRITE_UPDATE_JSON).
//   npx electron scripts/check-update.js   → 결과 JSON 한 줄, 하나라도 틀리면 종료 코드 1
// test/update-ui.test.js 가 부른다. 1.1.3 "설정에서 '팝업 위 알림에서 받기' 라는데 띠가 없다" 의 재발 방지:
//   전체 창의 실시간·지난 기록·설정 어느 화면이든 맨 위에 새 버전 띠, 저장됨 띠는 그 아래 (맥 MainView)
//   설정의 버전 줄은 "새 버전 X가 있습니다" + [받기], 누르면 설치 파일 주소를 연다
//   [나중에] 는 팝업·전체 창 둘 다에서 띠를 닫고, 설정의 [업데이트 확인] 은 둘 다에 다시 띄운다
//   띠의 단추는 창 끌기 영역에 먹히지 않는다
// EZRITE_UPDATE_SHOTS=<폴더> 이면 설정 탭(띠 보임) 전체 창과 팝업을 찍는다.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-update-'));
const roaming = path.join(tmp, 'Roaming');
fs.mkdirSync(path.join(roaming, 'Ezrite'), { recursive: true });
const theme = process.env.EZRITE_THEME || 'light';
fs.writeFileSync(path.join(roaming, 'Ezrite', 'settings.json'), JSON.stringify({ welcomed: true, theme }));
const EXE = 'https://github.com/dakcoe/ezrite/releases/download/v9.9.9/Ezrite-Setup-9.9.9.exe';
const RELEASE = {
  tag_name: 'v9.9.9', html_url: 'https://github.com/dakcoe/ezrite/releases/tag/v9.9.9',
  body: '- 전체 창에도 새 버전 알림\n- 설정에서 바로 받기\n- 셋째 줄\n- 넷째 줄은 띠에 안 나온다',
  assets: [{ name: 'Ezrite-9.9.9.dmg', browser_download_url: 'https://github.com/dakcoe/ezrite/releases/download/v9.9.9/Ezrite-9.9.9.dmg' },
    { name: 'Ezrite-Setup-9.9.9.exe', browser_download_url: EXE }],
};
Object.assign(process.env, {
  APPDATA: roaming, LOCALAPPDATA: path.join(tmp, 'Local'), EZRITE_THEME: theme, EZRITE_UPDATE_JSON: JSON.stringify(RELEASE),
});

const { app, BrowserWindow, shell } = require('electron');
for (const m of ['show', 'showInactive', 'focus', 'moveTop']) BrowserWindow.prototype[m] = function noop() {};
// [받기] 는 브라우저를 열지 않고 연 주소만 적어 둔다
const opened = [];
shell.openExternal = async (url) => { opened.push(url); };
app.setPath('userData', path.join(tmp, 'userData'));
require('../main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(100);
  }
  return null;
}
async function page(name) {
  const wc = await until(() => BrowserWindow.getAllWindows().map((w) => w.webContents).find((x) => x.getURL().includes(name) && !x.isLoading()));
  if (!wc) throw new Error(`${name} 이 열리지 않음`);
  return wc;
}

/** 새 버전 띠: 보이는지, 글, 맨 위인지(저장됨 띠보다 위), 단추가 창 끌기 영역 밖이고 가려지지 않는지 */
const bannerOf = (wc) => wc.executeJavaScript(`(() => {
  const b = document.querySelector('.update-banner');
  if (!b || b.classList.contains('hidden') || !b.offsetHeight) return null;
  const region = (el) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const v = getComputedStyle(n).appRegion || getComputedStyle(n).webkitAppRegion; if (v === 'drag' || v === 'no-drag') return v; } return 'none'; };
  const tops = b.parentElement;
  const first = tops.parentElement.querySelector(':scope > *:not(.titlebar)');
  const buttons = [...b.querySelectorAll('button')].map((el) => { const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { text: el.textContent.trim(), region: region(el), covered: !hit || (hit !== el && !el.contains(hit)) }; });
  return { title: b.querySelector('.ub-title')?.textContent, now: b.querySelector('.ub-now')?.textContent,
    notes: b.querySelector('.ub-notes')?.textContent ?? '', top: tops.classList.contains('top-banners') && tops.firstElementChild === b,
    first: first === tops || first === b, y: Math.round(b.getBoundingClientRect().y), buttons };
})()`);

const center = (wc, sel, text) => wc.executeJavaScript(`(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.trim() === ${JSON.stringify(text)} && e.offsetHeight);
  if (!el) return null; el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`);
async function click(wc, sel, text) {
  const pt = await center(wc, sel, text);
  if (!pt) throw new Error(`${sel} "${text}" 없음`);
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) {
    wc.sendInputEvent({ type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    await wait(30);
  }
}

app.whenReady().then(async () => {
  const r = { ok: false, pages: {} };
  try {
    const popup = await page('popup.html');
    const main = await page('main.html');
    const set = (patch) => main.executeJavaScript(`window.ezrite.set(${JSON.stringify(patch)})`);

    r.popup = await until(() => bannerOf(popup));
    for (const p of ['live', 'history', 'settings']) {
      await set({ page: p });
      r.pages[p] = await until(() => bannerOf(main));
    }
    // 설정: 버전 줄과 [받기]
    const version = () => main.executeJavaScript(`(() => { const c = document.querySelector('.card.version');
      return c && { tab: document.querySelector('.tab.on')?.textContent ?? null, gear: document.querySelector('.gear.on') != null, sub: c.querySelector('.sub')?.textContent, buttons: [...c.querySelectorAll('button')].map((b) => b.textContent.trim()) }; })()`);
    r.version = await until(version);

    if (process.env.EZRITE_UPDATE_SHOTS) {
      const { flattenBGRA, hexColor } = require('../lib/png');
      const { themeColors } = require('../lib/ui');
      const { nativeImage } = require('electron');
      const c = themeColors(theme === 'dark');
      // 설정 맨 위(띠) · 설정 버전 카드까지 내린 것([받기]) · 팝업
      const toVersion = () => main.executeJavaScript("document.querySelector('.card.version').scrollIntoView({ block: 'center' })");
      for (const [name, wc, bg, before] of [['settings', main, c.win], ['settings-version', main, c.win, toVersion], ['popover', popup, c.popup]]) {
        if (before) await before();
        wc.setBackgroundThrottling(false);
        // 숨긴 창은 다시 그리지 않아 이전 그림(탭 강조가 남은 것)이 찍힌다. 다시 그리게 하고 넉넉히 기다린다
        wc.invalidate();
        await wait(1500);
        wc.invalidate();
        await wait(300);
        const img = await wc.capturePage();
        const { width, height } = img.getSize();
        const flat = nativeImage.createFromBitmap(flattenBGRA(img.toBitmap(), hexColor(bg)), { width, height });
        fs.writeFileSync(path.join(process.env.EZRITE_UPDATE_SHOTS, `update-${name}-${theme}.png`), flat.toPNG());
      }
    }

    await click(main, '.card.version button', '받기');
    await until(() => opened.length);
    r.opened = [...opened];

    // [나중에] (전체 창에서) → 두 창 모두 닫힘
    await click(main, '.update-banner button', '나중에');
    r.afterSkip = { main: await until(async () => (await bannerOf(main)) === null && 'gone'), popup: await until(async () => (await bannerOf(popup)) === null && 'gone') };
    r.versionAfterSkip = await version();
    // [업데이트 확인] → 두 창 모두 다시
    await click(main, '.card.version button', '업데이트 확인');
    r.afterCheck = { main: Boolean(await until(() => bannerOf(main))), popup: Boolean(await until(() => bannerOf(popup))) };

    const good = (b) => b && b.title === '새 버전 9.9.9' && b.now === `지금 ${app.getVersion()}` && b.top && b.first
      && b.notes === '- 전체 창에도 새 버전 알림\n- 설정에서 바로 받기\n- 셋째 줄'
      && JSON.stringify(b.buttons.map((x) => x.text)) === '["나중에","받기"]'
      && b.buttons.every((x) => x.region !== 'drag' && !x.covered);
    r.ok = good(r.popup) && ['live', 'history', 'settings'].every((p) => good(r.pages[p]))
      && r.version?.sub === '새 버전 9.9.9가 있습니다' && r.version.buttons.includes('받기')
      && JSON.stringify(r.opened) === JSON.stringify([EXE])
      && r.afterSkip.main === 'gone' && r.afterSkip.popup === 'gone' && !r.versionAfterSkip.buttons.includes('받기')
      && r.afterCheck.main && r.afterCheck.popup;
  } catch (e) {
    r.error = e.stack;
  }
  console.log(JSON.stringify(r));
  app.exit(r.ok ? 0 : 1);
});
app.on('quit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 다음에 */ } });
