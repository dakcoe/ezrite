'use strict';

// 에너지 VAD — 30ms 블록의 RMS 로 발화 구간을 끊는다. 맥 VAD.swift 이식.
// 상태: 대기 ─[음성 감지]→ 발화 모음 ─[침묵·길이 조건]→ 발화 하나를 돌려줌 → 대기
//
// 맥은 Float(32비트)로 RMS·잡음 바닥을 계산한다. 문턱 근처에서 판정이 갈리지 않도록
// 같은 값들은 Math.fround 로 32비트 정밀도에 맞춘다. 초 단위 누적(Double)은 JS number 와 같다.

const f32 = Math.fround;

const SAMPLE_RATE = 16000;
const BLOCK_SIZE = 480; // 16kHz × 30ms
const BLOCK_SECS = 0.03;

const ONSET_BLOCKS = 3; // 연속 3블록(90ms) 음성이면 발화 시작
const PREROLL_BLOCKS = 10; // 시작 300ms 앞부터 포함 (첫 음절 잘림 방지)
const NOISE_FACTOR = f32(3.0); // 잡음 바닥의 3배를 넘으면 음성
const NOISE_FLOOR_MIN = f32(1e-4); // 완전 무음에서 문턱이 0 으로 붙는 것 방지

// 잡음 바닥은 빠르게 내려가고 아주 천천히 올라간다.
// 음성 아닌 블록으로만 갱신하면 시작이 완전 무음일 때 바닥이 0 에 붙어 발화가 안 끊기고,
// 최근 구간 백분위로 잡으면 말이 이어질 때 바닥이 음성 레벨까지 올라간다.
const NOISE_DOWN = f32(0.3);
const NOISE_UP = f32(0.0003); // 시상수 약 100초

// Groq 무료 한도(분당 20회)를 넘지 않도록 짧은 말은 뭉친다
const SHORT_SILENCE = 0.8; // 이만큼 조용하면 끊는다 (MIN_CHUNK 이상 모였을 때)
const LONG_SILENCE = 2.0; // 이만큼 조용하면 짧아도 끊는다
const MIN_CHUNK = 6.0;
const MAX_CHUNK = 12.0; // 계속 말하면 이 길이에서 강제로 끊는다
const MIN_UTTERANCE = 0.4; // 이보다 짧으면 잡음으로 보고 버린다
// 강제로 끊을 때 단어 가운데를 자르지 않도록, 마지막 1초(33블록) 안에서 가장 조용한 블록 뒤를 끊는 자리로 고른다.
// 그 뒤 블록들은 버리지 않고 다음 발화의 시작으로 넘긴다 (맥과 같은 규칙, 2026-10-17 사용자 결정)
const SPLIT_SEARCH_BLOCKS = 33;

function rms(block) {
  let sum = 0;
  for (let i = 0; i < block.length; i++) sum = f32(sum + f32(block[i] * block[i]));
  return f32(Math.sqrt(f32(sum / Math.max(1, block.length))));
}

function concat(blocks) {
  const out = new Float32Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

class VAD {
  constructor() {
    this.noiseFloor = null;
    this.preroll = [];
    this.speechRun = 0;
    this.utterance = [];
    this.levels = []; // utterance 블록마다 RMS
    this.speechFlags = []; // utterance 블록마다 음성 여부
    this.speechSecs = 0;
    this.silenceSecs = 0;
  }

  /** 지금 발화 버퍼에 들고 있는 샘플 수 (강제 끊김 뒤 넘긴 블록 포함) */
  get heldSamples() {
    return this.utterance.reduce((n, b) => n + b.length, 0);
  }

  get inSpeech() {
    return this.utterance.length > 0;
  }

  /** 블록 하나를 넣는다. 발화가 끊기면 그 샘플(Float32Array)을, 아니면 null 을 돌려준다 */
  feed(input) {
    const block = input instanceof Float32Array ? input : Float32Array.from(input);
    const level = rms(block);
    let floor = this.noiseFloor ?? Math.max(level, NOISE_FLOOR_MIN);
    if (this.noiseFloor !== null) {
      const k = level < floor ? NOISE_DOWN : NOISE_UP;
      floor = f32(f32(f32(1 - k) * floor) + f32(k * level));
    }
    floor = Math.max(floor, NOISE_FLOOR_MIN);
    this.noiseFloor = floor;
    const isSpeech = level > f32(floor * NOISE_FACTOR);

    if (this.utterance.length > 0) {
      this.utterance.push(block);
      this.levels.push(level);
      this.speechFlags.push(isSpeech);
      if (isSpeech) {
        this.speechSecs += BLOCK_SECS;
        this.silenceSecs = 0;
      } else {
        this.silenceSecs += BLOCK_SECS;
      }
      const total = this.utterance.length * BLOCK_SECS;
      if ((this.silenceSecs >= SHORT_SILENCE && this.speechSecs >= MIN_CHUNK)
        || this.silenceSecs >= LONG_SILENCE) {
        return this.flush();
      }
      return total >= MAX_CHUNK ? this.splitAtQuietest() : null;
    }

    this.preroll.push({ block, level, isSpeech });
    if (this.preroll.length > PREROLL_BLOCKS) this.preroll.shift();
    this.speechRun = isSpeech ? this.speechRun + 1 : 0;
    if (this.speechRun >= ONSET_BLOCKS) {
      this.utterance = this.preroll.map((p) => p.block);
      this.levels = this.preroll.map((p) => p.level);
      this.speechFlags = this.preroll.map((p) => p.isSpeech);
      this.speechSecs = this.speechRun * BLOCK_SECS;
      this.silenceSecs = 0;
      this.preroll = [];
    }
    return null;
  }

  /**
   * 최대 길이에 닿았을 때: 마지막 1초 안에서 RMS 가 가장 작은 블록(같으면 더 뒤)까지 내보내고,
   * 그 뒤 블록들은 다음 발화의 시작으로 넘긴다. 다음 발화는 바로 "말하는 중" 상태로 시작하고,
   * speechSecs 는 넘긴 블록 중 음성 블록 수 × 30ms 로 센다.
   */
  splitAtQuietest() {
    const n = this.utterance.length;
    const from = Math.max(0, n - SPLIT_SEARCH_BLOCKS);
    let cutAt = from;
    for (let i = from; i < n; i++) {
      if (this.levels[i] <= this.levels[cutAt]) cutAt = i; // <= 라서 같으면 더 뒤
    }

    const outBlocks = this.utterance.slice(0, cutAt + 1);
    const outSpeech = this.speechFlags.slice(0, cutAt + 1).filter(Boolean).length * BLOCK_SECS;
    const keepBlocks = this.utterance.slice(cutAt + 1);
    const keepLevels = this.levels.slice(cutAt + 1);
    const keepFlags = this.speechFlags.slice(cutAt + 1);

    this.utterance = keepBlocks;
    this.levels = keepLevels;
    this.speechFlags = keepFlags;
    this.speechSecs = keepFlags.filter(Boolean).length * BLOCK_SECS;
    // 넘긴 블록 끝쪽의 연속 무음은 무음 시간으로 이어서 센다
    let trailing = 0;
    for (let i = keepFlags.length - 1; i >= 0 && !keepFlags[i]; i--) trailing++;
    this.silenceSecs = trailing * BLOCK_SECS;
    this.speechRun = 0;

    if (outSpeech < MIN_UTTERANCE) return null;
    return concat(outBlocks);
  }

  /** 모으던 발화를 내보낸다. 너무 짧으면 버린다 */
  flush() {
    const blocks = this.utterance;
    const speech = this.speechSecs;
    this.utterance = [];
    this.levels = [];
    this.speechFlags = [];
    this.speechSecs = 0;
    this.silenceSecs = 0;
    this.speechRun = 0;
    if (blocks.length === 0 || speech < MIN_UTTERANCE) return null;
    return concat(blocks);
  }
}

Object.assign(VAD, {
  SAMPLE_RATE, BLOCK_SIZE, BLOCK_SECS, ONSET_BLOCKS, PREROLL_BLOCKS, NOISE_FACTOR, NOISE_FLOOR_MIN,
  NOISE_DOWN, NOISE_UP, SHORT_SILENCE, LONG_SILENCE, MIN_CHUNK, MAX_CHUNK, MIN_UTTERANCE, SPLIT_SEARCH_BLOCKS, rms,
});

/**
 * helper 가 흘리는 16kHz mono s16le 조각 → 30ms 블록 → VAD → 발화. 맥 AudioPipeline 의 VAD 부분.
 *
 * onUtterance({ samples, start, end }): 시각(초)은 녹음 파일 안의 위치다
 * onLevel(rms): 90ms 마다 파형 갱신용
 * startOffset: 이 스트림이 시작할 때 녹음 파일에 이미 쌓인 초 (다시 연결·일시정지 뒤에도 시각이 이어지게)
 *
 * 맥의 마이크 섞기(pushMic)는 옮기지 않았다. Windows helper 는 한 번에 소스 하나만 받는다.
 */
class VadStream {
  constructor({ onUtterance = () => {}, onLevel = () => {}, startOffset = 0 } = {}) {
    this.vad = new VAD();
    this.onUtterance = onUtterance;
    this.onLevel = onLevel;
    this.startOffset = startOffset;
    this.carry = Buffer.alloc(0); // 홀수 바이트로 끊긴 나머지
    this.pending = new Float32Array(BLOCK_SIZE);
    this.pendingLen = 0;
    this.blocksSinceLevel = 0;
    this.consumed = 0; // VAD 가 지금까지 읽은 샘플 수
  }

  emit(samples) {
    // 강제 끊김 뒤 VAD 가 아직 들고 있는(다음 발화로 넘긴) 샘플만큼 끝이 앞당겨진다
    const end = this.startOffset + (this.consumed - this.vad.heldSamples) / SAMPLE_RATE;
    this.onUtterance({ samples, start: end - samples.length / SAMPLE_RATE, end });
  }

  /** s16le 바이트 조각을 넣는다 */
  push(chunk) {
    if (!Buffer.isBuffer(chunk)) throw new TypeError('VadStream.push: Buffer 가 필요합니다');
    const buf = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const n = Math.floor(buf.length / 2);
    this.carry = Buffer.from(buf.subarray(n * 2));
    for (let i = 0; i < n; i++) {
      this.pending[this.pendingLen++] = buf.readInt16LE(i * 2) / 32768;
      if (this.pendingLen === BLOCK_SIZE) this.feedBlock();
    }
  }

  feedBlock() {
    const block = this.pending;
    this.pending = new Float32Array(BLOCK_SIZE);
    this.pendingLen = 0;
    this.blocksSinceLevel += 1;
    if (this.blocksSinceLevel >= 3) {
      this.blocksSinceLevel = 0;
      this.onLevel(rms(block));
    }
    this.consumed += BLOCK_SIZE;
    const u = this.vad.feed(block);
    if (u) this.emit(u);
  }

  /** 정지할 때 모으던 발화도 내보낸다. 블록이 안 된 나머지는 버린다 (맥과 같다) */
  finish() {
    const u = this.vad.flush();
    if (u) this.emit(u);
    this.pendingLen = 0;
    this.carry = Buffer.alloc(0);
  }
}

module.exports = { VAD, VadStream };
