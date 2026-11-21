'use strict';

// 1.3.0 "설명 표시 방식" (맥 MarkStyle · ExplainTests 꼬리표·카드 자리). 시험 이름 [mac …] 은 맥과 같은 이름이다
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../lib/markstyle');
const E = require('../lib/explain');
const G = require('../lib/groq-explain');

const R = (x, y, w, h) => ({ x, y, w, h });
const L = (id, text, box = R(0, 0, 0, 0)) => ({ id, text, box });
const lines = [L(1, '손실 L', R(0.1, 0.1, 0.3, 0.04)), L(2, '∂L/∂w', R(0.1, 0.2, 0.06, 0.05)), L(3, '역전파', R(0.5, 0.5, 0.2, 0.04))];

const sceneRequired = (schema) => schema.properties.scenes.items.required;

test('[mac ExplainTests] 꼬리표가_오면_쓰고_없으면_자막_첫_마디로_대신한다', () => {
  const json = '{"scenes":[{"say":"출발점은 손실 L. 가장 쉬운 한 칸","focus":[1],"tag":" 출발점 "},{"say":"받은 값에 자기 몫만 곱하면 끝나는 아주 긴 첫 마디입니다, 그 다음","focus":[2]}]}';
  const s = E.scenes(json, lines, 0);
  assert.equal(s[0].tag, '출발점');
  assert.equal(E.shortTag(s[0]), '출발점');
  assert.equal(s[1].tag, null);
  const t = E.shortTag(s[1]);
  assert.equal([...t].length, 14);
  assert.ok(t.endsWith('…'));
});

test('[mac ExplainTests] 꼬리표는_말풍선_메모_판서에서만_요청한다', () => {
  assert.deepEqual(M.IDS.filter(M.wantsTags), ['bubble', 'notes', 'pen']);
  assert.ok(!G.scenesGuide(false).includes('"tag"'));
  assert.ok(!sceneRequired(G.visualsSchema(false)).includes('tag'));
  assert.ok(G.scenesGuide(true).includes('"tag"'));
  assert.ok(sceneRequired(G.visualsSchema(true)).includes('tag'));
  assert.equal(G.visualsSchema(true).properties.scenes.items.properties.tag.type, 'string');
  // 요청 글에도 꼬리표 안내가 그때만 붙는다 (Groq 한 번에 묻기·나눠 묻기, 다른 서비스)
  assert.ok(G.unifiedPrompt(lines, [], '', false, true).includes(G.TAG_GUIDE));
  assert.ok(!G.unifiedPrompt(lines, [], '', false, false).includes(G.TAG_GUIDE));
  assert.ok(G.visualsPrompt(lines, [], '', true).includes(G.TAG_GUIDE));
  assert.equal(G.visualsBody('p', true).response_format.json_schema.schema.properties.scenes.items.properties.tag.type, 'string');
  assert.equal(G.visualsBody('p').response_format.json_schema.schema.properties.scenes.items.properties.tag, undefined);
});

test('[mac ExplainTests] 설명_카드는_글자가_적은_쪽에_뜬다', () => {
  // 맥은 왼쪽 아래가 원점이라 위아래를 뒤집어 옮겼다 (Windows 는 왼쪽 위가 원점)
  const screen = { x: 0, y: 0, width: 1440, height: 900 };
  const card = { width: 420, height: 150 };
  // 빈 화면: 예전처럼 오른쪽 위
  assert.deepEqual(E.freeSpot([], screen, card), { x: 1000, y: 20 });
  // 오른쪽 절반이 글자로 차 있으면 왼쪽으로
  const right = E.freeSpot([{ x: 720, y: 0, width: 720, height: 900 }], screen, card);
  assert.ok(right.x + card.width <= 720, JSON.stringify(right));
  // 위쪽 전체가 글자면 아래쪽에 붙는다 (늘어난 높이가 아래로 화면을 넘지 않게)
  const top = E.freeSpot([{ x: 0, y: 0, width: 1440, height: 400 }], screen, card);
  assert.ok(top.y > 900 * 0.3, JSON.stringify(top));
  assert.ok(top.y + 900 * 0.6 <= 900 - 20 + 1e-9, '늘어나도 아래 여백 20 안');
});

test('카드 자리: 두 번째 화면(음수 좌표)에서도 그 작업 영역 안. 녹음 팝업은 글자 20줄만큼 무겁게 피한다', () => {
  const work = { x: -1280, y: 100, width: 1280, height: 984 };
  const card = { width: 436, height: 150 };
  assert.deepEqual(E.freeSpot([], work, card), { x: -1280 + 1280 - 436 - 20, y: 120 });
  // 팝업이 오른쪽 위에 있으면 (글자 한 줄이 왼쪽 위에 있어도) 팝업을 피한다
  const popup = { x: -360, y: 120, width: 340, height: 260 };
  const text = [{ x: -1260, y: 120, width: 400, height: 30 }];
  const spot = E.cardSpot(text, work, card, popup);
  const r = { x: spot.x, y: spot.y, width: card.width, height: Math.max(card.height, work.height * 0.6) };
  const overlap = Math.max(0, Math.min(r.x + r.width, popup.x + popup.width) - Math.max(r.x, popup.x))
    * Math.max(0, Math.min(r.y + r.height, popup.y + popup.height) - Math.max(r.y, popup.y));
  assert.equal(overlap, 0, JSON.stringify(spot));
});

test('글자 줄(화면 비율) → 화면 좌표 상자', () => {
  const display = { x: -1280, y: 0, width: 1280, height: 1024 };
  assert.deepEqual(E.screenBoxes([L(1, 'a', R(0.5, 0.25, 0.1, 0.05))], display), [{ x: -640, y: 256, width: 128, height: 51.2 }]);
});

test('설명 표시 방식 목록: 13가지, 묶음 순서, 기본은 발자취, 모르는 값도 발자취', () => {
  assert.equal(M.STYLES.length, 13);
  assert.deepEqual(M.groups().map((g) => g.group), ['기본', '지금 하나만', '카드와 짝', '순서를 남기기', '화면에 바로 적기']);
  assert.deepEqual(M.groups().map((g) => g.styles.length), [1, 3, 3, 3, 3]);
  assert.equal(M.FALLBACK, 'trail');
  assert.equal(M.normalize('pen'), 'pen');
  assert.equal(M.normalize('nope'), 'trail');
  assert.equal(M.normalize(undefined), 'trail');
  assert.equal(M.STYLES.find((s) => s.id === 'trail').label, '발자취 (추천)');
  assert.deepEqual(M.IDS.filter(M.usesHover), ['spotlight', 'highlighter', 'corners', 'hover', 'leader', 'trail']);
  assert.deepEqual(M.IDS.filter(M.usesAnchors), ['leader']);
  for (const s of M.STYLES) assert.ok(s.detail.endsWith('.'), s.id);
});

test('카드 내용: 방식(style), 장면마다 짚은 곳 순번(mark: 첫 focus 중 marks 에 있는 줄, 없으면 -1), 지도(map)', () => {
  const marks = '{"marks":[{"id":3,"note":"c"},{"id":1,"note":"a"}],'
    + '"summary":"s","visuals":[],"scenes":[{"say":"하나","focus":[2,1]},{"say":"둘","focus":[3]},{"say":"셋","focus":[2]},{"say":"넷","focus":[]}]}';
  const { payload, model } = E.presentation(marks, { data: marks }, lines, { style: 'colors' });
  assert.equal(payload.style, 'colors');
  assert.deepEqual(payload.scenes.map((s) => s.mark), [1, 0, -1, -1]);
  assert.equal(model.style, 'colors');
  // 지도: 장면마다 짚은 줄·화살표 상자 (화면 비율 [x, y, w, h])
  const map = E.mapPayload(model, 'data:image/jpeg;base64,AA', 16 / 9);
  assert.equal(map.img, 'data:image/jpeg;base64,AA');
  assert.equal(map.aspect, 16 / 9);
  assert.deepEqual(map.scenes[1], { focus: [[0.5, 0.5, 0.2, 0.04]], arrow: null });
  assert.deepEqual(map.marks, [[0.5, 0.5, 0.2, 0.04], [0.1, 0.1, 0.3, 0.04]]);
  // 방식을 모르면 발자취
  assert.equal(E.presentation(marks, { data: marks }, lines).payload.style, 'trail');
});

test('화면 표시 자료: 방식·넓힌 상자(R)·글자 상자(Q)·장면(focus·arrow·꼬리표)·마우스·카드 위치·다른 글자', () => {
  const json = '{"marks":[{"id":1,"note":"a"}],"path":{"ids":[2,3],"note":"n"},"summary":"s","visuals":[],'
    + '"scenes":[{"say":"첫 장면, 둘째","focus":[1],"arrow":{"from":2,"to":3},"tag":"출발"},{"say":"다음입니다","focus":[3]}]}';
  const { model } = E.presentation(json, { data: json }, lines, { style: 'notes' });
  const d = E.markData({ ...model, hover: 's1', anchors: { say: { x: 10, y: 20 } }, others: lines.map((l) => l.box) }, { width: 1000, height: 500 });
  assert.equal(d.style, 'notes');
  assert.deepEqual(Object.keys(d.R).map(Number).sort(), [1, 2, 3]);
  assert.deepEqual(d.Q[1], { x: 100, y: 50, w: 300, h: 20 });
  assert.ok(d.R[1].x < 100 && d.R[1].w > 300, '넓힌 상자');
  assert.deepEqual(d.scenes, [{ focus: [1], arrow: [2, 3], tag: '출발' }, { focus: [3], arrow: null, tag: '다음입니다' }]);
  assert.deepEqual(d.marks, [1]);
  assert.deepEqual(d.path, [2, 3]);
  assert.equal(d.scene, 0);
  assert.equal(d.hover, 's1');
  assert.deepEqual(d.anchors, { say: { x: 10, y: 20 } });
  assert.deepEqual(d.others[0], { x: 100, y: 50, w: 300, h: 20 });
  // 화면 밖으로 나간 줄은 R·Q 에서 빠진다
  assert.equal(E.markData({ ...model, missing: [3] }, { width: 1000, height: 500 }).R[3], undefined);
});
