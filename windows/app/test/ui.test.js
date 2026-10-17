'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDevEnv, popupPosition, buildSources, captureArgsFor, keepSelected, supportsMaterial, notPlayingMessage } = require('../lib/ui');

test('EZRITE_PREVIEW·EZRITE_THEME·EZRITE_SHOT을 읽는다', () => {
  assert.deepEqual(parseDevEnv({ EZRITE_PREVIEW: 'live', EZRITE_THEME: 'dark', EZRITE_SHOT: 'C:\\a.png' }), {
    preview: 'live',
    theme: 'dark',
    shot: 'C:\\a.png',
    testScale: null,
    capturePid: null, demoScript: null, testFile: null,
    fakeGroq: false,
    speed: 1,
    shotDelay: 1200,
    explainAfter: null,
    card: null,
    ask: null,
    capturable: false,
    updateJSON: null,
    shotScroll: 0,
  });
});

test('EZRITE_TEST_SCALE는 1~3 사이 숫자일 때만 받는다 (기본은 배율을 건드리지 않음)', () => {
  assert.equal(parseDevEnv({ EZRITE_TEST_SCALE: '1.5' }).testScale, 1.5);
  assert.equal(parseDevEnv({ EZRITE_TEST_SCALE: '1' }).testScale, 1);
  assert.equal(parseDevEnv({ EZRITE_TEST_SCALE: '0.5' }).testScale, null);
  assert.equal(parseDevEnv({ EZRITE_TEST_SCALE: '4' }).testScale, null);
  assert.equal(parseDevEnv({ EZRITE_TEST_SCALE: 'abc' }).testScale, null);
  assert.equal(parseDevEnv({}).testScale, null);
});

test('Mica·Acrylic은 Windows 11 22H2(빌드 22621) 이상에서만', () => {
  assert.equal(supportsMaterial('win32', '10.0.26200'), true);
  assert.equal(supportsMaterial('win32', '10.0.22621'), true);
  assert.equal(supportsMaterial('win32', '10.0.22000'), false);
  assert.equal(supportsMaterial('win32', '10.0.19045'), false);
  assert.equal(supportsMaterial('darwin', '24.0.0'), false);
  assert.equal(supportsMaterial('win32', 'weird'), false);
});

test('값이 없으면 미리보기 없음, 테마는 system', () => {
  assert.deepEqual(parseDevEnv({}), {
    preview: null, theme: 'system', shot: null, testScale: null, capturePid: null, demoScript: null, testFile: null, fakeGroq: false, speed: 1, shotDelay: 1200,
    explainAfter: null, card: null, ask: null, capturable: false, updateJSON: null, shotScroll: 0,
  });
});

test('대소문자·공백을 무시하고, 모르는 값은 버린다', () => {
  assert.equal(parseDevEnv({ EZRITE_PREVIEW: ' Popover ' }).preview, 'popover');
  assert.equal(parseDevEnv({ EZRITE_PREVIEW: 'mini' }).preview, null);
  assert.equal(parseDevEnv({ EZRITE_THEME: 'LIGHT' }).theme, 'light');
  assert.equal(parseDevEnv({ EZRITE_THEME: 'blue' }).theme, 'system');
  assert.equal(parseDevEnv({ EZRITE_SHOT: '   ' }).shot, null);
});

test('여섯 화면 이름을 모두 받는다', () => {
  for (const p of ['popover', 'compact', 'live', 'history', 'settings', 'onboarding']) {
    assert.equal(parseDevEnv({ EZRITE_PREVIEW: p }).preview, p);
  }
});

const work = { x: 0, y: 0, width: 1920, height: 1032 }; // 아래쪽 작업 표시줄 48px
const size = { width: 340, height: 344 };

test('작업 표시줄이 아래면 트레이 아이콘 위에 띄운다', () => {
  const tray = { x: 1700, y: 1040, width: 24, height: 32 };
  assert.deepEqual(popupPosition(tray, work, size), { x: 1712 - 170, y: 1032 - 344 - 8 });
});

test('화면 오른쪽 끝을 넘지 않게 당긴다', () => {
  const tray = { x: 1890, y: 1040, width: 24, height: 32 };
  assert.deepEqual(popupPosition(tray, work, size), { x: 1920 - 340 - 8, y: 1032 - 344 - 8 });
});

test('작업 표시줄이 위면 아이콘 아래에 띄운다', () => {
  const top = { x: 0, y: 48, width: 1920, height: 1032 };
  const tray = { x: 1700, y: 8, width: 24, height: 32 };
  assert.deepEqual(popupPosition(tray, top, size), { x: 1542, y: 48 + 8 });
});

test('작업 표시줄이 왼쪽이면 아이콘 오른쪽에 띄운다', () => {
  const left = { x: 48, y: 0, width: 1872, height: 1080 };
  const tray = { x: 8, y: 1000, width: 32, height: 24 };
  assert.deepEqual(popupPosition(tray, left, size), { x: 48 + 8, y: 1080 - 344 - 8 });
});

test('작업 표시줄이 오른쪽이면 아이콘 왼쪽에 띄운다', () => {
  const right = { x: 0, y: 0, width: 1872, height: 1080 };
  const tray = { x: 1880, y: 500, width: 32, height: 24 };
  assert.deepEqual(popupPosition(tray, right, size), { x: 1872 - 340 - 8, y: 512 - 172 });
});

test('트레이 위치를 모르면(0 크기) 작업 영역 오른쪽 아래', () => {
  assert.deepEqual(popupPosition({ x: 0, y: 0, width: 0, height: 0 }, work, size), {
    x: 1920 - 340 - 8,
    y: 1032 - 344 - 8,
  });
});

test('소리 출처: 기본 마이크가 맨 앞, 다른 마이크, 그다음 프로그램', () => {
  const list = buildSources({
    apps: [{ pid: 5060, exe: 'chrome.exe', title: '' }, { pid: 7, exe: 'Zoom.exe', title: 'Zoom 회의' }],
    mics: [
      { id: 'm2', name: '헤드셋 마이크', isDefault: false },
      { id: 'm1', name: '마이크(Yeti X)', isDefault: true },
    ],
  });
  assert.deepEqual(list, [
    { id: 'mic:m1', label: '기본 마이크', detail: '마이크(Yeti X)', kind: 'mic' },
    { id: 'mic:m2', label: '헤드셋 마이크', detail: '', kind: 'mic' },
    { id: 'app:chrome.exe', label: 'chrome', detail: '', kind: 'app', pid: 5060 },
    { id: 'app:zoom.exe', label: 'Zoom', detail: 'Zoom 회의', kind: 'app', pid: 7 },
  ]);
});

test('소리 출처가 비어 있어도 배열', () => {
  assert.deepEqual(buildSources({ apps: [], mics: [] }), []);
  assert.deepEqual(buildSources(null), []);
});

test('[mac refreshSources] 프로그램은 exe 이름으로 기억한다 (다시 켜면 pid 가 바뀐다). 같은 exe 가 여럿이면 하나로', () => {
  const list = buildSources({ apps: [{ pid: 10, exe: 'chrome.exe', title: '' }, { pid: 11, exe: 'Chrome.exe', title: '' }], mics: [] });
  assert.deepEqual(list.map((s) => [s.id, s.pid]), [['app:chrome.exe', 10]]);
});

test('[mac refreshSources] 고른 프로그램이 지금 소리를 안 내도 목록에 남긴다 (처음 켤 때도)', () => {
  const next = [{ id: 'mic:m1', label: '기본 마이크', detail: '', kind: 'mic' }];
  assert.deepEqual(keepSelected(next, [], 'app:chrome.exe'),
    [...next, { id: 'app:chrome.exe', label: 'chrome', detail: '지금 켜져 있지 않음', kind: 'app', missing: true }]);
});

test('녹음 시작: 고른 프로그램의 지금 pid 로 받는다. 소리를 안 내고 있으면 맥처럼 알린다', () => {
  const sources = [{ id: 'app:chrome.exe', label: 'chrome', kind: 'app', pid: 4242 }, { id: 'app:zoom.exe', label: 'Zoom', kind: 'app', missing: true }];
  assert.deepEqual(captureArgsFor('app:chrome.exe', sources), { pid: 4242 });
  assert.equal(captureArgsFor('app:zoom.exe', sources), null);
  assert.equal(captureArgsFor('app:zoom.exe'), null);
  assert.equal(notPlayingMessage('Zoom'), 'Zoom 이(가) 켜져 있지 않습니다. 프로그램을 켠 뒤 다시 시작하세요.');
});

test('출처 id를 helper capture 인자로 바꾼다', () => {
  assert.deepEqual(captureArgsFor('pid:5060'), { pid: 5060 });
  assert.deepEqual(captureArgsFor('mic:{0.0.1}.{abc}'), { mic: '{0.0.1}.{abc}' });
  assert.equal(captureArgsFor('pid:abc'), null);
  assert.equal(captureArgsFor('pid:0'), null);
  assert.equal(captureArgsFor('mic:'), null);
  assert.equal(captureArgsFor('system'), null);
  assert.equal(captureArgsFor(undefined), null);
});

test('목록을 새로 읽어도 고른 출처가 사라지지 않게 남긴다', () => {
  const prev = [{ id: 'pid:9', label: 'old', detail: '', kind: 'app' }];
  const next = [{ id: 'mic:m1', label: '기본 마이크', detail: '', kind: 'mic' }];
  assert.deepEqual(keepSelected(next, prev, 'pid:9'), [...next, prev[0]]);
  assert.deepEqual(keepSelected(next, prev, 'mic:m1'), next);
  assert.deepEqual(keepSelected(next, prev, 'pid:404'), next);
  assert.deepEqual(keepSelected(next, prev, null), next);
});

test('EZRITE_TESTFILE·EZRITE_FAKE_GROQ·EZRITE_SPEED·EZRITE_SHOT_DELAY', () => {
  const d = parseDevEnv({ EZRITE_TESTFILE: ' C:/t.wav ', EZRITE_FAKE_GROQ: '1', EZRITE_SPEED: '4', EZRITE_SHOT_DELAY: '9000' });
  assert.equal(d.testFile, 'C:/t.wav');
  assert.equal(d.fakeGroq, true);
  assert.equal(d.speed, 4);
  assert.equal(d.shotDelay, 9000);
  assert.equal(parseDevEnv({ EZRITE_FAKE_GROQ: 'true' }).fakeGroq, true);
  assert.equal(parseDevEnv({ EZRITE_FAKE_GROQ: '0' }).fakeGroq, false);
  assert.equal(parseDevEnv({ EZRITE_SPEED: '0' }).speed, 1);
  assert.equal(parseDevEnv({ EZRITE_SPEED: '100' }).speed, 1);
  assert.equal(parseDevEnv({ EZRITE_SHOT_DELAY: '-5' }).shotDelay, 1200);
  assert.equal(parseDevEnv({ EZRITE_SHOT_DELAY: '999999' }).shotDelay, 1200);
});

test('EZRITE_EXPLAIN(초)·EZRITE_CARD(json)·EZRITE_ASK(질문)', () => {
  const d = parseDevEnv({ EZRITE_EXPLAIN: '3.5', EZRITE_CARD: ' {"summary":"s"} ', EZRITE_ASK: ' 왜 같아야 해? ' });
  assert.equal(d.explainAfter, 3.5);
  assert.equal(d.card, '{"summary":"s"}');
  assert.equal(d.ask, '왜 같아야 해?');
  assert.equal(parseDevEnv({ EZRITE_EXPLAIN: '0' }).explainAfter, 0);
  assert.equal(parseDevEnv({ EZRITE_EXPLAIN: '-1' }).explainAfter, null);
  assert.equal(parseDevEnv({ EZRITE_EXPLAIN: 'soon' }).explainAfter, null);
  assert.equal(parseDevEnv({ EZRITE_CARD: '  ' }).card, null);
});

test('EZRITE_CAPTURABLE: 설명 카드·화면 표시를 화면 캡처에 보이게 (평소엔 캡처에서 빠진다)', () => {
  assert.equal(parseDevEnv({ EZRITE_CAPTURABLE: '1' }).capturable, true);
  assert.equal(parseDevEnv({ EZRITE_CAPTURABLE: 'no' }).capturable, false);
});

test('EZRITE_UPDATE_JSON: 새 버전 띠 모양 확인용 릴리스 JSON (글 또는 파일 경로)', () => {
  assert.equal(parseDevEnv({ EZRITE_UPDATE_JSON: ' {"tag_name":"v9"} ' }).updateJSON, '{"tag_name":"v9"}');
  assert.equal(parseDevEnv({ EZRITE_UPDATE_JSON: '' }).updateJSON, null);
});

test('helper 위치: 설치한 앱은 resources 폴더, 개발 중에는 helper/target 의 release → debug', () => {
  const { helperCandidates } = require('../lib/ui');
  const path = require('node:path');
  assert.deepEqual(helperCandidates({ packaged: true, resourcesPath: 'C:\P\resources', appDir: 'C:\P\resources\app.asar' }),
    [path.join('C:\P\resources', 'ezrite-audio.exe')]);
  assert.deepEqual(helperCandidates({ packaged: false, resourcesPath: 'x', appDir: 'C:\src\app' }), [
    path.join('C:\src\app', '..', 'helper', 'target', 'release', 'ezrite-audio.exe'),
    path.join('C:\src\app', '..', 'helper', 'target', 'debug', 'ezrite-audio.exe'),
  ]);
});

test('EZRITE_SHOT_SCROLL: 찍기 전에 내용을 그만큼 내린다 (설정 아래쪽 확인용)', () => {
  assert.equal(parseDevEnv({ EZRITE_SHOT_SCROLL: '600' }).shotScroll, 600);
  assert.equal(parseDevEnv({ EZRITE_SHOT_SCROLL: '-1' }).shotScroll, 0);
  assert.equal(parseDevEnv({ EZRITE_SHOT_SCROLL: 'x' }).shotScroll, 0);
});

test('소리 출처: Ezrite 자신(개발 실행의 electron 포함)은 목록에 넣지 않는다', () => {
  const list = { mics: [], apps: [{ pid: 7, exe: 'electron.exe' }, { pid: 8, exe: 'chrome.exe' }] };
  assert.deepEqual(buildSources(list, { selfPid: 7 }).map((s) => s.id), ['app:chrome.exe']);
  assert.deepEqual(buildSources(list).map((s) => s.id), ['app:electron.exe', 'app:chrome.exe']);
});

// ── 프로그램별 소리 받기 (process loopback) 는 Windows 10 Build 20348 부터 (Microsoft 문서 AUDIOCLIENT_ACTIVATION_TYPE) ──
const { supportsProcessLoopback, LOOPBACK_MIN_BUILD, LOOPBACK_UNSUPPORTED } = require('../lib/ui');

test('프로그램별 소리 받기: 빌드 20348 이상에서만', () => {
  assert.equal(LOOPBACK_MIN_BUILD, 20348);
  assert.equal(supportsProcessLoopback('win32', '10.0.19045'), false, 'Windows 10 22H2');
  assert.equal(supportsProcessLoopback('win32', '10.0.20348'), true, 'Server 2022');
  assert.equal(supportsProcessLoopback('win32', '10.0.22631'), true, 'Windows 11 23H2');
  assert.equal(supportsProcessLoopback('win32', '10.0.26100'), true, 'Windows 11 24H2');
  assert.equal(supportsProcessLoopback('win32', 'garbage'), false);
  assert.equal(supportsProcessLoopback('darwin', '23.0.0'), false);
  assert.equal(LOOPBACK_UNSUPPORTED, '이 Windows 버전에서는 프로그램별 소리 받기를 쓸 수 없습니다. 마이크를 쓰세요.');
});

test('프로그램별 소리 받기를 못 쓰는 Windows: 출처 목록에 프로그램을 넣지 않고 마이크만', () => {
  const list = { mics: [{ id: 'm1', name: 'USB 마이크', isDefault: true }], apps: [{ pid: 8, exe: 'chrome.exe' }] };
  assert.deepEqual(buildSources(list, { appsAllowed: false }).map((s) => s.id), ['mic:m1']);
  assert.deepEqual(buildSources(list).map((s) => s.id), ['mic:m1', 'app:chrome.exe']);
  // 예전에 고른 프로그램은 "켜져 있지 않음" 으로 남기지 않는다 (그 Windows 에서는 쓸 수 없으니)
  const kept = keepSelected(buildSources(list, { appsAllowed: false }), [], 'app:chrome.exe', { appsAllowed: false });
  assert.deepEqual(kept.map((s) => s.id), ['mic:m1']);
});

test('개발용 EZRITE_CAPTURE_PID: 그 프로세스의 소리를 바로 받는다 (없으면 평소와 같다)', () => {
  const { sourceArgs } = require('../lib/ui');
  assert.equal(parseDevEnv({}).capturePid, null);
  assert.equal(parseDevEnv({ EZRITE_CAPTURE_PID: 'abc' }).capturePid, null);
  assert.equal(parseDevEnv({ EZRITE_CAPTURE_PID: '1234' }).capturePid, 1234);
  assert.deepEqual(sourceArgs({ capturePid: 1234 }, 'mic:x', []), { pid: 1234 });
  assert.deepEqual(sourceArgs({ capturePid: null }, 'mic:x', []), { mic: 'x' });
});
