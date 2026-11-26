'use strict';
require('./guard'); // 오류가 나도 화면에 창을 띄우지 않고 종료 코드 1
// 새 버전 띠를 실제 앱 화면에서 본다 (창은 화면에 띄우지 않는다. 임시 APPDATA, 가짜 릴리스 EZRITE_UPDATE_JSON).
//   npx electron scripts/check-update.js   → 결과 JSON 한 줄, 하나라도 틀리면 종료 코드 1
// test/update-ui.test.js 가 부른다. 1.1.3 "설정에서 '팝업 위 알림에서 받기' 라는데 띠가 없다" 의 재발 방지:
//   전체 창의 실시간·지난 기록·설정 어느 화면이든 맨 위에 새 버전 띠, 저장됨 띠는 그 아래 (맥 MainView)
//   설정의 버전 줄은 "새 버전 X가 있습니다" + [업데이트] (1.2.4 앱 안 업데이트)
//   [업데이트] 가 실패하면(여기서는 받기가 404) 띠에 오류 한 줄과 [브라우저로 받기], 누르면 설치 파일 주소를 연다
//   [나중에] 는 팝업·전체 창 둘 다에서 띠를 닫고, 설정의 [업데이트 확인] 은 둘 다에 다시 띄운다
//   띠의 단추는 창 끌기 영역에 먹히지 않는다
//   1.3.2: 띠는 창 안 내용 위에 겹쳐 뜬다 (위 8·좌우 8, 두 띠 사이 6, 반지름 10, 그림자, 제목 한 줄). 팝업 크기는 띠가 있든 없든 같다 (340×344, 화면 배율 반올림 몇 점)
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

// 앱 안 업데이트의 받기는 네트워크에 나가지 않고 404 로 실패시킨다 (main.js 를 부르기 전에 바꿔야 SelfUpdate 가 이것을 쓴다)
const fetched = [];
globalThis.fetch = async (url) => { fetched.push(String(url)); return { ok: false, status: 404, url: String(url), headers: new Headers(), body: null }; };

const { app, BrowserWindow, shell } = require('electron');
for (const m of ['show', 'showInactive', 'focus', 'moveTop']) BrowserWindow.prototype[m] = function noop() {};
// [받기] 는 브라우저를 열지 않고 연 주소만 적어 둔다
const opened = [];
shell.openExternal = async (url) => { opened.push(url); };
app.setPath('userData', path.join(tmp, 'userData'));
// electron 으로 스크립트를 바로 돌리면 앱 버전이 Electron 버전(44.x)이 된다. 9.9.9 가 새 버전이 되게 실제 앱 버전으로
app.setVersion(require('../package.json').version);
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
const bannerOf = (wc) => wc.executeJavaScript(`(() => { ${OVERLAY}
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
    first: first === tops || first === b, y: Math.round(b.getBoundingClientRect().y), buttons, overlay: overlayOf(b) };
})()`);

// 1.3.2: 띠는 창 안에서 내용 위에 겹친다 — 흐름 밖(absolute), 위 8·좌우 8, 바로 뒤 내용(머리)은 밀리지 않고 맨 위, 제목 한 줄
const OVERLAY = `function overlayOf(b) {
  const tops = b.parentElement, host = tops.parentElement.getBoundingClientRect(), r = b.getBoundingClientRect();
  const next = tops.nextElementSibling, t = b.querySelector('.ub-title'), cs = getComputedStyle(b);
  return { position: getComputedStyle(tops).position, top: Math.round(r.y - host.y), left: Math.round(r.x - host.x), right: Math.round(host.right - r.right),
    nextTop: next ? Math.round(next.getBoundingClientRect().y - host.y) : null, radius: cs.borderRadius, shadow: cs.boxShadow !== 'none',
    titleOneLine: t ? t.getClientRects().length === 1 && getComputedStyle(t).whiteSpace === 'nowrap' : null };
}`;

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
    // 띠가 떠도 팝업 크기는 그대로 (예전에는 띠 높이만큼 위로 커졌다)
    await wait(300);
    const pb = BrowserWindow.fromWebContents(popup).getBounds();
    r.popupSize = { width: pb.width, height: pb.height };
    // 두 띠가 같이 있으면 세로로 6 (저장됨 띠는 녹음해야 생기므로 화면에서만 잠깐 보이게 해서 잰다)
    r.gap = await popup.executeJavaScript(`(() => { const s = document.querySelector('.saved-banner'), u = document.querySelector('.update-banner');
      s.classList.remove('hidden'); const x = document.createElement('div'); x.textContent = '녹음 기록 저장됨'; s.append(x);
      const g = Math.round(s.getBoundingClientRect().y - u.getBoundingClientRect().bottom), left = Math.round(s.getBoundingClientRect().x);
      x.remove(); s.classList.add('hidden'); return { gap: g, left }; })()`);
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
      // 설정 맨 위(띠) · 설정 버전 카드까지 내린 것([업데이트]) · 팝업
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

    // [업데이트] → 받기 실패(404) → 오류 한 줄 + [브라우저로 받기] → 설치 파일 주소를 연다
    await click(main, '.update-banner button', '업데이트');
    r.installError = await until(() => main.executeJavaScript("document.querySelector('.update-banner .ub-error span')?.textContent ?? null"));
    r.fetched = fetched.filter((u) => u.endsWith('.exe')); // 설정을 열면 버전별 요약도 묻는다 (그것도 여기서 404)
    await click(main, '.update-banner .ub-error button', '브라우저로 받기');
    await until(() => opened.length);
    r.opened = [...opened];

    // [나중에] (전체 창에서) → 두 창 모두 닫힘
    await click(main, '.update-banner button', '나중에');
    r.afterSkip = { main: await until(async () => (await bannerOf(main)) === null && 'gone'), popup: await until(async () => (await bannerOf(popup)) === null && 'gone') };
    r.versionAfterSkip = await version();
    await wait(300);
    const pa = BrowserWindow.fromWebContents(popup).getBounds();
    r.popupSizeNoBanner = { width: pa.width, height: pa.height };
    // [업데이트 확인] → 두 창 모두 다시
    await click(main, '.card.version button', '업데이트 확인');
    r.afterCheck = { main: Boolean(await until(() => bannerOf(main))), popup: Boolean(await until(() => bannerOf(popup))) };

    const good = (b) => b && b.title === '새 버전 9.9.9' && b.now === `지금 ${app.getVersion()}` && b.top && b.first
      && b.notes === '- 전체 창에도 새 버전 알림\n- 설정에서 바로 받기\n- 셋째 줄'
      && JSON.stringify(b.buttons.map((x) => x.text)) === '["나중에","업데이트"]'
      && b.buttons.every((x) => x.region !== 'drag' && !x.covered)
      && b.overlay.position === 'absolute' && b.overlay.top === 8 && b.overlay.left === 8 && b.overlay.right === 8 && b.overlay.nextTop === 0
      && b.overlay.radius === '10px' && b.overlay.shadow && b.overlay.titleOneLine;
    r.ok = good(r.popup) && ['live', 'history', 'settings'].every((p) => good(r.pages[p]))
      && JSON.stringify(r.popupSize) === JSON.stringify(r.popupSizeNoBanner) && Math.abs(r.popupSize.height - 344) <= 3 && r.gap.gap === 6 && r.gap.left === 8
      && r.version?.sub === '새 버전 9.9.9가 있습니다' && r.version.buttons.includes('업데이트')
      && r.installError === '새 버전을 받지 못했어요' && JSON.stringify(r.fetched) === JSON.stringify([EXE])
      && JSON.stringify(r.opened) === JSON.stringify([EXE])
      && r.afterSkip.main === 'gone' && r.afterSkip.popup === 'gone' && !r.versionAfterSkip.buttons.includes('업데이트')
      && r.afterCheck.main && r.afterCheck.popup;
  } catch (e) {
    r.error = e.stack;
  }
  console.log(JSON.stringify(r));
  app.exit(r.ok ? 0 : 1);
});
app.on('quit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 다음에 */ } });
