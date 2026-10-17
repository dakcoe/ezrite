'use strict';

const {
  app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, ipcMain, screen, shell, dialog, clipboard, protocol,
} = require('electron');
const { Readable } = require('stream');
const path = require('path');
const fs = require('fs');
const { execFile, execFileSync, spawn } = require('child_process');
const { parseListOutput, LevelMeter } = require('./lib/audio');
const os = require('os');
const { parseDevEnv, supportsMaterial, popupPosition, buildSources, keepSelected, helperCandidates, mixArgs, notPlayingMessage, sourceArgs, supportsProcessLoopback, LOOPBACK_UNSUPPORTED, guideSize, levelTargets,
  themeSource, themeColors, titleBarOverlay, copyText } = require('./lib/ui');
const { mixedSource } = require('./lib/mixer');
const { flattenBGRA, hexColor } = require('./lib/png');
const sample = require('./lib/sample');
const { KeyStore } = require('./lib/keystore');
const { GroqClient } = require('./lib/groq');
const { Transcriber, languageCode, MESSAGES } = require('./lib/transcriber');
const { LiveSession, usageFooter } = require('./lib/live');
const { parseWav, wavFeed } = require('./lib/devfeed');
const { loadDemoScript, DemoScript, demoSource, fakeLevel } = require('./lib/demoscript');
const { fakeFetch } = require('./lib/fakegroq');
const notes = require('./lib/notes');
const { PcmFile, finishAudio, parseRange } = require('./lib/recording');
const Settings = require('./lib/settings');
const { Budget } = require('./lib/budget');
const { Updater, issueURL } = require('./lib/updater');
const PKG = require('./package.json');
const E = require('./lib/explain');
const { Explainer } = require('./lib/explainer');
const ExplainUI = require('./explain-ui');

// 녹음 듣기용 주소 ezrite-note://audio/<파일 이름>. 저장 폴더의 .m4a 만 내준다 (renderer 가 아무 파일이나 읽지 못하게)
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
  startedAt: null,
  recordedBefore: 0,
  notice: null,
  error: null,
  options: { autoTranslate: true, askBeforeRecord: true, includeMic: false },
  compact: false,
  page: 'live',
  entries: [],
  sessions: [],
  footer: { audio: null, translate: null, explain: null, uses: null, captions: {} },
  notesFolder: '', // 사용자가 고른 저장 위치. 빈 글이면 기본 위치
  notesDir: '', // 화면에 보일 저장 위치
  liveSession: null, // 지금 쓰고 있는 기록 파일 (지난 기록의 "진행 중")
  opened: null, // 지난 기록에서 연 기록 { path, title, date, audio, audioSrc, live, entries }
  version: app.getVersion(),
  appAudio: true, // 프로그램별 소리 받기를 쓸 수 있는 Windows 인지 (설정에 안내)
  hasKey: false, // 키 자체는 화면 쪽으로 보내지 않는다. 있는지만
  keyStatus: null, // 키 줄 아래 한 줄 ("저장됨 …" / "✕ …")
  inflight: 0,
  micReady: false,
  sample: false,
  explaining: false, // "설명해줘" 진행 중 (✨ 단추가 돌아간다)
  userGuide: '', // AI 지침
  update: { available: null, checking: false, checkedAt: null, current: app.getVersion() }, // 새 버전 (lib/updater.js)
  openAtLogin: false, // 로그인할 때 자동 실행
  loginItemAvailable: app.isPackaged, // 개발 중(electron.exe)에는 바꾸지 않는다
  build: `${app.getVersion()} (Windows ${os.release()})`,
};
// 다음 실행 때도 그대로 둘 설정 (맥 UserDefaults 자리). 미리보기·스크린샷은 사용자 설정을 바꾸지 않는다
const SETTINGS_FILE = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Ezrite', 'settings.json');
const keepSettings = !dev.preview && !dev.shot;
{
  const saved = Settings.load(SETTINGS_FILE);
  Object.assign(state, {
    language: saved.language, options: saved.options, notesFolder: saved.notesFolder, sourceId: saved.sourceId, userGuide: saved.userGuide, theme: saved.theme,
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
      userGuide: state.userGuide, welcomed: state.welcomed, theme: state.theme,
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
  for (const w of levelTargets([popup, mainWin])) w.webContents.send('level', v);
}

// ── 받아쓰기: 소리 출처 → VAD → Transcriber (lib/live.js) ──

const GROQ_KEY_PAGE = 'https://console.groq.com/keys';
const keystore = new KeyStore();
const usage = {}; // 모델 → { remaining, limit } (응답 헤더)

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
  if (!state.sample) setState({ footer: usageFooter(usage, budget) });
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

const session = new LiveSession({ transcriber, openSource: openSourceFor(), hasKey });
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

// ── 기록 저장: 받아 적은 줄 → 기록이름.txt (+ .times.json), 소리 → 기록이름.pcm → 끝내면 .m4a ──

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
  const job = finishAudio(pcm, { run: runHelper })
    .catch((e) => showNotice(`녹음 소리를 m4a 로 바꾸지 못했습니다 — 다음 실행 때 다시 합니다 (${e.message})`))
    .finally(() => {
      encoding.delete(job);
      reloadSessions();
      if (state.opened) openNote(state.opened.path);
    });
  encoding.add(job);
  return job;
}

session.on('start', () => {
  writer = new notes.Writer(notesDir());
  try {
    pcmFile = new PcmFile(writer.planned.replace(/\.txt$/, '.pcm'));
  } catch (e) {
    pcmFile = null;
    showNotice(`녹음 소리를 저장할 수 없습니다: ${e.message}`);
  }
  setState({ liveSession: null });
});
session.on('pcm', (chunk) => pcmFile?.write(chunk));
session.on('stop', () => {
  const f = pcmFile;
  pcmFile = null;
  if (f) {
    f.close();
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
    if (/^ezrite-ocr-\d+-\d+\.png$/.test(n)) fs.rmSync(path.join(os.tmpdir(), n), { force: true });
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

const explainer = new Explainer({
  groq,
  grab: (opts) => ExplainUI.grab(opts, ourWindows),
  ocr: ocrImage,
  context: () => ({
    // 최근 받아 적은 문장 12개 (맥 explain())
    transcript: transcriber.entries.filter((e) => e.kind === 'text').slice(-12).map((e) => e.original),
    guide: state.userGuide,
  }),
  popupFrame: () => (popup && !popup.isDestroyed() && popup.isVisible() ? popup.getBounds() : null),
  createCard: (hooks) => ExplainUI.createCard(hooks, { capturable: dev.capturable }),
  createOverlay: (display, model) => ExplainUI.createOverlay(display, model, {
    capturable: dev.capturable, onShown: () => explainer.card?.raise(),
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
  for (const n of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (n.startsWith('.encoding-')) fs.rmSync(path.join(dir, n), { force: true }); // 바꾸다 꺼진 반쪽 파일
  }
  for (const pcm of notes.pendingAudio(dir)) {
    try {
      await finishAudio(pcm, { run: runHelper });
    } catch {
      // .pcm 은 남는다. 다음 실행 때 다시
    }
  }
  try {
    notes.prune(dir, { autoDelete: !state.notesFolder });
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
  return `ezrite-note://audio/${encodeURIComponent(path.basename(m4a))}?v=${Math.round(fs.statSync(m4a).mtimeMs)}`;
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
  setState({ opened: null }); // 듣던 소리를 먼저 놓는다
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

/** 녹음 듣기: 저장 폴더의 .m4a 만, 막대를 옮길 수 있게 Range 요청도 받는다 */
function serveAudio(request) {
  const url = new URL(request.url);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const dir = notesDir();
  const file = path.join(dir, name);
  if (url.hostname !== 'audio' || path.dirname(file) !== path.resolve(dir) || !/\.m4a$/i.test(name)
    || name.includes('/') || name.includes('\\') || !fs.existsSync(file)) {
    return new Response('not found', { status: 404 });
  }
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
    setState({ error: src?.kind === 'app' ? notPlayingMessage(src.label) : '소리 출처를 먼저 고르세요 (설정 → 소리 출처)' });
    return;
  }
  session.start(args);
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

/** 키를 저장(빈 글이면 지움)한다. 키는 로그·상태·오류 어디에도 싣지 않는다 */
function saveKey(provider, key) {
  if (provider !== 'groq' || typeof key !== 'string') return;
  const trimmed = key.trim();
  if (trimmed.length > 512 || /\s/.test(trimmed)) {
    setState({ keyStatus: '✕ 키 모양이 아닙니다 (공백 없이 gsk_… 한 줄)' });
    return;
  }
  try {
    keystore.save(trimmed, 'groq');
  } catch (e) {
    setState({ keyStatus: `✕ ${e.message}` });
    return;
  }
  const saved = hasKey();
  setState({
    hasKey: saved,
    // 맥은 저장하자마자 모델 목록을 불러 확인한다. 여기서는 Groq 를 부르지 않고 첫 받아쓰기 때 확인된다
    keyStatus: saved ? '저장됨 · 받아쓰기를 시작하면 확인됩니다' : null,
    error: saved && state.error === MESSAGES.noKey ? null : state.error,
  });
}

function applyPatch(patch) {
  const next = {};
  if (typeof patch.sourceId === 'string' && state.sources.some((s) => s.id === patch.sourceId)) {
    next.sourceId = patch.sourceId;
  }
  if (state.languages.includes(patch.language)) next.language = patch.language;
  if (['live', 'history', 'settings'].includes(patch.page)) next.page = patch.page;
  if (typeof patch.compact === 'boolean') next.compact = patch.compact;
  if (typeof patch.userGuide === 'string') next.userGuide = patch.userGuide.slice(0, Settings.GUIDE_MAX);
  if (Settings.THEMES.includes(patch.theme)) next.theme = patch.theme;
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
  const languageChanged = next.language && next.language !== state.language;
  setState(next);
  if (next.sourceId || next.language || next.options || next.userGuide != null || next.theme) persistSettings();
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
  if (typeof next.compact === 'boolean') resizePopup();
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

let bannerHeight = 0; // 팝업 위 "새 버전" 띠 높이 (renderer 가 잰다). 그만큼 팝업이 커진다 (맥 UpdateBanner)
function popupSize() {
  return state.compact ? COMPACT : { width: POPUP.width, height: POPUP.height + bannerHeight };
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

const updater = new Updater({
  repo: PKG.ezriteUpdateRepo,
  current: app.getVersion(),
  fakeJSON: fakeRelease(),
  onChange: (update) => setState({ update }),
});

// ── IPC ──

function registerIpc() {
  ipcMain.handle('state:get', () => state);
  ipcMain.handle('state:set', (_e, patch) => applyPatch(patch || {}));
  ipcMain.handle('sources:refresh', () => refreshSources());
  ipcMain.handle('record:start', () => startRecord());
  ipcMain.handle('record:stop', () => stopRecord());
  ipcMain.handle('record:pause', () => togglePause());
  ipcMain.handle('window:main', (_e, page) => showMain(page));
  ipcMain.handle('window:onboarding', () => showOnboarding());
  ipcMain.handle('key:save', (_e, provider, key) => saveKey(provider, key));
  ipcMain.handle('key:remove', (_e, provider) => saveKey(provider, ''));
  // 키 발급 페이지만 연다 (renderer 가 주소를 고르지 못하게)
  ipcMain.handle('open:keyPage', () => shell.openExternal(GROQ_KEY_PAGE));
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
  ipcMain.handle('popup:banner', (e, h) => {
    if (BrowserWindow.fromWebContents(e.sender) !== popup || !Number.isFinite(h)) return;
    const next = Math.max(0, Math.min(200, Math.ceil(h)));
    if (next === bannerHeight) return;
    bannerHeight = next;
    resizePopup();
  });
  // 새 버전: [받기] 는 lib/updater.js 가 확인한 GitHub 주소만 연다
  ipcMain.handle('update:download', () => {
    const url = updater.available?.download;
    if (url) shell.openExternal(url);
  });
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
  ipcMain.handle('app:quit', () => {
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
        { label: '종료', click: () => { app.isQuitting = true; app.quit(); } },
      ]));
    });

    // 미리보기 예시는 맥 스크린샷처럼 "키 있음"으로 둔다. 그 밖에는 실제 키 파일을 본다
    if (!state.sample) setState({ hasKey: hasKey() });
    if (state.loginItemAvailable) setState({ openAtLogin: app.getLoginItemSettings().openAtLogin });
    // 켤 때와 6시간마다 새 버전 확인. 미리보기·스크린샷은 EZRITE_UPDATE_JSON 이 있을 때만 (네트워크에 나가지 않게)
    if (dev.updateJSON || (!dev.preview && !dev.shot)) updater.start();
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
  });
}

// 끝낼 때: 녹음을 마무리하고, m4a 로 바꾸는 일이 끝날 때까지(최대 30초) 기다린다.
// 그래도 못 끝내면 .pcm 이 남아 다음 실행 때 바꾼다
let quitting = false;
app.on('before-quit', (e) => {
  app.isQuitting = true;
  session.stop();
  explainer.clear();
  if (quitting || encoding.size === 0) return;
  e.preventDefault();
  quitting = true;
  const timeout = new Promise((r) => setTimeout(r, 30_000));
  Promise.race([Promise.allSettled([...encoding]), timeout]).then(() => app.quit());
});
app.on('window-all-closed', () => {
  // 트레이에 남아 있으므로 종료하지 않는다
});
