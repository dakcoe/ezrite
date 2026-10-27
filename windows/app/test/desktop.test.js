'use strict';
// 가상 데스크톱 (1.2.2): 설명한 화면의 기준 창 후보 고르기와 helper desktop-watch 줄 읽기
const test = require('node:test');
const assert = require('node:assert/strict');
const { candidates, readLine, DesktopWatch } = require('../lib/desktop');

const area = { x: 0, y: 0, w: 1920, h: 1080 };
const win = (hwnd, pid, x, y, w = 800, h = 600) => ({ hwnd, pid, x, y, w, h, max: false });

test('후보: 그 화면에 걸친 다른 프로그램 창, 맨 앞부터 (우리 창 빼고, 최대 8개)', () => {
  const list = { foreground: 1, windows: [win(1, 99, 10, 10), win(2, 7, 100, 100), win(3, 8, 3000, 0), win(4, 9, -500, 0, 600)] };
  assert.deepEqual(candidates(list, area, 99), [2, 4]);
  const many = { windows: Array.from({ length: 12 }, (_, i) => win(i + 1, 5, 0, 0)) };
  assert.equal(candidates(many, area, 99).length, 8);
  assert.deepEqual(candidates(null, area, 99), []);
  assert.deepEqual(candidates({ windows: 'x' }, area, 99), []);
});

test('줄 읽기: 처음 줄·바뀜·기준 창 없음·닫힘, 빈 줄(살아 있음 표시)과 깨진 줄은 무시', () => {
  assert.deepEqual(readLine('{"anchor":5,"on":true}'), { on: true });
  assert.deepEqual(readLine('{"on":false}'), { on: false });
  assert.deepEqual(readLine('{"anchor":null}'), { unknown: true });
  assert.deepEqual(readLine('{"gone":true}'), { unknown: true });
  assert.equal(readLine(''), null);
  assert.equal(readLine('{'), null);
  assert.equal(readLine('{"on":"yes"}'), null);
});

/** 가짜 helper: spawn(args, onLine) 를 기록하고 줄을 직접 흘린다 */
function rig({ list = { windows: [win(2, 7, 0, 0)] }, failList = false } = {}) {
  const spawned = [];
  const w = new DesktopWatch({
    me: 99,
    list: async () => { if (failList) throw new Error('helper 없음'); return list; },
    spawn: (args, onLine) => {
      const p = { args, onLine, killed: false, kill() { p.killed = true; } };
      spawned.push(p);
      return p;
    },
  });
  return { w, spawned };
}

test('지켜보기: 후보를 helper 에 넘기고, 바뀐 값만 알린다. stop 하면 helper 를 끝낸다', async () => {
  const { w, spawned } = rig({ list: { windows: [win(2, 7, 0, 0), win(3, 8, 10, 10)] } });
  const seen = [];
  const h = await w.watch(area, (on) => seen.push(on));
  assert.deepEqual(spawned[0].args, ['desktop-watch', '--hwnd', '2,3']);
  spawned[0].onLine('{"anchor":2,"on":true}');
  spawned[0].onLine('');
  spawned[0].onLine('{"on":false}');
  spawned[0].onLine('{"on":true}');
  assert.deepEqual(seen, [true, false, true]);
  h.stop();
  assert.equal(spawned[0].killed, true);
  spawned[0].onLine('{"on":false}');
  assert.deepEqual(seen, [true, false, true], '끝낸 뒤 줄은 버린다');
});

test('지켜보기: 기준 창이 없거나 닫히면 늘 보이는 것으로 (표시를 숨긴 채 두지 않는다)', async () => {
  const { w, spawned } = rig();
  const seen = [];
  await w.watch(area, (on) => seen.push(on));
  spawned[0].onLine('{"anchor":2,"on":false}');
  spawned[0].onLine('{"gone":true}');
  assert.deepEqual(seen, [false, true]);
});

test('지켜보기: 그 화면에 다른 창이 없거나 창 목록을 못 읽으면 null (helper 를 띄우지 않는다)', async () => {
  for (const r of [rig({ list: { windows: [win(1, 99, 0, 0)] } }), rig({ failList: true })]) {
    assert.equal(await r.w.watch(area, () => {}), null);
    assert.equal(r.spawned.length, 0);
  }
});
