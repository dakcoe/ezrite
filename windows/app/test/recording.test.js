'use strict';

// 녹음 원본 저장(.pcm 이어 쓰기 → helper encode 로 .m4a), 재생용 Range 해석, 설정 저장 시험. 모두 임시 폴더에서.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PcmFile, finishAudio, parseRange } = require('../lib/recording');
const Settings = require('../lib/settings');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-rec-'));

test('PcmFile: 조각을 이어 쓰고 길이(초)를 센다. 닫은 뒤 쓰기는 무시', () => {
  const d = tempDir();
  const p = path.join(d, '2026-10-17_10-00-00.pcm');
  const f = new PcmFile(p);
  f.write(Buffer.alloc(32000));
  f.write(Buffer.alloc(16000));
  assert.equal(f.seconds, 1.5);
  f.close();
  f.write(Buffer.alloc(100));
  assert.equal(fs.statSync(p).size, 48000);
});

test('PcmFile: 폴더가 없으면 만든다', () => {
  const p = path.join(tempDir(), 'a', 'b', 'x.pcm');
  const f = new PcmFile(p);
  f.write(Buffer.from([1, 2]));
  f.close();
  assert.equal(fs.readFileSync(p).length, 2);
});

test('finishAudio: helper 로 임시 이름에 만든 뒤 .m4a 로 옮기고 .pcm 을 지운다', async () => {
  const d = tempDir();
  const pcm = path.join(d, '2026-10-17_10-00-00.pcm');
  fs.writeFileSync(pcm, Buffer.alloc(3200));
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    fs.writeFileSync(args[4], 'm4a');
    return '{"seconds":0.1}';
  };
  const out = await finishAudio(pcm, { run });
  assert.equal(out, path.join(d, '2026-10-17_10-00-00.m4a'));
  assert.deepEqual(calls[0].slice(0, 4), ['encode', '--in', pcm, '--out']);
  assert.match(path.basename(calls[0][4]), /^\.encoding-2026-10-17_10-00-00\.m4a$/);
  assert.deepEqual(fs.readdirSync(d), ['2026-10-17_10-00-00.m4a']);
});

test('finishAudio: 바꾸기에 실패하면 .pcm 을 남기고 반쯤 된 파일은 지운다', async () => {
  const d = tempDir();
  const pcm = path.join(d, '2026-10-17_10-00-00.pcm');
  fs.writeFileSync(pcm, Buffer.alloc(3200));
  const run = async (args) => {
    fs.writeFileSync(args[4], 'half');
    throw new Error('encode 실패: 테스트');
  };
  await assert.rejects(() => finishAudio(pcm, { run }), /encode 실패/);
  assert.deepEqual(fs.readdirSync(d), ['2026-10-17_10-00-00.pcm']);
});

test('finishAudio: 빈 .pcm 은 지우고 소리 파일을 만들지 않는다', async () => {
  const d = tempDir();
  const pcm = path.join(d, '2026-10-17_10-00-00.pcm');
  fs.writeFileSync(pcm, Buffer.alloc(0));
  const out = await finishAudio(pcm, { run: async () => assert.fail('부르지 않는다') });
  assert.equal(out, null);
  assert.deepEqual(fs.readdirSync(d), []);
});

test('finishAudio: .pcm 이 없으면 null', async () => {
  assert.equal(await finishAudio(path.join(tempDir(), 'x.pcm'), { run: async () => '' }), null);
});

test('parseRange: bytes=a-b, a-, -n 과 범위 밖', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 });
  assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
  assert.equal(parseRange(null, 1000), null);
  assert.equal(parseRange('items=0-1', 1000), null);
  assert.equal(parseRange('bytes=0-1,5-6', 1000), null); // 여러 구간은 통째로 보낸다
});

// --- 설정 (맥 UserDefaults 자리: %APPDATA%\Ezrite\settings.json) ---

test('설정: 없으면 기본값, 저장한 값은 다음에 그대로', () => {
  const file = path.join(tempDir(), 'Ezrite', 'settings.json');
  assert.deepEqual(Settings.load(file), Settings.DEFAULTS);
  Settings.save(file, { ...Settings.DEFAULTS, language: 'English', notesFolder: 'D:\\수업', options: { autoTranslate: false, askBeforeRecord: true, includeMic: true } });
  const s = Settings.load(file);
  assert.equal(s.language, 'English');
  assert.equal(s.notesFolder, 'D:\\수업');
  assert.deepEqual(s.options, { autoTranslate: false, askBeforeRecord: true, includeMic: true });
});

test('설정: AI 지침은 글 그대로 남기고, 글이 아니면 빈 글, 너무 길면 자른다', () => {
  const file = path.join(tempDir(), 'settings.json');
  Settings.save(file, { ...Settings.DEFAULTS, userGuide: '통계학 2학년 수준으로\n수식은 풀이까지' });
  assert.equal(Settings.load(file).userGuide, '통계학 2학년 수준으로\n수식은 풀이까지');
  fs.writeFileSync(file, JSON.stringify({ userGuide: 42 }));
  assert.equal(Settings.load(file).userGuide, '');
  fs.writeFileSync(file, JSON.stringify({ userGuide: '가'.repeat(Settings.GUIDE_MAX + 50) }));
  assert.equal(Settings.load(file).userGuide.length, Settings.GUIDE_MAX);
});

test('설정: 사용 가이드를 한 번 보여줬는지 (맥 welcomed) 는 참·거짓만', () => {
  const file = path.join(tempDir(), 'settings.json');
  assert.equal(Settings.load(file).welcomed, false);
  Settings.save(file, { ...Settings.DEFAULTS, welcomed: true });
  assert.equal(Settings.load(file).welcomed, true);
  fs.writeFileSync(file, JSON.stringify({ welcomed: 'yes' }));
  assert.equal(Settings.load(file).welcomed, false);
});

test('설정: 깨진 파일·모르는 값·틀린 형식은 기본값으로', () => {
  const file = path.join(tempDir(), 'settings.json');
  fs.writeFileSync(file, '{ 깨짐');
  assert.deepEqual(Settings.load(file), Settings.DEFAULTS);
  fs.writeFileSync(file, JSON.stringify({ language: 'Klingon', notesFolder: 3, options: { autoTranslate: 'yes', includeMic: true }, sourceId: 'pid:5', extra: 1 }));
  const s = Settings.load(file);
  assert.equal(s.language, Settings.DEFAULTS.language);
  assert.equal(s.notesFolder, '');
  assert.deepEqual(s.options, { ...Settings.DEFAULTS.options, includeMic: true });
  assert.equal(s.sourceId, 'pid:5');
  assert.equal('extra' in s, false);
});
