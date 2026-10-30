'use strict';

// 앱 안 업데이트 (1.2.4, 맥과 같다). 새 버전 띠의 [업데이트] 한 번으로:
//   1. 릴리스의 설치 파일(Ezrite-Setup-<버전>.exe)을 앱이 직접 %LOCALAPPDATA%\ezrite-updater 로 받는다.
//      브라우저로 받으면 MOTW(Zone.Identifier)가 붙어 SmartScreen 경고(추가 정보 → 실행)가 뜬다. 앱이 받은 파일엔 그 표시가
//      없고, 혹시 있으면 지운다. 서명이 없어서 출처는 https 의 GitHub 주소(trusted, 리다이렉트 끝 주소까지)와 이름·버전·크기로 본다
//   2. 녹음 중이면 받지 않고 띠에 기다리라고 쓴다
//   3. 설치 파일을 분리된 프로세스로 `--updated /S --force-run` 띄우고 앱을 끝낸다 (electron-updater 와 같은 방식).
//      --updated 면 설치기가 앱이 끝나기를 기다렸다가(남으면 닫는다) 바꾼다. /S 조용히, --force-run 끝나면 앱을 다시 켠다,
//      --updated 라서 예전 판 지우기(installer.nsh customUnInstall)가 ezrite-updater·캐시를 지우지 않는다.
//      키·기록·설정(%APPDATA%\Ezrite)은 설치기가 원래 건드리지 않는다.
//      (PowerShell 로 앱이 끝나기를 기다리게 했더니, 콘솔 없이 분리해 띄운 PowerShell 5.1 이 아무것도 하지 않고 끝났다)
//   실패하면 오류 한 줄 — 띠의 [받기](브라우저)로 대신할 수 있다

const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { trusted, isNewer } = require('./updater');

const UPDATE_DIR_NAME = 'ezrite-updater';
const WAIT_RECORDING = '녹음이 끝나면 업데이트할 수 있어요';
const DOWNLOAD_MS = 10 * 60_000;
const NAME = /^Ezrite-Setup-(\d+\.\d+\.\d+)\.exe$/;

/** "Ezrite-Setup-1.2.5.exe" → "1.2.5", 아니면 null */
function installerVersion(name) {
  return NAME.exec(String(name))?.[1] ?? null;
}

/** 이 이름의 설치 파일을 지금 버전 위에 깔아도 되면 null, 아니면 이유 */
function checkInstaller(name, current) {
  const v = installerVersion(name);
  if (!v) return `설치 파일이 아닙니다 (${name})`;
  if (!isNewer(v, current)) return `새 버전이 아닙니다 (${v})`;
  return null;
}

/** 조용히 설치하고 다시 켜는 명령 (설치기가 앱이 끝나기를 기다린다) */
function installCommand(exe) {
  return { file: exe, args: ['--updated', '/S', '--force-run'] };
}

// 띠에 보이는 오류 한 줄 (맥 1.2.4 와 같은 문구). 맥의 "받은 파일을 풀지 못했어요"(zip) 는 Windows 에 없고,
// 서명 확인 대신 이름·크기 확인이 틀리면 verify
const MESSAGES = Object.freeze({
  download: '새 버전을 받지 못했어요',
  verify: '받은 파일이 맞지 않아 설치하지 않았어요',
  version: '받은 앱이 지금보다 새 버전이 아니에요',
  start: '업데이트를 시작하지 못했어요',
});

/** kind(MESSAGES 의 열쇠)를 단 오류 */
function failure(kind, detail) {
  return Object.assign(new Error(detail), { kind });
}

/** 받은 파일의 MOTW 를 지운다 (없으면 그대로) */
function stripMotw(file) {
  try {
    fs.rmSync(`${file}:Zone.Identifier`, { force: true });
  } catch {
    // NTFS 가 아니면 붙지도 않는다
  }
}

class SelfUpdate {
  /**
   * dir: 작업 폴더 (%LOCALAPPDATA%\ezrite-updater). busy(): 녹음 중인가. localExe: EZRITE_UPDATE_EXE (받지 않고 복사).
   * spawn(file, args, opts) → { unref() }, quit(): 앱 끝내기, onChange(status): 띠에 알리기
   */
  constructor({ current, dir, fetch = globalThis.fetch, busy = () => false, localExe = null, spawn, quit, onChange = () => {} }) {
    Object.assign(this, { current, dir, fetch, busy, localExe, spawn, quit, onChange });
    this.state = { phase: null, percent: null, error: null, detail: null, waiting: null };
    this.ready = null; // 받아서 확인까지 마친 설치 파일 (녹음 때문에 멈췄으면 다음엔 다시 받지 않는다)
  }

  /** { phase: null|'downloading'|'installing', percent, error: 맥 문구, detail: 자세한 이유, waiting } */
  status() {
    return { ...this.state };
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.onChange(this.status());
  }

  fail(kind, detail) {
    this.set({ phase: null, percent: null, error: MESSAGES[kind] ?? MESSAGES.download, detail: String(detail ?? ''), waiting: null });
  }

  /**
   * [업데이트]. installer: release().installer ({ name, url, size }).
   * 녹음 중인지는 두 번 본다: 누를 때, 그리고 받은 뒤 설치를 띄우기 직전 (받는 사이 녹음을 시작했을 수 있다)
   */
  async install(installer) {
    if (this.state.phase) return; // 이미 받는 중·설치 중
    if (this.busy()) {
      this.set({ waiting: WAIT_RECORDING, error: null, detail: null });
      return;
    }
    this.set({ phase: 'downloading', percent: 0, error: null, detail: null, waiting: null });
    let file;
    try {
      file = this.readyFor(installer) ?? (this.localExe ? this.copyLocal() : await this.download(installer));
    } catch (e) {
      this.fail(e.kind, e.message);
      return;
    }
    this.ready = file;
    if (this.busy()) {
      this.set({ phase: null, percent: null, waiting: WAIT_RECORDING });
      return;
    }
    this.set({ phase: 'installing', percent: null });
    try {
      const c = installCommand(file);
      this.spawn(c.file, c.args, { detached: true, stdio: 'ignore' }).unref();
    } catch (e) {
      this.fail('start', e.message);
      return;
    }
    this.quit();
  }

  /** 앞서 받아 둔 같은 설치 파일이 아직 있으면 그 경로 */
  readyFor(installer) {
    const name = this.localExe ? path.basename(this.localExe) : installer?.name;
    return this.ready && name && path.basename(this.ready) === name && fs.existsSync(this.ready) ? this.ready : null;
  }

  /** 이름·버전 확인. 틀리면 어느 쪽 실패인지(kind)를 단 오류 */
  checkName(name) {
    const bad = checkInstaller(name, this.current);
    if (bad) throw failure(installerVersion(name) ? 'version' : 'verify', bad);
  }

  async download(installer) {
    if (!installer) throw failure('download', '이 릴리스에 Windows 설치 파일이 없습니다');
    this.checkName(installer.name);
    const url = trusted(installer.url);
    if (!url) throw failure('download', 'GitHub 주소가 아닙니다');
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, installer.name);
    const part = `${file}.part`;
    try {
      const res = await this.fetch(url, {
        headers: { Accept: 'application/octet-stream', 'User-Agent': 'Ezrite' },
        redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_MS),
      });
      if (res.url && !trusted(res.url)) throw failure('download', 'GitHub 밖 주소로 넘어갔습니다');
      if (!res.ok) throw failure('download', `받지 못했습니다 (${res.status})`);
      const total = installer.size ?? (Number(res.headers?.get('content-length')) || null);
      let got = 0;
      const count = new Transform({
        transform: (chunk, _enc, done) => {
          got += chunk.length;
          const p = total ? Math.min(100, Math.floor((got * 100) / total)) : null;
          if (p !== this.state.percent) this.set({ percent: p });
          done(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body), count, fs.createWriteStream(part));
      if (installer.size && got !== installer.size) throw failure('verify', `크기가 맞지 않습니다 (${got} / ${installer.size} 바이트)`);
      fs.renameSync(part, file);
    } catch (e) {
      fs.rmSync(part, { force: true });
      throw e;
    }
    stripMotw(file);
    return file;
  }

  /** 개발용 EZRITE_UPDATE_EXE: 로컬 설치 파일을 작업 폴더로 복사 */
  copyLocal() {
    const name = path.basename(this.localExe);
    this.checkName(name);
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, name);
    fs.copyFileSync(this.localExe, file);
    stripMotw(file);
    return file;
  }

  /**
   * 켤 때: 받았던 설치 파일(지금 버전 이하 — 업데이트가 끝난 것)과 받다 만 파일을 지운다.
   * 못 지운 이름을 돌려준다: 업데이트 뒤 다시 켜진 직후엔 설치기가 아직 그 파일을 잡고 있다 (EPERM) — 앱이 잠시 뒤 한 번 더 부른다
   */
  cleanup() {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const left = [];
    for (const n of names) {
      const v = installerVersion(n);
      if (!n.endsWith('.exe.part') && !(v && !isNewer(v, this.current))) continue;
      try {
        fs.rmSync(path.join(this.dir, n), { force: true });
      } catch {
        left.push(n);
      }
    }
    return left;
  }
}

module.exports = { SelfUpdate, installerVersion, checkInstaller, installCommand, stripMotw, WAIT_RECORDING, UPDATE_DIR_NAME, DOWNLOAD_MS, MESSAGES };
