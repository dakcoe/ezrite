'use strict';

// 앱 기록 (1.3.2, 맥 AppLog). 버그를 다시 못 만들어도 나중에 무슨 일이 있었는지 찾을 수 있게 남긴다.
//   파일: %LOCALAPPDATA%\Ezrite\logs\ezrite-YYYY-MM-DD.log (맥 ~/Library/Logs/Ezrite/ezrite-YYYY-MM-DD.log)
//   줄:   YYYY-MM-DD HH:mm:ss.SSS LEVEL [영역] 내용 (main|bg)   — LEVEL 은 INFO / WARN / ERR, 시각은 이 컴퓨터 시각
//   날이 바뀌면 새 파일, 14일 지난 파일은 열 때 지운다.
// 받아 적은 글·질문 글·AI 답 글·API 키는 남기지 않는다. 부르는 쪽은 길이(자 수)·개수·시간만 넘기고,
// 오류 글은 err() 로 따옴표 안 조각(JSON.parse 가 답 글 일부를 싣는다)을 가리고 키 모양을 지운다.
// 한 모듈을 앱 전체가 require 한다. open() 하기 전에는 아무것도 쓰지 않는다 (단위 시험이 조용하다).
// 테스트 실행 중(node --test 아래)과 EZRITE_NO_LOG=1 이면 open() 해도 쓰지 않는다.
// 쓰기는 한 줄씩 바로 (appendFileSync): 멈추거나 죽기 직전 줄도 남는다. 종료 때 flush 할 버퍼가 없다.

const fs = require('node:fs');
const path = require('node:path');
const { redact } = require('./crashlog');

const KEEP_DAYS = 14;
const NAME = /^ezrite-(\d{4})-(\d{2})-(\d{2})\.log$/;
const HANG = /^hang-(\d{4})(\d{2})(\d{2})-\d{6}\.txt$/;

// day·line·hangName 은 바깥 이름을 쓰지 않는다: 멈춤 감시 worker 에 글로 넘겨 같은 꼴로 쓰게 한다 (lib/hangwatch.js)

/** 이 컴퓨터 날짜 YYYY-MM-DD (파일 이름) */
function day(d) {
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 한 줄: YYYY-MM-DD HH:mm:ss.SSS LEVEL [영역] 내용 (main|bg). 줄바꿈은 " | " 로 (한 기록 = 한 줄) */
function line(level, area, body, thread, now) {
  const p = (v, n = 2) => String(v).padStart(n, '0');
  const d = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const t = `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}.${p(now.getMilliseconds(), 3)}`;
  return `${d} ${t} ${level} [${area}] ${String(body).replace(/\s*\r?\n\s*/g, ' | ')} (${thread})`;
}

/** 남길 한 줄. 키 모양은 가린다 */
function format(level, area, text, thread = 'main', now = new Date()) {
  return line(level, area, redact(String(text)), thread, now);
}

/** 오류를 남길 글로: 따옴표 안 조각은 "…" 로 (AI 답·받아 적은 글이 실릴 수 있다), 200자까지 */
function err(e) {
  const raw = e instanceof Error ? `${e.name === 'Error' ? '' : `${e.name}: `}${e.message}` : String(e ?? '');
  const masked = raw.replace(/"[^"\n]{1,}"/g, '"…"').replace(/'[^'\n]{12,}'/g, "'…'");
  return masked.length > 200 ? `${masked.slice(0, 200)}…` : masked;
}

/** 초 (소수 한 자리) */
const secs = (ms) => `${(ms / 1000).toFixed(1)}초`;

/** 이 프로세스에서 기록을 켤까: EZRITE_NO_LOG=1 이나 node --test 아래(시험)면 끈다 */
function enabledBy(env) {
  if (['1', 'true'].includes(String(env.EZRITE_NO_LOG ?? '').trim().toLowerCase())) return false;
  return !env.NODE_TEST_CONTEXT;
}

class AppLog {
  constructor() {
    this.dir = null;
    this.thread = 'main';
    this.now = () => new Date();
    this.sink = null; // 시험용: 파일 대신 줄을 받는다
  }

  /**
   * 기록을 연다. dir: 로그 폴더, env: 켤지 볼 환경 변수. 14일 지난 파일을 지운다.
   * 켰으면 true. 폴더를 못 만들어도 앱은 돈다 (false)
   */
  open({ dir, env = process.env, thread = 'main', now } = {}) {
    if (!enabledBy(env)) return false;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      return false;
    }
    this.dir = dir;
    this.thread = thread;
    if (now) this.now = now;
    this.prune();
    return true;
  }

  get on() {
    return Boolean(this.dir || this.sink);
  }

  /** 오늘 파일 경로 */
  file(d = this.now()) {
    return this.dir ? path.join(this.dir, `ezrite-${day(d)}.log`) : null;
  }

  write(level, area, text) {
    if (!this.on) return;
    const now = this.now();
    const line = format(level, area, text, this.thread, now);
    if (this.sink) {
      this.sink(line);
      return;
    }
    try {
      fs.appendFileSync(this.file(now), `${line}\n`);
    } catch {
      // 기록을 못 써도 앱은 계속 간다
    }
  }

  info(area, text) { this.write('INFO', area, text); }

  warn(area, text) { this.write('WARN', area, text); }

  error(area, text) { this.write('ERR', area, text); }

  /** 14일 지난 기록 파일과 멈춤 스택 파일을 지운다. 지운 이름들 */
  prune(now = this.now()) {
    if (!this.dir) return [];
    const cut = new Date(now.getFullYear(), now.getMonth(), now.getDate() - KEEP_DAYS);
    const gone = [];
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return gone;
    }
    for (const n of names) {
      const m = NAME.exec(n) ?? HANG.exec(n);
      if (!m) continue;
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (d >= cut) continue;
      try {
        fs.rmSync(path.join(this.dir, n), { force: true });
        gone.push(n);
      } catch {
        // 다음에 다시
      }
    }
    return gone;
  }

  /** 시험용: 파일 대신 fn(줄) 로 받는다. null 이면 되돌린다 */
  capture(fn, now) {
    this.sink = fn;
    if (now) this.now = now;
    else this.now = () => new Date();
  }

  close() {
    this.dir = null;
    this.sink = null;
  }
}

/** 멈춤 스택 파일 이름 hang-YYYYMMDD-HHmmss.txt (맥 hang-시각.txt) */
function hangName(d = new Date()) {
  const p = (v) => String(v).padStart(2, '0');
  return `hang-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.txt`;
}

const log = new AppLog();
module.exports = log;
module.exports.AppLog = AppLog;
module.exports.format = format;
module.exports.line = line;
module.exports.day = day;
module.exports.err = err;
module.exports.secs = secs;
module.exports.enabledBy = enabledBy;
module.exports.hangName = hangName;
module.exports.KEEP_DAYS = KEEP_DAYS;
