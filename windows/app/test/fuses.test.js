'use strict';

// 설치 파일의 Ezrite.exe 는 Electron fuse 로 잠근다: Node 로 돌리기·NODE_OPTIONS·--inspect 를 끄고,
// asar 무결성 검사·asar 에서만 읽기·쿠키 암호화를 켠다. 빌드가 없으면 실제 exe 검사는 건너뛴다
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EXPECTED, BUILDER_FUSES, compareFuses, readFuses, DEFAULT_EXE } = require('../scripts/check-fuses');

test('기대값: 끄는 셋, 켜는 셋. LoadBrowserProcessSpecificV8Snapshot 은 건드리지 않는다', () => {
  assert.deepEqual(EXPECTED, {
    RunAsNode: false,
    EnableNodeOptionsEnvironmentVariable: false,
    EnableNodeCliInspectArguments: false,
    EnableEmbeddedAsarIntegrityValidation: true,
    OnlyLoadAppFromAsar: true,
    EnableCookieEncryption: true,
  });
  assert.equal('LoadBrowserProcessSpecificV8Snapshot' in EXPECTED, false);
});

test('package.json build.electronFuses 가 기대값과 같다 (electron-builder 이름)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.deepEqual(pkg.build.electronFuses, BUILDER_FUSES);
  assert.deepEqual(BUILDER_FUSES, {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    enableCookieEncryption: true,
  });
});

test('fuse 를 읽는 도구는 정확한 버전으로 고정한다', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.match(pkg.devDependencies['@electron/fuses'] ?? '', /^\d+\.\d+\.\d+$/);
});

test('compareFuses: 모두 맞으면 빈 목록, 틀리거나 없으면 이름과 값', () => {
  const ok = { ...EXPECTED, LoadBrowserProcessSpecificV8Snapshot: false, WasmTrapHandlers: true };
  assert.deepEqual(compareFuses(ok), []);
  assert.deepEqual(compareFuses({ ...ok, RunAsNode: true }), ['RunAsNode: 기대 false, 실제 true']);
  const missing = { ...ok };
  delete missing.OnlyLoadAppFromAsar;
  assert.deepEqual(compareFuses(missing), ['OnlyLoadAppFromAsar: 기대 true, 실제 없음']);
});

test('빌드한 dist/win-unpacked/Ezrite.exe 의 fuse 가 기대값과 같다', { skip: !fs.existsSync(DEFAULT_EXE) && '빌드 없음' }, async () => {
  const fuses = await readFuses(DEFAULT_EXE);
  assert.deepEqual(compareFuses(fuses), []);
});
