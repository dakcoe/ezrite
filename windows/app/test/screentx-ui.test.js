'use strict';
// 화면 번역(실험 기능)을 실제 앱으로 (scripts/check-screentx.js): 화면 밖 시험 창을 골라 덮개가 뜨고, 스크롤하면 새 문단만 옮기고, 멈추면 사라진다.
// helper(grab·screen-watch·ocr)가 있어야 한다 (verify 가 cargo build 를 먼저 한다)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { helperCandidates } = require('../lib/ui');

const electron = (() => { try { return require('electron'); } catch { return null; } })();
const helper = helperCandidates({ packaged: false, appDir: path.join(__dirname, '..') }).some((p) => fs.existsSync(p));

test('화면 번역: 창 고르기 → 덮개 → 스크롤하면 새 문단만 → 멈춤, 기록에 화면 글 없음', { skip: !electron || !helper, timeout: 120_000 }, () => {
  const r = spawnSync(electron, [path.join(__dirname, '..', 'scripts', 'check-screentx.js')], { encoding: 'utf8', timeout: 110_000 });
  const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('{'));
  assert.ok(line, `결과 없음: ${r.stderr}`);
  const out = JSON.parse(line);
  assert.equal(out.error, undefined, out.error);
  for (const [k, v] of Object.entries(out.checks)) assert.equal(v, true, `${k}: ${JSON.stringify(out.log)}`);
  assert.equal(out.ok, true);
});
