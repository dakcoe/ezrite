'use strict';

// "내 목소리도 함께": 프로그램 소리에 마이크를 섞는다 (맥 Transcriber.swift AudioPipeline pushMain/pushMic/micBuf).
// 프로그램 소리가 기준이다. 마이크는 쌓아 두었다가 프로그램 소리 덩어리마다 같은 수만큼 꺼내 같은 자리에 더한다
// (모자라면 0). 두 출처의 시계가 조금씩 어긋나 지연이 쌓이지 않게 마이크는 200ms 까지만 쌓는다 (맥은 300ms).
// 소리는 helper capture 와 같은 16kHz mono s16le.

const MIC_LAG_MAX = 3200; // 샘플 (16kHz 에서 200ms)

const clip = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

class MicMixer {
  constructor({ maxLag = MIC_LAG_MAX } = {}) {
    this.maxLag = maxLag;
    this.mic = new Int16Array(maxLag); // 쌓인 마이크 샘플 (앞에서부터 queued 개)
    this.queued = 0;
    this.micCarry = Buffer.alloc(0); // 파이프 덩어리가 샘플 중간에서 끊겼을 때 남은 바이트
    this.mainCarry = Buffer.alloc(0);
  }

  /** 마이크 소리를 쌓는다. 넘치면 오래된 것부터 버린다 */
  pushMic(chunk) {
    const buf = this.micCarry.length ? Buffer.concat([this.micCarry, chunk]) : chunk;
    const n = buf.length >> 1;
    this.micCarry = Buffer.from(buf.subarray(n * 2));
    if (!n) return;
    const take = Math.min(n, this.maxLag);
    const from = n - take; // 새 덩어리가 통째로 넘치면 그 뒷부분만
    const keep = Math.min(this.queued, this.maxLag - take);
    this.mic.copyWithin(0, this.queued - keep, this.queued);
    for (let i = 0; i < take; i++) this.mic[keep + i] = buf.readInt16LE((from + i) * 2);
    this.queued = keep + take;
  }

  /** 프로그램 소리 덩어리에 같은 길이만큼 마이크를 더해 돌려준다 (길이는 프로그램 소리 그대로) */
  mix(chunk) {
    const buf = this.mainCarry.length ? Buffer.concat([this.mainCarry, chunk]) : chunk;
    const n = buf.length >> 1;
    this.mainCarry = Buffer.from(buf.subarray(n * 2));
    const out = Buffer.alloc(n * 2);
    const m = Math.min(n, this.queued);
    for (let i = 0; i < n; i++) out.writeInt16LE(clip(buf.readInt16LE(i * 2) + (i < m ? this.mic[i] : 0)), i * 2);
    this.mic.copyWithin(0, m, this.queued);
    this.queued -= m;
    return out;
  }
}

/**
 * 출처 열기. args.mixMic 이 있으면 프로그램(args 의 나머지)과 그 마이크를 함께 열어 섞은 소리를 onData 로 낸다.
 * open(args, {onData, onEnd}) → {stop()} 은 출처 하나를 여는 함수 (helper capture 또는 시험 파일).
 * 마이크만 끊기면 프로그램 소리는 그대로 받고 onMicLost 로 알린다. 프로그램이 끊기면 onEnd (다시 붙이기는 LiveSession)
 */
function mixedSource(open, args, { onData, onEnd, onMicLost = () => {} }) {
  if (!args?.mixMic) return open(args, { onData, onEnd });
  const { mixMic, ...main } = args;
  const mixer = new MicMixer();
  let mic = null;
  let micAlive = false;
  const stopMic = () => {
    micAlive = false;
    mic?.stop();
  };
  const prog = open(main, {
    onData: (c) => onData(mixer.mix(c)),
    onEnd: (message) => {
      stopMic();
      return onEnd(message);
    },
  });
  const micLost = (message) => {
    if (!micAlive) return;
    micAlive = false;
    onMicLost(message);
  };
  try {
    micAlive = true;
    mic = open({ mic: mixMic }, { onData: (c) => { if (micAlive) mixer.pushMic(c); }, onEnd: micLost });
  } catch (e) {
    micLost(e?.message ?? String(e)); // 마이크를 못 열어도 프로그램 소리는 받는다
  }
  return {
    stop() {
      stopMic();
      prog.stop();
    },
  };
}

module.exports = { MicMixer, MIC_LAG_MAX, mixedSource };
