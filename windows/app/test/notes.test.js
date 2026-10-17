'use strict';

// 기록 저장 규칙. 맥 StorageTests · TimelineTests(줄마다 시각) 이식 + 맥 Notes.swift 의 이름·형식 규칙 시험.
// 모두 임시 폴더에서 한다. 실제 %APPDATA% 는 건드리지 않는다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const N = require('../lib/notes');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-notes-'));
}

/** 파일 하나 만들기. daysOld: 수정 시각을 그만큼 옛날로 */
function file(dir, name, { daysOld = 0, body = '내용\n' } = {}) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  const t = new Date(Date.now() - daysOld * 86400_000);
  fs.utimesSync(p, t, t);
  return p;
}

const names = (dir) => fs.readdirSync(dir).sort();

// --- 맥 StorageTests ---

test('[mac StorageTests] 기록_목록에는_이_앱이_만든_파일만_나온다', () => {
  const d = tempDir();
  file(d, '2026-10-14_21-13-43.txt');
  file(d, '2026-10-14_21-23-07 1주차 수업.txt');
  file(d, '6주차 정리.txt'); // 사용자가 직접 만든 노트
  assert.deepEqual(N.sessions(d).map((s) => path.basename(s.path)).sort(),
    ['2026-10-14_21-13-43.txt', '2026-10-14_21-23-07 1주차 수업.txt']);
});

test('[mac StorageTests] 사용자가_고른_폴더에서는_오래된_기록도_지우지_않는다', () => {
  const d = tempDir();
  const old = file(d, '2025-01-01_10-00-00.txt', { daysOld: 400 });
  const mine = file(d, '6주차 정리.txt', { daysOld: 400 });
  N.prune(d, { autoDelete: false });
  assert.ok(fs.existsSync(old));
  assert.ok(fs.existsSync(mine));
});

test('[mac StorageTests] 기본_폴더에서는_30일_지난_기록만_지우고_다른_파일은_남긴다', () => {
  const d = tempDir();
  const old = file(d, '2025-01-01_10-00-00.txt', { daysOld: 400 });
  const oldAudio = file(d, '2025-01-01_10-00-00.m4a', { daysOld: 400 });
  const recent = file(d, path.basename(N.newPath(d)));
  const mine = file(d, '메모.txt', { daysOld: 400 });
  N.prune(d, { autoDelete: true });
  assert.ok(!fs.existsSync(old));
  assert.ok(!fs.existsSync(oldAudio));
  assert.ok(fs.existsSync(recent));
  assert.ok(fs.existsSync(mine));
});

test('[mac StorageTests] 내보내면_글과_소리를_고른_폴더로_복사하고_원본은_남는다', () => {
  const src = tempDir();
  const dest = tempDir();
  const txt = file(src, '2026-10-14_21-23-07 테스트.txt');
  file(src, '2026-10-14_21-23-07 테스트.m4a');
  const out = N.exportTo(txt, dest);
  assert.deepEqual(out.map((p) => path.basename(p)).sort(), ['2026-10-14_21-23-07 테스트.m4a', '2026-10-14_21-23-07 테스트.txt']);
  assert.ok(fs.existsSync(txt));
  // 같은 이름이 이미 있으면 덮어쓰지 않고 번호를 붙인다
  const again = N.exportTo(txt, dest);
  assert.deepEqual(again.map((p) => path.basename(p)).sort(), ['2026-10-14_21-23-07 테스트 2.m4a', '2026-10-14_21-23-07 테스트 2.txt']);
});

// --- 맥 TimelineTests ---

test('[mac TimelineTests] 줄마다의_시각을_따로_저장하고_다시_읽을_때_글_줄에만_붙인다', () => {
  const d = tempDir();
  const txt = path.join(d, '2026-10-15_09-00-00.txt');
  fs.writeFileSync(txt, '첫 줄\n── 09:01:00 소리가 끊겼습니다\n둘째 줄\n    번역\n');
  N.saveTimes([[1.0, 3.0], [5.5, 8.0]], txt);
  const entries = N.load(txt);
  assert.deepEqual(entries.map((e) => e.kind), ['text', 'gap', 'text']);
  assert.deepEqual(entries[0].time, [1.0, 3.0]);
  assert.equal(entries[1].time, null);
  assert.deepEqual(entries[2].time, [5.5, 8.0]);
  assert.equal(entries[2].translation, '번역');
});

// --- 맥 Notes.swift 규칙 ---

test('파일 형식: 원문 / 네 칸 들여쓴 번역 / 끊김 줄 그대로', () => {
  const text = N.render([
    { kind: 'text', original: 'Hello there.', translation: '안녕하세요.' },
    { kind: 'gap', original: '── 09:01:00 소리가 끊겼습니다', translation: null },
    { kind: 'text', original: '번역 없는 줄', translation: null },
  ]);
  assert.equal(text, 'Hello there.\n    안녕하세요.\n── 09:01:00 소리가 끊겼습니다\n번역 없는 줄');
});

test('읽기: 들여쓴 줄이 여러 개면 한 번역으로 잇고, 빈 줄은 건너뛰고, 원문 앞뒤 공백은 뗀다', () => {
  const entries = N.parse('  첫 줄  \n\n    번역 하나\n    번역 둘\n── 10:00:00 인식 언어 → English\n    끊김 뒤 들여쓴 줄\n');
  assert.deepEqual(entries.map((e) => [e.kind, e.original, e.translation]), [
    ['text', '첫 줄', '번역 하나 번역 둘'],
    ['gap', '── 10:00:00 인식 언어 → English', null],
    ['text', '끊김 뒤 들여쓴 줄', null], // 끊김 줄 아래 들여쓴 줄은 번역이 아니다
  ]);
});

test('CRLF 로 저장된 기록도 읽는다 (메모장에서 고친 파일)', () => {
  const entries = N.parse('첫 줄\r\n    번역\r\n');
  assert.deepEqual(entries.map((e) => [e.original, e.translation]), [['첫 줄', '번역']]);
});

test('새 이름은 시작 시각, 같은 이름(글이나 소리)이 있으면 _2, _3', () => {
  const d = tempDir();
  const at = new Date(2026, 9, 17, 9, 5, 3);
  assert.equal(path.basename(N.newPath(d, at)), '2026-10-17_09-05-03.txt');
  file(d, '2026-10-17_09-05-03.txt');
  assert.equal(path.basename(N.newPath(d, at)), '2026-10-17_09-05-03_2.txt');
  file(d, '2026-10-17_09-05-03_2.m4a');
  assert.equal(path.basename(N.newPath(d, at)), '2026-10-17_09-05-03_3.txt');
});

test('제목은 시작 시각 뒤의 글, _번호는 빼고', () => {
  assert.equal(N.title('C:/x/2026-10-14_21-23-07 1주차 수업.txt'), '1주차 수업');
  assert.equal(N.title('2026-10-14_21-23-07_2 실험.txt'), '실험');
  assert.equal(N.title('2026-10-14_21-23-07.txt'), '');
  assert.equal(N.title('2026-10-14_21-23-07_3.txt'), '');
});

test('시작 시각은 이름 앞 19자. 형식이 아니면 null', () => {
  assert.deepEqual(N.startedAt('2026-10-14_21-23-07 수업.txt'), new Date(2026, 9, 14, 21, 23, 7));
  assert.equal(N.startedAt('메모.txt'), null);
  assert.equal(N.startedAt('2026-13-40_99-00-00.txt'), null);
});

test('이름 바꾸기: 딸린 파일(소리·시각)도 같이, 빈 이름이면 이름을 없앤다, _번호는 지킨다', () => {
  const d = tempDir();
  const txt = file(d, '2026-10-14_21-23-07_2.txt');
  file(d, '2026-10-14_21-23-07_2.m4a');
  file(d, '2026-10-14_21-23-07_2.times.json', { body: '[]' });
  // 맥처럼 / : 줄바꿈 자리에서 나눈 조각을 띄어쓰기로 잇는다 (": " 는 띄어쓰기 두 칸이 된다)
  const renamed = N.rename(txt, '  1주차: 수업/정리  ');
  assert.equal(path.basename(renamed), '2026-10-14_21-23-07_2 1주차  수업 정리.txt');
  assert.deepEqual(names(d), [
    '2026-10-14_21-23-07_2 1주차  수업 정리.m4a',
    '2026-10-14_21-23-07_2 1주차  수업 정리.times.json',
    '2026-10-14_21-23-07_2 1주차  수업 정리.txt',
  ]);
  const back = N.rename(renamed, '');
  assert.equal(path.basename(back), '2026-10-14_21-23-07_2.txt');
  assert.equal(N.rename(back, ''), back); // 그대로면 아무것도 안 한다
});

test('이름 바꾸기: Windows 파일 이름에 못 쓰는 글자는 띄어쓰기로', () => {
  const d = tempDir();
  const txt = file(d, '2026-10-14_21-23-07.txt');
  assert.equal(path.basename(N.rename(txt, 'a\\b*c?d"e<f>g|h')), '2026-10-14_21-23-07 a b c d e f g h.txt');
});

test('딸린 파일: "기록이름." 으로 시작하는 파일만 (비슷한 이름의 다른 기록은 아니다)', () => {
  const d = tempDir();
  const txt = file(d, '2026-10-14_21-23-07.txt');
  file(d, '2026-10-14_21-23-07.m4a');
  file(d, '2026-10-14_21-23-07.pcm');
  file(d, '2026-10-14_21-23-07_2.txt');
  file(d, '2026-10-14_21-23-07 다른.txt');
  assert.deepEqual(N.companions(txt).map((c) => c.suffix).sort(), ['.m4a', '.pcm']);
});

test('지우기: 글과 딸린 파일을 휴지통 함수로 넘긴다', async () => {
  const d = tempDir();
  const txt = file(d, '2026-10-14_21-23-07.txt');
  file(d, '2026-10-14_21-23-07.m4a');
  const trashed = [];
  await N.remove(txt, async (p) => { trashed.push(path.basename(p)); fs.rmSync(p); });
  assert.deepEqual(trashed.sort(), ['2026-10-14_21-23-07.m4a', '2026-10-14_21-23-07.txt']);
  assert.deepEqual(names(d), []);
});

test('정리: 글 없이 소리만 남은 기록 소리는 지운다 (맥 prune)', () => {
  const d = tempDir();
  file(d, '2026-10-14_21-23-07.m4a');
  file(d, '2026-10-14_21-30-00.txt');
  file(d, '2026-10-14_21-30-00.m4a');
  file(d, '내 음악.m4a');
  N.prune(d, { autoDelete: false });
  assert.deepEqual(names(d), ['2026-10-14_21-30-00.m4a', '2026-10-14_21-30-00.txt', '내 음악.m4a']);
});

test('되살릴 소리: 끝내지 못한 .pcm (글이 있는 것만, 글 없는 pcm 은 지운다)', () => {
  const d = tempDir();
  file(d, '2026-10-14_21-23-07.txt');
  file(d, '2026-10-14_21-23-07.pcm');
  file(d, '2026-10-14_22-00-00.pcm'); // 받아 적은 글이 하나도 없던 녹음
  file(d, '다른.pcm');
  const list = N.pendingAudio(d);
  assert.deepEqual(list.map((p) => path.basename(p)), ['2026-10-14_21-23-07.pcm']);
  assert.ok(!fs.existsSync(path.join(d, '2026-10-14_22-00-00.pcm')));
  assert.ok(fs.existsSync(path.join(d, '다른.pcm')));
});

test('목록 미리보기: 끊김 줄이 아닌 첫 줄', () => {
  const d = tempDir();
  const txt = file(d, '2026-10-14_21-23-07.txt', { body: '── 21:23:07 소리 출처 → chrome\n첫 문장입니다.\n    First.\n' });
  const s = N.sessions(d)[0];
  assert.equal(s.preview, '첫 문장입니다.');
  assert.equal(s.audio, false);
  assert.equal(s.path, txt);
  assert.equal(s.date, new Date(2026, 9, 14, 21, 23, 7).getTime());
});

test('목록은 최신이 먼저', () => {
  const d = tempDir();
  file(d, '2026-10-14_09-00-00.txt');
  file(d, '2026-10-15_09-00-00.txt');
  assert.deepEqual(N.sessions(d).map((s) => path.basename(s.path)), ['2026-10-15_09-00-00.txt', '2026-10-14_09-00-00.txt']);
});

test('폴더가 없으면 목록은 비어 있고 정리는 조용히 넘어간다', () => {
  const d = path.join(tempDir(), '없음');
  assert.deepEqual(N.sessions(d), []);
  N.prune(d, { autoDelete: true });
  assert.deepEqual(N.pendingAudio(d), []);
});

test('Writer: 첫 줄을 쓸 때 파일을 만들고, 줄마다 이어 쓰고, 번역이 붙으면 통째로 다시 쓴다', () => {
  const d = path.join(tempDir(), 'notes', 'autosave');
  const w = new N.Writer(d, new Date(2026, 9, 17, 10, 0, 0));
  assert.equal(path.basename(w.planned), '2026-10-17_10-00-00.txt');
  assert.equal(w.path, null);
  assert.ok(!fs.existsSync(w.planned));
  w.append('Hello.');
  w.append('── 10:00:05 다시 연결됨');
  assert.equal(w.path, w.planned);
  assert.equal(fs.readFileSync(w.path, 'utf8'), 'Hello.\n── 10:00:05 다시 연결됨\n');
  w.rewrite([
    { kind: 'text', original: 'Hello.', translation: '안녕.' },
    { kind: 'gap', original: '── 10:00:05 다시 연결됨', translation: null },
  ]);
  assert.equal(fs.readFileSync(w.path, 'utf8'), 'Hello.\n    안녕.\n── 10:00:05 다시 연결됨\n');
});

test('Writer: 아직 아무것도 안 썼으면 다시 쓰기는 하지 않는다', () => {
  const d = tempDir();
  const w = new N.Writer(d);
  w.rewrite([{ kind: 'text', original: 'x', translation: 'y' }]);
  assert.deepEqual(names(d), []);
});

test('Writer: 쓰기가 실패해도 던지지 않는다 (받아쓰기는 계속돼야 한다)', () => {
  const d = tempDir();
  const blocker = file(d, 'notes'); // 폴더 자리에 파일이 있어 만들 수 없다
  const w = new N.Writer(path.join(blocker, 'autosave'));
  assert.doesNotThrow(() => w.append('x'));
  assert.equal(w.path, null);
});

test('기본 저장 위치는 맥과 같은 notes/autosave (%APPDATA%\\Ezrite 아래)', () => {
  assert.equal(N.defaultDir({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }),
    path.join('C:\\Users\\a\\AppData\\Roaming', 'Ezrite', 'notes', 'autosave'));
});

test('기록 경로 확인: 그 폴더 안의 이 앱 기록(.txt)만 받는다 (화면에서 온 경로를 그대로 믿지 않는다)', () => {
  const d = tempDir();
  const txt = file(d, '2026-10-14_21-23-07.txt');
  assert.equal(N.ownNote(d, txt), txt);
  assert.equal(N.ownNote(d, path.join(d, '..', path.basename(d), '2026-10-14_21-23-07.txt')), txt);
  assert.equal(N.ownNote(d, path.join(d, '메모.txt')), null);
  assert.equal(N.ownNote(d, path.join(os.tmpdir(), '2026-10-14_21-23-07.txt')), null);
  assert.equal(N.ownNote(d, path.join(d, '2026-10-14_21-23-07.m4a')), null);
  assert.equal(N.ownNote(d, path.join(d, '2026-10-15_00-00-00.txt')), null); // 없는 파일
  assert.equal(N.ownNote(d, 42), null);
});
