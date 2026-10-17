'use strict';

// "녹음 기록 저장됨" 띠 (맥 1.1.3 SavedBanner · Transcriber start/stop 의 savedSession)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const S = require('../lib/saved');

const DIR = path.join('C:\\', 'Users', 'u', 'AppData', 'Roaming', 'Ezrite', 'notes', 'autosave');
const FOLDERED = path.join(DIR, '2026-10-18_09-00-00 1주차', '2026-10-18_09-00-00 1주차.txt');
const FLAT = path.join(DIR, '2026-10-17_09-00-00.txt');

test('녹음을 끝내면(받아 적은 글이 있으면) 띠를 보이고, 새 녹음을 시작하면 지운다 (맥 savedSession)', () => {
  let saved = S.next(null, { event: 'start' });
  assert.equal(saved, null);
  saved = S.next(saved, { event: 'stop', written: FOLDERED });
  assert.equal(saved.path, FOLDERED);
  saved = S.next(saved, { event: 'start' });
  assert.equal(saved, null);
});

test('받아 적은 글이 없으면(기록이 남지 않으면) 띠를 보이지 않는다', () => {
  assert.equal(S.next(null, { event: 'stop', written: null }), null);
  const shown = S.next(null, { event: 'stop', written: FOLDERED });
  assert.equal(S.next(shown, { event: 'stop', written: null }), null);
});

test('✕ 를 누르면 지운다', () => {
  const shown = S.next(null, { event: 'stop', written: FOLDERED });
  assert.equal(S.next(shown, { event: 'dismiss' }), null);
});

test('둘째 줄: "저장 폴더 이름 › 기록 폴더 이름", 예전 기록이면 파일 이름. 누르면 그것을 탐색기에서 고른다', () => {
  const a = S.banner(FOLDERED);
  assert.equal(a.place, 'autosave › 2026-10-18_09-00-00 1주차');
  assert.equal(a.target, path.dirname(FOLDERED));
  assert.equal(a.help, `탐색기에서 보기 — ${path.dirname(FOLDERED)}`);
  const b = S.banner(FLAT);
  assert.equal(b.place, 'autosave › 2026-10-17_09-00-00.txt');
  assert.equal(b.target, FLAT);
  assert.equal(b.help, `탐색기에서 보기 — ${DIR}`);
});
