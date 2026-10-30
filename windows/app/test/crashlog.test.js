'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { install, formatEntry, redact } = require('../lib/crashlog');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-crashlog-'));
}

test('처리 안 된 예외와 거부를 로그 파일에 쓰고 앱 안 알림을 부른다 (대화상자 대신)', () => {
  const dir = tmpDir();
  const proc = new EventEmitter();
  const seen = [];
  const off = install({ logDir: dir, onError: (m) => seen.push(m), proc, now: () => new Date('2026-10-18T00:00:00Z') });
  proc.emit('uncaughtException', new TypeError('boom'));
  proc.emit('unhandledRejection', 'nope');
  const log = fs.readFileSync(path.join(dir, 'main.log'), 'utf8');
  assert.match(log, /\[2026-10-18T00:00:00.000Z\] uncaughtException\nTypeError: boom/);
  assert.match(log, /unhandledRejection\nnope/);
  assert.deepEqual(seen, ['boom', 'nope']);
  off();
  assert.equal(proc.listenerCount('uncaughtException'), 0);
  assert.equal(proc.listenerCount('unhandledRejection'), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('로그와 알림에 API 키 모양 글자는 가린다', () => {
  assert.equal(redact('bad key gsk_ABCDEFGH12345678 here'), 'bad key gsk_*** here');
  assert.equal(redact('sk-ant-api03-abcdefghijk'), 'sk-ant-***');
  assert.equal(redact('AIzaSyABCDEFGHIJKL'), 'AIza***');
  const e = new Error('401 for gsk_SECRETSECRET1234');
  assert.ok(!formatEntry('uncaughtException', e).includes('SECRETSECRET'));
});

test('로그를 못 쓰거나 알림이 다시 던져도 처리기는 던지지 않는다', () => {
  const proc = new EventEmitter();
  // 로그 폴더 자리에 파일이 있어 mkdir 이 실패하는 경우
  const dir = tmpDir();
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, 'x');
  install({ logDir: path.join(blocker, 'logs'), onError: () => { throw new Error('again'); }, proc });
  assert.doesNotThrow(() => proc.emit('uncaughtException', new Error('x')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('[1.2.4] 한 줄 기록: 시각과 함께 main.log 에 덧붙인다 (키 모양은 가린다, 못 써도 던지지 않는다)', () => {
  const { appendLine } = require('../lib/crashlog');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-log-')), 'logs');
  appendLine(dir, 'Ezrite 정리: a.m4a 지움 (글 없는 소리)', new Date('2026-10-30T10:00:00Z'));
  appendLine(dir, 'gsk_ABCDEFGHIJKL 줄', new Date('2026-10-30T10:00:01Z'));
  assert.equal(fs.readFileSync(path.join(dir, 'main.log'), 'utf8'),
    '[2026-10-30T10:00:00.000Z] Ezrite 정리: a.m4a 지움 (글 없는 소리)\n[2026-10-30T10:00:01.000Z] gsk_*** 줄\n');
  assert.doesNotThrow(() => appendLine('\0bad', 'x'));
});

test('main.js 는 다른 모듈을 부르기 전에 처리기를 단다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const at = src.indexOf("require('./lib/crashlog')");
  assert.ok(at > 0, 'crashlog 를 불러야 함');
  assert.ok(at < src.indexOf("require('./lib/audio')"), '앱 모듈보다 먼저');
});
