'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseListOutput, rmsFromS16le, levelFromRms, appLabel } = require('../lib/audio');

function s16(values) {
  const b = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => b.writeInt16LE(v, i * 2));
  return b;
}

test('list 출력을 앱/마이크 목록으로 읽는다', () => {
  const out = JSON.stringify({
    apps: [{ pid: 1234, exe: 'chrome.exe', title: 'YouTube' }, { pid: 99, exe: 'x.exe' }],
    mics: [{ id: '{0.0.1}', name: '마이크', default: true }],
  });
  const r = parseListOutput(`${out}\r\n`);
  assert.deepEqual(r.apps, [
    { pid: 1234, exe: 'chrome.exe', title: 'YouTube' },
    { pid: 99, exe: 'x.exe', title: '' },
  ]);
  assert.deepEqual(r.mics, [{ id: '{0.0.1}', name: '마이크', isDefault: true }]);
});

test('여러 줄이면 마지막 줄을 쓰고, 잘못된 항목은 걸러낸다', () => {
  const out = 'log line\n' + JSON.stringify({
    apps: [{ pid: 0, exe: 'idle' }, { pid: 'x', exe: 'a' }, { pid: 5, exe: 'ok.exe' }],
    mics: [{ id: '' }, { id: 'm1' }],
  });
  const r = parseListOutput(out);
  assert.deepEqual(r.apps.map((a) => a.pid), [5]);
  assert.deepEqual(r.mics, [{ id: 'm1', name: 'm1', isDefault: false }]);
});

test('빈 출력·JSON 아님·필드 없음은 에러', () => {
  assert.throws(() => parseListOutput('  \n'), /비어 있음/);
  assert.throws(() => parseListOutput('not json'), /JSON이 아님/);
  assert.throws(() => parseListOutput('{"apps":[]}'), /apps\/mics/);
});

test('RMS: 무음은 0, 최대 진폭 사각파는 거의 1', () => {
  assert.equal(rmsFromS16le(s16([0, 0, 0])).rms, 0);
  const r = rmsFromS16le(s16([32767, -32768, 32767, -32768]));
  assert.ok(r.rms > 0.999);
  assert.equal(r.samples, 4);
});

test('홀수 바이트로 끊긴 조각은 다음 조각과 이어 붙인다', () => {
  const full = s16([16384, 16384]);
  const a = rmsFromS16le(full.subarray(0, 3));
  assert.equal(a.samples, 1);
  assert.equal(a.carry.length, 1);
  const b = rmsFromS16le(full.subarray(3), a.carry);
  assert.equal(b.samples, 1);
  assert.equal(b.carry.length, 0);
  assert.ok(Math.abs(b.rms - 0.5) < 1e-6);
});

test('빈 조각은 0', () => {
  const r = rmsFromS16le(Buffer.alloc(0));
  assert.equal(r.rms, 0);
  assert.equal(r.samples, 0);
});

test('막대 길이는 -60dB~0dB를 0~1로', () => {
  assert.equal(levelFromRms(0), 0);
  assert.equal(levelFromRms(NaN), 0);
  assert.equal(levelFromRms(1), 1);
  assert.equal(levelFromRms(2), 1);
  assert.equal(levelFromRms(0.0001), 0);
  assert.ok(Math.abs(levelFromRms(0.031622776) - 0.5) < 1e-6);
});

test('목록 이름은 창 제목이 있으면 함께 보인다', () => {
  assert.equal(appLabel({ exe: 'a.exe', title: '' }), 'a.exe');
  assert.equal(appLabel({ exe: 'a.exe', title: 'T' }), 'a.exe — T');
});
