'use strict';

// Electron 보안 기본값이 조용히 풀리지 않게 지킨다 (Electron 을 올리거나 창을 새로 만들 때)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');
const SOURCES = ['main.js', 'explain-ui.js'];

/** `key: {` 다음의 짝 맞는 중괄호 덩어리들 */
function blocks(src, opener) {
  const out = [];
  let i = src.indexOf(opener);
  while (i !== -1) {
    let depth = 0;
    let j = src.indexOf('{', i);
    const start = j;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) break;
    }
    out.push(src.slice(start, j + 1));
    i = src.indexOf(opener, j);
  }
  return out;
}

const SAFE = [/contextIsolation:\s*true/, /nodeIntegration:\s*false/, /sandbox:\s*true/];

test('창마다 webPreferences 가 있고, 공용 설정이든 직접 쓴 설정이든 격리·샌드박스·Node 끔이다', () => {
  const main = read('main.js');
  const shared = /const webPreferences = (\{[\s\S]*?\n\});/.exec(main);
  assert.ok(shared, '공용 webPreferences');
  for (const re of SAFE) assert.match(shared[1], re);
  let windows = 0;
  for (const f of SOURCES) {
    for (const b of blocks(read(f), 'new BrowserWindow(')) {
      windows++;
      assert.match(b, /webPreferences/, `${f}: webPreferences 없는 창`);
      const inline = blocks(b, 'webPreferences: {');
      for (const w of inline) for (const re of SAFE) assert.match(w, re, `${f}: ${w}`);
    }
  }
  assert.ok(windows >= 6, `창 ${windows}개`);
});

test('앱 코드 어디에도 보안을 끄는 설정이 없다', () => {
  for (const f of SOURCES) {
    const src = read(f);
    for (const bad of [/nodeIntegration:\s*true/, /contextIsolation:\s*false/, /sandbox:\s*false/, /webSecurity:\s*false/, /allowRunningInsecureContent:\s*true/]) {
      assert.doesNotMatch(src, bad, `${f}: ${bad}`);
    }
  }
});

test('모든 웹 내용에서 다른 주소로 넘어가기와 새 창 열기를 막는다', () => {
  const main = read('main.js');
  const hook = /app\.on\('web-contents-created',[\s\S]*?\n\}\);/.exec(main);
  assert.ok(hook, 'web-contents-created');
  assert.match(hook[0], /will-navigate['"],\s*\(e\)\s*=>\s*e\.preventDefault\(\)/);
  assert.match(hook[0], /setWindowOpenHandler\(\(\)\s*=>\s*\(\{\s*action:\s*'deny'\s*\}\)\)/);
});

test('renderer 의 모든 HTML 에 CSP 가 있고 eval·인라인 스크립트를 허용하지 않는다', () => {
  const htmls = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.html')) htmls.push(p);
    }
  };
  walk(path.join(APP, 'renderer'));
  assert.ok(htmls.length >= 7, `HTML ${htmls.length}개`);
  for (const f of htmls) {
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(fs.readFileSync(f, 'utf8'));
    assert.ok(csp, `${path.basename(f)}: CSP 없음`);
    assert.match(csp[1], /default-src '(self|none)'/, path.basename(f));
    assert.doesNotMatch(csp[1], /unsafe-eval/, path.basename(f));
    const script = /script-src([^;]*)/.exec(csp[1]);
    if (script) assert.doesNotMatch(script[1], /unsafe-inline|\*/, path.basename(f));
  }
});

test('Electron 은 정확한 버전으로 고정하고, 지원이 끝난 33 이하로 돌아가지 않는다', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const name of ['electron', 'electron-builder']) {
    assert.match(pkg.devDependencies[name], /^\d+\.\d+\.\d+$/, `${name} 는 ^·~ 없이 고정`);
  }
  assert.ok(Number(pkg.devDependencies.electron.split('.')[0]) >= 44, pkg.devDependencies.electron);
});
