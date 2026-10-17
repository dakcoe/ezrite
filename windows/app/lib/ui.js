'use strict';

// 화면 쪽 순수 규칙 (Electron 없이 테스트한다): 개발용 환경 변수, 팝업 자리, 소리 출처 목록.

const PREVIEWS = ['popover', 'compact', 'live', 'history', 'settings', 'onboarding', 'guide'];
const THEMES = ['light', 'dark'];

/**
 * EZRITE_PREVIEW / THEME / SHOT / SHOT_DELAY / TEST_SCALE / TESTFILE / SPEED / FAKE_GROQ / EXPLAIN / CARD / ASK / CAPTURABLE / UPDATE_JSON / SHOT_SCROLL.
 * 모르는 값은 없는 것으로 친다.
 * EZRITE_TEST_SCALE은 시험할 때만 화면 배율(100%·150% 등)을 흉내 낸다. 평소에는 Windows 배율을 그대로 쓴다
 */
function parseDevEnv(env) {
  const norm = (v) => String(v ?? '').trim().toLowerCase();
  const preview = norm(env.EZRITE_PREVIEW);
  const theme = norm(env.EZRITE_THEME);
  const shot = String(env.EZRITE_SHOT ?? '').trim();
  const scale = Number(String(env.EZRITE_TEST_SCALE ?? '').trim() || NaN);
  const testFile = String(env.EZRITE_TESTFILE ?? '').trim();
  const demoScript = String(env.EZRITE_DEMO_SCRIPT ?? '').trim();
  const capturePid = Number(String(env.EZRITE_CAPTURE_PID ?? '').trim() || NaN);
  const speed = Number(String(env.EZRITE_SPEED ?? '').trim() || NaN);
  const delay = Number(String(env.EZRITE_SHOT_DELAY ?? '').trim() || NaN);
  const explainAfter = Number(String(env.EZRITE_EXPLAIN ?? '').trim() || NaN);
  const card = String(env.EZRITE_CARD ?? '').trim();
  const ask = String(env.EZRITE_ASK ?? '').trim();
  const updateJSON = String(env.EZRITE_UPDATE_JSON ?? '').trim();
  const scroll = Number(String(env.EZRITE_SHOT_SCROLL ?? '').trim() || NaN);
  return {
    preview: PREVIEWS.includes(preview) ? preview : null,
    theme: THEMES.includes(theme) ? theme : 'system',
    shot: shot || null,
    testScale: scale >= 1 && scale <= 3 ? scale : null,
    capturePid: Number.isInteger(capturePid) && capturePid > 0 ? capturePid : null, // 이 pid 의 소리를 받는다 (출처 목록을 거치지 않는 시험용)
    demoScript: demoScript || null, // 시연 대본 json: 녹음을 누르면 이 줄들이 받아쓴 것처럼 차례로 뜬다 (lib/demoscript.js)
    testFile: testFile || null, // 이 wav 를 소리처럼 흘려 넣고 바로 녹음을 시작한다 (맥 EZRITE_TESTFILE)
    fakeGroq: ['1', 'true'].includes(norm(env.EZRITE_FAKE_GROQ)), // 네트워크 없는 가짜 Groq
    speed: speed > 0 && speed <= 16 ? speed : 1, // EZRITE_TESTFILE 을 몇 배속으로
    shotDelay: Number.isInteger(delay) && delay >= 0 && delay <= 120000 ? delay : 1200, // EZRITE_SHOT 찍기 전 기다림(ms)
    explainAfter: explainAfter >= 0 ? explainAfter : null, // 이 초가 지나면 "설명해줘"를 한 번 누른다 (맥과 같다)
    card: card || null, // AI 없이 설명 카드에 이 JSON 을 띄운다
    ask: ask || null, // 설명이 뜬 6초 뒤 이 질문을 묻는다
    // 설명 카드·화면 표시는 평소 화면 캡처(녹화·화면 공유 포함)에서 빠진다. 이 값이면 보이게 두고 찍을 때만 잠깐 뺀다 (스크린샷 확인용)
    capturable: ['1', 'true'].includes(norm(env.EZRITE_CAPTURABLE)),
    shotScroll: Number.isInteger(scroll) && scroll > 0 ? scroll : 0, // EZRITE_SHOT 전에 내용을 이만큼(px) 내린다
    updateJSON: updateJSON || null, // GitHub 대신 이 릴리스 JSON(글 또는 파일 경로)으로 새 버전 띠를 띄운다 (맥과 같다)
  };
}

/** Mica·Acrylic 창 바탕(backgroundMaterial)은 Windows 11 22H2(빌드 22621)부터 */
function supportsMaterial(platform, release) {
  if (platform !== 'win32') return false;
  const build = Number(String(release).split('.')[2]);
  return Number.isInteger(build) && build >= 22621;
}

// 설정 → 옵션 → 화면 테마
const THEME_OPTIONS = [
  { value: 'system', label: '시스템 설정 따르기' },
  { value: 'light', label: '밝게' },
  { value: 'dark', label: '어둡게' },
];

/** nativeTheme.themeSource 값. 개발용 EZRITE_THEME(light·dark)이 설정보다 앞선다 */
function themeSource(setting, envTheme) {
  if (THEMES.includes(envTheme)) return envTheme;
  return THEMES.includes(setting) ? setting : 'system';
}

// app.css 의 --win-bg / --popup-bg / --text 와 같은 값
const WINDOW_COLORS = {
  light: { win: '#eef0f2', popup: '#d9dcde', text: '#1d1d1f' },
  dark: { win: '#1f2023', popup: '#2b2d30', text: '#f5f5f7' },
};
const themeColors = (dark) => WINDOW_COLORS[dark ? 'dark' : 'light'];

/** Windows 창 버튼 띠. 재질(Mica)을 쓰면 띠를 비워 앱 바탕과 한 띠로 보이게 하고 기호 색만 테마를 따른다 */
function titleBarOverlay({ dark, material, height }) {
  const c = themeColors(dark);
  return { color: material ? '#00000000' : c.win, symbolColor: c.text, height };
}

// 프로그램별 소리 받기(WASAPI process loopback)는 Windows 10 Build 20348 부터 (Microsoft 문서 AUDIOCLIENT_ACTIVATION_TYPE).
// 일반 Windows 10(19045 까지)은 못 쓰고 Windows 11(22000~)은 쓴다. 못 쓰는 PC 는 마이크로만 받는다
const LOOPBACK_MIN_BUILD = 20348;
const LOOPBACK_UNSUPPORTED = '이 Windows 버전에서는 프로그램별 소리 받기를 쓸 수 없습니다. 마이크를 쓰세요.';

function supportsProcessLoopback(platform, release) {
  if (platform !== 'win32') return false;
  const build = Number(String(release).split('.')[2]);
  return Number.isInteger(build) && build >= LOOPBACK_MIN_BUILD;
}

// 사용 가이드 창 (맥과 같은 760×860). 화면이 낮으면 작업 영역 높이에 맞춘다 (창 제목 막대 몫 40 을 뺀 내용 높이). 폭은 그대로
const GUIDE_SIZE = Object.freeze({ width: 760, height: 860 });
function guideSize(workArea) {
  const h = Number(workArea?.height);
  if (!(h > 0)) return { ...GUIDE_SIZE };
  return { width: GUIDE_SIZE.width, height: Math.min(GUIDE_SIZE.height, Math.round(h - 40)) };
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * 트레이 아이콘 근처에 팝업을 띄울 자리. 작업 표시줄이 어느 쪽에 붙었는지는
 * 아이콘이 작업 영역 밖 어느 쪽에 있는지로 판단한다. 어느 경우든 작업 영역 안으로 당긴다.
 */
function popupPosition(tray, work, size, gap = 8) {
  const minX = work.x + gap;
  const maxX = work.x + work.width - size.width - gap;
  const minY = work.y + gap;
  const maxY = work.y + work.height - size.height - gap;

  if (!tray || !(tray.width > 0) || !(tray.height > 0)) return { x: maxX, y: maxY };

  const cx = tray.x + tray.width / 2;
  const cy = tray.y + tray.height / 2;
  let x;
  let y;
  if (cy < work.y) {
    x = cx - size.width / 2;
    y = minY;
  } else if (cx < work.x) {
    x = minX;
    y = cy - size.height / 2;
  } else if (cx >= work.x + work.width) {
    x = maxX;
    y = cy - size.height / 2;
  } else {
    // 아래쪽 작업 표시줄(기본), 또는 아이콘이 작업 영역 안(숨은 아이콘 창)일 때: 아이콘 위로
    x = cx - size.width / 2;
    y = Math.min(tray.y - size.height - gap, maxY);
  }
  return { x: Math.round(clamp(x, minX, maxX)), y: Math.round(clamp(y, minY, maxY)) };
}

/** helper list 결과를 화면에 보일 소리 출처 목록으로. 기본 마이크 → 다른 마이크 → 프로그램 */
/** selfPid: Ezrite 자신의 pid — 창이 있는 프로그램도 목록에 오므로 자기 창은 뺀다 */
function buildSources(list, { selfPid = null, appsAllowed = true } = {}) {
  if (!list) return [];
  const mics = [...(list.mics || [])].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const out = mics.map((m) => ({
    id: `mic:${m.id}`,
    label: m.isDefault ? '기본 마이크' : m.name,
    detail: m.isDefault ? m.name : '',
    kind: 'mic',
  }));
  // 프로그램은 exe 이름으로 기억한다 (맥은 번들 id). pid 는 다시 켜면 바뀌므로 녹음을 시작할 때 지금 pid 를 쓴다
  const seen = new Set();
  for (const a of (appsAllowed ? list.apps : null) || []) {
    if (selfPid != null && a.pid === selfPid) continue;
    const id = `app:${a.exe.toLowerCase()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: a.exe.replace(/\.exe$/i, ''), detail: a.title || '', kind: 'app', pid: a.pid });
  }
  return out;
}

/**
 * 출처 id → helper capture 인자 ({pid} 또는 {mic}). 알 수 없으면 null.
 * 프로그램(app:exe)은 지금 목록(sources)에서 그 exe 의 pid 를 찾는다. 소리를 안 내고 있으면 null
 */
function captureArgsFor(id, sources = []) {
  const s = String(id ?? '');
  if (s.startsWith('app:')) {
    const src = sources.find((x) => x.id === s && !x.missing && Number.isInteger(x.pid));
    return src ? { pid: src.pid } : null;
  }
  if (s.startsWith('pid:')) {
    const pid = Number(s.slice(4));
    return Number.isInteger(pid) && pid > 0 ? { pid } : null;
  }
  if (s.startsWith('mic:')) {
    const mic = s.slice(4);
    return mic ? { mic } : null;
  }
  return null;
}

/**
 * "내 목소리도 함께": 프로그램 소리(또는 시험 파일)를 받을 때 켜져 있으면 기본 마이크(목록의 첫 마이크)를 섞는다.
 * 마이크를 출처로 고르면 이미 내 목소리가 들어가므로 쓰지 않는다 (맥 mixMic: source != .mic && includeMic)
 */
function mixArgs(args, { includeMic, sources }) {
  if (!args) return null;
  if (!includeMic || args.mic) return args;
  const mic = sources.find((s) => s.kind === 'mic' && s.id.startsWith('mic:'));
  return mic ? { ...args, mixMic: mic.id.slice(4) } : args;
}

/** 고른 프로그램이 켜져 있지 않을 때 (맥 "선택한 앱이 실행 중이 아닙니다. 앱을 켠 뒤 다시 시작하세요.") */
function notPlayingMessage(label) {
  return `${label} 이(가) 켜져 있지 않습니다. 프로그램을 켠 뒤 다시 시작하세요.`;
}

/**
 * 목록을 새로 읽을 때 고른 출처가 빠졌으면 뒤에 붙여 둔다 (맥 refreshSources 와 같다).
 * 프로그램은 앱을 다시 켜도(처음 실행 때도) exe 이름으로 남기고 "지금 켜져 있지 않음" 이라고 적는다
 */
function keepSelected(next, prev, selectedId, { appsAllowed = true } = {}) {
  if (!selectedId || next.some((s) => s.id === selectedId)) return next;
  if (selectedId.startsWith('app:')) {
    if (!appsAllowed) return next; // 이 Windows 에서는 프로그램 소리를 받을 수 없다
    const exe = selectedId.slice(4);
    return [...next, { id: selectedId, label: exe.replace(/\.exe$/i, ''), detail: '지금 켜져 있지 않음', kind: 'app', missing: true }];
  }
  const kept = (prev || []).find((s) => s.id === selectedId);
  return kept ? [...next, kept] : next;
}

/**
 * helper(ezrite-audio.exe)를 찾을 자리. 설치한 앱은 설치 폴더의 resources (electron-builder extraResources),
 * 개발 중에는 helper/target 의 release 빌드를 먼저, 없으면 debug 빌드
 */
function helperCandidates({ packaged, resourcesPath, appDir }) {
  const path = require('node:path');
  if (packaged) return [path.join(resourcesPath, 'ezrite-audio.exe')];
  return ['release', 'debug'].map((kind) => path.join(appDir, '..', 'helper', 'target', kind, 'ezrite-audio.exe'));
}

/** 녹음에 쓸 출처 인자. 시연 대본 → {demo}, 시험 파일 → {testfile}, 아니면 고른 출처 (captureArgsFor) */
function sourceArgs(dev, sourceId, sources) {
  if (dev.capturePid) return { pid: dev.capturePid };
  if (dev.demoScript) return { demo: true };
  if (dev.testFile) return { testfile: true };
  return captureArgsFor(sourceId, sources);
}

/** 소리 크기를 보낼 창: 보이는 팝업·전체 창 모두 (숨기면 빼고, 다시 열면 다시 받는다) */
function levelTargets(wins) {
  return wins.filter((w) => w && !w.isDestroyed() && w.isVisible());
}

/** Electron 44+ 의 clipboard.writeText 는 Promise. 끝난 뒤에만 알리고, 실패는 안내 문구로 바꾼다 */
async function copyText(clip, text) {
  try {
    await clip.writeText(text);
    return '전체 복사함';
  } catch (e) {
    return `복사하지 못했습니다: ${e.message}`;
  }
}

module.exports = {
  copyText, levelTargets, GUIDE_SIZE, guideSize, supportsProcessLoopback, LOOPBACK_MIN_BUILD, LOOPBACK_UNSUPPORTED, sourceArgs, THEME_OPTIONS, themeSource, themeColors, titleBarOverlay, notPlayingMessage, mixArgs, helperCandidates, PREVIEWS, parseDevEnv, supportsMaterial, popupPosition, buildSources, captureArgsFor, keepSelected };
