'use strict';

const {
  app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, ipcMain, screen, shell, dialog, clipboard, protocol, globalShortcut,
} = require('electron');
const { Readable } = require('stream');
const path = require('path');
const fs = require('fs');

// 처리 안 된 예외는 기본 오류 창 대신 %APPDATA%\Ezrite\logs\main.log 로 쓰고 앱 안 알림으로 알린다.
// 다른 앱 모듈을 부르기 전에 달아서, 불러오는 중의 오류도 창으로 뜨지 않게 한다
const LOG_DIR = path.join(process.env.APPDATA || app.getPath('appData'), 'Ezrite', 'logs');
const { appendLine } = require('./lib/crashlog');
// 앱 기록 (1.3.2, 맥 ~/Library/Logs/Ezrite): %LOCALAPPDATA%\Ezrite\logs\ezrite-YYYY-MM-DD.log. 시험 중·EZRITE_NO_LOG=1 이면 쓰지 않는다 (lib/applog.js)
const log = require('./lib/applog');
const APP_LOG_DIR = path.join(process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local'), 'Ezrite', 'logs');
log.open({ dir: APP_LOG_DIR });
require('./lib/crashlog').install({
  logDir: LOG_DIR,
  onError: (msg) => {
    log.error('앱', `처리 안 된 오류: ${log.err(msg)}`);
    try {
      showNotice(`문제가 생겨 기록해 두었습니다: ${msg}`);
    } catch {
      // 상태가 아직 준비되지 않았으면 로그만 남긴다
    }
  },
});

const { execFile, execFileSync, spawn } = require('child_process');
const { parseListOutput, LevelMeter } = require('./lib/audio');
const os = require('os');
const { parseDevEnv, supportsMaterial, popupPosition, buildSources, keepSelected, helperCandidates, mixArgs, notPlayingMessage, sourceArgs, supportsProcessLoopback, LOOPBACK_UNSUPPORTED, guideSize, levelTargets,
  themeSource, themeColors, titleBarOverlay, copyText } = require('./lib/ui');
const { mixedSource } = require('./lib/mixer');
const { flattenBGRA, hexColor, decodeBMP } = require('./lib/png');
const sample = require('./lib/sample');
const { KeyStore } = require('./lib/keystore');
const { GroqClient } = require('./lib/groq');
const AI = require('./lib/ai');
const Providers = require('./lib/providers');
const { translate: translateWith, translateScreen } = require('./lib/translation');
const { Transcriber, languageCode, MESSAGES } = require('./lib/transcriber');
const { LiveSession, usageFooter } = require('./lib/live');
const { parseWav, wavFeed } = require('./lib/devfeed');
const { loadDemoScript, DemoScript, demoSource, fakeLevel } = require('./lib/demoscript');
const { fakeFetch } = require('./lib/fakegroq');
const notes = require('./lib/notes');
const Saved = require('./lib/saved');
const { PcmFile, finishAudio, parseRange } = require('./lib/recording');
const Settings = require('./lib/settings');
const { Budget } = require('./lib/budget');
const { AIClient } = require('./lib/ai');
const { CostMeter } = require('./lib/cost');
const { releasesURL, summaries } = require('./lib/releases');
const { Updater, issueURL } = require('./lib/updater');
const { SelfUpdate, UPDATE_DIR_NAME } = require('./lib/selfupdate');
const PKG = require('./package.json');
const E = require('./lib/explain');
const { Explainer } = require('./lib/explainer');
const ExplainUI = require('./explain-ui');
const MarkStyle = require('./lib/markstyle');
const { DesktopWatch } = require('./lib/desktop');
const { PingWatch, watchMain, spin } = require('./lib/hangwatch');
const { ScreenTranslate } = require('./lib/screentranslate');
const TranslateUI = require('./translate-ui');
const { windowAt, panelRect } = require('./lib/windowpick');

// 녹음 듣기용 주소 ezrite-note://audio/<기록이름>.m4a 또는 /<기록 폴더>/<기록이름>.m4a.
// 저장 폴더 안 이 앱 기록의 .m4a 만 내준다 (renderer 가 아무 파일이나 읽지 못하게, notes.audioFile)
protocol.registerSchemesAsPrivileged([
  { scheme: 'ezrite-note', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

const dev = parseDevEnv(process.env);
// 설치한 앱: Chromium 이 쓰는 캐시·저장소는 %LOCALAPPDATA%\Ezrite 로. 기본값(%APPDATA%\Ezrite)은 키·기록 폴더와 겹친다
if (app.isPackaged && process.env.LOCALAPPDATA) app.setPath('userData', path.join(process.env.LOCALAPPDATA, 'Ezrite'));
// 평소에는 Windows 배율을 그대로 따른다. 시험할 때만 EZRITE_TEST_SCALE로 100%·150% 등을 흉내 낸다
if (dev.testScale) app.commandLine.appendSwitch('force-device-scale-factor', String(dev.testScale));
// Mica(전체 창)·Acrylic(팝업). 스크린샷(capturePage)에는 재질이 안 찍히므로 그때는 단색으로 그린다
const material = supportsMaterial(process.platform, os.release()) && !dev.shot;

// 창 아이콘 (작업 표시줄·제목 막대). 설치한 앱은 exe 아이콘과 같다 (scripts/make-app-icon.py)
const APP_ICON = path.join(__dirname, 'assets', 'app.ico');
const POPUP = { width: 340, height: 344 };
const COMPACT = { width: 340, height: 94 };
const TITLE_H = 32; // Windows 창 버튼(titleBarOverlay) 높이 = 위 띠 높이
const MAIN = { width: 380, height: TITLE_H + 460 };
// 맥은 560폭. 맑은 고딕이 맥 글꼴보다 넓어 줄이 더 꺾이므로 조금 넓히고, 높이는 내용에 맞춘다 (window:fit)
const ONBOARDING = { width: 600, height: TITLE_H + 758 };

const colors = () => themeColors(nativeTheme.shouldUseDarkColors);

let tray = null;
let popup = null;
let mainWin = null;
let onboardingWin = null;

const state = {
  sources: [],
  sourceId: null,
  language: '한국어',
  languages: ['한국어', 'English', '日本語'],
  listening: false,
  paused: false,
  quietPaused: false, // 조용해서 저절로 쉬는 중 (1.1.5). 수동 일시정지(paused)와 따로
  startedAt: null,
  recordedBefore: 0,
  notice: null,
  error: null,
  options: { autoTranslate: true, askBeforeRecord: true, includeMic: false, autoPauseQuiet: true },
  markStyle: MarkStyle.FALLBACK, // 설명 표시 방식 (1.3.0, 맥 markStyle)
  markStyles: MarkStyle.groups(), // 설정 목록 (묶음별)
  compact: false,
  page: 'live',
  entries: [],
  sessions: [],
  footer: { audio: null, translate: null, explain: null, uses: null, captions: {} },
  cost: null, // 이번 실행 AI 비용 { label: "$0.03", caption } 또는 null(숨김) (1.2.3, lib/cost.js)
  releases: [], // 설정의 버전별 요약 [{ version, lines }] (1.2.3, lib/releases.js)
  notesFolder: '', // 사용자가 고른 저장 위치. 빈 글이면 기본 위치
  notesDir: '', // 화면에 보일 저장 위치
  liveSession: null, // 지금 쓰고 있는 기록 파일 (지난 기록의 "진행 중")
  opened: null, // 지난 기록에서 연 기록 { path, title, date, audio, audioSrc, live, entries }
  saved: null, // 방금 끝난 녹음의 기록 "저장됨" 띠 { path, target, place, help } (lib/saved.js)
  version: app.getVersion(),
  appAudio: true, // 프로그램별 소리 받기를 쓸 수 있는 Windows 인지 (설정에 안내)
  hasKey: false, // 키 자체는 화면 쪽으로 보내지 않는다. 있는지만
  keyStatus: null, // Groq 키 줄 아래 한 줄 (처음 설정 안내). providerStatus.groq 와 같다
  ai: Settings.DEFAULTS.ai, // 기능별 AI: 서비스·모델, 받아 온 모델 목록 (lib/settings.js)
  aiView: null, // 화면에 보낼 고르기 칸과 키 있음/없음 (키 자체는 보내지 않는다)
  providerStatus: {}, // 서비스 → 키 확인 결과 한 줄
  modelCheck: {}, // "서비스.용도" → 모델 확인 결과 한 줄
  checking: {}, // 서비스 또는 "서비스.용도" → 확인을 시작한 때(ms). 확인 중일 때만
  inflight: 0,
  micReady: false,
  sample: false,
  explaining: false, // "설명해줘" 진행 중 (✨ 단추가 돌아간다)
  userGuide: '', // AI 지침
  update: { available: null, checking: false, checkedAt: null, current: app.getVersion() }, // 새 버전 (lib/updater.js)
  install: { phase: null, percent: null, error: null, waiting: null }, // 앱 안 업데이트 진행 (1.2.4, lib/selfupdate.js)
  openAtLogin: false, // 로그인할 때 자동 실행
  loginItemAvailable: app.isPackaged, // 개발 중(electron.exe)에는 바꾸지 않는다
  build: `${app.getVersion()} (Windows ${os.release()})`,
  screenTx: { active: false, title: null, reason: null }, // 화면 번역 (실험 기능, 1.3.2 예정)
};
// 다음 실행 때도 그대로 둘 설정 (맥 UserDefaults 자리). 미리보기·스크린샷은 사용자 설정을 바꾸지 않는다
const SETTINGS_FILE = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Ezrite', 'settings.json');
const keepSettings = !dev.preview && !dev.shot;
{
  const saved = Settings.load(SETTINGS_FILE);
  Object.assign(state, {
    language: saved.language, options: saved.options, notesFolder: saved.notesFolder, sourceId: saved.sourceId, userGuide: saved.userGuide, theme: saved.theme,
    ai: saved.ai, markStyle: saved.markStyle,
  });
  state.welcomed = saved.welcomed;
}
if (dev.preview) Object.assign(state, sample.state());
// 미리보기·스크린샷은 EZRITE_THEME 을 고른 것처럼 보인다 (사용자 설정 파일은 건드리지 않는다)
if (dev.preview && dev.theme !== 'system') state.theme = dev.theme;
// 화면 테마: 설정값(시스템·밝게·어둡게). 트레이 아이콘은 이것과 상관없이 작업 표시줄 색을 따른다
nativeTheme.themeSource = themeSource(state.theme, dev.theme);

/** 지금 저장 위치. 기본 위치에서만 30일 지난 기록을 지운다 (맥 Notes.dir) */
function notesDir() {
  return state.notesFolder || notes.defaultDir();
}
function notesDirLabel() {
  return state.notesFolder || '%APPDATA%\\Ezrite\\notes\\autosave';
}
state.notesDir = notesDirLabel();

function persistSettings() {
  if (!keepSettings) return;
  try {
    Settings.save(SETTINGS_FILE, {
      language: state.language, sourceId: state.sourceId, notesFolder: state.notesFolder, options: state.options,
      userGuide: state.userGuide, welcomed: state.welcomed, theme: state.theme, ai: state.ai, markStyle: state.markStyle,
    });
  } catch {
    // 설정을 못 써도 앱은 돈다
  }
}

function windows() {
  return [popup, mainWin, onboardingWin].filter((w) => w && !w.isDestroyed());
}

/** "설명해줘" 화면 사진에서 뺄 창 (상태를 받지 않는 사용 가이드 포함) */
function appWindows() {
  return [...windows(), guideWin].filter((w) => w && !w.isDestroyed());
}

function broadcast() {
  for (const w of windows()) w.webContents.send('state', state);
  updateTrayIcon();
}

function setState(patch) {
  Object.assign(state, patch);
  broadcast();
}

// ── helper (Rust) ──

/** 설치한 앱은 resources 폴더, 개발 중에는 release 빌드를 먼저 찾고 없으면 debug 빌드 (lib/ui.js helperCandidates) */
function helperPath() {
  const found = helperCandidates({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appDir: __dirname })
    .find((p) => fs.existsSync(p));
  if (found) return found;
  throw new Error(app.isPackaged ? 'ezrite-audio.exe를 찾지 못함 (다시 설치해 보세요)' : 'ezrite-audio.exe를 찾지 못함 (helper를 먼저 cargo build 하세요)');
}

function listSources() {
  return new Promise((resolve, reject) => {
    let exe;
    try {
      exe = helperPath();
    } catch (e) {
      reject(e);
      return;
    }
    execFile(exe, ['list'], { windowsHide: true, timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`helper list 실패: ${stderr || err.message}`));
        return;
      }
      try {
        resolve(parseListOutput(stdout));
      } catch (e) {
        reject(e);
      }
    });
  });
}

// 프로그램별 소리 받기는 Windows 10 Build 20348 부터. 못 쓰는 PC 는 마이크만 보이고, 예전에 고른 프로그램이 있었으면 한 번 알린다
const appAudio = supportsProcessLoopback(process.platform, os.release());
let loopbackNoticed = false;
state.appAudio = appAudio;

async function refreshSources() {
  try {
    const list = await listSources();
    if (!appAudio && state.sourceId?.startsWith('app:') && !loopbackNoticed) {
      loopbackNoticed = true;
      showNotice(LOOPBACK_UNSUPPORTED);
    }
    const opts = { appsAllowed: appAudio };
    let sources = keepSelected(buildSources(list, { selfPid: process.pid, ...opts }), state.sources, state.sourceId, opts);
    if (state.sample && !sources.length) sources = sample.state().sources;
    const sourceId = sources.some((s) => s.id === state.sourceId) ? state.sourceId : sources[0]?.id ?? null;
    setState({ sources, sourceId, micReady: state.micReady || list.mics.length > 0 });
  } catch (e) {
    setState({ error: e.message });
  }
}

function sendLevel(v) {
  // 작은 창에는 막대가 없다
  for (const w of levelTargets([state.compact ? null : popup, mainWin])) w.webContents.send('level', v);
}

// ── 받아쓰기: 소리 출처 → VAD → Transcriber (lib/live.js) ──

const keystore = new KeyStore();
const usage = {}; // 모델 → { remaining, limit } (응답 헤더)

// Claude·Gemini·GPT (그리고 키 확인 때 Groq 모델 목록). 키는 keystore 에서 그때그때 읽는다
const costMeter = new CostMeter(); // 앱을 켠 뒤로 (끄면 처음부터)
const aiClient = new AIClient({
  getKey: (p) => {
    try {
      return keystore.read(p);
    } catch {
      return null;
    }
  },
  onSpent: (model, kind, amount) => {
    budget.note(model, kind, amount);
    saveBudget();
  },
  // 이번 실행 AI 비용 (팝업 아래 줄). Groq 는 무료라 따로 더하지 않는다
  onCost: (p, model, input, output) => {
    costMeter.add(p, model, input, output);
    const label = costMeter.label();
    setState({ cost: label ? { label, caption: costMeter.caption() } : null });
  },
});

/** 그 서비스의 키가 있나 (Groq 는 hasKey) */
function keyPresent(p) {
  if (p === 'groq') return hasKey();
  try {
    return keystore.has(p);
  } catch {
    return false;
  }
}

/** 화면에 보낼 기능별 AI 칸: 키는 있다/없다만 */
function aiView() {
  return {
    keys: Object.fromEntries(AI.PROVIDERS.map((p) => [p, keyPresent(p)])),
    translate: Providers.featureView(state.ai, 'translate', keyPresent),
    explain: Providers.featureView(state.ai, 'explain', keyPresent),
  };
}

/** 키가 있나. 키 파일을 못 읽어도 앱은 돌고, 녹음 시작 때 "키 없음"으로 안내된다 */
function hasKey() {
  if (dev.fakeGroq) return true;
  try {
    return keystore.has('groq');
  } catch {
    return false;
  }
}

// 하루 토큰·음성 시간 (맥 Budget). 앱을 껐다 켜도 이어진다. 미리보기·스크린샷은 사용자 기록을 읽지도 쓰지도 않는다
const BUDGET_FILE = path.join(path.dirname(SETTINGS_FILE), 'usage.json');
const budget = keepSettings ? Budget.load(BUDGET_FILE) : new Budget();
function saveBudget() {
  if (!keepSettings) return;
  try {
    budget.save(BUDGET_FILE);
  } catch {
    // 못 써도 앱은 돈다
  }
}
function refreshFooter() {
  if (!state.sample) setState({ footer: usageFooter(usage, budget, Date.now(), { translate: state.ai.translateProvider, explain: state.ai.explainProvider }) });
}

const groq = new GroqClient({
  // EZRITE_FAKE_GROQ: 네트워크에 나가지 않는 가짜 응답 (키 없이 화면 확인용)
  fetch: dev.fakeGroq ? fakeFetch() : globalThis.fetch,
  getKey: () => (dev.fakeGroq ? 'fake-key' : keystore.read('groq')),
  onUsage: (model, u) => {
    usage[model] = u;
    refreshFooter();
  },
  // 응답에 실린 쓴 양 (토큰 수 또는 음성 초)
  onSpent: (model, kind, amount) => {
    budget.note(model, kind, amount);
    saveBudget();
    refreshFooter();
  },
  // 수식 역슬래시로 Groq 이 거절한 JSON 을 다시 묻지 않고 고쳐 쓴다 (맥 lenientJSON)
  lenientJSON: E.lenientJSON,
});

const transcriber = new Transcriber({
  groq,
  translate: (lines, context) => translateWith(lines, context, {
    provider: state.ai.translateProvider, model: state.ai.translateModel, groq, ai: aiClient, onNotice: showNotice,
  }),
  language: () => languageCode(state.language),
  autoTranslate: () => state.options.autoTranslate,
});

/** helper capture 를 소리 출처로 연다. 저절로 끝나면(장치 빠짐 등) onEnd 로 알린다 */
function openHelper(args, { onData, onEnd }) {
  const argv = args.pid ? ['capture', '--pid', String(args.pid)] : ['capture', '--mic', args.mic];
  const child = spawn(helperPath(), argv, { windowsHide: true });
  let stopped = false;
  let errText = '';
  child.stdout.on('data', onData);
  child.stderr.on('data', (d) => {
    errText = (errText + d.toString()).slice(-500);
  });
  child.on('error', (e) => {
    errText = e.message;
  });
  child.on('exit', (code) => {
    if (stopped) return;
    stopped = true;
    onEnd(`helper 종료 (code ${code})${errText.trim() ? `: ${errText.trim()}` : ''}`);
  });
  return {
    stop() {
      stopped = true;
      child.kill();
    },
  };
}

/** EZRITE_TESTFILE: helper 대신 wav 를 소리처럼 흘린다 */
/**
 * 출처 열기. "내 목소리도 함께"면 프로그램 소리와 마이크 helper 를 함께 열어 섞는다 (lib/mixer.js).
 * EZRITE_TESTFILE 이면 프로그램 소리 자리에 시험 파일을 흘린다 (마이크는 진짜 helper — 섞이는지 확인용)
 */
function openSourceFor() {
  if (dev.demoScript) return demo ? demoSource(demo) : () => { throw new Error(demoError); };
  const feed = dev.testFile ? wavFeed(parseWav(fs.readFileSync(dev.testFile)).pcm, { speed: dev.speed }) : null;
  const one = (args, cbs) => (args.testfile ? feed(args, cbs) : openHelper(args, cbs));
  return (args, cbs) => mixedSource(one, args, {
    ...cbs,
    // 맥에는 없는 알림: 마이크만 끊기면 프로그램 소리는 계속 받는다
    onMicLost: () => showNotice('마이크 소리가 끊겼습니다 — 프로그램 소리만 받아 적습니다'),
  });
}

// 개발용 시연 대본 (EZRITE_DEMO_SCRIPT): 소리·Groq 받아쓰기 대신 대본 줄을 받아쓴 것처럼 띄운다. 없으면 아무 일도 하지 않는다
let demo = null;
let demoError = null;
if (dev.demoScript) {
  try {
    demo = new DemoScript(loadDemoScript(dev.demoScript), {
      pending: (on) => transcriber.setInflight(on ? 1 : 0),
      line: (text, time) => transcriber.addScripted(text, time).id,
      translate: (id, ko) => { if (state.options.autoTranslate) transcriber.setTranslation(id, ko); },
    });
  } catch (e) {
    demoError = e.message;
  }
}

// 조용하면 자동 일시정지 (1.1.5): 말소리가 30초 없으면 쉰다. 시연 대본은 소리가 무음이라 쓰지 않는다
const QUIET_SECS = 30;
const session = new LiveSession({
  transcriber, openSource: openSourceFor(), hasKey,
  quietAfter: () => (state.options.autoPauseQuiet && !dev.demoScript ? QUIET_SECS : null),
});
session.on('start', () => demo?.reset());
session.on('change', (patch) => setState(patch));
session.on('notice', (message) => showNotice(message));

// 소리 크기 막대: 약 50ms(800샘플)마다 갱신
const levelMeter = new LevelMeter();
session.on('start', () => levelMeter.reset());
session.on('pcm', (chunk) => {
  if (demo) {
    // 시연 대본: 소리는 무음이라 말하는 것처럼 보이는 가짜 크기를 보낸다
    sendLevel({ level: fakeLevel(Date.now() / 1000), rms: 0 });
    return;
  }
  // 프로그램 소리·마이크·섞은 소리 모두 같은 조각이 온다 (lib/mixer.js 가 섞은 뒤)
  const out = levelMeter.push(chunk);
  if (out) sendLevel(out[out.length - 1]);
});

// ── 기록 저장: 기록마다 폴더 하나 (저장 폴더/기록이름/). 받아 적은 줄 → 기록이름.txt (+ .times.json),
//    소리 → 기록이름.pcm → 끝내면 .m4a. 모두 그 폴더 안에 (맥 1.1.3 Notes.swift) ──

let writer = null; // 지금 녹음의 기록 파일 (다음 녹음을 시작할 때까지 늦게 온 결과도 여기에 쓴다)
let pcmFile = null;
const encoding = new Set(); // m4a 로 바꾸는 중인 일 (종료할 때 기다린다)

/** helper 를 실행해 stdout 을 돌려준다 */
function runHelper(args, timeout = 10 * 60_000) {
  return new Promise((resolve, reject) => {
    let exe;
    try {
      exe = helperPath();
    } catch (e) {
      reject(e);
      return;
    }
    execFile(exe, args, { windowsHide: true, timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

/** .pcm 을 .m4a 로. 실패하면 .pcm 을 남겨 두고 다음 실행 때 다시 한다 */
function encodeLater(pcm) {
  // 맥은 60초 조각을 합친다. Windows 는 .pcm 한 조각을 m4a 로 바꾼다 — 같은 자리라 "합침" 으로 남긴다 (10초 넘으면 WARN)
  const t0 = Date.now();
  const job = finishAudio(pcm, { run: runHelper })
    .then((dest) => {
      const ms = Date.now() - t0;
      if (dest) log[ms > 10_000 ? 'warn' : 'info']('소리 파일', `조각 합침(m4a) ${log.secs(ms)}`);
    })
    .catch((e) => {
      log.error('소리 파일', `합치기(m4a) 실패 — .pcm 남김: ${log.err(e)}`);
      showNotice(`녹음 소리를 m4a 로 바꾸지 못했습니다 — 다음 실행 때 다시 합니다 (${e.message})`);
    })
    .finally(() => {
      encoding.delete(job);
      reloadSessions();
      if (state.opened) openNote(state.opened.path);
    });
  encoding.add(job);
  return job;
}

session.on('start', () => {
  setState({ saved: Saved.next(state.saved, { event: 'start' }) });
  writer = new notes.Writer(notesDir());
  try {
    pcmFile = new PcmFile(writer.planned.replace(/\.txt$/, '.pcm'));
  } catch (e) {
    pcmFile = null;
    log.error('소리 파일', `열기 실패: ${log.err(e)}`);
    showNotice(`녹음 소리를 저장할 수 없습니다: ${e.message}`);
  }
  setState({ liveSession: null });
});
// 받은 조각 그대로이되, 조용해서 쉬는 동안은 오지 않는다 (LiveSession 'record')
session.on('record', (chunk) => pcmFile?.write(chunk));
session.on('stop', () => {
  // 받아 적은 글이 있을 때만 (없으면 기록이 남지 않는다) — 맥 Transcriber.stop 의 savedSession = writer.url
  setState({ saved: Saved.next(state.saved, { event: 'stop', written: writer?.path ?? null }) });
  const f = pcmFile;
  pcmFile = null;
  if (f) {
    const t0 = Date.now();
    f.close();
    log.info('소리 파일', `닫음 — 소리 ${f.seconds.toFixed(1)}초 (.pcm 한 조각), 닫기 ${Date.now() - t0}ms`);
    encodeLater(f.path);
  }
  reloadSessions();
});

/** 첫 줄을 쓰면 기록 파일이 생긴다. 지난 기록 목록에 "진행 중"으로 보인다 */
function wrote() {
  if (writer?.path && state.liveSession !== writer.path) {
    setState({ liveSession: writer.path });
    reloadSessions();
  }
}
transcriber.on('entry', (e) => { writer?.append(e.original); wrote(); });
transcriber.on('gap', (e) => { writer?.append(e.original); wrote(); });
// 번역은 원문 바로 아래 줄에 들어가야 해서 파일을 통째로 다시 쓴다 (맥 Writer.rewrite)
transcriber.on('translated', () => writer?.rewrite(transcriber.entries));
transcriber.on('times', (times) => { if (writer?.path) notes.saveTimes(times, writer.path); });

// ── 설명해줘: 화면 찍기 → helper ocr → Groq → 화면 표시 + 설명 카드 (lib/explainer.js, explain-ui.js) ──

let ocrN = 0;
// 글자를 읽는 도중 앱이 강제로 꺼지면 화면 사진이 임시 폴더에 남는다. 켤 때 지운다
try {
  for (const n of fs.readdirSync(os.tmpdir())) {
    if (/^ezrite-(?:ocr-\d+-\d+\.png|grab-\d+-\d+\.bmp)$/.test(n)) fs.rmSync(path.join(os.tmpdir(), n), { force: true });
  }
} catch {
  // 못 지워도 앱은 돈다
}
/** 화면 사진을 임시 파일로 써서 helper 로 글자를 읽고, 사진은 바로 지운다 */
async function ocrImage(png) {
  const file = path.join(os.tmpdir(), `ezrite-ocr-${process.pid}-${ocrN++}.png`);
  fs.writeFileSync(file, png);
  try {
    return JSON.parse(await runHelper(['ocr', file], 30_000));
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/**
 * 찍는 동안 잠깐 사진에서 뺄 우리 창. 팝업·전체 창은 "설명해줘"를 누른 그 한 번만 (지켜보기 때 껐다 켜면 녹화에서 깜박인다).
 * 설명 카드·표시 창은 처음부터 빠져 있다 (EZRITE_CAPTURABLE 일 때만 여기서 뺀다)
 */
function ourWindows(full) {
  const list = full ? appWindows() : [];
  if (dev.capturable) list.push(explainer.card?.win, explainer.overlay?.win);
  return list.filter((w) => w && !w.isDestroyed());
}

/** Electron 좌표(DIP) 사각형 → helper 가 쓰는 물리 픽셀 {x, y, w, h} */
function physical(r) {
  const p = screen.dipToScreenRect(null, r);
  return { x: p.x, y: p.y, w: p.width, h: p.height };
}

// 창 목록은 helper (windows). 가상 데스크톱 지켜보기(1.2.2)가 쓴다
async function listWindows() {
  const list = JSON.parse(await runHelper(['windows'], 10_000));
  if (dev.dockOnly) list.windows = list.windows.filter((w) => dev.dockOnly.includes(w.pid));
  return list;
}

/** 오래 도는 helper (desktop-watch): stdout 한 줄마다 onLine. 실패해도 조용히 (표시는 예전처럼 보인다) */
function helperLines(args, onLine) {
  let child;
  try {
    child = spawn(helperPath(), args, { windowsHide: true });
  } catch {
    return { kill() {} };
  }
  let rest = '';
  child.stdout.on('data', (d) => {
    const parts = (rest + d.toString()).split(/\r?\n/);
    rest = parts.pop();
    for (const line of parts) onLine(line);
  });
  child.on('error', () => {});
  return { kill: () => child.kill() };
}

// 가상 데스크톱 (1.2.2): 설명한 화면의 데스크톱을 떠나면 ①②③ 표시를 숨긴다 (lib/desktop.js)
const desktopWatch = new DesktopWatch({
  me: process.pid,
  list: listWindows,
  spawn: helperLines,
});

const explainer = new Explainer({
  groq,
  ai: aiClient,
  onNotice: (m) => showNotice(m),
  grab: (opts) => ExplainUI.grab(opts, ourWindows),
  ocr: ocrImage,
  context: () => ({
    // 최근 받아 적은 문장 12개 (맥 explain())
    transcript: transcriber.entries.filter((e) => e.kind === 'text').slice(-12).map((e) => e.original),
    guide: state.userGuide,
    provider: state.ai.explainProvider,
    model: state.ai.explainModel,
    style: state.markStyle,
  }),
  desktop: { watch: (display, onChange) => desktopWatch.watch(physical(display.bounds), onChange) },
  popupFrame: () => (popup && !popup.isDestroyed() && popup.isVisible() ? popup.getBounds() : null),
  createCard: (hooks) => ExplainUI.createCard(hooks, { capturable: dev.capturable }),
  createOverlay: (display, model) => ExplainUI.createOverlay(display, model, {
    // 표시 창은 녹음 팝업·카드보다 아래 (맥 floating+3 < +4). 띄운 뒤 팝업과 카드를 다시 위로
    capturable: dev.capturable,
    onShown: () => {
      if (popup && !popup.isDestroyed() && popup.isVisible()) popup.moveTop();
      explainer.card?.raise();
    },
  }),
  devQuestion: dev.ask,
  // EZRITE_CAPTURABLE 은 카드·표시를 녹화에 보이게 두는 대신 찍을 때마다 뺀다. 0.4초마다 지켜보면 녹화에서 깜박이므로 끈다
  watch: !dev.capturable,
  // 설명·질문 한 번에 쓴 토큰 → 남은 횟수 평균
  onUsed: (use, tokens) => {
    budget.average(use, tokens);
    saveBudget();
    refreshFooter();
  },
});
explainer.on('busy', (b) => setState({ explaining: b }));

// ── 화면 번역 (실험 기능, 1.3.2 예정, 맥 ScreenTranslate): 고른 창만 찍기 → 글자 읽기 → Groq → 그 창 위 덮개 (lib/screentranslate.js) ──

let grabN = 0;
let enOcr = null; // 영어 글자 인식 팩이 있나 (처음 읽을 때 안다)
let txOverlay = null;
const txOverlayWin = () => {
  if (!txOverlay || txOverlay.win.isDestroyed()) {
    txOverlay = TranslateUI.createOverlay({
      // 덮개는 팝업 아래 (덮개를 띄운 뒤 팝업을 다시 위로)
      onShown: () => { if (popup && !popup.isDestroyed() && popup.isVisible()) popup.moveTop(); },
    });
  }
  return txOverlay;
};
const screenTx = new ScreenTranslate({
  // 그 창 하나만 BMP 로 찍는다 (가려져 있어도 그 창 내용). 글자를 읽은 뒤 지운다
  grab: async (hwnd) => {
    const file = path.join(os.tmpdir(), `ezrite-grab-${process.pid}-${grabN++}.bmp`);
    const rect = JSON.parse(await runHelper(['grab', '--hwnd', String(hwnd), '--out', file], 15_000));
    try {
      return { rect, bitmap: decodeBMP(fs.readFileSync(file)), file };
    } catch (e) {
      fs.rmSync(file, { force: true });
      throw e;
    }
  },
  // 영어 글자 인식 팩이 있으면 그것으로 (번역할 글은 보통 영어). 한국어 팩으로 영어를 읽으면 0/o·5/s·1/l 이 자주 섞인다.
  // 없으면 기본(한국어 → 사용자 언어) 으로 읽고 한 번 알린다
  ocr: async (file) => {
    try {
      if (enOcr !== false) {
        try {
          const r = JSON.parse(await runHelper(['ocr', file, '--lang', 'en-US'], 30_000));
          enOcr = true;
          return r;
        } catch {
          enOcr = false;
          log.info('화면 번역', '영어 글자 인식 팩 없음 — 기본 인식으로 읽음');
          showNotice('영어 글자 인식 팩이 없어 영어를 잘못 읽을 수 있습니다 (Windows 설정 → 시간 및 언어 → 언어에 English 추가)');
        }
      }
      return JSON.parse(await runHelper(['ocr', file], 30_000));
    } finally {
      fs.rmSync(file, { force: true });
    }
  },
  // 설정의 번역 서비스로 (Groq 면 120b → qwen, 20b 는 영어를 그대로 돌려줘서 뺐다). 다른 서비스가 실패하면 Groq 로 (맥과 같다)
  translate: (texts) => translateScreen(texts, {
    provider: state.ai.translateProvider, model: state.ai.translateModel, groq, ai: aiClient, onNotice: showNotice,
  }),
  watch: (hwnd, onLine) => helperLines(['screen-watch', '--hwnd', String(hwnd), '--ms', '500'], (line) => {
    let v;
    try {
      v = JSON.parse(line);
    } catch {
      return;
    }
    onLine(v);
  }),
  overlay: {
    show: (rect, items, scale) => txOverlayWin().show(rect, items, scale),
    move: (rect) => txOverlay?.move(rect),
    hide: () => txOverlay?.hide(),
    reveal: (key) => txOverlay?.reveal(key),
  },
  cursor: () => screen.dipToScreenPoint(screen.getCursorScreenPoint()),
  scaleOf: (r) => screen.getDisplayMatching(screen.screenToDipRect(null, { x: r.x, y: r.y, width: r.w, height: r.h })).scaleFactor,
  ownPid: process.pid,
});
screenTx.on('change', (st) => {
  setState({ screenTx: st });
  if (st.reason) showNotice(`화면 번역을 멈췄습니다 — ${st.reason}`);
});
screenTx.on('notice', (m) => showNotice(m));

/** 번역할 수 있는 창 (이 앱 창은 빼고, 제목 있는 것). 맨 앞부터 */
async function translatableWindows() {
  const list = await listWindows();
  return list.windows.filter((w) => w.pid !== process.pid && w.title).map((w) => ({ hwnd: String(w.hwnd), title: w.title }));
}

/**
 * 마우스로 가리켜 번역할 창 고르기 (맥과 같다): 팝업을 닫고 화면마다 패널을 띄워 마우스 아래 창을 파랗게, 누르면 고름, Esc 면 취소.
 * 같은 앱 창이 여럿이어도 헷갈리지 않는다 (제목 목록 대신)
 */
let picking = null;
async function pickWindow() {
  if (picking || !state.options.screenTranslate) return;
  if (!hasKey()) {
    showNotice(MESSAGES.noKey);
    return;
  }
  if (popup && !popup.isDestroyed() && popup.isVisible()) popup.hide();
  let list;
  try {
    list = (await listWindows()).windows.filter((w) => w.pid !== process.pid && w.title);
  } catch (e) {
    showNotice(`창 목록을 읽지 못했습니다: ${e.message}`);
    return;
  }
  const panels = screen.getAllDisplays().map((d) => TranslateUI.createPicker(d));
  let current = null;
  const toDip = (r) => screen.screenToDipRect(null, r);
  const tick = () => {
    const hit = windowAt(list, screen.dipToScreenPoint(screen.getCursorScreenPoint()));
    if (hit === current) return;
    current = hit;
    for (const p of panels) p.highlight(panelRect(hit, p.display, toDip));
  };
  const timer = setInterval(tick, 50);
  // 고르는 동안만 Esc 를 전역 단축키로: 팝업을 닫은 뒤라 Windows 가 패널을 앞으로 못 내줄 수 있다 (포커스 없으면 키가 안 온다)
  let escKey = false;
  try {
    escKey = globalShortcut.register('Escape', () => picking?.finish(false));
  } catch {
    escKey = false;
  }
  const cursorAt = screen.getCursorScreenPoint();
  // Esc 를 받게 마우스가 있는 화면의 패널에 포커스
  const home = panels.find((p) => {
    const b = p.display.bounds;
    return cursorAt.x >= b.x && cursorAt.x < b.x + b.width && cursorAt.y >= b.y && cursorAt.y < b.y + b.height;
  }) ?? panels[0];
  home?.win.webContents.once('did-finish-load', () => setTimeout(() => home.focus(), 50));
  log.info('화면 번역', `창 고르기 — 창 ${list.length}개, 화면 ${panels.length}개`);
  picking = {
    finish(pick) {
      clearInterval(timer);
      if (escKey) globalShortcut.unregister('Escape');
      for (const p of panels) p.close();
      picking = null;
      if (pick && current) startScreenTx(String(current.hwnd));
      else log.info('화면 번역', '창 고르기 취소');
    },
    owns: (wc) => panels.some((p) => !p.win.isDestroyed() && p.win.webContents === wc),
  };
}

async function startScreenTx(hwnd) {
  if (!state.options.screenTranslate) return;
  if (!hasKey()) {
    showNotice(MESSAGES.noKey);
    return;
  }
  const win = (await translatableWindows()).find((w) => w.hwnd === String(hwnd));
  if (!win) {
    showNotice('그 창을 찾지 못했습니다');
    return;
  }
  screenTx.start({ hwnd: win.hwnd, title: win.title });
}

/** EZRITE_CARD: AI 없이 이 JSON 내용을 카드에 띄운다 (맥과 같다) */
function demoCard(value) {
  try {
    // 맥처럼 JSON 파일 경로. '{' 로 시작하면 JSON 글 그대로
    explainer.demo(JSON.parse(value.startsWith('{') ? value : fs.readFileSync(value, 'utf8')));
  } catch (e) {
    showNotice(`EZRITE_CARD 를 읽지 못했습니다: ${e.message}`);
  }
}

/** 앱이 죽어 남은 녹음(.pcm)을 m4a 로 바꾸고, 글 없는 소리와 (기본 위치면) 30일 지난 기록을 지운다 */
async function recoverAndPrune() {
  const dir = notesDir();
  // 지운 것은 이름과 이유를 main.log 에 한 줄씩 (1.2.4, 맥 "Ezrite 정리: <이름> 지움 (<이유>)")
  const logDeleted = (name, reason) => {
    appendLine(LOG_DIR, notes.cleanupLine(name, reason));
    log.info('정리', `${name} 지움 (${reason})`);
  };
  // 바꾸다 꺼진 반쪽 파일 (기록 폴더 안에도 생긴다)
  for (const folder of [dir, ...notes.subfolders(dir)]) {
    for (const n of fs.existsSync(folder) ? fs.readdirSync(folder) : []) {
      if (!n.startsWith('.encoding-')) continue;
      fs.rmSync(path.join(folder, n), { force: true });
      logDeleted(n, '변환 임시 파일');
    }
  }
  const pending = notes.pendingAudio(dir, logDeleted);
  if (pending.length) log.warn('소리 파일', `지난번에 못 합친 조각 ${pending.length}개 발견 — 지금 합친다`);
  for (const pcm of pending) {
    try {
      await finishAudio(pcm, { run: runHelper, onDelete: logDeleted });
    } catch (e) {
      // .pcm 은 남는다. 다음 실행 때 다시
      log.error('소리 파일', `지난 조각 합치기 실패: ${log.err(e)}`);
    }
  }
  try {
    notes.prune(dir, { autoDelete: !state.notesFolder, onDelete: logDeleted });
  } catch {
    // 정리를 못 해도 앱은 돈다
  }
  reloadSessions();
}

// ── 지난 기록 ──

function reloadSessions() {
  if (state.sample) return; // 미리보기는 예시 목록
  const live = state.listening ? state.liveSession : null;
  setState({ sessions: notes.sessions(notesDir()).map((s) => ({ ...s, live: s.path === live })) });
}

/** 녹음 듣기 주소. 바뀐 뒤(이름 바꾸기·다시 만들기) 옛 것이 남지 않게 수정 시각을 붙인다 */
function audioSrc(txt) {
  const m4a = txt.replace(/\.txt$/, '.m4a');
  if (!fs.existsSync(m4a)) return null;
  const rel = notes.audioRel(notesDir(), txt).split('/').map(encodeURIComponent).join('/');
  return `ezrite-note://audio/${rel}?v=${Math.round(fs.statSync(m4a).mtimeMs)}`;
}

function openNote(p) {
  const txt = notes.ownNote(notesDir(), p);
  if (!txt) {
    setState({ opened: null });
    return;
  }
  const live = state.listening && txt === state.liveSession;
  setState({
    opened: {
      path: txt,
      title: notes.title(txt),
      date: notes.startedAt(txt).getTime(),
      live,
      audio: live ? null : audioSrc(txt), // 녹음 중엔 소리 파일이 아직 없다
      entries: live ? [] : notes.load(txt), // 진행 중인 기록은 화면이 실시간 줄을 쓴다
    },
  });
}

/** 화면에서 넘어온 기록 경로를 확인하고, 녹음 중인 기록이면 막는다 */
function noteFor(p, { allowLive = false } = {}) {
  const txt = notes.ownNote(notesDir(), p);
  if (!txt) return null;
  if (!allowLive && state.listening && txt === state.liveSession) {
    showNotice('녹음 중인 기록은 끝난 뒤에 바꿀 수 있습니다');
    return null;
  }
  return txt;
}

function renameNote(p, newTitle) {
  const txt = noteFor(p);
  if (!txt || typeof newTitle !== 'string') return;
  try {
    const dest = notes.rename(txt, newTitle);
    if (state.saved?.path === txt) setState({ saved: Saved.banner(dest) });
    reloadSessions();
    openNote(dest);
  } catch (e) {
    showNotice(`이름을 바꾸지 못했습니다: ${e.message}`);
  }
}

async function deleteNote(p) {
  const txt = noteFor(p);
  if (!txt) return;
  const { response } = await dialog.showMessageBox(mainWin, {
    type: 'warning',
    buttons: ['휴지통으로 이동', '취소'],
    defaultId: 1,
    cancelId: 1,
    title: 'Ezrite',
    message: '이 기록을 지울까요?',
    detail: '받아 적은 글과 녹음 소리를 함께 휴지통으로 옮깁니다.',
    noLink: true,
  });
  if (response !== 0) return;
  setState({ opened: null, ...(state.saved?.path === txt ? { saved: null } : {}) }); // 듣던 소리를 먼저 놓는다
  const error = await notes.remove(txt, (f) => shell.trashItem(f));
  reloadSessions();
  if (error) {
    await dialog.showMessageBox(mainWin, { type: 'error', title: 'Ezrite', message: '기록을 지우지 못했습니다', detail: error, noLink: true });
  }
}

// Electron 43+ 는 defaultPath 가 없으면 늘 다운로드 폴더에서 연다. 마지막으로 고른 곳을 직접 기억한다
let lastExportDir;

async function exportNote(p) {
  const txt = noteFor(p);
  if (!txt) return;
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWin, {
    title: '내보낼 폴더', buttonLabel: '여기로 내보내기', properties: ['openDirectory', 'createDirectory'], defaultPath: lastExportDir,
  });
  if (canceled || !filePaths[0]) return;
  try {
    notes.exportTo(txt, filePaths[0]);
    lastExportDir = filePaths[0];
    showNotice(`내보냄 → ${path.basename(filePaths[0]) || filePaths[0]}`);
  } catch (e) {
    showNotice(`내보내지 못했습니다: ${e.message}`);
  }
}

async function copyNote(p) {
  const txt = noteFor(p, { allowLive: true });
  if (!txt) return;
  const entries = state.listening && txt === state.liveSession ? transcriber.entries : notes.load(txt);
  showNotice(await copyText(clipboard, notes.render(entries)));
}

function revealNote(p) {
  const txt = noteFor(p, { allowLive: true });
  if (txt) shell.showItemInFolder(txt);
}

/** 저장 위치 바꾸기 (맥 설정 "변경…"). 이전 위치의 기록은 옮기지 않는다 */
async function chooseNotesFolder() {
  if (state.listening) return;
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWin, {
    title: '저장 위치', buttonLabel: '여기에 저장', properties: ['openDirectory', 'createDirectory'], defaultPath: state.notesFolder || undefined,
  });
  if (canceled || !filePaths[0]) return;
  setNotesFolder(filePaths[0]);
}

function setNotesFolder(folder) {
  if (state.listening) return;
  state.notesFolder = folder;
  setState({ notesDir: notesDirLabel(), opened: null });
  persistSettings();
  reloadSessions();
}

/** 녹음 듣기: 저장 폴더 안 이 앱 기록의 .m4a 만 (예전 기록 옆, 기록 폴더 안), 막대를 옮길 수 있게 Range 요청도 받는다 */
function serveAudio(request) {
  const url = new URL(request.url);
  let rel;
  try {
    rel = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    rel = null;
  }
  const file = url.hostname === 'audio' ? notes.audioFile(notesDir(), rel) : null;
  if (!file) return new Response('not found', { status: 404 });
  const size = fs.statSync(file).size;
  const range = parseRange(request.headers.get('range'), size);
  const head = { 'Content-Type': 'audio/mp4', 'Accept-Ranges': 'bytes' };
  if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...head, 'Content-Range': `bytes */${size}` } });
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const body = Readable.toWeb(fs.createReadStream(file, { start, end }));
  return new Response(body, {
    status: range ? 206 : 200,
    headers: { ...head, 'Content-Length': String(end - start + 1), ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) },
  });
}

/** 위쪽 줄에 잠깐 띄우는 알림. 6초 뒤 저절로 사라진다 (맥 AppState.notice) */
let noticeTimer = null;
function showNotice(message) {
  clearTimeout(noticeTimer);
  setState({ notice: message });
  noticeTimer = setTimeout(() => setState({ notice: null }), 6000);
}

/** 지금 고른 출처의 capture 인자. 시험 파일을 흘릴 때는 출처가 없어도 된다 */
function currentArgs() {
  const base = sourceArgs(dev, state.sourceId, state.sources);
  if (dev.demoScript) return base; // 시연 대본은 마이크도 열지 않는다
  return mixArgs(base, { includeMic: state.options.includeMic, sources: state.sources });
}

function sourceLabel() {
  return state.sources.find((s) => s.id === state.sourceId)?.label ?? '';
}

/** 녹음 시작. 프로그램 출처는 목록을 새로 읽어 그 exe 의 지금 pid 로 받는다 (다시 켠 프로그램도 이어서 고를 수 있게) */
async function startRecord() {
  if (!appAudio && !dev.testFile && !dev.demoScript && state.sourceId?.startsWith('app:')) {
    setState({ error: LOOPBACK_UNSUPPORTED });
    return;
  }
  if (dev.demoScript && !demo) {
    setState({ error: demoError });
    return;
  }
  if (!dev.testFile && !dev.demoScript && state.sourceId?.startsWith('app:')) await refreshSources();
  const args = currentArgs();
  if (!args) {
    const src = state.sources.find((s) => s.id === state.sourceId);
    log.warn('녹음', src?.kind === 'app' ? '시작 못 함 — 고른 프로그램이 소리를 내지 않음' : '시작 못 함 — 출처 없음');
    setState({ error: src?.kind === 'app' ? notPlayingMessage(src.label) : '소리 출처를 먼저 고르세요 (설정 → 소리 출처)' });
    return;
  }
  if (session.start(args)) {
    const kind = dev.demoScript ? '시연 대본' : args.testfile ? '시험 파일' : args.pid ? '프로그램' : '마이크';
    const o = state.options;
    log.info('녹음', `시작 — 출처 ${kind}, 마이크 섞기 ${args.mixMic ? 'on' : 'off'}, 언어 ${state.language}, 자동 번역 ${o.autoTranslate ? 'on' : 'off'}, 조용하면 쉬기 ${o.autoPauseQuiet ? 'on' : 'off'}`);
  }
}

/** 단추를 누른 곳 (앱 기록) */
function pressedIn(e) {
  const w = e ? BrowserWindow.fromWebContents(e.sender) : null;
  if (w && w === popup) return state.compact ? '작은 창' : '팝업';
  if (w && w === mainWin) return '전체 창';
  return '앱';
}

function stopRecord() {
  session.stop();
  sendLevel({ level: 0, rms: 0 });
}

function togglePause() {
  if (state.paused) {
    const args = currentArgs();
    if (args) session.resume(args);
    else setState({ error: notPlayingMessage(sourceLabel()) });
  }
  else {
    session.pause();
    sendLevel({ level: 0, rms: 0 });
  }
}

// ── 키 (Groq 만. 다른 서비스 키는 다음 단계) ──

/** 키 확인 결과 한 줄. started: 확인을 시작한 때(진행 표시의 경과 초), 끝났으면 null */
function setProviderStatus(p, text, started = null) {
  const providerStatus = { ...state.providerStatus, [p]: text };
  const checking = { ...state.checking };
  if (started) checking[p] = started;
  else delete checking[p];
  setState({ providerStatus, checking, ...(p === 'groq' ? { keyStatus: text } : {}) });
}

/** 기능별 AI 설정을 바꾸고 화면·게이지에 알린다 */
function setAI(ai) {
  state.ai = ai;
  setState({ ai, aiView: aiView() });
  persistSettings();
  refreshFooter();
}

/** 키를 저장(빈 글이면 지움)한다. 키는 로그·상태·오류 어디에도 싣지 않는다 (맥 AppState.saveKey) */
function saveKey(provider, key) {
  if (!AI.isProvider(provider) || typeof key !== 'string') return;
  const trimmed = key.trim();
  if (!trimmed) {
    removeKey(provider);
    return;
  }
  const bad = Providers.keyShapeError(trimmed);
  if (bad) {
    setProviderStatus(provider, bad);
    return;
  }
  try {
    keystore.save(trimmed, provider);
  } catch (e) {
    setProviderStatus(provider, `✕ ${e.message}`);
    return;
  }
  if (provider === 'groq') {
    const saved = hasKey();
    setState({ hasKey: saved, error: saved && state.error === MESSAGES.noKey ? null : state.error });
  }
  setState({ aiView: aiView() });
  verifyStoredKey(provider);
}

/** 키 확인: 모델 목록을 받고, Groq 가 아니면 용도별로 실제로 답하는 모델을 기본으로 정한다 */
async function verifyStoredKey(p) {
  // 가짜 Groq(화면 확인용)는 네트워크에 나가지 않는다
  if (dev.fakeGroq && p === 'groq') {
    setProviderStatus(p, '연결됨');
    return;
  }
  const started = Date.now();
  setProviderStatus(p, '키 확인 중', started);
  const r = await Providers.verifyKey(p, aiClient, (text) => {
    if (state.checking[p] === started) setProviderStatus(p, text, started);
  });
  if (state.checking[p] !== started) return; // 그 사이 다시 저장했거나 지웠다
  setAI(Providers.withVerified(state.ai, p, r));
  setProviderStatus(p, r.status);
}

function removeKey(p) {
  try {
    keystore.remove(p);
  } catch (e) {
    setProviderStatus(p, `✕ ${e.message}`);
    return;
  }
  const providerStatus = { ...state.providerStatus };
  const checking = { ...state.checking };
  delete providerStatus[p];
  delete checking[p];
  setState({ providerStatus, checking, ...(p === 'groq' ? { hasKey: hasKey(), keyStatus: null } : {}) });
  setAI(Providers.afterRemove(state.ai, p));
}

/** 설정에서 고른 모델을 바로 불러 봐서 쓸 수 있는지 알려 준다 (맥 checkModel) */
async function checkModel({ provider, model, feature }) {
  const k = `${provider}.${feature}`;
  const modelCheck = { ...state.modelCheck };
  const checking = { ...state.checking };
  if (provider === 'groq' || !model) {
    delete modelCheck[k];
    delete checking[k];
    setState({ modelCheck, checking });
    return;
  }
  const started = Date.now();
  setState({ modelCheck: { ...modelCheck, [k]: '확인 중' }, checking: { ...checking, [k]: started } });
  const reason = await aiClient.check(provider, model);
  // 그 사이 다른 모델로 바꿨으면 버린다
  if (state.ai[`${feature}Model`] !== model || state.checking[k] !== started) return;
  const done = { ...state.checking };
  delete done[k];
  setState({ modelCheck: { ...state.modelCheck, [k]: Providers.checkLine(reason) }, checking: done });
}

/** 기능별 AI 고르기: { feature, provider } 또는 { feature, model } */
function chooseAI(choice) {
  const r = Providers.applyChoice(state.ai, choice, keyPresent);
  if (r.ai === state.ai) return;
  setAI(r.ai);
  if (r.check) checkModel(r.check);
}

function applyPatch(patch) {
  const next = {};
  if (typeof patch.sourceId === 'string' && state.sources.some((s) => s.id === patch.sourceId)) {
    next.sourceId = patch.sourceId;
  }
  if (state.languages.includes(patch.language)) next.language = patch.language;
  if (['live', 'history', 'settings'].includes(patch.page)) next.page = patch.page;
  if (next.page === 'settings') refreshReleases(); // 버전별 요약 (1.2.3)
  if (typeof patch.compact === 'boolean') next.compact = patch.compact;
  if (typeof patch.userGuide === 'string') next.userGuide = patch.userGuide.slice(0, Settings.GUIDE_MAX);
  if (Settings.THEMES.includes(patch.theme)) next.theme = patch.theme;
  if (MarkStyle.IDS.includes(patch.markStyle)) next.markStyle = patch.markStyle;
  if (typeof patch.openAtLogin === 'boolean' && state.loginItemAvailable) next.openAtLogin = setOpenAtLogin(patch.openAtLogin);
  if (patch.options && typeof patch.options === 'object') {
    const options = { ...state.options };
    for (const k of Object.keys(options)) {
      if (typeof patch.options[k] === 'boolean') options[k] = patch.options[k];
    }
    next.options = options;
  }
  const sourceChanged = next.sourceId && next.sourceId !== state.sourceId;
  const includeMicBefore = state.options.includeMic;
  const quietBefore = state.options.autoPauseQuiet;
  const languageChanged = next.language && next.language !== state.language;
  setState(next);
  if (next.sourceId || next.language || next.options || next.userGuide != null || next.theme || next.markStyle) persistSettings();
  // 떠 있는 설명에도 바로 (화면 표시 다시 그리기 + 카드 restyle. 질문 답이 떠 있으면 카드는 그대로)
  if (next.markStyle) explainer.restyle(next.markStyle);
  // 열려 있는 창(팝업·설정·안내·가이드)이 바로 바뀐다. 색이 실제로 안 바뀌면 nativeTheme 'updated' 가 안 오므로 직접 부른다
  if (next.theme) {
    nativeTheme.themeSource = themeSource(next.theme, dev.theme);
    applyTheme();
  }
  if (next.page === 'history') reloadSessions();
  // 녹음 중에 바꾸면 같은 기록에 이어 받고, 바꾼 자리를 남긴다 (맥 switchSource / languageChanged)
  // "내 목소리도 함께"를 바꿔도 출처를 다시 붙이고 "+ 마이크" 자리를 남긴다 (마이크 출처면 이 옵션은 쓰지 않는다)
  const micChanged = next.options && next.options.includeMic !== includeMicBefore && !state.sourceId?.startsWith('mic:');
  if ((sourceChanged || micChanged) && !dev.testFile && !dev.demoScript && state.listening) {
    const args = currentArgs();
    if (args) session.switchSource(args, sourceLabel());
    else {
      // 고른 프로그램이 소리를 안 낸다 (맥: 캡처를 못 붙이면 오류를 보이고 멈춘다)
      stopRecord();
      setState({ error: notPlayingMessage(sourceLabel()) });
    }
  }
  if (languageChanged) session.languageChanged(state.language);
  // 녹음 중에 끄면 쉬던 것을 바로 이어 가고, 켜면 그때부터 30초를 센다
  if (next.options && next.options.autoPauseQuiet !== quietBefore) session.quietSettingChanged();
  if (typeof next.compact === 'boolean') resizePopup();
  if (next.options && !next.options.screenTranslate && screenTx.active) screenTx.stop();
}

// ── 트레이 아이콘 ──

/** 작업 표시줄이 어두우면(Windows 기본) 흰 아이콘. 레지스트리를 못 읽으면 어두운 것으로 본다 */
function taskbarIsLight() {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
      '/v', 'SystemUsesLightTheme'], { windowsHide: true, encoding: 'utf8' });
    return /0x1\b/.test(out);
  } catch {
    return false;
  }
}

/** 트레이 아이콘 (.ico 안에 16/20/24/32px). scripts/make-tray-icon.js 가 SVG에서 만든다 */
function trayImage(recording) {
  const name = recording ? 'tray-rec.ico' : taskbarIsLight() ? 'tray-light.ico' : 'tray-dark.ico';
  return nativeImage.createFromPath(path.join(__dirname, 'assets', name));
}

let trayRecording = null;
function updateTrayIcon() {
  const rec = state.listening && !state.paused;
  if (!tray || trayRecording === rec) return;
  trayRecording = rec;
  tray.setImage(trayImage(rec));
}

// ── 창 ──

const webPreferences = {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: false,
  // 재질을 쓰는지 화면 쪽에 알려 바탕을 비워 둔다 (app.css html.material)
  additionalArguments: material ? ['--ezrite-material'] : [],
};

/** 재질을 쓰면 창 바탕을 비워 두고 Windows가 칠하게, 아니면 테마 단색 */
function windowLook(kind) {
  if (material) return { backgroundMaterial: kind, backgroundColor: '#00000000' };
  return { backgroundColor: kind === 'acrylic' ? colors().popup : colors().win };
}

function overlayFor() {
  return titleBarOverlay({ dark: nativeTheme.shouldUseDarkColors, material, height: TITLE_H });
}

function applyTheme() {
  const c = colors();
  for (const w of [mainWin, onboardingWin]) {
    if (!w || w.isDestroyed()) continue;
    w.setTitleBarOverlay(overlayFor());
    if (!material) w.setBackgroundColor(c.win);
  }
  if (popup && !popup.isDestroyed() && !material) popup.setBackgroundColor(c.popup);
  if (guideWin && !guideWin.isDestroyed()) guideWin.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7');
  if (tray) {
    trayRecording = null;
    updateTrayIcon();
  }
}

function createPopup() {
  popup = new BrowserWindow({
    ...POPUP,
    show: false,
    icon: APP_ICON,
    frame: false,
    ...windowLook('acrylic'),
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'Ezrite 팝업',
    webPreferences,
  });
  popup.loadFile(path.join(__dirname, 'renderer', 'popup.html'));
  roundCorners(popup);
  // 바깥을 눌러도 닫지 않는다. 트레이 아이콘을 다시 누를 때까지 떠 있다 (맥 StatusBar: 강의 창을 누르며 받아쓰기를 봐야 한다)
}

/**
 * 테두리 없는 창에 Windows 11 둥근 모서리(DWMWCP_ROUND)를 켠다. Electron roundedCorners는 macOS 전용이라
 * helper(corner --hwnd)가 DwmSetWindowAttribute를 부른다. 실패해도(Windows 10 등) 모서리가 각질 뿐이다
 */
function roundCorners(win) {
  let exe;
  try {
    exe = helperPath();
  } catch {
    return;
  }
  const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0).toString();
  execFile(exe, ['corner', '--hwnd', hwnd], { windowsHide: true, timeout: 5000 }, () => {});
}

// 새 버전·저장됨 띠는 내용 위에 겹쳐 뜬다 (1.3.2, 맥과 같다). 띠가 생겨도 팝업 크기는 그대로
function popupSize() {
  return state.compact ? COMPACT : POPUP;
}

function placePopup() {
  const size = popupSize();
  const bounds = tray ? tray.getBounds() : { x: 0, y: 0, width: 0, height: 0 };
  const display = bounds.width ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay();
  const { x, y } = popupPosition(bounds, display.workArea, size);
  popup.setBounds({ x, y, ...size });
}

/** 보통 ↔ 작은 창. 아래쪽 가장자리를 그대로 두고 높이만 바꾼다 (작업 표시줄 위에 붙어 있으므로) */
function resizePopup() {
  if (!popup || popup.isDestroyed()) return;
  const size = popupSize();
  const b = popup.getBounds();
  popup.setBounds({ x: b.x, y: b.y + b.height - size.height, ...size });
}

function showPopup() {
  placePopup();
  popup.show();
  popup.focus();
  refreshSources();
}

function togglePopup() {
  if (popup.isVisible()) popup.hide();
  else showPopup();
}

/**
 * 흰 화면이 번쩍이지 않게 다 그려진 뒤에 창을 보인다. Mica 창은 숨긴 채로는 ready-to-show가
 * 오지 않을 때가 있어서, 페이지를 다 읽고 잠시 뒤에도 그린 것으로 친다
 */
function trackPainted(win) {
  win.ezPainted = false;
  const done = () => {
    if (win.ezPainted) return;
    win.ezPainted = true;
    win.emit('ez-painted');
  };
  win.once('ready-to-show', done);
  win.webContents.once('did-finish-load', () => setTimeout(done, 150));
}

function showWhenPainted(win) {
  const show = () => {
    win.show();
    win.focus();
  };
  if (win.ezPainted) show();
  else win.once('ez-painted', show);
}

function createMain() {
  mainWin = new BrowserWindow({
    ...MAIN,
    useContentSize: true,
    minWidth: MAIN.width,
    minHeight: MAIN.height,
    show: false,
    icon: APP_ICON,
    title: 'Ezrite',
    titleBarStyle: 'hidden',
    titleBarOverlay: overlayFor(),
    ...windowLook('mica'),
    webPreferences,
  });
  // Mica + 최소 크기를 같이 주면 최대화가 꺼진 채로 만들어진다 (Electron 33). 최대화 단추와 스냅 레이아웃을 살린다
  mainWin.setMaximizable(true);
  mainWin.loadFile(path.join(__dirname, 'renderer', 'main.html'));
  trackPainted(mainWin);
  // 창을 닫으면 숨긴다. 종료는 팝업의 전원 버튼이나 트레이 메뉴에서.
  mainWin.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWin.hide();
    }
  });
}

function showMain(page) {
  if (page) applyPatch({ page });
  else if (state.page === 'settings') refreshReleases();
  if (popup?.isVisible() && !state.compact) popup.hide();
  showWhenPainted(mainWin);
  refreshSources();
}

function showOnboarding() {
  if (onboardingWin && !onboardingWin.isDestroyed()) {
    onboardingWin.focus();
    return;
  }
  onboardingWin = new BrowserWindow({
    ...ONBOARDING,
    useContentSize: true,
    minWidth: ONBOARDING.width,
    show: false,
    icon: APP_ICON,
    title: 'Ezrite 시작하기',
    titleBarStyle: 'hidden',
    titleBarOverlay: overlayFor(),
    ...windowLook('mica'),
    webPreferences,
  });
  onboardingWin.setMaximizable(true);
  onboardingWin.loadFile(path.join(__dirname, 'renderer', 'onboarding.html'));
  trackPainted(onboardingWin);
  showWhenPainted(onboardingWin);
}

/**
 * EZRITE_SHOT: 다 그려진 뒤 창 내용을 PNG로 저장하고 끝낸다.
 * Windows 창 버튼(titleBarOverlay)은 웹 내용 밖이라 안 찍힌다 (화면 캡처로 따로 본다)
 */
function shoot(win) {
  const save = async () => {
    await new Promise((r) => setTimeout(r, dev.shotDelay));
    if (dev.shotScroll) {
      // 스크롤되는 칸(설정·지난 기록)을 내린다
      await win.webContents.executeJavaScript(`for (const e of document.querySelectorAll('.settings, .sessions, .scroll')) e.scrollTop = ${dev.shotScroll}`);
      await new Promise((r) => setTimeout(r, 300));
    }
    const shot = await win.webContents.capturePage();
    // 재질(Mica·Acrylic) 창은 바탕이 투명하게 찍힌다. 창 바탕색 위에 얹어 늘 불투명하게 저장한다 (가이드 그림이 검게 보이지 않게)
    const size = shot.getSize();
    const bitmap = shot.toBitmap();
    const k = Math.sqrt(bitmap.length / 4 / (size.width * size.height)); // 비트맵은 실제 점 크기 (배율이 1 이 아닐 때)
    const flat = flattenBGRA(bitmap, hexColor(win === popup ? colors().popup : colors().win));
    const img = nativeImage.createFromBitmap(flat, { width: Math.round(size.width * k), height: Math.round(size.height * k) });
    fs.mkdirSync(path.dirname(dev.shot), { recursive: true });
    fs.writeFileSync(dev.shot, img.toPNG());
    app.isQuitting = true;
    app.quit();
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', save);
  else save();
}

function openPreview(name) {
  let win;
  if (name === 'popover' || name === 'compact') {
    applyPatch({ compact: name === 'compact' });
    showPopup();
    win = popup;
  } else if (name === 'onboarding') {
    showOnboarding();
    win = onboardingWin;
  } else if (name === 'guide') {
    showGuide();
    win = guideWin;
  } else {
    showMain(name);
    win = mainWin;
  }
  if (dev.shot) shoot(win);
}

// ── 사용 가이드 · 처음 한 번 · 오픈소스 고지 · 로그인할 때 실행 ──

let guideWin = null;

/** 사용 가이드 (맥 showGuide: Resources/web/guide.html). 넘기는 슬라이드 7장 */
function showGuide() {
  if (guideWin && !guideWin.isDestroyed()) {
    guideWin.show();
    guideWin.focus();
    return;
  }
  guideWin = new BrowserWindow({
    ...guideSize(screen.getPrimaryDisplay().workArea), // 760×860, 낮은 화면은 높이만 맞춘다
    useContentSize: true,
    show: false,
    icon: APP_ICON,
    title: 'Ezrite 사용 가이드',
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7',
    // 가이드는 앱 상태·IPC 가 필요 없는 정적 페이지라 preload 를 주지 않는다
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  guideWin.removeMenu();
  guideWin.loadFile(path.join(__dirname, 'renderer', 'guide', 'guide.html'));
  trackPainted(guideWin);
  showWhenPainted(guideWin);
}

/** 처음 한 번: 팝업을 열고 사용 가이드를 띄운다 (맥 welcome — 트레이 아이콘만 생겨서 설치됐는지 모르기 쉽다) */
function welcome() {
  state.welcomed = true;
  persistSettings();
  showGuide();
  // 가이드가 뜬 뒤에 팝업을 연다 (먼저 열면 가이드가 포커스를 가져가 팝업이 바로 닫힌다)
  guideWin.once('show', () => setTimeout(showPopup, 300));
}

/** 오픈소스 고지: 설치한 앱은 resources\ThirdPartyNotices.txt, 개발 중에는 build 의 같은 파일 (scripts/make-notices.js) */
function noticesPath() {
  return app.isPackaged ? path.join(process.resourcesPath, 'ThirdPartyNotices.txt') : path.join(__dirname, 'build', 'ThirdPartyNotices.txt');
}

/** 로그인할 때 자동 실행 (Windows 시작 프로그램). 설치한 앱에서만 바꾼다 — 개발 중엔 electron.exe 가 등록된다 */
function setOpenAtLogin(on) {
  try {
    app.setLoginItemSettings({ openAtLogin: on });
  } catch {
    // 못 바꾸면 지금 값 그대로
  }
  return app.getLoginItemSettings().openAtLogin;
}

// ── 새 버전 (맥 Updater) ──

/** EZRITE_UPDATE_JSON: '{' 로 시작하면 JSON 글, 아니면 파일 경로 (맥은 파일 경로) */
function fakeRelease() {
  if (!dev.updateJSON) return null;
  if (dev.updateJSON.startsWith('{')) return dev.updateJSON;
  try {
    return fs.readFileSync(dev.updateJSON, 'utf8');
  } catch {
    return '';
  }
}

// 앱 안 업데이트 (1.2.4): [업데이트] → 설치 파일을 직접 받아 조용히 설치하고 다시 켠다 (lib/selfupdate.js)
const selfUpdate = new SelfUpdate({
  current: app.getVersion(),
  dir: path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), UPDATE_DIR_NAME),
  // 녹음 중·방금 끝난 녹음을 m4a 로 바꾸는 중에는 설치하지 않는다 (설치기가 앱을 닫으면 .pcm 이 남는다)
  busy: () => state.listening || state.paused || state.quietPaused || encoding.size > 0,
  localExe: dev.updateExe,
  spawn,
  quit: () => {
    app.isQuitting = true;
    app.quit();
  },
  onChange: (install) => setState({ install }),
});

let autoUpdated = false; // EZRITE_UPDATE_NOW: 한 번만 누른다
const updater = new Updater({
  repo: PKG.ezriteUpdateRepo,
  current: app.getVersion(),
  fakeJSON: fakeRelease(),
  onChange: (update) => {
    // 설치 파일 자산이 있어야 [업데이트] (앱이 받아 설치). 없으면 띠 단추는 [받기] = 브라우저 (맥과 같다)
    setState({ update: { ...update, canInstall: Boolean(update.available?.installer || dev.updateExe) } });
    if (dev.updateNow && update.available && !autoUpdated) {
      autoUpdated = true;
      selfUpdate.install(update.available.installer);
    }
  },
});

// 설정의 버전별 요약 (1.2.3, lib/releases.js). 설정을 열 때 받는다. GitHub 은 키 없이 시간당 60번까지라 10분 안에는 다시 받지 않는다.
// 미리보기·스크린샷은 네트워크에 나가지 않는다 (예시 데이터)
const RELEASES_EVERY_MS = 10 * 60_000;
let releasesAt = 0;
async function refreshReleases() {
  const url = releasesURL(PKG.ezriteUpdateRepo);
  if (!url || dev.preview || dev.shot || Date.now() - releasesAt < RELEASES_EVERY_MS) return;
  releasesAt = Date.now();
  try {
    const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Ezrite' }, signal: AbortSignal.timeout(20_000) });
    // 404(비공개 저장소)·한도 초과는 조용히 — 요약 없이 버전 카드만 보인다
    if (res.status === 200) setState({ releases: summaries(await res.text()) });
    else releasesAt = 0;
  } catch {
    releasesAt = 0;
  }
}

// ── IPC ──

function registerIpc() {
  ipcMain.handle('state:get', () => state);
  ipcMain.handle('state:set', (_e, patch) => applyPatch(patch || {}));
  ipcMain.handle('sources:refresh', () => refreshSources());
  ipcMain.handle('record:start', (e) => {
    log.info('녹음', `시작 누름 (${pressedIn(e)})`);
    return startRecord();
  });
  ipcMain.handle('record:stop', (e) => {
    log.info('녹음', `끝내기 누름 (${pressedIn(e)})`);
    return stopRecord();
  });
  ipcMain.handle('record:pause', (e) => {
    log.info('녹음', `${state.paused ? '다시 시작' : '일시정지'} 누름 (${pressedIn(e)})`);
    return togglePause();
  });
  // 화면 멈춤 감시: preload 가 ping 에 바로 답한다 (lib/hangwatch.js)
  ipcMain.on('ez:pong', (e, n) => pingWatch?.pong(e.sender.id, n));
  // 창이 화면에 그려지는지 (levelTargets 가 본다)
  ipcMain.on('window:shown', (e, v) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) w.ezShown = v === true;
  });
  ipcMain.handle('window:main', (_e, page) => showMain(page));
  ipcMain.handle('window:onboarding', () => showOnboarding());
  ipcMain.handle('key:save', (_e, provider, key) => saveKey(provider, key));
  ipcMain.handle('key:remove', (_e, provider) => saveKey(provider, ''));
  ipcMain.handle('ai:choose', (_e, choice) => chooseAI(choice));
  // 저장됨 띠: 경로는 renderer 가 아니라 main 의 상태에서만 꺼낸다
  ipcMain.handle('saved:dismiss', () => setState({ saved: null }));
  ipcMain.handle('saved:open', () => {
    const p = state.saved?.path;
    if (!p) return;
    setState({ saved: Saved.next(state.saved, { event: 'open' }) }); // 확인했으니 띠를 내린다 (맥 1.1.4)
    showMain('history');
    openNote(p);
  });
  ipcMain.handle('saved:reveal', () => {
    const t = state.saved?.target;
    if (t && fs.existsSync(t)) shell.showItemInFolder(t);
  });
  // 키 발급 페이지만 연다 (renderer 는 서비스 이름만 고른다. 주소는 main 이 정한다)
  ipcMain.handle('open:keyPage', (_e, provider) => shell.openExternal(AI.KEY_PAGE[AI.isProvider(provider) ? provider : 'groq']));
  // 안내 창은 스크롤 없이 내용 높이에 맞춘다 (화면 작업 영역을 넘지는 않는다)
  ipcMain.handle('window:fit', (e, height) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win !== onboardingWin || !Number.isFinite(height)) return;
    const work = screen.getDisplayMatching(win.getBounds()).workArea;
    const h = Math.min(Math.ceil(height), work.height - 16);
    win.setContentSize(ONBOARDING.width, h);
  });
  ipcMain.handle('history:open', (_e, p) => openNote(p));
  ipcMain.handle('history:close', () => setState({ opened: null }));
  ipcMain.handle('history:rename', (_e, p, t) => renameNote(p, t));
  ipcMain.handle('history:delete', (_e, p) => deleteNote(p));
  ipcMain.handle('history:export', (_e, p) => exportNote(p));
  ipcMain.handle('history:copy', (_e, p) => copyNote(p));
  ipcMain.handle('history:reveal', (_e, p) => revealNote(p));
  ipcMain.handle('notes:choose', () => chooseNotesFolder());
  ipcMain.handle('notes:default', () => setNotesFolder(''));
  ipcMain.handle('explain:run', () => { explainer.run(); });
  // 화면 번역 (실험 기능): 창 목록은 제목·핸들만 (내용은 보내지 않는다)
  ipcMain.handle('screentx:windows', () => (state.options.screenTranslate ? translatableWindows().catch(() => []) : []));
  ipcMain.handle('screentx:start', (_e, hwnd) => (/^\d{1,20}$/.test(String(hwnd)) ? startScreenTx(String(hwnd)) : undefined));
  ipcMain.handle('screentx:stop', () => screenTx.stop());
  ipcMain.handle('screentx:pick', () => pickWindow());
  ipcMain.on('pick:click', (e) => { if (picking?.owns(e.sender)) picking.finish(true); });
  ipcMain.on('pick:cancel', (e) => { if (picking?.owns(e.sender)) picking.finish(false); });
  // 새 버전: [받기] 는 lib/updater.js 가 확인한 GitHub 주소만 연다
  ipcMain.handle('update:download', () => {
    const url = updater.available?.download;
    if (url) shell.openExternal(url);
  });
  // [업데이트]: 앱이 직접 받아 설치한다. 실패하면 띠에 오류와 [받기](위 브라우저 길)가 남는다
  ipcMain.handle('update:install', () => selfUpdate.install(updater.available?.installer ?? null));
  ipcMain.handle('update:skip', () => updater.skip());
  ipcMain.handle('update:check', () => updater.checkNow());
  ipcMain.handle('window:guide', () => showGuide());
  ipcMain.handle('open:issue', () => {
    const url = issueURL(PKG.ezriteUpdateRepo, app.getVersion(), `Windows ${os.release()}`);
    if (url) shell.openExternal(url);
  });
  ipcMain.handle('open:notices', () => shell.openPath(noticesPath()));
  ipcMain.handle('open:micSettings', () => shell.openExternal('ms-settings:privacy-microphone'));
  ipcMain.handle('onboarding:done', () => {
    if (onboardingWin && !onboardingWin.isDestroyed()) onboardingWin.close();
    welcome();
  });
  ipcMain.handle('app:quit', (e) => {
    log.info('앱', `종료 누름 (${pressedIn(e)})`);
    app.isQuitting = true;
    app.quit();
  });
}

// 웹 페이지처럼 굴지 않게: 다른 주소로 넘어가기·새 창 열기를 막는다
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showPopup());

  app.whenReady().then(async () => {
    startAppLog();
    Menu.setApplicationMenu(null);
    protocol.handle('ezrite-note', serveAudio);
    registerIpc();
    nativeTheme.on('updated', applyTheme);

    createPopup();
    createMain();

    tray = new Tray(trayImage(false));
    trayRecording = false;
    tray.setToolTip('Ezrite');
    tray.setContextMenu(null);
    tray.on('click', togglePopup);
    tray.on('right-click', () => {
      tray.popUpContextMenu(Menu.buildFromTemplate([
        { label: '창 열기', click: () => showMain() },
        { label: '처음 설정 안내', click: () => showOnboarding() },
        { type: 'separator' },
        { label: '종료', click: () => { log.info('앱', '종료 누름 (트레이 메뉴)'); app.isQuitting = true; app.quit(); } },
      ]));
    });

    // 미리보기 예시는 맥 스크린샷처럼 "키 있음"으로 둔다. 그 밖에는 실제 키 파일을 본다
    if (!state.sample) setState({ hasKey: hasKey() });
    setState({ aiView: aiView() });
    if (state.loginItemAvailable) setState({ openAtLogin: app.getLoginItemSettings().openAtLogin });
    // 켤 때와 6시간마다 새 버전 확인. 미리보기·스크린샷은 EZRITE_UPDATE_JSON 이 있을 때만 (네트워크에 나가지 않게)
    if (dev.updateJSON || (!dev.preview && !dev.shot)) updater.start();
    // 업데이트 뒤 다시 켜졌으면 받았던 설치 파일을 지운다 (지금 버전 이하·받다 만 것). 다시 켜진 직후엔
    // 설치기가 아직 그 파일을 잡고 있을 수 있어, 못 지웠으면 1분 뒤 한 번 더
    if (!dev.preview && !dev.shot && selfUpdate.cleanup().length) setTimeout(() => selfUpdate.cleanup(), 60_000).unref?.();
    // 한도는 24시간에 걸쳐 차오른다. 1분마다 다시 내어 막대와 횟수가 따라 오르게 한다 (맥 TimelineView 60초)
    refreshFooter();
    setInterval(refreshFooter, 60_000);
    await refreshSources();
    if (dev.preview) openPreview(dev.preview);
    // 처음 켰을 때: 키가 없으면 키·권한 안내, 있으면 팝업과 사용 가이드 (맥과 같다). 개발용 실행에서는 띄우지 않는다
    if (!dev.preview && !dev.shot && !dev.testFile && !dev.card && dev.explainAfter == null) {
      if (!hasKey()) showOnboarding();
      else if (!state.welcomed) welcome();
    }
    // 미리보기·스크린샷은 사용자 기록 폴더를 건드리지 않는다
    if (!dev.preview && !dev.shot) recoverAndPrune();
    else reloadSessions();
    // 맥 EZRITE_TESTFILE: 켜자마자 그 파일을 소리처럼 흘려 넣으며 받아쓰기를 시작한다
    if (dev.testFile) startRecord();
    if (dev.card) {
      demoCard(dev.card);
      // EZRITE_CARD + EZRITE_SHOT (미리보기 없이): 설명 카드 내용을 찍는다
      if (dev.shot && !dev.preview && explainer.card) shoot(explainer.card.win);
    }
    // 맥 EZRITE_EXPLAIN=<초>: 그 시간 뒤에 "설명해줘"를 한 번 누른다
    if (dev.explainAfter != null) setTimeout(() => explainer.run(), dev.explainAfter * 1000);
    runScript();
  });
}

// ── 앱 기록 · 멈춤 감시 (1.3.2, 맥 AppLog·HangWatch) ──

let pingWatch = null;
const GB = (b) => (b / 1024 ** 3).toFixed(1);

/** 앱 창 이름 (기록용) */
function windowName(wc) {
  const named = [[popup, state.compact ? '작은 창' : '팝업'], [mainWin, '전체 창'], [onboardingWin, '처음 안내'], [guideWin, '사용 가이드'],
    [explainer.card?.win, '설명 카드'], [explainer.overlay?.win, '화면 표시']];
  const hit = named.find(([w]) => w && !w.isDestroyed() && w.webContents === wc);
  return hit ? hit[1] : '창';
}

/** 멈춘 화면의 hang-시각.txt: 어느 창·얼마나·그 프로세스 CPU·메모리 (Windows 는 화면 스택을 뜰 수 없다, lib/hangwatch.js) */
function uiHangFile(t, ms) {
  try {
    const pid = t.win.webContents.getOSProcessId();
    const m = app.getAppMetrics().find((x) => x.pid === pid);
    const name = require('./lib/applog').hangName(new Date());
    fs.writeFileSync(path.join(log.dir, name), [
      `Ezrite 멈춤 (화면: ${t.name})`,
      `시각: ${new Date(Date.now() - ms).toISOString()} 부터 ${(ms / 1000).toFixed(1)}초째 응답 없음`,
      `Ezrite ${app.getVersion()}, Windows ${os.release()}, 화면 프로세스 pid ${pid}`,
      m ? `CPU ${m.cpu.percentCPUUsage.toFixed(1)}%, 메모리 ${Math.round(m.memory.workingSetSize / 1024)}MB` : '프로세스 정보 없음',
      '',
      '화면 스택: Windows 에서는 뜰 수 없다 (Chromium 은 페이지가 Document-Policy 헤더로 허락해야 주는데 앱 화면은 file:// 이라 헤더가 없다)',
      '',
    ].join('\n'));
    log.info('앱', `멈춘 화면 정보 → ${name}`);
  } catch (e) {
    log.warn('앱', `멈춘 화면 정보를 남기지 못함: ${log.err(e)}`);
  }
}

function startAppLog() {
  if (!log.on) return;
  log.info('앱', `시작 — 버전 ${app.getVersion()} (${app.isPackaged ? '설치본' : '개발'}), Electron ${process.versions.electron}, Windows ${os.release()} ${os.arch()}, `
    + `메모리 ${GB(os.totalmem())}GB (여유 ${GB(os.freemem())}GB), pid ${process.pid}, 기록 ${log.dir}`);
  // 메인 프로세스 멈춤: worker 스레드가 지켜보고 스택을 뜬다
  watchMain({ dir: log.dir, info: `Ezrite ${app.getVersion()}, Windows ${os.release()}` });
  // 화면 멈춤: 1초마다 창마다 ping
  pingWatch = new PingWatch({
    onHang: (t, ms) => {
      log.warn('앱', `화면(${t.name})이 ${Math.round(ms / 1000)}초째 응답 없음`);
      uiHangFile(t, ms);
    },
    onRecover: (t, ms) => log.warn('앱', `화면(${t.name}) 풀림 — ${(ms / 1000).toFixed(1)}초 동안 멈춰 있었음`),
  });
  const targets = () => [popup, mainWin, onboardingWin, explainer.card?.win]
    .filter((w) => w && !w.isDestroyed() && !w.webContents.isLoading() && !w.webContents.isCrashed())
    .map((w) => ({ id: w.webContents.id, name: windowName(w.webContents), win: w, send: (n) => w.webContents.send('ez:ping', n) }));
  setInterval(() => pingWatch.tick(targets()), 1000).unref?.();
  // Chromium 자신의 판단 (보통 더 늦다), 프로세스가 꺼진 것
  app.on('browser-window-created', (_e, w) => {
    w.on('unresponsive', () => log.warn('앱', `창(${windowName(w.webContents)}) 응답 없음 (Chromium)`));
    w.on('responsive', () => log.warn('앱', `창(${windowName(w.webContents)}) 다시 응답 (Chromium)`));
  });
  app.on('render-process-gone', (_e, wc, d) => log.error('앱', `화면 프로세스 꺼짐 (${windowName(wc)}) — ${d.reason}, 종료 코드 ${d.exitCode}`));
  app.on('child-process-gone', (_e, d) => log[d.reason === 'clean-exit' ? 'info' : 'error']('앱',
    `보조 프로세스 꺼짐 — ${d.type}${d.name ? ` (${d.name})` : ''}, ${d.reason}, 종료 코드 ${d.exitCode}`));
  // 시스템 (Electron powerMonitor). 사용자 전환은 Windows 에서 화면 잠금으로 온다. 발열은 macOS 만 알린다
  const { powerMonitor } = require('electron');
  const sys = {
    suspend: '잠자기', resume: '깨어남', 'lock-screen': '화면 잠금', 'unlock-screen': '화면 잠금 풀림', shutdown: '끄기/로그아웃',
    'on-ac': '전원 연결', 'on-battery': '배터리로 돎',
  };
  for (const [ev, text] of Object.entries(sys)) powerMonitor.on(ev, () => log.info('시스템', text));
  powerMonitor.on('thermal-state-change', (d) => log.warn('시스템', `발열 상태 ${d?.state ?? d}`));
  powerMonitor.on('speed-limit-change', (d) => log.warn('시스템', `CPU 속도 제한 ${d?.limit ?? d}%`));
  screen.on('display-added', () => log.info('시스템', `화면 연결 — 이제 ${screen.getAllDisplays().length}개`));
  screen.on('display-removed', () => log.info('시스템', `화면 빠짐 — 이제 ${screen.getAllDisplays().length}개`));
}

/** EZRITE_SCRIPT 멈춤 시험 (맥 hang@8=5): 켠 지 at 초에 메인 프로세스(hang)나 팝업 화면(uihang)을 secs 초 굳힌다 */
function runScript() {
  for (const step of dev.script) {
    setTimeout(() => {
      log.info('앱', `시험 ${step.kind}@${step.at}=${step.secs} — ${step.kind === 'hang' ? '메인 프로세스를' : '팝업 화면을'} ${step.secs}초 굳힘`);
      if (step.kind === 'hang') spin(step.secs * 1000);
      else if (popup && !popup.isDestroyed()) {
        popup.webContents.executeJavaScript(`(function ezriteHangTest() { const end = Date.now() + ${step.secs * 1000}; while (Date.now() < end) { /* 굳힘 */ } })(); 0`).catch(() => {});
      }
    }, step.at * 1000);
  }
}

// 끝낼 때: 녹음을 마무리하고, m4a 로 바꾸는 일이 끝날 때까지(최대 30초) 기다린다.
// 그래도 못 끝내면 .pcm 이 남아 다음 실행 때 바꾼다
let quitting = false;
let quitAt = null; // 종료를 시작한 때 (앱 기록: 단계별 걸린 시간)
app.on('before-quit', (e) => {
  if (quitAt == null) {
    quitAt = Date.now();
    const rec = state.listening ? (state.paused ? '일시정지 중' : state.quietPaused ? '조용해서 쉬는 중' : '녹음 중') : '녹음 안 함';
    log.info('앱', `종료 시작 — ${rec}, 소리 합치는 중 ${encoding.size}개`);
  }
  app.isQuitting = true;
  const t0 = Date.now();
  session.stop();
  explainer.clear();
  screenTx.stop();
  if (!quitting) log.info('앱', `녹음 정리 ${Date.now() - t0}ms`);
  const waits = [...encoding];
  if (quitting || waits.length === 0) return;
  e.preventDefault();
  quitting = true;
  log.info('앱', `소리 합치기 기다림 — ${waits.length}개 (최대 30초)`);
  const w0 = Date.now();
  const timeout = new Promise((r) => setTimeout(() => r('timeout'), 30_000));
  Promise.race([Promise.allSettled(waits), timeout]).then((r) => {
    if (r === 'timeout') log.warn('앱', `소리 합치기 30초 넘김 — .pcm 을 남기고 끝낸다 (다음 실행 때 합친다)`);
    else log.info('앱', `소리 합치기 끝 ${log.secs(Date.now() - w0)}`);
    app.quit();
  });
});
// 마지막 줄. 기록은 한 줄씩 바로 쓰므로 비울 버퍼가 없다 (lib/applog.js)
app.on('will-quit', () => log.info('앱', `기록 닫음 — 종료 시작부터 ${quitAt == null ? 0 : Date.now() - quitAt}ms`));
app.on('window-all-closed', () => {
  // 트레이에 남아 있으므로 종료하지 않는다
});
