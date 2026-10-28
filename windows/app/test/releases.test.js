'use strict';
// 1.2.3 설정의 버전별 요약 (맥 1.2.3): GitHub 릴리스 4개, 본문의 첫 "##" 앞 "- " 줄만, "Windows" 로 시작하는 줄은 빼고
const test = require('node:test');
const assert = require('node:assert/strict');
const { releasesURL, summaries, SUMMARY_COUNT } = require('../lib/releases');

test('주소: 최근 릴리스 4개 (저장소 이름이 이상하면 null)', () => {
  assert.equal(SUMMARY_COUNT, 4);
  assert.equal(releasesURL('dakcoe/ezrite'), 'https://api.github.com/repos/dakcoe/ezrite/releases?per_page=4');
  assert.equal(releasesURL('../x'), null);
  assert.equal(releasesURL(null), null);
});

const body122 = [
  '- 녹음하는 동안 배터리를 훨씬 덜 씁니다',
  '- 설명해줘를 누르고 다른 데스크톱으로 넘어가도 설명 카드가 따라옵니다',
  '- Windows 도 1.2.2: 녹음 중 CPU 를 크게 줄이고',
  '',
  '## 받기',
  '- macOS 13 이상: `Ezrite-1.2.2.dmg`',
].join('\r\n');

test('요약: 첫 "##" 앞의 "- " 줄만, "Windows" 로 시작하는 줄은 빼고, 버전 앞 v 는 뗀다', () => {
  const list = summaries(JSON.stringify([
    { tag_name: 'v1.2.2', body: body122 },
    { tag_name: 'v1.2.1', body: '설명 문단\n- 기본(Groq) 화면 설명을 다시 가볍게\n  - 들여쓴 줄은 아니다\n## macOS\n- 맥만' },
    { tag_name: 'v1.2.0', body: '## macOS\n- 머리 줄이 없다' },
  ]));
  assert.deepEqual(list, [
    { version: '1.2.2', lines: ['녹음하는 동안 배터리를 훨씬 덜 씁니다', '설명해줘를 누르고 다른 데스크톱으로 넘어가도 설명 카드가 따라옵니다'] },
    { version: '1.2.1', lines: ['기본(Groq) 화면 설명을 다시 가볍게'] },
  ]);
});

test('요약: 초안·잘못된 응답은 건너뛰고, 4개까지만', () => {
  const r = (v, extra = {}) => ({ tag_name: v, body: `- ${v} 바뀐 점`, ...extra });
  const list = summaries(JSON.stringify([r('v9'), r('v8', { draft: true }), r('v7'), { body: '- 태그 없음' }, r('v6'), r('v5'), r('v4')]));
  assert.deepEqual(list.map((x) => x.version), ['9', '7', '6', '5']);
  assert.deepEqual(summaries('{'), []);
  assert.deepEqual(summaries('{"message":"Not Found"}'), []);
  assert.deepEqual(summaries(JSON.stringify([{ tag_name: 'v1', body: null }])), []);
});
