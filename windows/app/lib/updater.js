'use strict';

// 새 버전 알림 (맥 Updater.swift 이식). 켤 때와 6시간마다 GitHub 의 최신 릴리스를 물어보고, 앱보다 높으면
// 팝업과 전체 창 맨 위에 띠를 띄운다. 설치는 사용자가 [받기]로 설치 파일(.exe)을 받아 직접 한다.
// 보내는 것은 릴리스 조회 요청 하나뿐이고 개인 정보는 보내지 않는다.
// 저장소가 비공개이면 GitHub 이 404 를 돌려준다 — 그때는 조용히 아무것도 띄우지 않는다.

const INTERVAL_MS = 6 * 3600 * 1000;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

const strip = (s) => String(s).replace(/^[vV\s]+|\s+$/g, '');

/** "v2.0.10" 처럼 앞의 v 를 떼고 점으로 나눈 숫자끼리 비교한다 */
function isNewer(a, b) {
  const parts = (s) => strip(s).split('.').map((x) => parseInt(x, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? 0;
    const q = y[i] ?? 0;
    if (p !== q) return p > q;
  }
  return false;
}

/** [받기] 로 여는 주소는 https 의 GitHub 것만 믿는다 (응답이 바뀌어도 다른 곳을 열지 않게) */
function trusted(s) {
  let u;
  try {
    u = new URL(String(s));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  return host === 'github.com' || host.endsWith('.githubusercontent.com') ? u.href : null;
}

/** GitHub releases/latest 응답 → { version, notes, download }. 설치 파일(.exe)이 없으면 릴리스 페이지 */
function release(text) {
  let obj;
  try {
    obj = JSON.parse(String(text));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || typeof obj.tag_name !== 'string') return null;
  const page = typeof obj.html_url === 'string' ? trusted(obj.html_url) : null;
  if (!page) return null;
  const assets = Array.isArray(obj.assets) ? obj.assets : [];
  const exe = assets.find((a) => typeof a?.name === 'string' && a.name.toLowerCase().endsWith('.exe'))?.browser_download_url;
  return {
    version: strip(obj.tag_name),
    notes: (typeof obj.body === 'string' ? obj.body : '').replace(/\r\n/g, '\n').trim(),
    download: (typeof exe === 'string' && trusted(exe)) || page,
  };
}

function latestURL(repo) {
  return typeof repo === 'string' && REPO.test(repo) && !repo.includes('..')
    ? `https://api.github.com/repos/${repo}/releases/latest` : null;
}

/** 문제 신고 양식 (버전·Windows 버전을 미리 채운다. 맥은 macOS·칩) */
function issueURL(repo, version, windows) {
  if (!latestURL(repo)) return null;
  const u = new URL(`https://github.com/${repo}/issues/new`);
  u.searchParams.set('template', 'bug.yml');
  u.searchParams.set('version', version);
  u.searchParams.set('windows', windows);
  return u.href;
}

class Updater {
  /**
   * repo: "owner/name" (package.json ezriteUpdateRepo), current: 앱 버전,
   * fakeJSON: EZRITE_UPDATE_JSON (그 릴리스 JSON 으로 띠 모양을 확인한다), onChange(status): 화면에 알릴 때
   */
  constructor({ repo = null, current, fetch = globalThis.fetch, fakeJSON = null, onChange = () => {} }) {
    Object.assign(this, { repo, current, fetch, fakeJSON, onChange });
    this.available = null;
    this.checking = false;
    this.checkedAt = null;
    this.snoozed = null; // [나중에] 로 닫은 버전. 이번 확인 동안만 숨긴다
    this.snoozeChecks = 0;
    this.timer = null;
  }

  status() {
    return { available: this.available, checking: this.checking, checkedAt: this.checkedAt, current: this.current };
  }

  changed() {
    this.onChange(this.status());
  }

  start() {
    this.check();
    this.timer = setInterval(() => this.check(), INTERVAL_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  async check() {
    this.newCheck();
    if (this.fakeJSON != null) {
      this.available = release(this.fakeJSON);
      this.changed();
      return;
    }
    const url = latestURL(this.repo);
    if (!url) return;
    this.checking = true;
    this.changed();
    let r = null;
    try {
      const res = await this.fetch(url, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Ezrite' },
        signal: AbortSignal.timeout(20_000),
      });
      // 404(비공개 저장소·릴리스 없음)·한도 초과 등은 알리지 않는다
      if (res.status === 200) r = release(await res.text());
    } catch {
      // 네트워크 오류도 조용히
    }
    this.checking = false;
    if (r) {
      this.checkedAt = Date.now();
      this.available = this.shouldShow(r.version, this.current) ? r : null;
    }
    this.changed();
  }

  /** [나중에]: 지금만 닫는다 */
  skip() {
    if (!this.available) return;
    this.snooze(this.available.version);
    this.available = null;
    this.changed();
  }

  snooze(version) {
    this.snoozed = version;
    this.snoozeChecks = 0;
  }

  /** 설정의 [업데이트 확인]: 직접 눌렀으니 [나중에] 로 닫은 것도 다시 보여준다 */
  checkNow() {
    this.snoozed = null;
    return this.check();
  }

  /** 새로 확인할 때마다 부른다. 닫은 뒤 한 번 더 확인하면 다시 알린다 */
  newCheck() {
    if (this.snoozed != null) this.snoozeChecks += 1;
    if (this.snoozeChecks >= 1) {
      this.snoozed = null;
      this.snoozeChecks = 0;
    }
  }

  shouldShow(version, current) {
    return isNewer(version, current) && this.snoozed !== version;
  }
}

module.exports = { Updater, isNewer, release, trusted, latestURL, issueURL, INTERVAL_MS };
