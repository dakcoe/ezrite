'use strict';

// 기록마다 폴더 하나 (맥 Notes.swift · SessionFolderTests 8개 항목).
//   새 기록: <저장 폴더>/<기록이름>/<기록이름>.txt + 같은 폴더에 .m4a · .times.json · .pcm(녹음 중) 등 딸린 파일
//   예전 기록(저장 폴더 바로 아래 .txt)은 옮기지 않고 그대로 읽는다
// 모두 임시 폴더에서 한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const N = require('../lib/notes');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-folder-'));
function file(p, { daysOld = 0, body = '내용\n' } = {}) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  const t = new Date(Date.now() - daysOld * 86400_000);
  fs.utimesSync(p, t, t);
  return p;
}
const names = (dir) => fs.readdirSync(dir).sort();
const AT = new Date(2026, 9, 18, 9, 0, 0);
const NAME = '2026-10-18_09-00-00';

// ── 맥 SessionFolderTests.swift (fixtures/mac-notes) 8개 — 이름·조건 그대로 ──

/** 맥 make(): 폴더에 기록이름 + .txt·.m4a·.times.json 을 만든다 */
function make(folder, base, files = ['.txt', '.m4a', '.times.json']) {
  fs.mkdirSync(folder, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(folder, base + f), 'x\n');
  return path.join(folder, `${base}.txt`);
}

test('[mac SessionFolderTests] 새_기록은_자기_이름의_폴더_안에_만든다', () => {
  const d = tempDir();
  const u = N.newPath(d);
  const base = path.basename(u, '.txt');
  assert.equal(path.basename(path.dirname(u)), base);
  assert.equal(path.dirname(path.dirname(u)), d);
});

test('[mac SessionFolderTests] 같은_시각이면_폴더_이름에_번호를_붙인다', () => {
  const d = tempDir();
  const at = new Date();
  const first = N.newPath(d, at);
  make(path.dirname(first), path.basename(first, '.txt'));
  const second = N.newPath(d, at);
  assert.notEqual(path.dirname(second), path.dirname(first));
  assert.ok(path.basename(second, '.txt').endsWith('_2'));
});

test('[mac SessionFolderTests] 기록_목록에_폴더_기록과_예전_기록이_함께_나온다', () => {
  const d = tempDir();
  make(path.join(d, '2026-10-18_09-00-00 1주차'), '2026-10-18_09-00-00 1주차');
  file(path.join(d, '2026-10-17_09-00-00.txt'));
  fs.mkdirSync(path.join(d, '다른 폴더'));
  assert.deepEqual(N.sessions(d).map((x) => path.basename(x.path)), ['2026-10-18_09-00-00 1주차.txt', '2026-10-17_09-00-00.txt']);
});

test('[mac SessionFolderTests] 이름을_바꾸면_폴더와_안의_파일이_함께_바뀐다', () => {
  const d = tempDir();
  const txt = make(path.join(d, '2026-10-18_09-00-00'), '2026-10-18_09-00-00');
  const neu = N.rename(txt, '2주차 수업');
  assert.equal(neu, path.join(d, '2026-10-18_09-00-00 2주차 수업', '2026-10-18_09-00-00 2주차 수업.txt'));
  for (const f of ['.txt', '.m4a', '.times.json']) assert.ok(fs.existsSync(path.join(path.dirname(neu), `2026-10-18_09-00-00 2주차 수업${f}`)), f);
  assert.ok(!fs.existsSync(path.join(d, '2026-10-18_09-00-00')));
});

test('[mac SessionFolderTests] 지울_때는_폴더째_보낸다', () => {
  const d = tempDir();
  const txt = make(path.join(d, '2026-10-18_09-00-00'), '2026-10-18_09-00-00');
  assert.deepEqual(N.trashTargets(txt), [path.dirname(txt)]);
  const flat = file(path.join(d, '2026-10-17_09-00-00.txt'));
  assert.deepEqual(N.trashTargets(flat), [flat]);
});

test('[mac SessionFolderTests] 오래된_폴더_기록은_폴더째_정리한다', () => {
  const d = tempDir();
  const txt = make(path.join(d, '2020-01-01_09-00-00'), '2020-01-01_09-00-00');
  N.prune(d, { autoDelete: true });
  assert.ok(!fs.existsSync(path.dirname(txt)));
});

test('[mac SessionFolderTests] 글_없이_소리만_남은_폴더는_지운다', () => {
  const d = tempDir();
  const folder = path.join(d, '2026-10-18_09-00-00');
  make(folder, '2026-10-18_09-00-00', ['.m4a']);
  N.prune(d, { autoDelete: false });
  assert.ok(!fs.existsSync(folder));
});

test('[mac SessionFolderTests] 내보내면_폴더째_복사한다', () => {
  const d = tempDir();
  const dest = tempDir();
  const txt = make(path.join(d, '2026-10-18_09-00-00'), '2026-10-18_09-00-00');
  assert.deepEqual(N.exportTo(txt, dest), [path.join(dest, '2026-10-18_09-00-00')]);
  assert.ok(fs.existsSync(path.join(dest, '2026-10-18_09-00-00', '2026-10-18_09-00-00.m4a')));
  assert.deepEqual(N.exportTo(txt, dest), [path.join(dest, '2026-10-18_09-00-00 2')]);
});

// ── Windows 덧붙임: 위 규칙의 경계 ──

test('Writer: 첫 줄을 쓸 때 기록 폴더를 만들고, 시각 파일도 같은 폴더에', () => {
  const d = tempDir();
  const w = new N.Writer(d, AT);
  assert.equal(w.planned, path.join(d, NAME, `${NAME}.txt`));
  assert.ok(!fs.existsSync(path.join(d, NAME)), '첫 줄을 쓰기 전에는 폴더도 없다');
  w.append('Hello.');
  assert.equal(w.path, w.planned);
  N.saveTimes([[0, 1]], w.path);
  assert.deepEqual(names(path.join(d, NAME)), [`${NAME}.times.json`, `${NAME}.txt`]);
  assert.deepEqual(names(d), [NAME]);
  assert.equal(N.isFoldered(w.path), true);
  assert.equal(N.isFoldered(path.join(d, `${NAME}.txt`)), false);
});

test('겹치는 이름: 같은 이름의 폴더, 예전 형식 글·소리 모두 피한다', () => {
  const d = tempDir();
  fs.mkdirSync(path.join(d, NAME));
  assert.equal(N.newPath(d, AT), path.join(d, `${NAME}_2`, `${NAME}_2.txt`));
  file(path.join(d, `${NAME}_2.txt`)); // 예전 형식 글
  assert.equal(N.newPath(d, AT), path.join(d, `${NAME}_3`, `${NAME}_3.txt`));
  file(path.join(d, `${NAME}_3.m4a`)); // 예전 형식 소리
  assert.equal(N.newPath(d, AT), path.join(d, `${NAME}_4`, `${NAME}_4.txt`));
});

test('목록: 시작 시각이 아닌 폴더, 폴더 이름과 글 이름이 다른 폴더, 다른 글은 빠진다', () => {
  const d = tempDir();
  const old = file(path.join(d, '2026-10-01_10-00-00 옛 강의.txt'), { body: '옛 줄\n' });
  file(path.join(d, '2026-10-01_10-00-00 옛 강의.m4a'));
  const neu = file(path.join(d, '2026-10-18_09-00-00 1주차', '2026-10-18_09-00-00 1주차.txt'), { body: '새 줄\n' });
  file(path.join(d, '2026-10-18_09-00-00 1주차', '2026-10-18_09-00-00 1주차.m4a'));
  file(path.join(d, '사진', '2026-10-18_09-00-00.txt')); // 시작 시각 이름이 아닌 폴더
  file(path.join(d, '2026-10-17_08-00-00 이름 다름', '2026-10-17_08-00-00.txt')); // 폴더 이름 ≠ 글 이름
  file(path.join(d, 'memo.txt'));
  const list = N.sessions(d);
  assert.deepEqual(list.map((s) => s.path), [neu, old]);
  assert.deepEqual(list.map((s) => [s.title, s.audio, s.preview]), [['1주차', true, '새 줄'], ['옛 강의', true, '옛 줄']]);
});

test('이름 바꾸기: 같은 이름의 기록 폴더가 있으면 막고, 이름을 지우면 시작 시각만', () => {
  const d = tempDir();
  const txt = file(path.join(d, NAME, `${NAME}.txt`));
  file(path.join(d, NAME, `${NAME}.m4a`));
  file(path.join(d, NAME, `${NAME}.times.json`));
  const dest = N.rename(txt, '1주차');
  const nn = `${NAME} 1주차`;
  assert.equal(dest, path.join(d, nn, `${nn}.txt`));
  assert.deepEqual(names(d), [nn]);
  assert.deepEqual(names(path.join(d, nn)), [`${nn}.m4a`, `${nn}.times.json`, `${nn}.txt`]);
  // 같은 이름(폴더든 예전 파일이든)이 있으면 막는다
  fs.mkdirSync(path.join(d, `${NAME} 2주차`));
  assert.throws(() => N.rename(dest, '2주차'), /같은 이름/);
  // 이름을 지우면 시작 시각만
  assert.equal(N.rename(dest, ''), path.join(d, NAME, `${NAME}.txt`));
});

test('지우기: 폴더 기록은 폴더 하나만 휴지통 함수로, 예전 기록은 글과 딸린 파일', async () => {
  const d = tempDir();
  const folderTxt = file(path.join(d, NAME, `${NAME}.txt`));
  file(path.join(d, NAME, `${NAME}.m4a`));
  const trashed = [];
  assert.equal(await N.remove(folderTxt, async (p) => trashed.push(p)), null);
  assert.deepEqual(trashed, [path.join(d, NAME)]);
  assert.deepEqual(N.trashTargets(folderTxt), [path.join(d, NAME)]);

  const old = file(path.join(d, '2026-10-01_10-00-00.txt'));
  file(path.join(d, '2026-10-01_10-00-00.m4a'));
  assert.deepEqual(N.trashTargets(old).sort(), [path.join(d, '2026-10-01_10-00-00.m4a'), old].sort());
});

test('30일 정리: 예전 형식도 지우고, 최근 기록·다른 폴더는 남기고, 사용자가 고른 폴더는 건드리지 않는다', () => {
  const d = tempDir();
  file(path.join(d, '2026-01-01_10-00-00', '2026-01-01_10-00-00.txt'), { daysOld: 40 });
  file(path.join(d, '2026-01-01_10-00-00', '2026-01-01_10-00-00.m4a'), { daysOld: 40 });
  file(path.join(d, '2026-01-02_10-00-00.txt'), { daysOld: 40 }); // 예전 형식도 지운다
  const keep = file(path.join(d, NAME, `${NAME}.txt`));
  file(path.join(d, '사진', 'a.txt'), { daysOld: 40 });
  N.prune(d, { autoDelete: true, now: Date.now() });
  // 시각은 이름이 아니라 시작 시각으로 본다 — 2026-01 기록은 30일이 지났다
  assert.deepEqual(names(d), [NAME, '사진'].sort());
  assert.ok(fs.existsSync(keep));
  // 사용자가 고른 폴더에서는 지우지 않는다
  const u = tempDir();
  file(path.join(u, '2026-01-01_10-00-00', '2026-01-01_10-00-00.txt'));
  N.prune(u, { autoDelete: false, now: Date.now() });
  assert.deepEqual(names(u), ['2026-01-01_10-00-00']);
});

test('소리만 남은 폴더: 빈 기록 폴더도 지우고, 사용자 파일이 있는 폴더는 남긴다', () => {
  const d = tempDir();
  file(path.join(d, NAME, `${NAME}.m4a`));
  fs.mkdirSync(path.join(d, '2026-10-18_09-30-00')); // 빈 기록 폴더 (빈 녹음)
  file(path.join(d, '2026-10-18_10-00-00', '2026-10-18_10-00-00.m4a'));
  file(path.join(d, '2026-10-18_10-00-00', '메모.docx')); // 사용자가 넣은 파일이 있으면 건드리지 않는다
  file(path.join(d, '2026-10-18_11-00-00.m4a')); // 예전 형식 소리만
  N.prune(d, { autoDelete: false });
  assert.deepEqual(names(d), ['2026-10-18_10-00-00']);
});

test('내보내기: 이름 붙은 기록 폴더도 폴더째, 세 번째는 " 3", 원본은 남는다', () => {
  const d = tempDir();
  const out = tempDir();
  const nn = `${NAME} 1주차`;
  const txt = file(path.join(d, nn, `${nn}.txt`), { body: '줄\n' });
  file(path.join(d, nn, `${nn}.m4a`), { body: 'm4a' });
  assert.deepEqual(N.exportTo(txt, out), [path.join(out, nn)]);
  assert.deepEqual(names(path.join(out, nn)), [`${nn}.m4a`, `${nn}.txt`]);
  assert.equal(fs.readFileSync(path.join(out, nn, `${nn}.txt`), 'utf8'), '줄\n');
  assert.deepEqual(N.exportTo(txt, out), [path.join(out, `${nn} 2`)]);
  assert.deepEqual(N.exportTo(txt, out), [path.join(out, `${nn} 3`)]);
  assert.ok(fs.existsSync(txt), '원본은 남는다');
});

// ── Windows: 되살릴 소리·경로 확인·재생 주소 ──

test('되살릴 소리(.pcm): 기록 폴더 안도 찾는다. 글이 없는 pcm 은 지운다', () => {
  const d = tempDir();
  file(path.join(d, NAME, `${NAME}.txt`));
  const pcm = file(path.join(d, NAME, `${NAME}.pcm`));
  file(path.join(d, '2026-10-18_10-00-00', '2026-10-18_10-00-00.pcm'));
  const old = file(path.join(d, '2026-10-01_10-00-00.pcm'));
  file(path.join(d, '2026-10-01_10-00-00.txt'));
  assert.deepEqual(N.pendingAudio(d), [old, pcm].sort());
  assert.ok(!fs.existsSync(path.join(d, '2026-10-18_10-00-00', '2026-10-18_10-00-00.pcm')));
});

test('기록 경로 확인: 저장 폴더 바로 아래 글과 기록 폴더 안의 "폴더이름.txt" 만 받는다', () => {
  const d = tempDir();
  const old = file(path.join(d, '2026-10-01_10-00-00.txt'));
  const neu = file(path.join(d, NAME, `${NAME}.txt`));
  const other = file(path.join(d, NAME, '2026-10-18_09-00-01.txt'));
  const deep = file(path.join(d, NAME, NAME, `${NAME}.txt`));
  assert.equal(N.ownNote(d, old), old);
  assert.equal(N.ownNote(d, neu), neu);
  assert.equal(N.ownNote(d, other), null);
  assert.equal(N.ownNote(d, deep), null);
  assert.equal(N.ownNote(d, path.join(d, NAME, '..', '..', 'x', `${NAME}.txt`)), null);
});

test('재생 주소: 기록의 m4a 를 저장 폴더 기준 상대 경로로, 되읽을 때 그 기록의 m4a 만 (.. 로 빠져나가지 못한다)', () => {
  const root = tempDir();
  const d = path.join(root, 'autosave');
  const old = file(path.join(d, '2026-10-01_10-00-00.m4a'));
  const neu = file(path.join(d, NAME, `${NAME}.m4a`));
  file(path.join(root, 'secret.m4a'));
  file(path.join(root, NAME, `${NAME}.m4a`));
  assert.equal(N.audioRel(d, path.join(d, '2026-10-01_10-00-00.txt')), '2026-10-01_10-00-00.m4a');
  assert.equal(N.audioRel(d, path.join(d, NAME, `${NAME}.txt`)), `${NAME}/${NAME}.m4a`);
  assert.equal(N.audioFile(d, '2026-10-01_10-00-00.m4a'), old);
  assert.equal(N.audioFile(d, `${NAME}/${NAME}.m4a`), neu);
  assert.equal(N.audioFile(d, `${NAME}\\${NAME}.m4a`), neu);
  for (const bad of ['../secret.m4a', '..\\secret.m4a', `../${NAME}/${NAME}.m4a`, `${NAME}/../../secret.m4a`,
    `${NAME}/${NAME}.txt`, 'C:\\Windows\\win.ini', '/etc/passwd', `${NAME}/other.m4a`, '', 'nope.m4a', `${NAME}/${NAME}/${NAME}.m4a`]) {
    assert.equal(N.audioFile(d, bad), null, bad);
  }
});
