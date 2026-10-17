'use strict';

// 오픈소스 고지: 앱과 함께 나가는 것이 모두 들어 있는지, 저장소의 고지 파일이 최신인지
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const N = require('../scripts/make-notices');

const ROOT = path.join(__dirname, '..', '..');
const { txt, md } = N.compose();

test('고지에 앱과 함께 나가는 것이 모두 있다 (글꼴·아이콘·수식·관계도·실행 환경·helper 크레이트)', () => {
  for (const name of ['Pretendard', 'Lucide', 'KaTeX', 'Mermaid', 'Electron', 'LICENSES.chromium.html', 'dompurify', 'elkjs',
    'Microsoft Corporation', 'serde_json', 'SIL OPEN FONT LICENSE']) {
    assert.ok(txt.includes(name), name);
  }
  // 맥 오픈소스고지.txt 와 같은 모양: 항목마다 === 띠 사이에 제목
  assert.ok(/={20,}\nPretendard [\d.]+ .*\n={20,}\n/.test(txt));
});

test('Mermaid 안에 묶여 들어간 라이브러리는 이름·버전·라이선스와 전문이 있다', () => {
  const web = N.webBundled();
  assert.ok(web.length > 20);
  for (const p of web) {
    assert.ok(p.license, `${p.name} 라이선스`);
    assert.ok(p.text.trim().length > 50, `${p.name} 전문`);
    assert.ok(txt.toLowerCase().includes(`${p.name} ${p.version}`.toLowerCase()), p.name);
  }
});

test('설치 파일에 넣는 앱 쪽 npm 런타임 의존성은 없다 (있으면 고지에 넣어야 한다)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
});

test('저장소의 THIRD_PARTY_NOTICES.md · 설치 파일용 ThirdPartyNotices.txt 가 최신이다 (node scripts/make-notices.js)', () => {
  assert.equal(fs.readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8'), md);
  assert.equal(fs.readFileSync(path.join(__dirname, '..', 'build', 'ThirdPartyNotices.txt'), 'utf8'), txt);
});
