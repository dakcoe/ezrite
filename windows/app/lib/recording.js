'use strict';

// 녹음 원본 저장. 녹음하는 동안 helper 가 흘리는 16kHz mono s16le 를 기록이름.pcm 에 그대로 이어 쓰고
// (앱이 죽어도 쓴 데까지는 남는다), 끝내면 helper encode 로 기록이름.m4a(AAC)로 바꾼다.
// 맥은 m4a 조각을 60초마다 마무리하고 끝낼 때 합친다. Windows 에는 같은 일을 하는 기본 API 가 없어 이렇게 나눴다.

const fs = require('node:fs');
const path = require('node:path');

const BYTES_PER_SECOND = 16000 * 2;

/** 받은 조각을 파일 끝에 바로 붙인다 (쓰기마다 OS 에 넘긴다. 디스크까지 내리는 fsync 는 닫을 때) */
class PcmFile {
  constructor(file) {
    this.path = file;
    this.bytes = 0;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.fd = fs.openSync(file, 'a');
  }

  get seconds() {
    return this.bytes / BYTES_PER_SECOND;
  }

  write(chunk) {
    if (this.fd == null) return;
    try {
      fs.writeSync(this.fd, chunk);
      this.bytes += chunk.length;
    } catch {
      // 디스크가 꽉 차도 받아쓰기는 계속된다. 소리 파일만 거기서 끊긴다
    }
  }

  close() {
    if (this.fd == null) return;
    try {
      fs.fsyncSync(this.fd);
    } catch { /* 닫기는 한다 */ }
    fs.closeSync(this.fd);
    this.fd = null;
  }
}

/**
 * 기록이름.pcm → 기록이름.m4a. run(args) 은 helper 를 실행하는 함수(stdout 을 돌려주는 Promise).
 * 임시 이름(.encoding-기록이름.m4a)에 만든 뒤 옮겨서, 도중에 꺼져도 반쯤 된 m4a 가 남지 않는다.
 * 실패하면 .pcm 을 남긴다 (다음 실행 때 다시 해 본다). 빈 .pcm 은 지우고 null
 */
async function finishAudio(pcm, { run }) {
  let size;
  try {
    size = fs.statSync(pcm).size;
  } catch {
    return null;
  }
  if (size === 0) {
    fs.rmSync(pcm, { force: true });
    return null;
  }
  const dir = path.dirname(pcm);
  const name = path.basename(pcm).replace(/\.pcm$/i, '.m4a');
  const dest = path.join(dir, name);
  const tmp = path.join(dir, `.encoding-${name}`);
  try {
    await run(['encode', '--in', pcm, '--out', tmp]);
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fs.rmSync(pcm, { force: true });
  return dest;
}

/**
 * HTTP Range 헤더 → {start, end} (끝 포함). 없거나 모르는 꼴이면 null(통째로 보낸다),
 * 파일 밖이면 'unsatisfiable'. <audio> 가 막대를 옮길 때 이 구간만 달라고 한다
 */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

module.exports = { PcmFile, finishAudio, parseRange, BYTES_PER_SECOND };
