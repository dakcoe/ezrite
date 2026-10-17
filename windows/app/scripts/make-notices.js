'use strict';

// 오픈소스 고지 만들기. 맥판 Resources/오픈소스고지.txt 와 같은 모양으로
//   app/build/ThirdPartyNotices.txt (설치 파일 resources 에 들어간다) 와 저장소 THIRD_PARTY_NOTICES.md 를 쓴다.
//
//   node scripts/make-notices.js                          고지 두 파일 다시 쓰기
//   node scripts/make-notices.js --collect <node_modules>  Mermaid·KaTeX 가 묶어 넣은 라이브러리 목록과 전문을
//                                                         build/notices/web-bundled.json 에 다시 모으기
//       (임시 폴더에서 npm install --omit=dev mermaid@10.9.1 katex@0.16.11 한 node_modules)
//   helper Rust 크레이트: helper 폴더에서 cargo about generate about.hbs -o ../app/build/notices/rust-licenses.txt

const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..');
const ROOT = path.join(APP, '..');
const NOTICES = path.join(APP, 'build', 'notices');
const BAR = '='.repeat(62);

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').trimEnd();
const section = (title, text) => `${BAR}\n${title}\n${BAR}\n${text.trimEnd()}\n`;

const MIT = (copyright) => `(MIT License — 패키지에 라이선스 파일이 없어 package.json 의 "license": "MIT" 와 작성자로 적었습니다)

${copyright}

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions
of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.`;

// 브라우저 묶음에 들어가지 않는 것: 타입 정의, KaTeX 명령줄 도구
const NOT_BUNDLED = (name) => name.startsWith('@types/') || name === 'commander';

/** node_modules 를 돌며 패키지 이름·버전·라이선스·전문을 모은다 */
function collect(dir) {
  const out = new Map();
  const visit = (nm) => {
    if (!fs.existsSync(nm)) return;
    for (const e of fs.readdirSync(nm)) {
      if (e.startsWith('.')) continue;
      const dirs = e.startsWith('@') ? fs.readdirSync(path.join(nm, e)).map((x) => path.join(nm, e, x)) : [path.join(nm, e)];
      for (const d of dirs) {
        const pj = path.join(d, 'package.json');
        if (!fs.existsSync(pj)) continue;
        const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'));
        if (!NOT_BUNDLED(pkg.name)) {
          const file = fs.readdirSync(d).find((f) => /^(licen[cs]e|copying)(\.|-|$)/i.test(f));
          let license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? '';
          // package.json 에 license 칸이 없는 패키지(khroma)는 라이선스 파일 첫머리로 정한다
          if (!license && file && /MIT License/.test(fs.readFileSync(path.join(d, file), 'utf8').slice(0, 200))) license = 'MIT';
          // 라이선스 파일 없이 package.json 에 MIT 라고만 적은 패키지(micromark 등)는 표준 MIT 문구에 작성자를 넣는다
          const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name ?? '';
          const text = file ? read(path.join(d, file))
            : license === 'MIT' ? MIT(`Copyright (c) ${author.replace(/\s*[<(].*$/, '')}`) : '';
          out.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, license, text });
        }
        visit(path.join(d, 'node_modules'));
      }
    }
  };
  visit(dir);
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function webBundled() {
  return JSON.parse(fs.readFileSync(path.join(NOTICES, 'web-bundled.json'), 'utf8'));
}

function compose() {
  const web = webBundled();
  const pick = (name) => web.find((p) => p.name === name);
  const katex = pick('katex');
  const mermaid = pick('mermaid');
  const electron = JSON.parse(fs.readFileSync(path.join(APP, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  const others = web.filter((p) => p.name !== 'katex' && p.name !== 'mermaid');

  const parts = [
    'Ezrite Windows판에 함께 들어 있는 오픈소스와 그 라이선스\n',
    '앱 쪽 npm 런타임 의존성(package.json dependencies)은 없습니다. 아래가 설치 파일에 들어가는 남의 저작물 전부입니다.\n',
    section('Pretendard 1.3.9 (앱 글꼴) — https://github.com/orioncactus/pretendard', read(path.join(APP, 'assets', 'fonts', 'LICENSE-Pretendard.txt'))),
    section('Lucide 0.460.0 (아이콘 모양, 앱 화면과 사용 가이드) — https://lucide.dev', read(path.join(NOTICES, 'lucide-LICENSE.txt'))),
    section(`KaTeX ${katex.version} (설명 카드의 수식 그리기, 글꼴 포함) — https://katex.org`, katex.text),
    section(`Mermaid ${mermaid.version} (설명 카드의 관계도 그리기) — https://mermaid.js.org`, mermaid.text),
    section(`Electron ${electron} (앱 실행 환경) — https://www.electronjs.org`,
      `${read(path.join(APP, 'node_modules', 'electron', 'LICENSE'))}\n\n`
      + 'Electron 에 들어 있는 Chromium 과 그 안의 오픈소스(Node.js, V8, FFmpeg 등)의 라이선스 전문은\n'
      + '설치 폴더의 LICENSES.chromium.html 에 있습니다 (Electron 라이선스는 LICENSE.electron.txt).'),
    section('Mermaid 가 관계도 그리기 파일(mermaid.min.js) 안에 함께 묶어 넣은 라이브러리',
      '버전은 mermaid 10.9.1 의 의존성 범위로 npm 이 고른 것입니다 (묶음을 만들 때의 버전과 조금 다를 수 있고, 라이선스는 같습니다).\n'
      + others.map((p) => `- ${p.name} ${p.version} (${p.license})`).join('\n')),
    ...others.map((p) => section(`${p.name} ${p.version} — ${p.license}`, p.text)),
    section('helper (ezrite-audio.exe) 에 들어간 Rust 크레이트 — cargo about 으로 만든 목록',
      'windows-rs (Microsoft) 와 serde 크레이트는 MIT 또는 Apache-2.0 이고, 여기서는 MIT 로 씁니다.'),
    read(path.join(NOTICES, 'rust-licenses.txt')).replace(/^\n+/, ''),
  ];
  const txt = `${parts.join('\n').trimEnd()}\n`;
  const md = '# 오픈소스 고지\n\n'
    + 'Ezrite Windows판과 함께 나가는 남의 저작물의 라이선스입니다. 설치 파일에는 같은 내용이 `resources\\ThirdPartyNotices.txt` 로 들어가고,\n'
    + '설정 → 버전 아래 "오픈소스 고지" 로 열립니다. 이 파일은 `node app/scripts/make-notices.js` 가 만듭니다 (손으로 고치지 않는다).\n\n'
    + `\`\`\`text\n${txt}\`\`\`\n`;
  return { txt, md };
}

function main(argv) {
  const i = argv.indexOf('--collect');
  if (i >= 0) {
    const list = collect(path.resolve(argv[i + 1]));
    fs.mkdirSync(NOTICES, { recursive: true });
    fs.writeFileSync(path.join(NOTICES, 'web-bundled.json'), `${JSON.stringify(list, null, 1)}\n`);
    console.log(`web-bundled.json: ${list.length}개`);
    const missing = list.filter((p) => !p.text);
    if (missing.length) console.log(`전문 없음: ${missing.map((p) => p.name).join(', ')}`);
  }
  const { txt, md } = compose();
  fs.writeFileSync(path.join(APP, 'build', 'ThirdPartyNotices.txt'), txt);
  fs.writeFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), md);
  console.log(`ThirdPartyNotices.txt ${txt.split('\n').length}줄 · THIRD_PARTY_NOTICES.md`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { collect, compose, webBundled };
