'use strict';

// 1.3.0 설명 표시 방식 그리기의 계산 부분 (renderer/explain/marks.js, 맥 MarksRenderer 의 "지금 무엇을 보여 주나"·자리 잡기)
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../renderer/explain/marks');

const box = (x, y, w, h) => ({ x, y, w, h });
// 줄 1·2 는 가로로 긴 줄, 3 은 그림 속 라벨 (가로 < 세로×2.2)
const DATA = {
  style: 'trail',
  R: { 1: box(92, 94, 316, 32), 2: box(92, 194, 216, 32), 3: box(492, 290, 56, 40) },
  Q: { 1: box(100, 100, 300, 20), 2: box(100, 200, 200, 20), 3: box(500, 296, 40, 28) },
  scenes: [{ focus: [1], arrow: null, tag: '출발점' }, { focus: [2], arrow: [2, 3], tag: '다음' }, { focus: [1], arrow: null, tag: '다시' }],
  marks: [2, 9], path: [], scene: 1, hover: null, anchors: {}, others: [],
};
const M = (patch) => K.Model({ ...DATA, ...patch });

test('지금 하나만: 마우스 올린 항목 > 지금 장면 > (장면이 없을 때) 짚은 곳', () => {
  assert.deepEqual(M({}).focusNow(), [2, 3], '지금 장면의 focus 와 화살표 양 끝');
  assert.deepEqual(M({ hover: 's0' }).focusNow(), [1]);
  assert.deepEqual(M({ hover: 'm0' }).focusNow(), [2]);
  assert.deepEqual(M({ hover: 'say' }).focusNow(), [2, 3], '자막은 지금 장면');
  assert.deepEqual(M({ scene: null }).focusNow(), [], '전체 보기는 장면이 있으면 아무것도');
  assert.deepEqual(M({ scene: null, scenes: [] }).focusNow(), [2], '장면이 없으면 짚은 곳 (화면 밖 9 는 뺀다)');
  assert.equal(M({ hover: 'm1' }).hoverIDs().length, 0, '화면 밖으로 나간 짚은 곳은 비어 있다');
  assert.equal(M({ hover: 'x9' }).hoverIDs(), null);
});

test('그림 속 라벨(가로가 세로의 2.2배보다 짧다)은 밑줄 대신 동그라미', () => {
  const m = M({});
  assert.equal(m.blob(1), false);
  assert.equal(m.blob(3), true);
});

test('발자취: 번호 = 설명 순서. 같은 줄을 여러 장면이 짚으면 번호를 모은다 ("1·3")', () => {
  const all = K.trailNumbers(M({ scene: null }));
  assert.deepEqual(all.order, [1, 2, 3]);
  assert.deepEqual(all.nums, { 1: [0, 2], 2: [1], 3: [1] });
  const now = K.trailNumbers(M({ scene: 1 }));
  assert.deepEqual(now.nums, { 1: [0], 2: [1], 3: [1] }, '지금 장면까지만');
});

test('색으로 짝 맞추기: 짚은 곳 순서대로 팔레트 색 (카드 목록과 같은 색)', () => {
  const m = M({ marks: [3, 1, 2, 9] });
  assert.deepEqual(m.colorOf(3), [124, 92, 255]);
  assert.deepEqual(m.colorOf(1), [15, 157, 138]);
  assert.deepEqual(m.colorOf(2), [229, 72, 77]);
  assert.equal(M({}).colorOf(1), null);
});

test('글 놓을 자리: 줄 오른쪽 → 아래(8) → 위(8) → 왼쪽, 다른 글자·이미 놓은 글과 겹치지 않는 첫 자리', () => {
  const area = { w: 1000, h: 600 };
  const r = box(100, 100, 300, 20);
  const size = { w: 80, h: 30 };
  assert.deepEqual(K.spot(size, r, [], [], area), box(418, 95, 80, 30), '오른쪽 18');
  const right = box(410, 90, 200, 40);
  assert.deepEqual(K.spot(size, r, [], [right], area), box(210, 128, 80, 30), '오른쪽이 막히면 아래');
  const below = box(150, 125, 200, 40);
  assert.deepEqual(K.spot(size, r, [below], [right], area), box(210, 62, 80, 30), '아래도 막히면 위');
  // 짚은 줄 자신을 덮는 글자 상자는 피하지 않는다
  assert.deepEqual(K.spot(size, r, [], [box(90, 95, 320, 30)], area), box(418, 95, 80, 30));
  // 오른쪽이 화면 밖이면 아래로
  assert.deepEqual(K.spot(size, box(900, 10, 90, 20), [], [], area), box(905, 38, 80, 30));
  // 네 자리가 모두 막히면 오른쪽 자리를 화면 안쪽으로 당긴다
  const wall = [box(0, 0, 1000, 28), box(0, 32, 1000, 568)];
  assert.deepEqual(K.spot(size, box(900, 10, 90, 20), [], wall, area), box(914, 6, 80, 30));
});

test('화살표: 상자 가장자리에서 5 띄워 시작해 끝나고, 같은 높이 두 상자 사이는 32 이상 휜다', () => {
  const a = box(0, 0, 100, 20);
  const b = box(300, 0, 100, 20);
  const { line, head } = K.arrowParts(a, b);
  assert.deepEqual(line[0], { x: 105, y: 10 });
  assert.deepEqual(line.at(-1), { x: 295, y: 10 });
  const midY = line[Math.floor(line.length / 2)].y;
  assert.ok(midY > 10 + 15, `아래로 휜다: ${midY}`);
  assert.equal(head.length, 3);
  assert.deepEqual(head[1], { x: 295, y: 10 });
  const straight = K.arrowParts(box(0, 0, 100, 20), box(0, 200, 100, 20)).line;
  assert.ok(straight.every((p) => Math.abs(p.x - 50) < 1e-9), '위아래는 곧게');
});

test('멈추는 때(맥 settleTime)와 부드럽게 움직이기(ease), 잘라 그리기(trim)', () => {
  assert.deepEqual(['spotlight', 'flow', 'minimap', 'pen', 'notes', 'bubble', 'trail', 'corners'].map(K.settleTime), [3.6, 9, 6, 2.2, 2.2, 2.2, 1.6, 1.6]);
  assert.equal(K.ease(-1), 0);
  assert.equal(K.ease(0.5), 0.5);
  assert.equal(K.ease(2), 1);
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }];
  assert.deepEqual(K.trim(pts, 0.25), [{ x: 0, y: 0 }, { x: 5, y: 0 }]);
  assert.equal(K.trim(pts, 1), pts);
});
