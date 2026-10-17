'use strict';
require('./guard'); // 오류가 나도 화면에 창을 띄우지 않고 종료 코드 1
// 키 칸을 실제 앱 화면에서 눌러 보고 저장까지 해 본다 (창은 화면에 띄우지 않는다. 마우스·키보드는 webContents 로만 보낸다).
//   npx electron scripts/check-keys.js   → 결과 JSON 한 줄, 하나라도 틀리면 종료 코드 1
// test/keys-ui.test.js 가 부른다.
//   1) 모든 화면의 입력칸·버튼·링크가 창 끌기 영역(app-region: drag) 위에 있지 않다
//   2) 처음 설정 안내 · 설정 · 키 없음 띠의 "키 넣기" 세 곳에서 Groq 키를 넣으면 저장된다. 설정에서 Claude 키도 저장·확인된다
// 임시 APPDATA 를 써서 사용자 설정·키를 건드리지 않는다. 네트워크 대신 맥이 받은 응답(fixtures/mac-providers)을 돌려준다.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-keys-'));
const roaming = path.join(tmp, 'Roaming');
fs.mkdirSync(path.join(roaming, 'Ezrite'), { recursive: true });
fs.writeFileSync(path.join(roaming, 'Ezrite', 'settings.json'), JSON.stringify({ welcomed: true, theme: 'light' }));
Object.assign(process.env, {
  APPDATA: roaming, LOCALAPPDATA: path.join(tmp, 'Local'),
  EZRITE_THEME: 'light', EZRITE_UPDATE_JSON: '{"tag_name":"v0.0.1","assets":[]}',
});
const keyFile = (p) => path.join(roaming, 'Ezrite', `${p}_key`);

// 네트워크 대신: 모델 목록은 맥이 받은 Claude 목록, 짧은 확인("Say OK")은 성공. 나간 요청 주소만 적어 둔다
const FIX = path.join(__dirname, '..', '..', 'fixtures', 'mac-providers');
const sent = [];
globalThis.fetch = async (url, init = {}) => {
  sent.push(`${init.method ?? 'GET'} ${String(url).split('?')[0]}`);
  const body = String(url).includes('anthropic.com/v1/models')
    ? fs.readFileSync(path.join(FIX, 'response-claude-models.json'), 'utf8')
    : String(url).endsWith('/models')
      ? JSON.stringify({ data: [{ id: 'whisper-large-v3' }] })
      : JSON.stringify({ content: [{ type: 'text', text: 'OK' }], choices: [{ message: { content: 'OK' } }] });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
};

const { app, BrowserWindow } = require('electron');
// 사용자 화면에 창을 띄우지 않는다 (그려지기는 한다)
for (const m of ['show', 'showInactive', 'focus', 'moveTop']) BrowserWindow.prototype[m] = function noop() {};
// 단일 실행 잠금·캐시는 userData 기준이다. 시험끼리(동시에 도는 다른 점검) 부딪치지 않고 사용자 폴더도 건드리지 않게 임시 폴더로
app.setPath('userData', path.join(tmp, 'userData'));
require('../main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function page(name) {
  for (let i = 0; i < 80; i++) {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes(name) && !x.webContents.isLoading());
    if (w) return w.webContents;
    await wait(100);
  }
  throw new Error(`${name} 이 열리지 않음`);
}

// 누를 수 있는 것마다: 가운데 점에 실제로 있는 요소와, 그 요소부터 위로 올라가며 처음 만나는 app-region (drag 면 창 끌기에 먹힌다)
const REGIONS = `(() => {
  const region = (el) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const v = getComputedStyle(n).appRegion || getComputedStyle(n).webkitAppRegion; if (v === 'drag' || v === 'no-drag') return v; } return 'none'; };
  const out = [];
  for (const el of document.querySelectorAll('input, button, a, select, textarea, [role=button], iframe')) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || getComputedStyle(el).visibility === 'hidden' || getComputedStyle(el).pointerEvents === 'none') continue;
    // 지금 안 보이는 것(가이드의 다른 장 등: 투명도 0)은 누를 수 없으니 뺀다
    let seen = true;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) if (getComputedStyle(n).opacity === '0') seen = false;
    if (!seen) continue;
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
    const hit = document.elementFromPoint(x, y);
    const label = el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : '') + (el.title ? '[' + el.title + ']' : '') + (el.textContent ? ':' + el.textContent.trim().slice(0, 12) : '');
    out.push({ el: label, region: region(el), hit: hit ? region(hit) : 'none', covered: !!hit && hit !== el && !el.contains(hit) && !hit.contains(el) });
  }
  return out;
})()`;

const center = (wc, sel, text = null) => wc.executeJavaScript(`(() => {
  const all = [...document.querySelectorAll(${JSON.stringify(sel)})];
  const el = ${JSON.stringify(text)} == null ? all[0] : all.find((e) => e.textContent.trim() === ${JSON.stringify(text)});
  if (!el) return null; el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), disabled: !!el.disabled };
})()`);

async function click(wc, pt) {
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) {
    wc.sendInputEvent({ type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    await wait(30);
  }
}

/** 입력칸을 누르고 → 글이 들어가고 → [저장] 을 누르면 키 파일에 저장되는가 */
async function enterKey(wc, inputSel, saveSel, p, value) {
  const at = await center(wc, inputSel);
  if (!at) return { ok: false, why: `${inputSel} 없음` };
  await click(wc, at);
  const focused = await wc.executeJavaScript(`document.activeElement === [...document.querySelectorAll(${JSON.stringify(inputSel)})][0]`);
  wc.insertText(value);
  await wait(100);
  const btn = await center(wc, saveSel, '저장');
  if (!btn) return { ok: false, why: '저장 단추 없음' };
  await click(wc, btn);
  await wait(400);
  const saved = fs.existsSync(keyFile(p)) && fs.readFileSync(keyFile(p), 'utf8') === value;
  const left = await wc.executeJavaScript(`[...document.querySelectorAll(${JSON.stringify(inputSel)})][0]?.value ?? ''`);
  return { ok: at.disabled === false && focused && btn.disabled === false && saved && left === '', disabled: at.disabled, focused, saveEnabled: !btn.disabled, saved, fieldCleared: left === '' };
}

app.whenReady().then(async () => {
  let code = 1;
  const result = { regions: {}, keys: {} };
  try {
    const popup = await page('popup.html');
    const main = await page('main.html');
    await wait(800);
    const ipc = (c) => popup.executeJavaScript(c);

    // ── 1) 처음 설정 안내 ──
    await ipc('window.ezrite.openOnboarding()');
    const onb = await page('onboarding.html');
    await wait(600);
    result.regions.onboarding = await onb.executeJavaScript(REGIONS);
    result.keys.onboarding = await enterKey(onb, 'input.field', '.step .buttons button.btn', 'groq', 'gsk_TESTonboarding0000000000000000000000000001');
    await ipc('window.ezrite.removeKey("groq")');

    // ── 2) 설정: Groq 줄, Claude 줄 ──
    await ipc('window.ezrite.openMain("settings")');
    await wait(600);
    result.regions.settings = await main.executeJavaScript(REGIONS);
    result.keys.settings = await enterKey(main, '.key-row input', '.key-row button.btn', 'groq', 'gsk_TESTsettings00000000000000000000000000002');
    const claudeRow = '.key-row:nth-of-type(3) input'; // 카드 안: Groq, 구분선, Claude …
    result.keys.claude = await enterKey(main, claudeRow, '.key-row:nth-of-type(3) button.btn', 'claude', 'sk-ant-TESTclaude0000000000000000000000003');
    for (let i = 0; i < 30; i++) {
      const st = await main.executeJavaScript('document.querySelectorAll(".key-row")[1]?.innerText ?? ""');
      if (st.includes('연결됨 · 화면 설명')) { result.keys.claude.status = st.replace(/\s+/g, ' ').trim(); break; }
      await wait(100);
    }
    result.keys.claude.featureProviders = await main.executeJavaScript('[...document.querySelectorAll(".feature select")][0] ? [...[...document.querySelectorAll(".feature select")][0].options].map((o) => o.value) : []');
    await ipc('window.ezrite.removeKey("groq")');
    await wait(200);

    // ── 3) 키 없음 띠의 "키 넣기" → 설정 → Groq 줄 ──
    await ipc('window.ezrite.set({ page: "live" })');
    await ipc('window.ezrite.startRecord()');
    await wait(700);
    result.regions.popupBanner = await popup.executeJavaScript(REGIONS);
    result.regions.mainLive = await main.executeJavaScript(REGIONS);
    const link = await center(popup, 'button.link-btn', '키 넣기');
    if (link) {
      await click(popup, link);
      await wait(700);
      result.keys.bannerOpenedSettings = await main.executeJavaScript('!!document.querySelector(".key-row input")');
      result.keys.banner = await enterKey(main, '.key-row input', '.key-row button.btn', 'groq', 'gsk_TESTbanner000000000000000000000000000004');
    } else {
      result.keys.banner = { ok: false, why: '키 넣기 없음' };
    }

    await ipc('window.ezrite.openGuide()');
    const guide = await page('guide.html');
    await wait(400);
    result.regions.guide = await guide.executeJavaScript(REGIONS);

    result.sent = sent;
    const dragged = Object.entries(result.regions).flatMap(([pg, list]) => list.filter((x) => x.region === 'drag' || x.hit === 'drag' || x.covered).map((x) => `${pg}: ${x.el}`));
    result.dragged = dragged;
    result.ok = dragged.length === 0 && ['onboarding', 'settings', 'claude', 'banner'].every((k) => result.keys[k]?.ok)
      && Boolean(result.keys.claude.status) && result.keys.bannerOpenedSettings === true;
    code = result.ok ? 0 : 1;
  } catch (e) {
    result.ok = false;
    result.error = e.stack;
  }
  console.log(JSON.stringify(result));
  app.exit(code);
});
app.on('quit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 다음에 */ } });
