'use strict';

// 서비스별 API 키를 파일 하나씩에 둔다: %APPDATA%\Ezrite\<서비스>_key. 맥 APIKey(Groq.swift) 이식.
// 키는 로그·오류 메시지에 절대 넣지 않는다 (오류에는 경로와 원인 코드만).
//
// 맥과 다른 점:
// - 맥은 0600 권한으로 나만 읽게 한다. Windows 는 POSIX 권한이 없고 %APPDATA% 가 이미 사용자 전용
//   ACL 이라 mode 는 넘기기만 한다.
// - 맥의 옛 Python 앱 settings.json 에서 키를 옮겨 오는 일(migrateOldGroq)은 Windows 에 옛 앱이 없어 뺐다.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { trimWsNl } = require('./text');

const PROVIDER = /^[a-z0-9]+$/;

function defaultDir(env = process.env) {
  const base = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'Ezrite');
}

function checkProvider(p) {
  if (typeof p !== 'string' || !PROVIDER.test(p)) throw new Error('API 키 서비스 이름이 올바르지 않습니다');
  return p;
}

class KeyStore {
  constructor({ dir = defaultDir() } = {}) {
    this.dir = dir;
  }

  file(provider = 'groq') {
    return path.join(this.dir, `${checkProvider(provider)}_key`);
  }

  /** 키 또는 null (파일 없음·비어 있음) */
  read(provider = 'groq') {
    const file = this.file(provider);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw new Error(`API 키를 읽지 못했습니다 (${file}: ${e.code ?? '알 수 없는 오류'})`);
    }
    const key = trimWsNl(raw);
    return key || null;
  }

  has(provider = 'groq') {
    return this.read(provider) !== null;
  }

  /** 빈 문자열이면 키를 지운다. 임시 파일에 쓴 뒤 바꿔 끼워서 반쯤 쓴 키가 남지 않게 한다 */
  save(key, provider = 'groq') {
    if (typeof key !== 'string') throw new TypeError('API 키는 문자열이어야 합니다');
    const file = this.file(provider);
    if (key === '') {
      this.remove(provider);
      return;
    }
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(tmp, key, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 정리 실패는 무시 */ }
      // 원래 오류(e.message)에는 경로가 들어 있을 뿐이지만, 키가 섞일 일이 없도록 코드만 옮긴다
      throw new Error(`API 키를 저장하지 못했습니다 (${file}: ${e.code ?? '알 수 없는 오류'})`);
    }
  }

  remove(provider = 'groq') {
    const file = this.file(provider);
    try {
      fs.rmSync(file, { force: true });
    } catch (e) {
      throw new Error(`API 키를 지우지 못했습니다 (${file}: ${e.code ?? '알 수 없는 오류'})`);
    }
  }
}

module.exports = { KeyStore, defaultDir };
