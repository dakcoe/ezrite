'use strict';
// 설정 → 옵션 → 화면 테마 (시스템 설정 따르기 / 밝게 / 어둡게)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Settings = require('../lib/settings');
const { THEME_OPTIONS, themeSource, themeColors, titleBarOverlay } = require('../lib/ui');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-theme-')), 'settings.json');

test('기본값은 시스템 설정 따르기', () => {
  assert.equal(Settings.DEFAULTS.theme, 'system');
  assert.equal(Settings.load(path.join(os.tmpdir(), 'no-such-ezrite', 'settings.json')).theme, 'system');
});

test('저장한 테마를 다시 읽는다', () => {
  const f = tmpFile();
  for (const t of ['light', 'dark', 'system']) {
    Settings.save(f, { theme: t });
    assert.equal(Settings.load(f).theme, t);
  }
});

test('모르는 값·깨진 값은 시스템 설정으로 돌린다', () => {
  const f = tmpFile();
  for (const bad of ['blue', 'DARK', 1, null, ['dark']]) {
    fs.writeFileSync(f, JSON.stringify({ theme: bad, language: 'English' }));
    const s = Settings.load(f);
    assert.equal(s.theme, 'system', String(bad));
    assert.equal(s.language, 'English', '다른 값은 그대로 둔다');
  }
  Settings.save(f, { theme: 'purple' });
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).theme, 'system');
});

test('고르기 칸: 세 값과 이름', () => {
  assert.deepEqual(THEME_OPTIONS, [
    { value: 'system', label: '시스템 설정 따르기' },
    { value: 'light', label: '밝게' },
    { value: 'dark', label: '어둡게' },
  ]);
  assert.deepEqual(THEME_OPTIONS.map((o) => o.value), Settings.THEMES);
});

test('nativeTheme.themeSource 로 옮긴다 — EZRITE_THEME 이 있으면 그것이 이긴다', () => {
  assert.equal(themeSource('system', 'system'), 'system');
  assert.equal(themeSource('light', 'system'), 'light');
  assert.equal(themeSource('dark', 'system'), 'dark');
  assert.equal(themeSource('dark', 'light'), 'light');
  assert.equal(themeSource('system', 'dark'), 'dark');
  assert.equal(themeSource('nonsense', 'system'), 'system');
  assert.equal(themeSource(undefined, undefined), 'system');
});

test('창 버튼 띠(titleBarOverlay) 색은 테마를 따른다', () => {
  assert.deepEqual(titleBarOverlay({ dark: false, material: false, height: 32 }),
    { color: themeColors(false).win, symbolColor: themeColors(false).text, height: 32 });
  assert.deepEqual(titleBarOverlay({ dark: true, material: false, height: 32 }),
    { color: themeColors(true).win, symbolColor: themeColors(true).text, height: 32 });
  // Mica 를 쓰면 띠는 비우고 기호 색만 테마를 따른다
  const m = titleBarOverlay({ dark: true, material: true, height: 32 });
  assert.equal(m.color, '#00000000');
  assert.equal(m.symbolColor, themeColors(true).text);
  assert.notEqual(themeColors(true).text, themeColors(false).text);
});

test('창 색은 app.css 의 --win-bg / --popup-bg 와 같다', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.css'), 'utf8');
  for (const dark of [false, true]) {
    const c = themeColors(dark);
    assert.match(css, new RegExp(`--win-bg:\\s*${c.win}`, 'i'));
    assert.match(css, new RegExp(`--popup-bg:\\s*${c.popup}`, 'i'));
  }
});

test('설정 화면의 고르기 칸 이름이 lib/ui 와 같다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'main.js'), 'utf8');
  for (const o of THEME_OPTIONS) assert.ok(src.includes(`{ value: '${o.value}', label: '${o.label}' }`), o.label);
  assert.match(src, /window\.ezrite\.set\(\{ theme: v \}\)/);
});
