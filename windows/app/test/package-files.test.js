'use strict';
// 설치본에 들어가는 파일(package.json build.files)이 앱이 실제로 여는 파일을 다 담는지.
// 1.3.2 는 새 최상위 파일(translate-ui.js·preload-translate.js·preload-picker.js)이 목록에 빠져, 설치본이 시작하자마자
// "Cannot find module" 로 죽었다. 개발 실행·다른 시험은 소스 폴더에서 돌아 모든 파일이 있으니 못 잡았다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..');
const pkg = require('../package.json');

/** electron-builder files 패턴 하나 → 정규식 (이 앱이 쓰는 꼴: 이름, *, dir/**\/*) */
function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (glob.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 2;
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const packaged = (rel) => {
  let ok = false;
  for (const g of pkg.build.files) {
    if (g.startsWith('!')) {
      if (globRe(g.slice(1)).test(rel)) ok = false;
    } else if (globRe(g).test(rel)) ok = true;
  }
  return ok;
};

/** main.js 에서 시작해 상대 require 와 __dirname 기준 파일 경로를 따라간 앱 파일들 (앱 폴더 기준 '/' 경로) */
function reachable() {
  const seen = new Set();
  const todo = ['main.js'];
  while (todo.length) {
    const rel = todo.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!rel.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(APP, rel), 'utf8');
    const dir = path.posix.dirname(rel);
    const add = (p) => {
      const full = path.posix.normalize(path.posix.join(dir, p));
      if (full.startsWith('..')) return;
      const cands = [full, `${full}.js`, `${full}.json`, `${full}/index.js`];
      const hit = cands.find((c) => fs.existsSync(path.join(APP, c)) && fs.statSync(path.join(APP, c)).isFile());
      assert.ok(hit, `${rel} 가 여는 ${p} 가 없다`);
      todo.push(hit);
    };
    for (const m of src.matchAll(/require\('(\.{1,2}\/[^']+)'\)/g)) add(m[1]);
    // path.join(__dirname, 'a', 'b.html') 처럼 글자만으로 된 경로
    for (const m of src.matchAll(/path\.join\(__dirname((?:\s*,\s*'[^']+')+)\s*\)/g)) {
      const parts = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
      const p = parts.join('/');
      if (/\.(js|html|css|json|png|ico|svg)$/.test(p)) add(p.startsWith('.') ? p : `./${p}`);
    }
  }
  return [...seen];
}

test('글 패턴 변환: 이름·*·dir/**/*', () => {
  assert.ok(globRe('main.js').test('main.js'));
  assert.ok(!globRe('main.js').test('lib/main.js'));
  assert.ok(globRe('*.js').test('translate-ui.js'));
  assert.ok(!globRe('*.js').test('scripts/guard.js'));
  assert.ok(globRe('lib/**/*').test('lib/a/b.js'));
  assert.ok(globRe('lib/**/*').test('lib/b.js'));
});

test('앱이 여는 파일은 모두 설치본에 들어간다 (1.3.2 시작 실패 재현)', () => {
  const files = reachable();
  // 따라가기가 실제로 넓게 닿는지 (시험이 헛돌지 않게)
  for (const must of ['main.js', 'explain-ui.js', 'translate-ui.js', 'preload.js', 'preload-card.js', 'preload-translate.js', 'preload-picker.js', 'lib/applog.js']) {
    assert.ok(files.includes(must), `${must} 까지 못 닿음`);
  }
  const missing = files.filter((f) => !packaged(f));
  assert.deepEqual(missing, [], `설치본에 빠진 파일: ${missing.join(', ')}`);
});

test('시험·확인 스크립트는 설치본에 넣지 않는다', () => {
  assert.ok(!packaged('scripts/guard.js'));
  assert.ok(!packaged('test/package-files.test.js'));
});
