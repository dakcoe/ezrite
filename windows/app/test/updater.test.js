'use strict';

// 새 버전 알림 (맥 UpdateTests 이식. 맥의 DMG 자리는 Windows 설치 파일 .exe)
const test = require('node:test');
const assert = require('node:assert/strict');
const { Updater, isNewer, release, trusted, issueURL, latestURL } = require('../lib/updater');

test('[mac UpdateTests] 버전_번호를_숫자로_비교한다', () => {
  assert.ok(isNewer('v2.1.0', '2.0.0'));
  assert.ok(isNewer('2.0.10', '2.0.9'));
  assert.ok(isNewer('v3', '2.9.9'));
  assert.ok(!isNewer('v2.0.0', '2.0.0'));
  assert.ok(!isNewer('1.9.0', '2.0.0'));
});

test('[mac UpdateTests] GitHub_최신_릴리스에서_번호·바뀐_점·설치_파일_주소를_읽는다', () => {
  const json = JSON.stringify({
    tag_name: 'v2.1.0', name: 'Ezrite 2.1.0', html_url: 'https://github.com/o/r/releases/tag/v2.1.0',
    body: '- 설명 영상\r\n- 버그 수정', draft: false, prerelease: false,
    assets: [
      { name: 'notes.txt', browser_download_url: 'https://github.com/o/r/releases/download/v2.1.0/notes.txt' },
      { name: 'Ezrite-2.1.0.dmg', browser_download_url: 'https://github.com/o/r/releases/download/v2.1.0/Ezrite-2.1.0.dmg' },
      { name: 'Ezrite-Setup-2.1.0.exe', browser_download_url: 'https://github.com/o/r/releases/download/v2.1.0/Ezrite-Setup-2.1.0.exe' },
      { name: 'Ezrite-Setup-2.1.0.exe.blockmap', browser_download_url: 'https://github.com/o/r/releases/download/v2.1.0/x.blockmap' },
    ],
  });
  const r = release(json);
  assert.equal(r.version, '2.1.0');
  assert.equal(r.notes, '- 설명 영상\n- 버그 수정');
  assert.equal(r.download, 'https://github.com/o/r/releases/download/v2.1.0/Ezrite-Setup-2.1.0.exe');
});

test('[mac UpdateTests] 설치_파일이_없으면_릴리스_페이지로', () => {
  const r = release('{"tag_name":"v2.2","html_url":"https://github.com/o/r/releases/tag/v2.2","body":"","assets":[]}');
  assert.equal(r.download, 'https://github.com/o/r/releases/tag/v2.2');
});

test('[mac UpdateTests] GitHub_밖의_주소는_열지_않는다', () => {
  const other = '{"tag_name":"v2.3","html_url":"https://github.com/o/r/releases/tag/v2.3","body":"","assets":[{"name":"a.exe","browser_download_url":"https://evil.example/a.exe"}]}';
  assert.equal(release(other).download, 'https://github.com/o/r/releases/tag/v2.3');
  for (const page of ['http://github.com/o/r', 'file:///C:/Windows/System32/calc.exe', 'https://github.com.evil.example/x']) {
    assert.equal(release(JSON.stringify({ tag_name: 'v2.3', html_url: page, body: '', assets: [] })), null, page);
  }
  assert.equal(trusted('https://objects.githubusercontent.com/a'), 'https://objects.githubusercontent.com/a');
  assert.equal(trusted('javascript:alert(1)'), null);
});

test('[mac UpdateTests] 나중에는_이번에만_닫고_다음_확인_때_다시_알린다', () => {
  const u = new Updater({ current: '0.9.0' });
  assert.ok(u.shouldShow('0.9.1', '0.9.0'));
  u.snooze('0.9.1');
  assert.ok(!u.shouldShow('0.9.1', '0.9.0'));
  u.newCheck();
  assert.ok(u.shouldShow('0.9.1', '0.9.0'));
  assert.ok(!u.shouldShow('0.9.0', '0.9.0'));
});

test('깨진 응답·태그 없는 응답은 알리지 않는다', () => {
  assert.equal(release('not json'), null);
  assert.equal(release('{"html_url":"https://github.com/o/r"}'), null);
  assert.equal(release('[]'), null);
});

const reply = (status, body) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const latest = { tag_name: 'v0.2.0', html_url: 'https://github.com/o/r/releases/tag/v0.2.0', body: '새 기능', assets: [] };

test('확인: 저장소의 releases/latest 를 묻고, 더 높은 버전이면 알린다', async () => {
  const urls = [];
  const changes = [];
  const u = new Updater({
    repo: 'o/r', current: '0.1.0',
    fetch: async (url, init) => { urls.push([url, init.headers.Accept]); return reply(200, latest)(); },
    onChange: (s) => changes.push(s),
  });
  await u.check();
  assert.deepEqual(urls, [['https://api.github.com/repos/o/r/releases/latest', 'application/vnd.github+json']]);
  assert.equal(u.available.version, '0.2.0');
  assert.equal(u.status().checking, false);
  assert.ok(u.status().checkedAt);
  assert.equal(changes.at(-1).available.version, '0.2.0');
});

test('확인: 비공개 저장소(404)·네트워크 오류·같은 버전이면 조용히 아무것도 띄우지 않는다', async () => {
  for (const fetch of [reply(404, { message: 'Not Found' }), async () => { throw new Error('offline'); }, reply(200, { ...latest, tag_name: 'v0.1.0' })]) {
    const u = new Updater({ repo: 'o/r', current: '0.1.0', fetch });
    await u.check();
    assert.equal(u.available, null);
    assert.equal(u.status().checking, false);
  }
});

test('확인: 저장소가 없으면 묻지 않는다. 저장소 이름 모양이 틀려도 묻지 않는다', async () => {
  for (const repo of [null, '', 'no-slash', 'a/b/c', '../x/y']) {
    const u = new Updater({ repo, current: '0.1.0', fetch: async () => assert.fail('묻지 않아야 한다') });
    await u.check();
  }
  assert.equal(latestURL('dakcoe/ezrite-windows'), 'https://api.github.com/repos/dakcoe/ezrite-windows/releases/latest');
  assert.equal(latestURL('a/b/c'), null);
});

test('개발용 EZRITE_UPDATE_JSON: 그 릴리스 JSON 으로 띠를 띄운다 (네트워크 없음)', async () => {
  const u = new Updater({ repo: 'o/r', current: '0.1.0', fakeJSON: JSON.stringify(latest), fetch: async () => assert.fail('묻지 않아야 한다') });
  await u.check();
  assert.equal(u.available.version, '0.2.0');
});

test('[나중에] 와 [업데이트 확인]: 직접 확인하면 닫았던 것도 다시 보인다', async () => {
  const u = new Updater({ repo: 'o/r', current: '0.1.0', fetch: reply(200, latest) });
  await u.check();
  u.skip();
  assert.equal(u.available, null);
  await u.checkNow();
  assert.equal(u.available.version, '0.2.0');
});

test('문의·신고: GitHub 이슈 양식에 버전과 Windows 버전을 미리 채운다', () => {
  const url = new URL(issueURL('o/r', '0.1.0', 'Windows 10.0.26200'));
  assert.equal(url.origin + url.pathname, 'https://github.com/o/r/issues/new');
  assert.equal(url.searchParams.get('template'), 'bug.yml');
  assert.equal(url.searchParams.get('version'), '0.1.0');
  assert.equal(url.searchParams.get('windows'), 'Windows 10.0.26200');
  assert.equal(issueURL(null, '0.1.0', 'x'), null);
});

test('맥·윈도우 한 릴리스 (dakcoe/ezrite v1.1.0): DMG 와 EXE 가 함께 있으면 EXE 만 받는다', () => {
  const both = {
    tag_name: 'v1.1.0', html_url: 'https://github.com/dakcoe/ezrite/releases/tag/v1.1.0', body: '바뀐 점',
    assets: [
      { name: 'Ezrite-1.1.0.dmg', browser_download_url: 'https://github.com/dakcoe/ezrite/releases/download/v1.1.0/Ezrite-1.1.0.dmg' },
      { name: 'Ezrite-Setup-1.1.0.exe.blockmap', browser_download_url: 'https://github.com/dakcoe/ezrite/releases/download/v1.1.0/Ezrite-Setup-1.1.0.exe.blockmap' },
      { name: 'Ezrite-Setup-1.1.0.exe', browser_download_url: 'https://github.com/dakcoe/ezrite/releases/download/v1.1.0/Ezrite-Setup-1.1.0.exe' },
    ],
  };
  const r = release(JSON.stringify(both));
  assert.equal(r.version, '1.1.0');
  assert.equal(r.download, 'https://github.com/dakcoe/ezrite/releases/download/v1.1.0/Ezrite-Setup-1.1.0.exe');
});

test('맥·윈도우 한 릴리스: DMG 만 있으면 (윈도우판이 아직 안 올라왔으면) 릴리스 페이지로', () => {
  const dmgOnly = {
    tag_name: 'v1.1.0', html_url: 'https://github.com/dakcoe/ezrite/releases/tag/v1.1.0', body: '',
    assets: [{ name: 'Ezrite-1.1.0.dmg', browser_download_url: 'https://github.com/dakcoe/ezrite/releases/download/v1.1.0/Ezrite-1.1.0.dmg' }],
  };
  assert.equal(release(JSON.stringify(dmgOnly)).download, 'https://github.com/dakcoe/ezrite/releases/tag/v1.1.0');
});

test('업데이트 저장소는 공개 리포 dakcoe/ezrite, 버전은 1.1.0', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.ezriteUpdateRepo, 'dakcoe/ezrite');
  assert.equal(pkg.version, '1.1.0');
  assert.equal(latestURL(pkg.ezriteUpdateRepo), 'https://api.github.com/repos/dakcoe/ezrite/releases/latest');
});
