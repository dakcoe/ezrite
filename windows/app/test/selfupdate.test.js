'use strict';
// 1.2.4 앱 안 업데이트 (맥 1.2.4 와 같다): 새 버전 띠의 [업데이트] 로 설치 파일을 앱이 직접 받아 조용히 설치하고 다시 켠다.
// 브라우저로 받으면 MOTW(Zone.Identifier)가 붙어 SmartScreen 경고가 뜨므로, 받은 파일엔 그 표시를 남기지 않는다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installerVersion, checkInstaller, installCommand, SelfUpdate, WAIT_RECORDING, UPDATE_DIR_NAME, MESSAGES } = require('../lib/selfupdate');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-selfupdate-'));
const URL0 = 'https://github.com/dakcoe/ezrite/releases/download/v1.2.5/Ezrite-Setup-1.2.5.exe';
const FINAL = 'https://release-assets.githubusercontent.com/github-production-release-asset/1?sig=x';

test('설치 파일 이름: Ezrite-Setup-<버전>.exe 만, 버전이 지금보다 새것이어야 한다', () => {
  assert.equal(UPDATE_DIR_NAME, 'ezrite-updater');
  assert.equal(installerVersion('Ezrite-Setup-1.2.5.exe'), '1.2.5');
  for (const bad of ['Ezrite-1.2.5.dmg', 'Ezrite-Setup-1.2.5.exe.blockmap', 'Setup.exe', '../Ezrite-Setup-1.2.5.exe', 'Ezrite-Setup-1.2.exe']) {
    assert.equal(installerVersion(bad), null, bad);
  }
  assert.equal(checkInstaller('Ezrite-Setup-1.2.5.exe', '1.2.4'), null);
  assert.match(checkInstaller('Ezrite-Setup-1.2.4.exe', '1.2.4'), /새 버전이 아닙니다/);
  assert.match(checkInstaller('evil.exe', '1.2.4'), /설치 파일이 아닙니다/);
});

test('설치 명령: 설치 파일을 바로 --updated /S --force-run 으로 (설치기가 앱이 끝나기를 기다린다)', () => {
  // 콘솔 없이(분리해서) 띄운 PowerShell 5.1 은 아무것도 하지 않고 끝나 버려서 쓰지 않는다 (2026-10-30 실제 시험)
  const exe = "C:\\Users\\O'Neil\\AppData\\Local\\ezrite-updater\\Ezrite-Setup-1.2.5.exe";
  assert.deepEqual(installCommand(exe), { file: exe, args: ['--updated', '/S', '--force-run'] });
});

/** 가짜 fetch: body 조각들, 리다이렉트 끝 주소, 상태 */
function fakeFetch({ chunks = [Buffer.from('MZ'), Buffer.from('rest')], url = FINAL, status = 200, total } = {}) {
  const calls = [];
  const fn = async (u, init) => {
    calls.push({ u, init });
    const body = new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(new Uint8Array(x)); c.close(); } });
    const size = total ?? chunks.reduce((n, x) => n + x.length, 0);
    return { ok: status === 200, status, url, body, headers: new Headers({ 'content-length': String(size) }) };
  };
  fn.calls = calls;
  return fn;
}

function rig(opts = {}) {
  const dir = opts.dir ?? tmpDir();
  const changes = [];
  const spawned = [];
  let quits = 0;
  const u = new SelfUpdate({
    current: '1.2.4',
    dir,
    fetch: opts.fetch ?? fakeFetch(),
    busy: opts.busy ?? (() => false),
    localExe: opts.localExe ?? null,
    spawn: (file, args, o) => {
      if (opts.spawnFails) throw new Error('spawn EACCES');
      spawned.push({ file, args, o });
      return { unref() {} };
    },
    quit: () => { quits++; },
    onChange: (s) => changes.push(s),
  });
  return { u, dir, changes, spawned, quits: () => quits };
}

const INSTALLER = { name: 'Ezrite-Setup-1.2.5.exe', url: URL0, size: 6 };

test('[업데이트]: GitHub 에서 받아 크기를 맞춰 보고, 설치를 띄우고 앱을 끝낸다. 받은 파일엔 Zone.Identifier 가 없다', async () => {
  const r = rig();
  await r.u.install(INSTALLER);
  const file = path.join(r.dir, 'Ezrite-Setup-1.2.5.exe');
  assert.equal(fs.readFileSync(file, 'utf8'), 'MZrest');
  assert.equal(fs.existsSync(`${file}.part`), false);
  assert.equal(fs.existsSync(`${file}:Zone.Identifier`), false);
  assert.equal(r.spawned.length, 1);
  assert.equal(r.spawned[0].file, file);
  assert.deepEqual(r.spawned[0].args, ['--updated', '/S', '--force-run']);
  assert.deepEqual(r.spawned[0].o, { detached: true, stdio: 'ignore' });
  assert.equal(r.quits(), 1);
  assert.equal(r.changes[0].phase, 'downloading');
  assert.equal(r.changes.at(-1).phase, 'installing');
  assert.ok(r.changes.some((s) => s.percent === 100));
  assert.equal(r.u.status().phase, 'installing');
});

test('[업데이트]: 녹음 중이면 받지도 설치하지도 않고 띠에 기다리라고', async () => {
  const f = fakeFetch();
  const r = rig({ busy: () => true, fetch: f });
  await r.u.install(INSTALLER);
  assert.equal(f.calls.length, 0);
  assert.equal(r.spawned.length, 0);
  assert.deepEqual(r.u.status(), { phase: null, percent: null, error: null, detail: null, waiting: WAIT_RECORDING });
  assert.equal(WAIT_RECORDING, '녹음이 끝나면 업데이트할 수 있어요');
});

test('[1.2.4 맥과 같게] 녹음 확인은 두 번: 받는 사이 녹음을 시작하면 설치하지 않고 기다리라고, 받은 파일은 두었다가 다음엔 다시 받지 않는다', async () => {
  let busy = false;
  const f = fakeFetch();
  const r = rig({ fetch: f, busy: () => busy });
  const orig = f;
  r.u.fetch = async (...a) => { const res = await orig(...a); busy = true; return res; }; // 받는 사이 녹음 시작
  await r.u.install(INSTALLER);
  assert.equal(r.spawned.length, 0, '설치 직전에 다시 보고 멈춘다');
  assert.equal(r.quits(), 0);
  assert.deepEqual(r.u.status(), { phase: null, percent: null, error: null, detail: null, waiting: WAIT_RECORDING });
  assert.ok(fs.existsSync(path.join(r.dir, 'Ezrite-Setup-1.2.5.exe')), '받은 파일은 둔다');
  busy = false; // 녹음을 끝내고 다시 [업데이트]
  await r.u.install(INSTALLER);
  assert.equal(f.calls.length, 1, '다시 받지 않는다');
  assert.equal(r.spawned.length, 1);
  assert.equal(r.quits(), 1);
});

test('[1.2.4 맥과 같게] 오류는 맥 문구 한 줄 (자세한 이유는 detail 로 따로), 설치하지 않고 받다 만 파일은 지운다', async () => {
  assert.deepEqual(MESSAGES, {
    download: '새 버전을 받지 못했어요',
    verify: '받은 파일이 맞지 않아 설치하지 않았어요',
    version: '받은 앱이 지금보다 새 버전이 아니에요',
    start: '업데이트를 시작하지 못했어요',
  });
  const cases = [
    [{ ...INSTALLER, url: 'https://evil.example/Ezrite-Setup-1.2.5.exe' }, fakeFetch(), MESSAGES.download, /GitHub/],
    [INSTALLER, fakeFetch({ url: 'https://evil.example/redirected' }), MESSAGES.download, /GitHub/],
    [INSTALLER, fakeFetch({ status: 404 }), MESSAGES.download, /404/],
    [null, fakeFetch(), MESSAGES.download, /설치 파일/],
    [{ ...INSTALLER, size: 999 }, fakeFetch(), MESSAGES.verify, /크기/],
    [{ ...INSTALLER, name: 'Setup.exe' }, fakeFetch(), MESSAGES.verify, /설치 파일이 아닙니다/],
    [{ ...INSTALLER, name: 'Ezrite-Setup-1.2.4.exe' }, fakeFetch(), MESSAGES.version, /새 버전이 아닙니다/],
  ];
  for (const [inst, fetch, message, detail] of cases) {
    const r = rig({ fetch });
    await r.u.install(inst);
    assert.equal(r.spawned.length, 0);
    assert.equal(r.quits(), 0);
    const s = r.u.status();
    assert.equal(s.phase, null);
    assert.equal(s.error, message);
    assert.match(s.detail, detail);
    assert.deepEqual(fs.readdirSync(r.dir).filter((n) => n.endsWith('.part')), []);
  }
  const r = rig({ spawnFails: true });
  await r.u.install(INSTALLER);
  assert.equal(r.u.status().error, MESSAGES.start);
  assert.match(r.u.status().detail, /EACCES/);
  assert.equal(r.quits(), 0, '설치를 못 띄웠으면 앱을 끄지 않는다');
});

test('[업데이트]: 받는 중 진행률(%)을 알리고, 이미 받는 중이면 또 누른 것은 무시한다', async () => {
  const big = [Buffer.alloc(50), Buffer.alloc(50)];
  const r = rig({ fetch: fakeFetch({ chunks: big }) });
  const a = r.u.install({ ...INSTALLER, size: 100 });
  const b = r.u.install({ ...INSTALLER, size: 100 });
  await Promise.all([a, b]);
  assert.equal(r.spawned.length, 1);
  assert.ok(r.changes.some((s) => s.phase === 'downloading' && s.percent === 100));
});

test('개발용 EZRITE_UPDATE_EXE: 받지 않고 그 로컬 설치 파일을 작업 폴더에 복사해 설치한다', async () => {
  const src = path.join(tmpDir(), 'Ezrite-Setup-1.2.5.exe');
  fs.writeFileSync(src, 'MZlocal');
  const f = fakeFetch();
  const r = rig({ localExe: src, fetch: f });
  await r.u.install(null);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.readFileSync(path.join(r.dir, 'Ezrite-Setup-1.2.5.exe'), 'utf8'), 'MZlocal');
  assert.equal(r.spawned.length, 1);
});

test('MOTW: 파일에 Zone.Identifier 가 붙어 있으면 지운다 (NTFS)', { skip: process.platform !== 'win32' }, () => {
  const { stripMotw } = require('../lib/selfupdate');
  const file = path.join(tmpDir(), 'Ezrite-Setup-1.2.5.exe');
  fs.writeFileSync(file, 'MZ');
  fs.writeFileSync(`${file}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n');
  assert.equal(fs.readFileSync(`${file}:Zone.Identifier`, 'utf8').includes('ZoneId=3'), true);
  stripMotw(file);
  assert.equal(fs.existsSync(`${file}:Zone.Identifier`), false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'MZ', '본문은 그대로');
});

test('정리: 켤 때 작업 폴더의 지난 설치 파일(지금 버전 이하·받다 만 것)을 지운다', () => {
  const r = rig();
  for (const n of ['Ezrite-Setup-1.2.3.exe', 'Ezrite-Setup-1.2.4.exe', 'Ezrite-Setup-1.2.5.exe', 'Ezrite-Setup-1.2.6.exe.part', 'other.txt']) {
    fs.writeFileSync(path.join(r.dir, n), 'x');
  }
  assert.deepEqual(r.u.cleanup(), [], '다 지웠으면 남은 것 없음');
  assert.deepEqual(fs.readdirSync(r.dir).sort(), ['Ezrite-Setup-1.2.5.exe', 'other.txt']);
  assert.deepEqual(rig({ dir: path.join(tmpDir(), 'none') }).u.cleanup(), []); // 폴더가 없어도 조용히
});

test('[1.2.4 맥과 같게] 정리: 못 지운 것(다시 켜진 직후 설치기가 아직 잡고 있음)은 이름을 돌려준다 — 앱이 잠시 뒤 한 번 더', () => {
  const r = rig();
  fs.mkdirSync(path.join(r.dir, 'Ezrite-Setup-1.2.3.exe')); // 지우기에 실패하는 자리 (폴더라 rmSync 가 거부)
  fs.writeFileSync(path.join(r.dir, 'Ezrite-Setup-1.2.2.exe'), 'x');
  assert.deepEqual(r.u.cleanup(), ['Ezrite-Setup-1.2.3.exe']);
  assert.equal(fs.existsSync(path.join(r.dir, 'Ezrite-Setup-1.2.2.exe')), false);
});
