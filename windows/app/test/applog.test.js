'use strict';
// 1.3.2 앱 기록 (맥 AppLog): 줄 꼴, 날짜별 파일, 14일 정리, 시험 중 끄기, 키·글 내용 가리기. 멈춤 감시(PingWatch)·EZRITE_SCRIPT
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const log = require('../lib/applog');
const { AppLog, format, err, enabledBy, hangName, line, day } = log;
const { PingWatch } = require('../lib/hangwatch');
const { parseScript, parseDevEnv } = require('../lib/ui');

const LINE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} (INFO|WARN|ERR) \[[^\]]+\] .* \((main|bg)\)$/;

test('줄 꼴: YYYY-MM-DD HH:mm:ss.SSS LEVEL [영역] 내용 (main|bg), 이 컴퓨터 시각', () => {
  const at = new Date(2026, 10, 27, 9, 5, 7, 42);
  assert.equal(format('INFO', '녹음', '시작 — 출처 프로그램', 'main', at), '2026-11-27 09:05:07.042 INFO [녹음] 시작 — 출처 프로그램 (main)');
  assert.equal(format('WARN', '앱', '둘째\n줄', 'bg', at), '2026-11-27 09:05:07.042 WARN [앱] 둘째 | 줄 (bg)');
  assert.match(format('ERR', '설명', 'x'), LINE);
});

test('키 모양은 가린다', () => {
  const l = format('ERR', '설명', 'Bearer gsk_abcdefghijklmnop1234 실패');
  assert.ok(!l.includes('abcdefghijklmnop'));
  assert.ok(l.includes('gsk_***'));
});

test('오류 글: 따옴표 안 조각(답 글이 실릴 수 있다)은 가리고 200자까지', () => {
  const e = new SyntaxError('Unexpected token \'역\', "역전파는 손실에서 출발한다" is not valid JSON');
  const t = err(e);
  assert.ok(!t.includes('역전파'), t);
  assert.ok(t.startsWith('SyntaxError: '));
  assert.ok(err(new Error('x'.repeat(500))).length <= 201);
  assert.equal(err(new Error('HTTP 429 한도 초과')), 'HTTP 429 한도 초과');
});

test('worker 에 넘기는 day·line·hangName 은 바깥 이름 없이도 돈다 (글로 다시 만든 함수가 같은 값)', () => {
  const at = new Date(2026, 0, 2, 3, 4, 5, 6);
  const again = (f) => new Function(`return ${f.toString()}`)(); // eslint-disable-line no-new-func
  assert.equal(again(day)(at), '2026-01-02');
  assert.equal(again(line)('WARN', '앱', '멈춤', 'bg', at), '2026-01-02 03:04:05.006 WARN [앱] 멈춤 (bg)');
  assert.equal(again(hangName)(at), 'hang-20260102-030405.txt');
});

test('파일: 날마다 ezrite-YYYY-MM-DD.log, 날이 바뀌면 새 파일', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-log-'));
  try {
    let now = new Date(2026, 10, 27, 23, 59, 59, 900);
    const l = new AppLog();
    assert.equal(l.open({ dir, env: {}, now: () => now }), true);
    l.info('앱', '하나');
    now = new Date(2026, 10, 28, 0, 0, 0, 100);
    l.warn('녹음', '둘');
    l.error('설명', '셋');
    const a = fs.readFileSync(path.join(dir, 'ezrite-2026-11-27.log'), 'utf8').trim().split('\n');
    const b = fs.readFileSync(path.join(dir, 'ezrite-2026-11-28.log'), 'utf8').trim().split('\n');
    assert.equal(a.length, 1);
    assert.equal(b.length, 2);
    for (const x of [...a, ...b]) assert.match(x, LINE);
    assert.ok(b[1].includes(' ERR [설명] 셋 (main)'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('열 때 14일 지난 기록·멈춤 스택 파일을 지운다 (다른 파일은 두기)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-log-'));
  try {
    for (const n of ['ezrite-2026-11-12.log', 'ezrite-2026-11-13.log', 'ezrite-2026-11-27.log', 'hang-20261101-120000.txt', 'hang-20261126-120000.txt', 'main.log', 'ezrite-2020-01-01.txt']) {
      fs.writeFileSync(path.join(dir, n), 'x');
    }
    const l = new AppLog();
    l.open({ dir, env: {}, now: () => new Date(2026, 10, 27, 10) });
    assert.deepEqual(fs.readdirSync(dir).sort(), ['ezrite-2020-01-01.txt', 'ezrite-2026-11-13.log', 'ezrite-2026-11-27.log', 'hang-20261126-120000.txt', 'main.log']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('EZRITE_NO_LOG=1 이나 테스트 실행 중(node --test)이면 쓰지 않는다', () => {
  assert.equal(enabledBy({}), true);
  assert.equal(enabledBy({ EZRITE_NO_LOG: '1' }), false);
  assert.equal(enabledBy({ NODE_TEST_CONTEXT: 'child-v8' }), false);
  // 이 시험 자체가 node --test 아래에서 돈다: 앱 기록을 열어도 꺼진다
  assert.equal(enabledBy(process.env), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-log-'));
  try {
    const l = new AppLog();
    assert.equal(l.open({ dir, env: { EZRITE_NO_LOG: '1' } }), false);
    l.info('앱', '안 써짐');
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('앱 전체가 쓰는 한 벌(log)은 열지 않으면 아무것도 안 한다', () => {
  assert.equal(log.on, false);
  log.info('앱', '조용');
  const got = [];
  log.capture((l) => got.push(l));
  log.warn('번역', '3줄 실패');
  log.capture(null);
  assert.equal(got.length, 1);
  assert.ok(got[0].includes('WARN [번역] 3줄 실패 (main)'));
});

test('화면 ping: 3초 넘게 답이 없으면 한 번 멈춤, 답이 오면 풀림 (걸린 시간)', () => {
  let t = 0;
  const ev = [];
  const sent = [];
  const w = new PingWatch({ now: () => t, onHang: (x, ms) => ev.push(['hang', x.name, ms]), onRecover: (x, ms) => ev.push(['ok', x.name, ms]) });
  const target = { id: 1, name: '팝업', send: (n) => sent.push(n) };
  w.tick([target]);
  t = 100;
  w.pong(1, sent[0]); // 제때 답
  for (t = 1000; t <= 5000; t += 1000) w.tick([target]); // 1000 에 보낸 것에 답이 없다
  assert.deepEqual(ev, [['hang', '팝업', 4000]]);
  assert.equal(sent.length, 2, '답을 기다리는 동안은 더 보내지 않는다');
  t = 6200;
  w.pong(1, sent[1]);
  assert.deepEqual(ev[1], ['ok', '팝업', 5200]);
  w.tick([target]);
  assert.equal(sent.length, 3);
});

test('화면 ping: 메인이 굳어 tick 이 늦게 오면 화면 탓으로 치지 않는다, 닫힌 창은 잊는다', () => {
  let t = 0;
  const ev = [];
  const w = new PingWatch({ now: () => t, onHang: (x) => ev.push(x.name) });
  const a = { id: 1, name: '팝업', send() {} };
  w.tick([a]);
  t = 6000; // 메인이 6초 굳었다 (그동안 답을 받을 수 없었다)
  w.tick([a]);
  assert.deepEqual(ev, []);
  t = 7000;
  w.tick([]);
  assert.equal(w.st.size, 0);
});

test('EZRITE_SCRIPT: hang@8=5 · uihang@2.5=4, 모르는 것은 버린다', () => {
  assert.deepEqual(parseScript('hang@8=5'), [{ kind: 'hang', at: 8, secs: 5 }]);
  assert.deepEqual(parseScript('uihang@2.5=4, explain@3=1 hang@1=999'), [{ kind: 'uihang', at: 2.5, secs: 4 }]);
  assert.deepEqual(parseScript(undefined), []);
  assert.deepEqual(parseDevEnv({ EZRITE_SCRIPT: 'hang@8=5' }).script, [{ kind: 'hang', at: 8, secs: 5 }]);
});
