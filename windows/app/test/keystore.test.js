'use strict';

// 맥 APIKey(Groq.swift) 규칙: 파일 하나에 키, 읽을 때 앞뒤 공백 자름, 빈 키 저장 = 삭제
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { KeyStore, defaultDir } = require('../lib/keystore');

const KEY = 'gsk_SECRET_test_key_1234567890';

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-key-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'Ezrite');
}

test('기본 위치는 %APPDATA%\\Ezrite, 파일 이름은 groq_key', () => {
  assert.equal(defaultDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }),
    path.join('C:\\Users\\u\\AppData\\Roaming', 'Ezrite'));
  const s = new KeyStore({ dir: 'X' });
  assert.equal(s.file('groq'), path.join('X', 'groq_key'));
});

test('APPDATA 가 없으면 홈 아래 AppData\\Roaming 으로', () => {
  assert.equal(defaultDir({}), path.join(os.homedir(), 'AppData', 'Roaming', 'Ezrite'));
});

test('키가 없으면 null (폴더도 없을 때)', () => {
  const s = new KeyStore({ dir: tmp() });
  assert.equal(s.read(), null);
  assert.equal(s.has(), false);
});

test('저장하면 폴더를 만들고, 읽을 때 앞뒤 공백·줄바꿈을 자른다', () => {
  const dir = tmp();
  const s = new KeyStore({ dir });
  s.save(`  ${KEY}\r\n`);
  assert.equal(fs.readFileSync(path.join(dir, 'groq_key'), 'utf8'), `  ${KEY}\r\n`);
  assert.equal(s.read(), KEY);
  assert.equal(s.has(), true);
});

test('다시 저장하면 덮어쓴다', () => {
  const s = new KeyStore({ dir: tmp() });
  s.save('first');
  s.save('second');
  assert.equal(s.read(), 'second');
});

test('빈 키를 저장하면 지운다, 없는 키 지우기도 오류가 아니다', () => {
  const dir = tmp();
  const s = new KeyStore({ dir });
  s.save(KEY);
  s.save('');
  assert.equal(fs.existsSync(path.join(dir, 'groq_key')), false);
  assert.equal(s.read(), null);
  s.remove();
  s.save('');
});

test('공백만 있는 파일은 키가 없는 것', () => {
  const dir = tmp();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'groq_key'), ' \n\t ');
  assert.equal(new KeyStore({ dir }).read(), null);
});

test('저장 뒤 임시 파일이 남지 않는다', () => {
  const dir = tmp();
  new KeyStore({ dir }).save(KEY);
  assert.deepEqual(fs.readdirSync(dir), ['groq_key']);
});

test('다른 서비스 키도 같은 꼴(<서비스>_key)로 둘 수 있다. 이상한 이름은 거부', () => {
  const dir = tmp();
  const s = new KeyStore({ dir });
  s.save('k2', 'gemini');
  assert.equal(s.read('gemini'), 'k2');
  assert.equal(s.read('groq'), null);
  for (const bad of ['../x', 'a/b', '', 'A B', 'groq\\..']) {
    assert.throws(() => s.read(bad), /서비스 이름/);
  }
});

test('키는 문자열이어야 한다', () => {
  const s = new KeyStore({ dir: tmp() });
  assert.throws(() => s.save(null), TypeError);
  assert.throws(() => s.save(123), TypeError);
});

test('읽기 실패(파일 자리에 폴더 등)는 키 없이 경로만 담은 오류', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'groq_key'), { recursive: true });
  const s = new KeyStore({ dir });
  assert.throws(() => s.read(), (e) => /API 키를 읽지 못했습니다/.test(e.message));
});

test('쓰기 실패 오류 메시지에 키가 들어가지 않는다', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'groq_key'), { recursive: true }); // 파일 자리에 폴더 → rename 실패
  const s = new KeyStore({ dir });
  const err = (() => { try { s.save(KEY); } catch (e) { return e; } })();
  assert.ok(err, '오류가 나야 한다');
  assert.match(err.message, /API 키를 저장하지 못했습니다/);
  assert.ok(!err.message.includes(KEY));
  assert.ok(!String(err.stack).includes(KEY));
  assert.ok(fs.readdirSync(dir).every((f) => !f.includes('.tmp')), '임시 파일 정리');
});

test('dir 를 주지 않으면 기본 위치를 쓴다 (파일은 만들지 않는다)', () => {
  const s = new KeyStore();
  assert.equal(s.file(), path.join(defaultDir(), 'groq_key'));
});
