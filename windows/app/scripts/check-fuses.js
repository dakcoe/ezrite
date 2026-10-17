'use strict';

// 빌드한 Ezrite.exe 의 Electron fuse 가 기대값대로 잠겼는지 읽어 본다.
//   node scripts/check-fuses.js [Ezrite.exe 경로] [--require]
//   경로가 없으면 ../dist/win-unpacked/Ezrite.exe. 파일이 없으면 건너뛴다(종료 코드 0). --require 면 없을 때 실패
//   틀린 fuse 가 하나라도 있으면 종료 코드 1
const fs = require('fs');
const path = require('path');

// @electron/fuses 의 FuseV1Options 이름. 이 밖의 fuse(LoadBrowserProcessSpecificV8Snapshot 등)는 Electron 기본값 그대로
const EXPECTED = Object.freeze({
  RunAsNode: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  EnableCookieEncryption: true,
});

// package.json build.electronFuses 에 쓰는 electron-builder 이름 (첫 글자만 소문자)
const BUILDER_FUSES = Object.freeze(Object.fromEntries(
  Object.entries(EXPECTED).map(([k, v]) => [k[0].toLowerCase() + k.slice(1), v]),
));

const DEFAULT_EXE = path.join(__dirname, '..', '..', 'dist', 'win-unpacked', 'Ezrite.exe');

/** fuses: { 이름: true/false }. 기대와 다른 것을 "이름: 기대 x, 실제 y" 목록으로 */
function compareFuses(fuses) {
  const out = [];
  for (const [name, want] of Object.entries(EXPECTED)) {
    const got = fuses[name];
    if (got !== want) out.push(`${name}: 기대 ${want}, 실제 ${got === undefined ? '없음' : got}`);
  }
  return out;
}

/** exe 의 fuse 를 { 이름: true/false } 로. 이 버전의 도구가 모르는 번호는 #번호 로 */
async function readFuses(exe) {
  const { getCurrentFuseWire, FuseV1Options, FuseState } = await import('@electron/fuses');
  const wire = await getCurrentFuseWire(exe);
  const out = {};
  for (const [key, state] of Object.entries(wire)) {
    if (key === 'version') continue;
    const name = FuseV1Options[key] ?? `#${key}`;
    if (state === FuseState.ENABLE) out[name] = true;
    else if (state === FuseState.DISABLE) out[name] = false;
    else out[name] = FuseState[state] ?? String(state);
  }
  return out;
}

async function main(argv) {
  const require = argv.includes('--require');
  const exe = path.resolve(argv.find((a) => !a.startsWith('--')) ?? DEFAULT_EXE);
  if (!fs.existsSync(exe)) {
    console.log(`건너뜀: ${exe} 없음`);
    return require ? 1 : 0;
  }
  const fuses = await readFuses(exe);
  for (const [name, v] of Object.entries(fuses)) console.log(`${name.padEnd(40)} ${v}`);
  const bad = compareFuses(fuses);
  if (bad.length) {
    console.log(`fuse 불일치 ${bad.length}개:\n  ${bad.join('\n  ')}`);
    return 1;
  }
  console.log(`fuse 확인: ${path.basename(exe)} 기대값 ${Object.keys(EXPECTED).length}개 모두 맞음`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(e.stack || e);
    process.exit(1);
  });
}

module.exports = { EXPECTED, BUILDER_FUSES, DEFAULT_EXE, compareFuses, readFuses };
