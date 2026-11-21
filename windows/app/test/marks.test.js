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

// ── 설정 미리보기 (맥 MarkStylePreview: 가짜 슬라이드, 장면 0→1→2→3→전체 보기) ──

const measure = (text, font) => ({ w: [...text].length * (font.startsWith('700') ? 27 : 19) * 0.6, h: font.startsWith('700') ? 36 : 25 });

test('미리보기: 가상 화면 760×400, 슬라이드 580, 3.4초마다, 마우스는 1.1초 뒤, 선은 카드 자리 왼쪽(594)에서', () => {
  assert.equal(K.PREVIEW.width, 760);
  assert.equal(K.PREVIEW.height, 400);
  assert.equal(K.PREVIEW.slideWidth, 580);
  assert.equal(K.PREVIEW.period, 3400);
  assert.equal(K.PREVIEW.hoverAfter, 1100);
  assert.deepEqual(K.PREVIEW.anchors, { say: { x: 594, y: 62 }, m0: { x: 594, y: 62 }, m1: { x: 594, y: 96 } });
});

test('미리보기 슬라이드: 제목·글 세 줄·그림 라벨 넷, 짚은 곳 둘(연쇄법칙·손실), 길 L→ŷ→h→x, 장면 넷 (맥 글 그대로)', () => {
  const pm = K.previewModel(measure);
  assert.deepEqual(pm.items.map((it) => it.text), ['역전파 — 연쇄법칙으로 기울기 구하기', '• 순전파: 입력 x → 은닉 h → 출력 ŷ → 손실 L',
    '• ∂L/∂W₁ = ∂L/∂h · ∂h/∂W₁', '• 기울기는 출력에서 입력 방향으로 전달된다', 'x', 'h', 'ŷ', 'L']);
  assert.deepEqual(pm.marks.map((m) => [m.line.id, m.note]), [[2, '연쇄법칙'], [7, '손실']]);
  assert.deepEqual(pm.path.steps.map((l) => l.id), [7, 6, 5, 4]);
  assert.deepEqual(pm.scenes.map((s) => s.tag), ['순전파', '출발점', '넘어온 값 × 내 몫', '출력 → 입력']);
  assert.deepEqual(pm.scenes.map((s) => s.arrow && [s.arrow.from.id, s.arrow.to.id]), [null, null, [6, 5], [5, 4]]);
  // 그림 라벨은 동그라미 가운데 (x 노드: 80, 312)
  const x = pm.items[4];
  assert.ok(Math.abs(x.box.x * 760 + x.box.w * 760 / 2 - 80) < 1e-9 && Math.abs(x.box.y * 400 + x.box.h * 400 / 2 - 312) < 1e-9);
});

test('미리보기 차례와 자료: 0→1→2→3→전체 보기→처음, 제목은 짚지 않고, 예전 방식 도형도 함께', () => {
  const pm = K.previewModel(measure);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((s) => K.previewScene(pm, s)), [0, 1, 2, 3, null, 0, null]);
  const d = K.previewData(pm, 'trail', 2, 'say');
  assert.equal(d.style, 'trail');
  assert.equal(d.scene, 2);
  assert.equal(d.hover, 'say');
  assert.equal(d.R[0], undefined, '제목은 짚을 줄이 아니다');
  assert.deepEqual(Object.keys(d.Q).map(Number), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(d.scenes[2], { focus: [2], arrow: [6, 5], tag: '넘어온 값 × 내 몫' });
  assert.equal(d.others.length, 8);
  // 예전 방식: 장면 2 는 짚은 줄 하나(주황, 번호 3)와 화살표
  assert.deepEqual(d.classic.map((s) => s.kind).sort(), ['arrow', 'focus', 'route']);
  assert.equal(d.classic.find((s) => s.kind === 'focus').label, '3');
  // 전체 보기: 짚은 곳 ①② 와 길(파란 상자 넷, 화살표 셋)
  const all = K.previewData(pm, 'classic', null);
  assert.equal(all.classic.filter((s) => s.kind === 'focus').length, 2);
  assert.equal(all.classic.filter((s) => s.kind === 'route').length, 4);
  assert.equal(all.classic.filter((s) => s.kind === 'arrow').length, 3);
});
