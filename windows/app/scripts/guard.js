'use strict';

// 시험·확인 스크립트(electron 으로 띄우는 것) 맨 위에서 부른다.
// 처리 안 된 오류가 나면 화면에 오류 창을 띄우지 않고 stderr 에 쓴 뒤 종료 코드 1 로 끝낸다.
function fail(kind, err) {
  try {
    process.stderr.write(`${kind}: ${err && err.stack ? err.stack : err}\n`);
  } finally {
    process.exit(1);
  }
}
process.on('uncaughtException', (e) => fail('uncaughtException', e));
process.on('unhandledRejection', (e) => fail('unhandledRejection', e));
