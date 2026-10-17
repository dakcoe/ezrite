'use strict';

// 받아 적은 기록 저장. 맥 Notes.swift 이식 — 폴더·이름·형식이 맥과 같아서 파일을 서로 옮겨도 읽힌다.
//   기록 하나 = 폴더 하나 (맥 1.1.3): <저장 폴더>/<기록이름>/<기록이름>.txt, 딸린 파일도 그 폴더에.
//   예전처럼 저장 폴더에 바로 놓인 기록(<저장 폴더>/<기록이름>.txt)도 옮기지 않고 그대로 읽고 다룬다.
//   기록이름:   <시작시각 yyyy-MM-dd_HH-mm-ss>[_n][ 이름]
//   내용:       원문 한 줄 / 번역은 네 칸 들여쓰기 / "── " 로 시작하면 끊김 표시. 머리말·줄별 시각은 없다
//   딸린 파일:  같은 이름 + .m4a(녹음) · .times.json(줄마다 녹음 위치) · .pcm(녹음 중 원본, Windows판만)
//   기본 위치:  %APPDATA%\Ezrite\notes\autosave (맥 ~/Library/Application Support/Ezrite/notes/autosave).
//               여기서만 30일 지난 기록을 지운다. 사용자가 고른 폴더에서는 지우지 않는다
//
// 맥과 다른 점:
// - 녹음 중에는 맥처럼 m4a 조각(.part-001.m4a)이 아니라 원본 소리를 .pcm 에 이어 쓰고, 끝낼 때 helper 가 m4a 로
//   바꾼다. 앱이 죽으면 다음 실행 때 남은 .pcm 을 바꾼다 (pendingAudio).
// - 이름 바꾸기에서 맥이 막는 / : 줄바꿈 말고도 Windows 파일 이름에 못 쓰는 \ * ? " < > | 를 띄어쓰기로 바꾼다.
// - 메모장에서 고쳐 CRLF 가 된 기록도 읽는다 (맥 Swift 는 "\r\n" 을 한 글자로 봐서 못 나눈다).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const KEEP_DAYS = 30;
// 탐색기가 폴더에 저절로 만드는 파일 (맥 .DS_Store 자리)
const SYSTEM_FILES = new Set(['desktop.ini', 'thumbs.db']);
const STAMP = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/;

function defaultDir(env = process.env) {
  const base = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'Ezrite', 'notes', 'autosave');
}

const pad = (n) => String(n).padStart(2, '0');

/** "yyyy-MM-dd_HH-mm-ss" (내 컴퓨터 시각) */
function stamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/** 이름 앞 19자가 시작 시각이면 그 Date, 아니면 null (이 앱 파일이 아니다) */
function startedAt(file) {
  const m = STAMP.exec(path.basename(String(file)));
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const date = new Date(y, mo - 1, d, h, mi, s);
  // 2026-13-40 같은 값은 Date 가 넘겨 버리므로 되돌려 보아 같은지 확인한다 (맥 DateFormatter 는 nil)
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d
    || date.getHours() !== h || date.getMinutes() !== mi || date.getSeconds() !== s) return null;
  return date;
}

const exists = (p) => fs.existsSync(p);
const stem = (file) => path.basename(file).replace(/\.[^.]*$/, ''); // 마지막 확장자만 뗀다
const swapExt = (txt, ext) => path.join(path.dirname(txt), stem(txt) + ext);

/** 기록 하나가 자기 이름의 폴더에 들어 있나 (저장 폴더/기록이름/기록이름.txt). 예전 기록은 저장 폴더에 바로 있다 (맥 isFoldered) */
const isFoldered = (txt) => path.basename(path.dirname(txt)) === stem(txt);

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 이 앱이 만든 기록 폴더 (이름이 시작 시각으로 시작하는 폴더) (맥 subfolders) */
function subfolders(dir) {
  return readDir(dir).filter((n) => startedAt(n)).map((n) => path.join(dir, n)).filter(isDir);
}

/**
 * 새 기록 경로: 저장 폴더/기록이름/기록이름.txt. 폴더는 처음 쓸 때 만든다.
 * 같은 이름의 폴더나 예전처럼 바로 놓인 같은 이름의 글·소리가 있으면 _2, _3 … (맥 newURL)
 */
function newPath(dir, date = new Date()) {
  const base = stamp(date);
  const taken = (name) => [path.join(dir, name), path.join(dir, `${name}.txt`), path.join(dir, `${name}.m4a`)].some(exists);
  let name = base;
  let n = 2;
  while (taken(name)) {
    name = `${base}_${n}`;
    n += 1;
  }
  return path.join(dir, name, `${name}.txt`);
}

/** 파일 이름 = "시작시각[_n][ 이름].txt" — 이름이 따로 저장되지 않아 파일만 옮겨도 함께 간다 */
function title(file) {
  let rest = stem(file).slice(19);
  if (rest.startsWith('_')) rest = rest.replace(/^[_\d]+/, '');
  return rest.trim();
}

/** 기록에 딸린 파일: 이름이 "기록이름." 으로 시작하는 파일 [{ path, suffix }] (suffix 는 ".m4a" 처럼 점부터) */
function companions(txt) {
  const base = `${stem(txt)}.`;
  const dir = path.dirname(txt);
  let list;
  try {
    list = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return list.filter((n) => n.startsWith(base) && n !== path.basename(txt))
    .map((n) => ({ path: path.join(dir, n), suffix: n.slice(base.length - 1) }));
}

/** 이름을 바꾸고(빈 글이면 이름 없앰) 새 경로를 돌려준다. 딸린 파일도 같이 옮긴다. 폴더 기록이면 폴더 이름도 같이 바꾼다 */
function rename(txt, newTitle) {
  const name = stem(txt);
  let base = name.slice(0, 19);
  const tail = name.slice(19);
  if (tail.startsWith('_')) base += /^[_\d]*/.exec(tail)[0];
  // 맥: / : 줄바꿈에서 나눈 조각을 띄어쓰기로 잇는다. Windows 에서 못 쓰는 글자도 같은 식으로
  const clean = String(newTitle).split(/[/:\n\r\\*?"<>|\t]/).join(' ').trim();
  const newName = clean ? `${base} ${clean}` : base;
  if (isFoldered(txt)) {
    const folder = path.dirname(txt);
    const newFolder = path.join(path.dirname(folder), newName);
    if (newFolder === folder) return txt;
    // 맥은 moveItem 이 실패한다. Windows 의 renameSync 는 빈 폴더면 덮어쓸 수 있어서 먼저 막는다
    if (exists(newFolder)) throw new Error('같은 이름의 기록이 이미 있습니다');
    fs.renameSync(folder, newFolder);
    return renameInPlace(path.join(newFolder, path.basename(txt)), newName);
  }
  return renameInPlace(txt, newName);
}

/** 같은 폴더 안에서 글과 딸린 파일의 이름만 바꾼다 (맥 rename(inPlace:)) */
function renameInPlace(txt, newName) {
  const dest = path.join(path.dirname(txt), `${newName}.txt`);
  if (dest === txt) return txt;
  if (exists(dest)) throw new Error('같은 이름의 기록이 이미 있습니다');
  const others = companions(txt);
  fs.renameSync(txt, dest);
  for (const c of others) {
    try {
      fs.renameSync(c.path, path.join(path.dirname(dest), newName + c.suffix));
    } catch {
      // 딸린 파일 하나를 못 옮겨도 기록 이름은 바뀐 채로 둔다 (맥과 같다)
    }
  }
  return dest;
}

/** 휴지통으로 보낼 것: 폴더 기록이면 폴더째, 예전 기록이면 글과 딸린 파일 (맥 trashTargets) */
function trashTargets(txt) {
  return isFoldered(txt) ? [path.dirname(txt)] : [...companions(txt).map((c) => c.path), txt];
}

/** 휴지통으로 (trash: shell.trashItem). 폴더 기록은 폴더째. 실패하면 이유 글, 다 되면 null */
async function remove(txt, trash) {
  const files = trashTargets(txt);
  for (const f of files) {
    try {
      await trash(f);
    } catch (e) {
      return `${path.basename(f)}: ${e?.message ?? e}`;
    }
  }
  return null;
}

/** 글과 딸린 파일을 다른 폴더로 복사한다. 같은 이름이 있으면 덮어쓰지 않고 " 2", " 3" 을 붙인다. 폴더 기록은 폴더째 */
function exportTo(txt, folder) {
  if (isFoldered(txt)) {
    const src = path.dirname(txt);
    const base = path.basename(src);
    let dest = path.join(folder, base);
    let n = 2;
    while (exists(dest)) {
      dest = path.join(folder, `${base} ${n}`);
      n += 1;
    }
    fs.cpSync(src, dest, { recursive: true, errorOnExist: true, force: false });
    return [dest];
  }
  const sources = [{ path: txt, suffix: '.txt' }, ...companions(txt)];
  const base = stem(txt);
  let name = base;
  let n = 2;
  while (sources.some((s) => exists(path.join(folder, name + s.suffix)))) {
    name = `${base} ${n}`;
    n += 1;
  }
  return sources.map((s) => {
    const dest = path.join(folder, name + s.suffix);
    fs.copyFileSync(s.path, dest, fs.constants.COPYFILE_EXCL);
    return dest;
  });
}

/** 파일 형식 그대로의 글: 원문 / 네 칸 들여쓴 번역 / 끊김 표시 */
function render(entries) {
  return entries.map((e) => (e.translation != null ? `${e.original}\n    ${e.translation}` : e.original)).join('\n');
}

/** 기록 글 → 줄 [{kind, original, translation, time}] */
function parse(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line) continue;
    const last = out[out.length - 1];
    if (line.startsWith('    ') && last && last.kind === 'text') {
      const t = line.trim();
      last.translation = last.translation != null ? `${last.translation} ${t}` : t;
    } else if (line.startsWith('── ')) {
      out.push({ kind: 'gap', original: line, translation: null, time: null });
    } else {
      out.push({ kind: 'text', original: line.trim(), translation: null, time: null });
    }
  }
  return out;
}

// --- 줄마다 녹음 위치 (.times.json) ---

const timesPath = (txt) => swapExt(txt, '.times.json');

function saveTimes(times, txt) {
  writeAtomic(timesPath(txt), JSON.stringify(times));
}

function loadTimes(txt) {
  try {
    const v = JSON.parse(fs.readFileSync(timesPath(txt), 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** 기록을 읽고, 글 줄 순서대로 녹음 위치를 붙인다 (끊김 줄은 빼고) */
function load(txt) {
  let text;
  try {
    text = fs.readFileSync(txt, 'utf8');
  } catch {
    return [];
  }
  const entries = parse(text);
  const times = loadTimes(txt);
  let i = 0;
  for (const e of entries) {
    if (e.kind !== 'text') continue;
    const t = times[i++];
    if (t === undefined) break;
    if (Array.isArray(t) && t.length === 2 && typeof t[0] === 'number' && typeof t[1] === 'number' && t[0] <= t[1]) e.time = t;
  }
  return entries;
}

function readDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** 목록에 보일 첫 줄. 목록이 길어도 빠르게 — 파일 앞 400바이트만 읽는다 */
function preview(txt) {
  let head = '';
  try {
    const fd = fs.openSync(txt, 'r');
    try {
      const buf = Buffer.alloc(400);
      head = buf.subarray(0, fs.readSync(fd, buf, 0, 400, 0)).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
  const line = head.split('\n').map((l) => l.replace(/\r$/, '')).find((l) => l && !l.startsWith('──'));
  return (line ?? '').replace(/�+$/, ''); // 400바이트에서 잘린 한글 조각은 뗀다
}

/**
 * 이 앱이 만든 기록만 — 이름이 시작 시각으로 시작하는 .txt. 저장 폴더에 바로 놓인 예전 기록과
 * 기록 폴더 안의 "폴더이름.txt" 를 함께. 최신이 먼저 (맥 sessions)
 */
function sessions(dir) {
  const flat = readDir(dir).filter((n) => n.toLowerCase().endsWith('.txt') && startedAt(n)).map((n) => path.join(dir, n));
  const foldered = subfolders(dir).map((sub) => path.join(sub, `${path.basename(sub)}.txt`)).filter(exists);
  return [...flat, ...foldered]
    .map((p) => ({ path: p, date: startedAt(p).getTime(), title: title(p), audio: exists(swapExt(p, '.m4a')), preview: preview(p) }))
    .sort((a, b) => b.date - a.date);
}

/**
 * 받아 적은 글 없이 소리만 남은 파일을 지운다. autoDelete 면(기본 위치) 30일 지난 기록도 지운다.
 * 어느 쪽이든 이 앱 이름 형식이 아닌 파일은 건드리지 않는다 (맥 Notes.prune)
 */
function prune(dir, { autoDelete, now = Date.now() } = {}) {
  // 글 없이 소리만 남은 기록 폴더는 폴더째 지운다. 사용자가 넣은 다른 파일이 있으면 두고 (맥: .m4a·.DS_Store 만 있으면)
  for (const sub of subfolders(dir)) {
    if (exists(path.join(sub, `${path.basename(sub)}.txt`))) continue;
    if (readDir(sub).every((n) => n.toLowerCase().endsWith('.m4a') || SYSTEM_FILES.has(n.toLowerCase()))) fs.rmSync(sub, { recursive: true, force: true });
  }
  for (const n of readDir(dir)) {
    if (!n.toLowerCase().endsWith('.m4a') || !startedAt(n)) continue;
    const audio = path.join(dir, n);
    if (!exists(swapExt(audio, '.txt'))) fs.rmSync(audio, { force: true });
  }
  if (!autoDelete) return;
  const cutoff = now - KEEP_DAYS * 86400_000;
  for (const s of sessions(dir)) {
    if (s.date >= cutoff) continue;
    for (const t of trashTargets(s.path)) fs.rmSync(t, { recursive: true, force: true });
  }
}

/**
 * 앱이 죽어 m4a 로 바꾸지 못한 녹음(.pcm) 목록 — 다음 실행 때 helper 로 바꾼다.
 * 받아 적은 글이 하나도 없는 녹음은 맥처럼 소리도 남기지 않는다 (여기서 지운다)
 */
function pendingAudio(dir) {
  const out = [];
  // 기록 폴더 안과 저장 폴더 바로 아래 (맥 recoverParts 가 하위 폴더까지 찾는 것과 같다)
  for (const folder of [...subfolders(dir), dir]) {
    for (const n of readDir(folder)) {
      if (!n.toLowerCase().endsWith('.pcm') || !startedAt(n)) continue;
      const pcm = path.join(folder, n);
      if (exists(swapExt(pcm, '.txt'))) out.push(pcm);
      else fs.rmSync(pcm, { force: true });
    }
  }
  return out.sort();
}

/**
 * 화면에서 넘어온 경로가 이 폴더의 이 앱 기록(.txt)인지 확인한다. 맞으면 정리된 경로, 아니면 null.
 * 이름 바꾸기·지우기·재생에 쓰므로 다른 곳의 파일을 건드리지 못하게 한다
 */
function ownNote(dir, p) {
  if (typeof p !== 'string' || !p) return null;
  const full = path.resolve(p);
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); // Windows 는 대소문자 구분 없음
  const parent = path.dirname(full);
  // 저장 폴더에 바로 놓인 예전 기록, 또는 저장 폴더/기록이름/기록이름.txt
  const placed = same(parent, dir) || (same(path.dirname(parent), dir) && isFoldered(full) && startedAt(path.basename(parent)));
  if (!placed) return null;
  if (!full.toLowerCase().endsWith('.txt') || !startedAt(full) || !exists(full)) return null;
  return full;
}

/** 녹음 듣기 주소에 넣을 소리 위치: 저장 폴더 기준 상대 경로 ("기록.m4a" 또는 "기록/기록.m4a") */
function audioRel(dir, txt) {
  return path.relative(dir, swapExt(txt, '.m4a')).split(path.sep).join('/');
}

/**
 * 녹음 듣기 주소의 상대 경로 → 소리 파일. 이 앱 기록의 .m4a(예전 기록 옆, 또는 기록 폴더 안의 "폴더이름.m4a")만,
 * .. 나 다른 드라이브로 저장 폴더 밖을 가리키면 null (renderer 가 아무 파일이나 읽지 못하게)
 */
function audioFile(dir, rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || /^[a-z]:/i.test(rel)) return null;
  const parts = rel.split(/[\\/]/);
  if (parts.some((x) => !x || x === '.' || x === '..') || parts.length > 2) return null;
  const full = path.join(dir, ...parts);
  if (!/\.m4a$/i.test(full)) return null;
  const txt = swapExt(full, '.txt');
  if (parts.length === 2 && !(isFoldered(txt) && startedAt(parts[0]))) return null;
  if (!startedAt(path.basename(full)) || !exists(full)) return null;
  return full;
}

/** 임시 파일에 쓰고 바꿔 끼운다 (쓰는 도중 꺼져도 반쯤 쓴 파일이 남지 않게) */
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** 받아 적은 줄을 그때그때 파일에 흘려 둔다. 앱이 죽어도 남도록 줄마다 디스크까지 내린다 (맥 Notes.Writer) */
class Writer {
  constructor(dir, date = new Date()) {
    this.dir = dir;
    this.planned = newPath(dir, date); // 녹음 원본(.pcm/.m4a)도 이 이름을 쓴다
    this.path = null; // 첫 줄을 쓰면 생긴다 — 받아 적은 글이 없으면 기록도 없다
  }

  append(line) {
    try {
      if (!this.path) {
        // 기록 폴더는 첫 줄을 쓸 때 만든다 (맥 Writer.create)
        fs.mkdirSync(path.dirname(this.planned), { recursive: true });
        this.path = this.planned;
      }
      const fd = fs.openSync(this.path, 'a');
      try {
        fs.writeSync(fd, `${line}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // 자동 저장이 실패해도 받아쓰기는 계속돼야 한다
      if (this.path && !exists(this.path)) this.path = null;
    }
  }

  /** 번역이 붙으면 원문 바로 아래에 넣어야 해서 파일 전체를 다시 쓴다 */
  rewrite(entries) {
    if (!this.path) return;
    try {
      writeAtomic(this.path, `${render(entries)}\n`);
    } catch {
      // 다음 번 다시 쓰기에서 맞춰진다
    }
  }
}

module.exports = {
  KEEP_DAYS, defaultDir, stamp, startedAt, newPath, title, companions, isFoldered, subfolders, rename, trashTargets, remove, exportTo,
  render, parse, timesPath, saveTimes, loadTimes, load, sessions, preview, prune, pendingAudio, ownNote, audioRel, audioFile, Writer,
};
