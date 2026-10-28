'use strict';

// 설정의 버전별 요약 (1.2.3, 맥과 같다). 설정을 열 때 GitHub 의 최근 릴리스 4개를 받아, 본문에서 첫 "##" 앞의
// "- " 줄(릴리스 머리의 요약)만 버전 카드 아래 버전별로 보인다. "Windows" 로 시작하는 줄은 뺀다
// (맥·Windows 함께 쓰는 요약이라 Windows 배포 안내 줄이 섞여 있다). 보내는 것은 조회 요청 하나뿐이다.

const SUMMARY_COUNT = 4;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

function releasesURL(repo) {
  return typeof repo === 'string' && REPO.test(repo) && !repo.includes('..')
    ? `https://api.github.com/repos/${repo}/releases?per_page=${SUMMARY_COUNT}` : null;
}

/** 본문 → 요약 줄들 */
function headLines(body) {
  const out = [];
  for (const line of String(body).replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('##')) break;
    if (!line.startsWith('- ')) continue;
    const text = line.slice(2).trim();
    if (text && !text.startsWith('Windows')) out.push(text);
  }
  return out;
}

/** GitHub releases 응답 글 → [{ version, lines }] (요약 줄이 없는 릴리스·초안은 뺀다) */
function summaries(text) {
  let list;
  try {
    list = JSON.parse(String(text));
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((r) => r && typeof r.tag_name === 'string' && !r.draft && typeof r.body === 'string')
    .map((r) => ({ version: r.tag_name.replace(/^[vV\s]+|\s+$/g, ''), lines: headLines(r.body) }))
    .filter((r) => r.lines.length)
    .slice(0, SUMMARY_COUNT);
}

module.exports = { releasesURL, summaries, SUMMARY_COUNT };
