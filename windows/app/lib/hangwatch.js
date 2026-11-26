'use strict';

// 멈춤 감시 (1.3.2, 맥 HangWatch). 앱이 응답 없이 굳었다가 꺼지는 일(맥: 일시정지 뒤 종료)을 다시 못 만들어도 찾을 수 있게.
// 3초 넘게 응답이 없으면 WARN "…이 N초째 응답 없음", 풀리면 WARN "풀림 — N초 동안 멈춰 있었음". 멈춤 한 번에 hang-시각.txt 한 장.
//
// 메인 프로세스 (MainWatch): 메인은 0.25초마다 SharedArrayBuffer 에 맥박을 찍고, worker 스레드가 그것을 본다.
//   멈추면 worker 가 inspector(connectToMainThread)로 메인을 잠깐 세워 멈춘 자리 스택(함수 파일:줄)을 뜬다.
//   JS 밖(네이티브 호출)에서 굳었으면 JS 로 돌아온 첫 자리가 찍힌다. 기록은 worker 가 직접 쓴다 (… (bg)).
// 화면 (PingWatch): 메인이 1초마다 창마다 ping 을 보내고 preload 가 바로 답한다. 화면 JS 가 굳으면 답이 밀린다.
//   Windows 에서는 화면 스택을 뜰 수 없다 (Chromium 은 페이지가 Document-Policy 헤더로 허락해야 주는데 file:// 페이지는 헤더가 없다).
//   그래서 hang 파일에는 어느 창인지·얼마나·그 프로세스의 CPU·메모리를 남긴다.

const { day, line, hangName } = require('./applog');

const LIMIT_MS = 3000;
const BEAT_MS = 250;

/**
 * 화면 ping 감시 (시계를 넣어 시험한다). tick(targets) 를 1초마다, pong(id, n) 은 답이 올 때.
 * targets: [{ id, name, send(n) }]. 메인 자신이 늦게 돌았으면(tick 이 늦음) 밀린 답은 화면 탓이 아니라 기다린 시간을 다시 센다
 */
class PingWatch {
  constructor({ limitMs = LIMIT_MS, now = () => Date.now(), onHang = () => {}, onRecover = () => {} } = {}) {
    Object.assign(this, { limitMs, now, onHang, onRecover });
    this.seq = 0;
    this.st = new Map();
    this.lastTick = null;
  }

  tick(targets) {
    const now = this.now();
    const late = this.lastTick != null && now - this.lastTick > 2500;
    this.lastTick = now;
    const ids = new Set();
    for (const t of targets) {
      ids.add(t.id);
      let s = this.st.get(t.id);
      if (!s) {
        s = { pending: null, since: 0, hung: false, name: t.name };
        this.st.set(t.id, s);
      }
      s.name = t.name;
      if (s.pending != null) {
        if (late && !s.hung) s.since = now; // 메인이 굳어 있던 동안은 세지 않는다
        const age = now - s.since;
        if (!s.hung && age > this.limitMs) {
          s.hung = true;
          this.onHang(t, age);
        }
        continue;
      }
      this.seq += 1;
      s.pending = this.seq;
      s.since = now;
      try {
        t.send(this.seq);
      } catch {
        s.pending = null; // 창이 닫히는 중
      }
    }
    for (const id of [...this.st.keys()]) if (!ids.has(id)) this.st.delete(id);
  }

  pong(id, n) {
    const s = this.st.get(id);
    if (!s || s.pending !== n) return;
    const ms = this.now() - s.since;
    const wasHung = s.hung;
    s.pending = null;
    s.hung = false;
    if (wasHung) this.onRecover({ id, name: s.name }, ms);
  }
}

/* eslint-disable no-inner-declarations */
/** worker 스레드 본문. 문자열로 넘겨 eval 로 띄운다 (asar 안 파일을 worker 로 여는 데 기대지 않는다). require 는 node: 모듈만 */
function workerMain() {
  const { workerData } = require('node:worker_threads');
  const fs = require('node:fs');
  const path = require('node:path');
  const inspector = require('node:inspector');
  const { sab, dir, limitMs, beatMs, info } = workerData;
  const beat = new BigInt64Array(sab);
  // applog 의 day·line·hangName 을 글로 받아 같은 꼴로 쓴다 (worker 에는 앱 모듈을 부르지 않는다)
  const fn = (src) => new Function(`return ${src}`)(); // eslint-disable-line no-new-func
  const DAY = fn(workerData.day);
  const LINE = fn(workerData.line);
  const HANG_NAME = fn(workerData.hangName);
  const write = (level, text) => {
    const now = new Date();
    try {
      fs.appendFileSync(path.join(dir, `ezrite-${DAY(now)}.log`), `${LINE(level, '앱', text, 'bg', now)}\n`);
    } catch { /* 못 써도 감시는 계속 */ }
  };
  let hung = null; // { since, file, written }
  function dump(h) {
    const session = new inspector.Session();
    const urls = new Map();
    let done = false;
    const finish = (frames, note) => {
      if (done) return;
      done = true;
      const lines = [
        'Ezrite 멈춤 스택 (메인 프로세스)',
        `시각: ${new Date(h.since).toISOString()} 부터 멈춤, 스택은 ${new Date().toISOString()} (멈춘 지 ${((Date.now() - h.since) / 1000).toFixed(1)}초)`,
        `${info}, pid ${process.pid}, 메모리 rss ${Math.round(process.memoryUsage().rss / 1048576)}MB`,
        '',
        note,
        ...frames.map((f) => `  at ${f}`),
        '',
      ];
      try {
        fs.writeFileSync(path.join(dir, h.file), lines.join('\n'));
        write('INFO', `멈춘 자리 스택 → ${h.file}`);
      } catch { /* 못 써도 감시는 계속 */ }
      try {
        session.post('Debugger.resume', () => session.post('Debugger.disable', () => session.disconnect()));
      } catch { /* 이미 끊김 */ }
    };
    try {
      session.connectToMainThread();
      session.on('Debugger.scriptParsed', (m) => urls.set(m.params.scriptId, m.params.url));
      session.on('Debugger.paused', (m) => {
        const frames = m.params.callFrames.slice(0, 40).map((f) => {
          const url = urls.get(f.location.scriptId) || f.url || '(알 수 없는 파일)';
          return `${f.functionName || '(이름 없음)'} (${url}:${f.location.lineNumber + 1}:${f.location.columnNumber + 1})`;
        });
        finish(frames, h.ended ? '풀린 뒤 JS 로 돌아온 첫 자리 (네이티브 호출에서 멈춰 있었다):' : '멈춘 자리:');
      });
      session.post('Debugger.enable', () => session.post('Debugger.pause'));
    } catch (e) {
      finish([], `스택을 뜨지 못함: ${e?.message ?? e}`);
      return;
    }
    // 굳은 곳이 JS 가 아니면 풀릴 때까지 세울 수 없다. 풀린 뒤 1초 안에도 못 세웠으면 스택 없이 남긴다
    h.giveUp = () => setTimeout(() => finish([], '스택을 뜨지 못함 (JS 밖에서 멈췄고, 풀린 뒤에도 세우지 못함)'), 1000);
  }
  setInterval(() => {
    const last = Number(Atomics.load(beat, 0));
    const lag = Date.now() - last;
    if (!hung && lag > limitMs) {
      hung = { since: last, file: HANG_NAME(new Date()), ended: false };
      write('WARN', `메인 프로세스가 ${(lag / 1000).toFixed(0)}초째 응답 없음`);
      dump(hung);
    } else if (hung && lag < beatMs * 4) {
      hung.ended = true;
      write('WARN', `풀림 — ${((last - hung.since) / 1000).toFixed(1)}초 동안 멈춰 있었음`);
      hung.giveUp?.();
      hung = null;
    }
  }, beatMs);
}

/** 메인 프로세스 감시를 띄운다. 끄는 함수를 돌려준다. dir: 로그 폴더 (없으면 띄우지 않는다) */
function watchMain({ dir, info = '', limitMs = LIMIT_MS, beatMs = BEAT_MS, Worker = require('node:worker_threads').Worker } = {}) {
  if (!dir) return () => {};
  const sab = new SharedArrayBuffer(8);
  const beat = new BigInt64Array(sab);
  const stamp = () => Atomics.store(beat, 0, BigInt(Date.now()));
  stamp();
  const timer = setInterval(stamp, beatMs);
  timer.unref?.();
  const worker = new Worker(`(${workerMain.toString()})()`, {
    eval: true,
    workerData: { sab, dir, limitMs, beatMs, info, day: day.toString(), line: line.toString(), hangName: hangName.toString() },
  });
  worker.unref();
  worker.on('error', () => {}); // 감시가 죽어도 앱은 돈다
  return () => {
    clearInterval(timer);
    worker.terminate().catch(() => {});
  };
}

/** EZRITE_SCRIPT 의 hang 시험: 메인 프로세스를 ms 동안 바쁘게 돌린다 (맥 hang@8=5 와 같은 시험) */
function spin(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* 일부러 굳힌다 */ }
}

module.exports = { PingWatch, watchMain, workerMain, spin, LIMIT_MS };
