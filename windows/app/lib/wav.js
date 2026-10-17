'use strict';

// Float 샘플 → 16kHz mono 16-bit PCM WAV. 맥 WAV.encode(Audio.swift) 이식.

const SAMPLE_RATE = 16000;

function encodeWav(samples) {
  const n = samples.length;
  const out = Buffer.alloc(44 + n * 2);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + n * 2, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(SAMPLE_RATE, 24);
  out.writeUInt32LE(SAMPLE_RATE * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    // Swift Int16(Float) 는 0 쪽으로 버린다. NaN 은 Swift 에서 멈추므로(트랩) 여기서는 0 으로 둔다
    const v = Number.isNaN(s) ? 0 : Math.trunc(Math.fround(s * 32767));
    out.writeInt16LE(v, 44 + i * 2);
  }
  return out;
}

module.exports = { encodeWav, SAMPLE_RATE };
