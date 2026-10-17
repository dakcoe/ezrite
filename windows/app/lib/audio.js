'use strict';

// helper 출력 해석과 소리 크기 계산. Electron 없이 테스트할 수 있도록 순수 함수만 둔다.

/**
 * `ezrite-audio list`의 stdout(JSON 한 줄)을 읽어 앱/마이크 목록으로 만든다.
 * 형식이 틀리면 Error를 던진다.
 */
function parseListOutput(stdout) {
  const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop();
  if (!line) throw new Error('helper list 출력이 비어 있음');

  let data;
  try {
    data = JSON.parse(line);
  } catch (e) {
    throw new Error(`helper list 출력이 JSON이 아님: ${e.message}`);
  }

  if (!Array.isArray(data.apps) || !Array.isArray(data.mics)) {
    throw new Error('helper list 출력에 apps/mics 배열이 없음');
  }

  const apps = data.apps
    .filter((a) => Number.isInteger(a.pid) && a.pid > 0 && typeof a.exe === 'string')
    .map((a) => ({ pid: a.pid, exe: a.exe, title: typeof a.title === 'string' ? a.title : '' }));
  const mics = data.mics
    .filter((m) => typeof m.id === 'string' && m.id)
    .map((m) => ({ id: m.id, name: String(m.name || m.id), isDefault: m.default === true }));

  return { apps, mics };
}

/**
 * s16le 바이트 조각에서 RMS(0~1)를 낸다.
 * 조각이 홀수 바이트로 끊길 수 있어 남은 1바이트를 돌려준다.
 */
function rmsFromS16le(chunk, carry = Buffer.alloc(0)) {
  const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
  const n = Math.floor(buf.length / 2);
  const rest = buf.subarray(n * 2);
  if (n === 0) return { rms: 0, samples: 0, carry: Buffer.from(rest) };

  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  return { rms: Math.sqrt(sum / n), samples: n, carry: Buffer.from(rest) };
}

/** RMS를 막대 길이(0~1)로. 작은 소리도 보이도록 dB 눈금(-60dB~0dB)을 쓴다. */
function levelFromRms(rms) {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

/** 목록에 보일 이름 */
function appLabel(app) {
  return app.title ? `${app.exe} — ${app.title}` : app.exe;
}

/**
 * 녹음 중 소리 크기: 받은 조각(s16le)을 every 샘플(기본 800 = 50ms)마다 묶어 { level(0~1), rms } 를 낸다.
 * 프로그램 소리·마이크·섞은 소리 모두 LiveSession 'pcm' 조각을 그대로 넣는다 (맥 onLevel 은 90ms 마다)
 */
class LevelMeter {
  constructor(every = 800) {
    this.every = every;
    this.reset();
  }

  reset() {
    this.carry = Buffer.alloc(0);
  }

  /** 다 찬 묶음의 크기들 (없으면 null) */
  push(chunk) {
    const buf = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const size = this.every * 2;
    const out = [];
    let at = 0;
    for (; at + size <= buf.length; at += size) {
      const { rms } = rmsFromS16le(buf.subarray(at, at + size));
      out.push({ level: levelFromRms(rms), rms });
    }
    this.carry = Buffer.from(buf.subarray(at));
    return out.length ? out : null;
  }
}

module.exports = { parseListOutput, rmsFromS16le, levelFromRms, appLabel, LevelMeter };
