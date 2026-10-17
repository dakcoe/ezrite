'use strict';

// 개발용: EZRITE_TESTFILE=<16kHz mono wav> 를 마이크 없이 소리처럼 흘려 넣는다. 맥 DevFeed.swift 와 같은 일.
// 100ms 조각을 100ms(÷ EZRITE_SPEED)마다 보낸다. 파일이 끝나면 무음을 이어 보낸다 (끊김으로 알리지 않는다).

const SAMPLE_RATE = 16000;

/** wav 버퍼 → { pcm: s16le Buffer }. 16kHz mono 16bit PCM 만 받는다 (helper capture 와 같은 형식) */
function parseWav(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('wav 파일이 아닙니다');
  }
  let fmt = null;
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== SAMPLE_RATE || fmt.bits !== 16) {
        throw new Error('EZRITE_TESTFILE 은 16kHz mono 16bit PCM wav 여야 합니다');
      }
      const end = Math.min(buf.length, body + size);
      return { pcm: buf.subarray(body, end - ((end - body) % 2)) };
    }
    at = body + size + (size % 2); // 덩어리는 짝수 바이트로 맞춘다
  }
  throw new Error('wav 파일에 소리(data)가 없습니다');
}

/**
 * pcm 을 소리 출처처럼 여는 함수 (LiveSession.openSource 자리).
 * 파일이 끝나면 실제 캡처처럼 무음을 계속 흘린다 — 그래야 VAD 가 침묵을 보고 마지막 발화를 끊어 보낸다.
 * (맥 DevFeed 는 파일 끝에서 멈춰서, 12초 강제 끊김 뒤 남은 꼬리가 녹음을 끝낼 때까지 보내지지 않았다)
 */
function wavFeed(pcm, { speed = 1, chunkMs = 100, setInterval: si = setInterval, clearInterval: ci = clearInterval } = {}) {
  const bytes = (SAMPLE_RATE * 2 * chunkMs) / 1000;
  const silence = Buffer.alloc(bytes);
  return (_args, { onData }) => {
    let at = 0;
    const timer = si(() => {
      if (at >= pcm.length) {
        onData(silence);
        return;
      }
      onData(pcm.subarray(at, Math.min(at + bytes, pcm.length)));
      at += bytes;
    }, chunkMs / speed);
    return { stop: () => ci(timer) };
  };
}

module.exports = { parseWav, wavFeed };
