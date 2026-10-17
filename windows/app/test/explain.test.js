'use strict';

// "설명해줘" 규칙. 맥 ExplainTests · LineRefTests · LenientJSONTests · ScenesTests · VisualsShapeTests ·
// RelocateTests · PaddingTests · ChangeTests · OnScreenTests 이식 + Windows 쪽(글자 인식 결과 읽기, 화면 표시 도형).
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/explain');

const R = (x, y, w, h) => ({ x, y, w, h });
const L = (id, text, box = R(0, 0, 0, 0)) => ({ id, text, box });
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// --- 맥 ExplainTests ---

const lines = [
  L(0, '파일 편집 보기', R(0.01, 0.0, 0.2, 0.02)),
  L(7, 'Pareto 효율성', R(0.3, 0.3, 0.25, 0.05)),
  L(9, 'MRS_A = MRS_B', R(0.4, 0.5, 0.3, 0.06)),
];

test('[mac ExplainTests] 화면에_없는_줄번호는_버리고_표시는_3개까지만_남긴다', () => {
  const json = '{"marks":[{"id":7,"note":"자원 배분 기준"},{"id":42,"note":"없는 줄"},{"id":9,"note":"조건"},{"id":7,"note":"중복"},{"id":0},{"id":9}]}';
  const marks = E.marks(json, lines);
  assert.deepEqual(marks.map((m) => m.line.id), [7, 9, 0]);
  assert.deepEqual(marks.map((m) => m.note), ['자원 배분 기준', '조건', '']);
});

test('[mac ExplainTests] 깨진_응답이면_표시를_그리지_않는다', () => {
  assert.deepEqual(E.marks('not json', lines), []);
});

test('[mac ExplainTests] 모르는_그림_형식과_필수_칸이_빠진_그림은_버린다', () => {
  const json = `{"summary":"요약","visuals":[
    {"type":"steps","title":"과정","items":["수요 증가","가격 상승"]},
    {"type":"steps","title":"빈 과정","items":[]},
    {"type":"table","title":"비교","headers":["구분","A"],"rows":[["장점","싸다"]]},
    {"type":"table","title":"행 없음","headers":["a"],"rows":[]},
    {"type":"card","title":"정의","formula":"MRS_A = MRS_B","terms":[["MRS","한계대체율"]]},
    {"type":"mermaid","title":"관계","code":"flowchart TD\\nA-->B"},
    {"type":"hologram","title":"?"}
  ]}`;
  const { summary, visuals } = E.visuals(json);
  assert.equal(summary, '요약');
  assert.deepEqual(visuals.map((v) => v.title), ['과정', '비교', '정의', '관계']);
});

const figure = [
  L(1, 'V1', R(0.1, 0.4, 0.03, 0.03)),
  L(2, 'R1', R(0.3, 0.2, 0.03, 0.03)),
  L(3, 'R2', R(0.5, 0.2, 0.03, 0.03)),
  L(4, 'GND', R(0.3, 0.7, 0.05, 0.03)),
];

test('[mac ExplainTests] 그림_속_경로는_라벨_순서대로_잇고_없는_라벨과_연달아_같은_라벨은_뺀다', () => {
  const p = E.path('{"path":{"ids":[1,2,2,99,3,4,1],"note":"전류가 흐르는 길"}}', figure);
  assert.deepEqual(p.steps.map((l) => l.text), ['V1', 'R1', 'R2', 'GND', 'V1']);
  assert.equal(p.note, '전류가 흐르는 길');
});

test('[mac ExplainTests] 이을_라벨이_둘보다_적으면_경로를_그리지_않는다', () => {
  assert.equal(E.path('{"path":{"ids":[2,99]}}', figure), null);
  assert.equal(E.path('{"marks":[]}', figure), null);
});

test('[mac VisualsSchemaTests] 카드의_빈_공식은_null_로_와도_그림이_남는다', () => {
  const json = '{"summary":"s","visuals":[{"type":"card","title":"t","formula":null,"body":"설명","terms":[]}]}';
  assert.equal(E.visuals(json).visuals.length, 1);
});

// --- 맥 ScenesTests ---

const sceneLines = [L(1, '파레토 효율', R(0.1, 0.3, 0.3, 0.04)), L(2, 'MRS_A = MRS_B', R(0.4, 0.5, 0.2, 0.05))];

test('[mac ScenesTests] 화면에_없는_줄과_빈_자막은_버리고_그림_번호와_단계를_범위_안으로', () => {
  const json = `{"scenes":[
    {"say":"먼저 정의입니다","focus":[1,99],"arrow":null,"visual":0,"reveal":1},
    {"say":"","focus":[2]},
    {"say":"이 조건이 핵심입니다","focus":[2],"arrow":{"from":1,"to":2},"visual":5,"reveal":-3},
    {"say":"없는 줄로 화살표","focus":[],"arrow":{"from":1,"to":42}}
  ]}`;
  const s = E.scenes(json, sceneLines, 2);
  assert.deepEqual(s.map((x) => x.say), ['먼저 정의입니다', '이 조건이 핵심입니다', '없는 줄로 화살표']);
  assert.deepEqual(s[0].focus.map((l) => l.id), [1]);
  assert.equal(s[0].visual, 0);
  assert.equal(s[0].reveal, 1);
  assert.equal(s[1].arrow.from.id, 1);
  assert.equal(s[1].arrow.to.id, 2);
  assert.equal(s[1].visual, null);
  assert.equal(s[1].reveal, null);
  assert.equal(s[2].arrow, null);
});

test('[mac ScenesTests] 장면은_6개까지', () => {
  const one = '{"say":"a","focus":[1]}';
  assert.equal(E.scenes(`{"scenes":[${Array(9).fill(one).join(',')}]}`, sceneLines, 0).length, 6);
});

test('[mac ScenesTests] 대본이_없으면_빈_목록이라_예전처럼_한번에_보여준다', () => {
  assert.deepEqual(E.scenes('{"summary":"s"}', sceneLines, 0), []);
});

// --- 맥 LineRefTests ---

const refLines = [L(25, '순전파: z = Wa + b'), L(28, '은닉층 "오차" \\delta')];

test('[mac LineRefTests] 줄_번호를_그_줄의_글자로_바꾼다', () => {
  assert.equal(E.dropLineRefs('25번 줄에 보이는 것처럼 계산해요', refLines), '‘순전파: z = Wa + b’에 보이는 것처럼 계산해요');
});

test('[mac LineRefTests] 괄호_속_번호는_지운다', () => {
  assert.equal(E.dropLineRefs('1. 전방 계산 (25번)', refLines), '1. 전방 계산');
  assert.equal(E.dropLineRefs('화면 2번 참고) 끝', refLines), '화면 2번 참고) 끝');
});

test('[mac LineRefTests] JSON_안에서_써도_JSON이_깨지지_않는다', () => {
  const fixed = E.dropLineRefs('{"answer":"28번 줄을 보세요"}', refLines);
  assert.equal(E.answer(fixed), '‘은닉층 ”오차” delta’을 보세요');
});

test('[mac LineRefTests] 없는_번호는_건드리지_않는다', () => {
  assert.equal(E.dropLineRefs('3번 줄', refLines), '3번 줄');
});

test('[mac LineRefTests] 번_화면이라고_써도_줄_글자로_바꾼다', () => {
  assert.equal(E.dropLineRefs('25번 화면을 보면', refLines), '‘순전파: z = Wa + b’을 보면');
  assert.equal(E.dropLineRefs('25번 스크린에서', refLines), '‘순전파: z = Wa + b’에서');
});

test('[mac LineRefTests] 없는_번호의_괄호_속_화면_줄은_지운다', () => {
  assert.equal(E.dropLineRefs('손실이 줄어요 (0번 화면).', refLines), '손실이 줄어요.');
  assert.equal(E.dropLineRefs('끝 (3번 줄)', refLines), '끝');
  // 괄호가 없으면 없는 번호는 그대로 둔다
  assert.equal(E.dropLineRefs('0번 화면', refLines), '0번 화면');
});

test('[mac LineRefTests] 라인_line_이라고_써도_바꾼다', () => {
  assert.equal(E.dropLineRefs('순전파(25번 라인)에서', refLines), '순전파(‘순전파: z = Wa + b’)에서');
  assert.equal(E.dropLineRefs('see line 25 here', refLines), 'see ‘순전파: z = Wa + b’ here');
  assert.equal(E.dropLineRefs('화면 25번 "순전파"', refLines), '‘순전파: z = Wa + b’ "순전파"');
});

// --- 맥 LenientJSONTests ---

test('[mac LenientJSONTests] 수식_역슬래시를_고쳐_읽는다', () => {
  const raw = '```json\n{"summary":"오차 \\delta 와 \\frac{1}{2}","marks":[]}\n```';
  const fixed = E.lenientJSON(raw);
  assert.ok(fixed);
  assert.equal(E.visuals(fixed).summary, '오차 \\delta 와 \\frac{1}{2}');
});

test('[mac LenientJSONTests] 올바른_이스케이프는_그대로_둔다', () => {
  const fixed = E.lenientJSON('{"summary":"줄\\n바꿈 \\"따옴표\\""}');
  assert.equal(E.visuals(fixed).summary, '줄\n바꿈 "따옴표"');
});

test('[mac LenientJSONTests] JSON이_아니면_nil', () => {
  assert.equal(E.lenientJSON('죄송합니다'), null);
});

// --- 맥 AskTests (답 읽기 부분) ---

test('[mac AskTests] 답에서_본문을_읽는다', () => {
  const json = '{"answer":"MRS 가 다르면\\n교환으로 둘 다 이득을 볼 수 있어요.","marks":[{"id":1,"note":"이 조건"}],"visuals":[]}';
  assert.equal(E.answer(json), 'MRS 가 다르면\n교환으로 둘 다 이득을 볼 수 있어요.');
  assert.deepEqual(E.marks(json, [L(1, 'MRS_A = MRS_B')]).map((m) => m.line.id), [1]);
  assert.equal(E.answer('깨짐'), null);
});

// --- 맥 RelocateTests ---

const rl = (id, text, y, x = 0.1) => L(id, text, R(x, y, 0.4, 0.04));

test('[mac RelocateTests] 위아래로_움직인_글자를_새_자리에서_찾는다', () => {
  const before = [rl(3, '파레토 효율: 누군가를 더 나쁘게', 0.30), rl(5, 'MRS_A = MRS_B', 0.50)];
  const after = [rl(0, '7.2 파레토 효율성', 0.05), rl(1, '파레토 효율: 누군가를 더 나쁘게', 0.22), rl(2, 'MRS_A = MRS_B', 0.42)];
  assert.deepEqual(E.relocate(before, after).map((l) => l.box.y), [0.22, 0.42]);
});

test('[mac RelocateTests] 글자_인식이_조금_달라도_같은_줄로_본다', () => {
  const before = [rl(3, '후생경제학 제1정리: 경쟁균형은 파레토 효율적이다', 0.7)];
  const after = [rl(9, '후생경제학 제1정리 : 경쟁균형은 파레토 효을적이다', 0.6)];
  assert.equal(E.relocate(before, after)[0].box.y, 0.6);
});

test('[mac RelocateTests] 같은_글자가_여러_곳이면_원래_자리에_가까운_쪽', () => {
  const after = [rl(7, '정리', 0.10), rl(8, '정리', 0.45)];
  assert.equal(E.relocate([rl(1, '정리', 0.40)], after)[0].box.y, 0.45);
});

test('[mac RelocateTests] 화면_밖으로_나간_줄만_빼고_보이는_줄은_옮긴다', () => {
  const before = [rl(3, '파레토 효율', 0.3), rl(5, 'MRS_A = MRS_B', 0.5)];
  const after = [rl(1, '파레토 효율', 0.2), rl(2, '다음 슬라이드 제목', 0.4)];
  const moved = E.relocate(before, after);
  assert.deepEqual(moved.map((l) => l.id), [3]);
  assert.equal(moved[0].box.y, 0.2);
});

test('[mac RelocateTests] 하나도_못_찾으면_nil', () => {
  assert.equal(E.relocate([rl(3, '파레토 효율', 0.3)], [rl(2, '다음 슬라이드 제목', 0.4)]), null);
});

test('[mac RelocateTests] 확대해서_줄이_다른_곳에서_끊겨도_찾는다', () => {
  const before = [rl(4, '과제 3: 2층 MLP를 직접 구현하고 위 표의 최적화기 5개를 비교한다. 학습 곡선과 검증 정확도를', 0.5)];
  const after = [rl(8, '과제 3: 2층 MLP를 직접 구현하고 위 표의 최적화기 5개를 비교한다', 0.6), rl(9, '학습 곡선과 검증 정확도를 보고서에 첨부한다', 0.64)];
  assert.equal(E.relocate(before, after)[0].box.y, 0.6);
});

test('[mac RelocateTests] 수식_부분_인식이_흔들려도_앞_글자가_같으면_찾는다', () => {
  const before = [rl(2, '출력층 오차: 6(t) = y - y', 0.3), rl(3, '은닉층 오차: 6(1) = (W (+1))', 0.35)];
  const after = [rl(5, '출력층 오차: 0(L =g-y', 0.25), rl(6, '은닉층 오차: 6(D) =(W(1+1))', 0.3)];
  assert.deepEqual(E.relocate(before, after).map((l) => l.box.y), [0.25, 0.3]);
});

test('[mac RelocateTests] 머리만_같은_다른_줄은_잡지_않는다', () => {
  assert.equal(E.relocate([rl(1, 'Adam: m - Bim + (1-B1)g', 0.3)], [rl(2, 'Adam', 0.3), rl(3, 'AdamW', 0.35)]), null);
});

test('[mac RelocateTests] 비슷한_줄이_여럿이면_글자가_더_같은_쪽', () => {
  assert.equal(E.relocate([rl(1, 'AdamW', 0.40)], [rl(2, 'Adam', 0.40), rl(3, 'AdamW', 0.45)])[0].box.y, 0.45);
});

// --- 맥 PaddingTests ---

const overlaps = (rs) => rs.some((a, i) => rs.some((b, j) => j > i && E.intersects(a, b)));

test('[mac PaddingTests] 떨어져_있으면_원래_여백', () => {
  const out = E.padded([R(0, 0, 100, 20), R(0, 100, 100, 20)]);
  assert.deepEqual(out[0], R(-8, -6, 116, 32));
});

test('[mac PaddingTests] 위아래로_붙은_줄은_사이_간격의_절반까지만', () => {
  const out = E.padded([R(0, 0, 100, 20), R(10, 26, 80, 20)]);
  assert.ok(!overlaps(out));
  assert.ok(out[0].y + out[0].h <= 23 && out[1].y >= 23);
  assert.equal(out[0].x, -8);
});

test('[mac PaddingTests] 좌우로_붙은_라벨도_겹치지_않는다', () => {
  assert.ok(!overlaps(E.padded([R(0, 0, 50, 20), R(54, 2, 50, 20)])));
});

test('[mac PaddingTests] 같은_줄을_두_번_짚은_건_그대로_겹친다', () => {
  const r = R(0, 0, 100, 20);
  const out = E.padded([r, r, R(0, 23, 100, 20)]);
  assert.deepEqual(out[0], out[1]);
  assert.ok(!E.intersects(out[0], out[2]));
});

test('[mac PaddingTests] 글자_인식이_원래부터_조금_겹치게_잡은_줄도_나눠서_겹치지_않게', () => {
  const out = E.padded([R(40, 0, 60, 20), R(0, 16, 140, 20)]);
  assert.ok(!overlaps(out));
  assert.ok(out[0].y + out[0].h <= 18 && out[1].y >= 18);
});

// --- 맥 ChangeTests (그림은 BGRA 픽셀 버퍼로 만든다) ---

/** 왼쪽 절반 검정·오른쪽 흰색 (darkLeft=false 면 반대). rightGray: 오른쪽 절반을 회색으로 */
function image(width = 400, height = 200, darkLeft = true, rightGray = null) {
  const data = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const left = x < width / 2;
      let v = left === darkLeft ? 0 : 255;
      if (rightGray != null && !left) v = rightGray;
      const i = (y * width + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = v;
    }
  }
  return { width, height, data };
}

test('[mac ChangeTests] 같은_자리가_그대로면_바뀌지_않은_것이다', () => {
  const box = R(0.1, 0.2, 0.3, 0.5);
  assert.equal(E.changed(E.thumbnail(image(400, 200, true), box), E.thumbnail(image(200, 100, true), box)), false);
});

test('[mac ChangeTests] 표시_자리가_달라지면_바뀐_것이다', () => {
  const box = R(0.1, 0.2, 0.3, 0.5);
  assert.equal(E.changed(E.thumbnail(image(400, 200, true), box), E.thumbnail(image(400, 200, false), box)), true);
});

test('[mac ChangeTests] 표시_밖이_바뀌는_건_상관없다', () => {
  const box = R(0.05, 0.1, 0.2, 0.3);
  assert.equal(E.changed(E.thumbnail(image(400, 200, true), box), E.thumbnail(image(400, 200, true, 128), box)), false);
});

test('빈 썸네일끼리는 바뀐 것으로 본다 (맥과 같다)', () => {
  assert.equal(E.changed([], []), true);
});

// --- 맥 OnScreenTests (Windows 는 왼쪽 위가 원점이라 "위쪽에 맞춘다"는 y 가 화면 위 끝) ---

const screen = R(0, 0, 1440, 875);

test('[mac OnScreenTests] 대부분_화면_안이면_그대로_둔다', () => {
  assert.equal(E.pulledIn(R(1100, 300, 420, 500), screen), null);
});

test('[mac OnScreenTests] 절반_넘게_밖으로_나가면_화면_안으로_옮긴다', () => {
  assert.deepEqual(E.pulledIn(R(1300, 300, 420, 500), screen), R(1440 - 420 - 8, 300, 420, 500));
});

test('[mac OnScreenTests] 완전히_밖에_있으면_가까운_가장자리_안쪽으로', () => {
  assert.deepEqual(E.pulledIn(R(-900, -800, 420, 500), screen), R(8, 8, 420, 500));
});

test('[mac OnScreenTests] 화면보다_큰_창은_위쪽에_맞춘다', () => {
  assert.equal(E.pulledIn(R(200, 600, 420, 1200), screen).y, 0);
});

// --- Windows: 글자 인식(helper ocr) 결과 → 줄 ---

test('helper ocr 결과를 화면 비율 상자로 바꾸고, 빈 줄은 뺀다 (번호는 원래 순서)', () => {
  const ocr = { lang: 'ko', width: 2000, height: 1000, lines: [
    { text: '제목', x: 100, y: 50, w: 400, h: 60 },
    { text: '   ', x: 0, y: 0, w: 1, h: 1 },
    { text: 'E = mc²', x: 1000, y: 500, w: 200, h: 40 },
  ] };
  assert.deepEqual(E.linesFromOcr(ocr), [
    L(0, '제목', R(0.05, 0.05, 0.2, 0.06)),
    L(2, 'E = mc²', R(0.5, 0.5, 0.1, 0.04)),
  ]);
  assert.deepEqual(E.linesFromOcr({ width: 0, height: 0, lines: [] }), []);
  assert.deepEqual(E.linesFromOcr(null), []);
});

// --- 화면 위 표시 도형 (맥 MarksView) ---

test('표시: 짚은 줄마다 주황 상자와 번호, 경로는 파란 상자·번호·화살표', () => {
  const marks = [{ line: figure[0], note: 'a' }];
  const path = { steps: [figure[1], figure[2]], note: '' };
  const shapes = E.shapes({ marks, path, scenes: [], scene: null, missing: [] }, { width: 1000, height: 1000 });
  assert.deepEqual(shapes.filter((s) => s.kind === 'focus').map((s) => s.label), ['1']);
  assert.deepEqual(shapes.filter((s) => s.kind === 'route').map((s) => s.label), ['1', '2']);
  assert.equal(shapes.filter((s) => s.kind === 'arrow').length, 1);
  const focus = shapes.find((s) => s.kind === 'focus');
  assert.deepEqual(focus.rect, R(100 - 8, 400 - 6, 30 + 16, 30 + 12));
});

test('표시: 장면을 고르면 그 장면의 줄만 장면 번호로, 화살표는 이전 자리 → 새 자리', () => {
  const scenes = [{ say: 'x', focus: [figure[3]], arrow: { from: figure[1], to: figure[2] }, visual: null, reveal: null }];
  const shapes = E.shapes({ marks: [{ line: figure[0], note: '' }], path: null, scenes, scene: 0, missing: [] }, { width: 1000, height: 1000 });
  assert.deepEqual(shapes.map((s) => s.kind).sort(), ['arrow', 'focus', 'route']);
  assert.equal(shapes.find((s) => s.kind === 'focus').label, '1');
  assert.equal(shapes.find((s) => s.kind === 'route').label, null); // 장면의 화살표 시작 상자에는 번호가 없다
});

test('표시: 화면 밖으로 나간 줄은 숨기고, 경로는 한 칸이라도 빠지면 통째로 숨긴다', () => {
  const marks = [{ line: figure[0], note: '' }, { line: figure[3], note: '' }];
  const path = { steps: [figure[1], figure[2]], note: '' };
  // 줄 1(첫 표시)과 줄 2(경로 첫 칸)가 화면 밖: 첫 표시는 숨고 둘째 표시는 번호 2 그대로, 경로는 통째로 숨는다
  const shapes = E.shapes({ marks, path, scenes: [], scene: null, missing: [1, 2] }, { width: 1000, height: 1000 });
  assert.deepEqual(shapes.map((s) => [s.kind, s.label]), [['focus', '2']]);
});

test('화살표는 상자 가장자리에서 시작해 가장자리에서 끝난다', () => {
  const a = E.edge(R(0, 0, 100, 20), { x: 300, y: 10 });
  assert.deepEqual(a, { x: 100, y: 10 });
  assert.deepEqual(E.edge(R(0, 0, 100, 20), { x: 50, y: 10 }), { x: 50, y: 10 });
});

test('모든 표시 줄: 같은 줄은 한 번만 (지켜볼 자리)', () => {
  const scenes = [{ say: 'x', focus: [figure[0]], arrow: { from: figure[1], to: figure[0] } }];
  const all = E.allLines({ marks: [{ line: figure[0] }], path: { steps: [figure[1], figure[2]] }, scenes });
  assert.deepEqual(all.map((l) => l.id), [1, 2, 3]);
});

// --- 맥 Explainer.present: 카드에 보낼 내용과 화면 표시 ---

test('[mac present] 표시·경로·요약·그림·장면을 카드 내용으로 만들고, 장면이 있으면 화면 표시는 첫 장면부터', () => {
  const data = JSON.stringify({
    marks: [{ id: 7, note: '배분 기준' }],
    path: { ids: [7, 9], note: '순서' },
    summary: '요약',
    visuals: [{ type: 'steps', title: '과정', items: ['가', '나'] }],
    scenes: [{ say: '첫 장면', focus: [9], visual: 0, reveal: 1 }, { say: '둘째', focus: [], visual: null }],
  });
  const p = E.presentation(data, { data }, lines);
  assert.deepEqual(p.payload.marks, [{ note: '배분 기준', text: 'Pareto 효율성' }]);
  assert.deepEqual(p.payload.path, { note: '순서', steps: ['Pareto 효율성', 'MRS_A = MRS_B'] });
  assert.equal(p.payload.summary, '요약');
  assert.equal(p.payload.visuals.length, 1);
  assert.deepEqual(p.payload.scenes, [{ say: '첫 장면', visual: 0, reveal: 1 }, { say: '둘째' }]);
  assert.equal(p.explanation, '요약');
  assert.equal(p.model.scene, 0);
  assert.deepEqual(E.allLines(p.model).map((l) => l.id), [7, 9]);
});

test('[mac present] 그림 설명이 실패하면 오류 문구, 표시가 없으면 화면 표시도 없다', () => {
  const p = E.presentation(null, { error: new Error('한도') }, lines);
  assert.equal(p.payload.error, '그림 설명을 만들지 못했습니다: 한도');
  assert.deepEqual(p.payload.marks, []);
  assert.equal(p.model, null);
  assert.equal(p.explanation, '');
});

test('[mac ask] 답 글이 있으면 답·짚은 곳·그림, 화면 표시는 그 답이 짚은 곳만', () => {
  const data = '{"answer":"한계대체율이에요\\n둘째 문단","marks":[{"id":9,"note":"조건"}],"visuals":[]}';
  const a = E.answerPresentation(data, lines);
  assert.equal(a.text, '한계대체율이에요\n둘째 문단');
  assert.deepEqual(a.payload, { answer: a.text, marks: [{ note: '조건', text: 'MRS_A = MRS_B' }], visuals: [] });
  assert.equal(a.model.scene, null);
  assert.deepEqual(E.allLines(a.model).map((l) => l.id), [9]);
  assert.equal(E.answerPresentation('{"marks":[]}', lines), null);
});

// --- 설명 카드 자리 (맥 ExplainCard.show · fit · asked. Windows 좌표는 위가 0) ---

const work = { x: 0, y: 0, width: 1707, height: 912 };

test('[mac card] 처음엔 작업 영역 오른쪽 위 (420×150, 오른쪽 20·위 20 띄움)', () => {
  assert.deepEqual(E.cardFrame(work, null), { x: 1707 - 440, y: 20, width: 420, height: 150 });
});

test('[mac card] 녹음 팝업과 겹치면 팝업 왼쪽 12 띄워서, 그래도 화면 왼쪽 20 안으로', () => {
  const popup = { x: 1360, y: 0, width: 340, height: 344 };
  assert.equal(E.cardFrame(work, popup).x, 1360 - 420 - 12);
  assert.equal(E.cardFrame(work, { x: 100, y: 0, width: 1600, height: 300 }).x, 20);
  assert.equal(E.cardFrame(work, { x: 0, y: 600, width: 300, height: 300 }).x, 1707 - 440); // 안 겹치면 그대로
});

test('[mac card] 내용 높이에 맞추되 110 이상·작업 영역의 75% 이하, 위쪽 가장자리는 그대로', () => {
  const f = { x: 10, y: 20, width: 420, height: 150 };
  assert.equal(E.cardFit(f, 40, 32, work).height, 110);
  assert.equal(E.cardFit(f, 300, 32, work).height, 332);
  assert.equal(E.cardFit(f, 5000, 32, work).height, 912 * 0.75);
  assert.equal(E.cardFit(f, 300, 32, work).y, 20);
});

test('[mac card] 아래가 화면을 넘으면 위로 올린다 (아래 10 띄움)', () => {
  const low = { x: 10, y: 700, width: 420, height: 150 };
  const g = E.cardFit(low, 400, 32, work);
  assert.equal(g.y + g.height, 912 - 10);
});

test('[mac card] 질문을 시작하면 75% 높이로 늘린다', () => {
  const g = E.cardAsked({ x: 10, y: 20, width: 420, height: 150 }, work);
  assert.deepEqual(g, { x: 10, y: 20, width: 420, height: 912 * 0.75 });
});

test('[mac jpeg] 폭 1280 넘는 화면만 줄인다 (비율 유지)', () => {
  assert.deepEqual(E.scaledSize({ width: 2560, height: 1440 }, 1280), { width: 1280, height: 720 });
  assert.deepEqual(E.scaledSize({ width: 1024, height: 768 }, 1280), { width: 1024, height: 768 });
});

// ── 한국어 글자 인식 팩이 없을 때 (영어 인식기가 한글을 읽으면 짧은 기호·글자 조각이 된다) ──
const { needsKoreanOcrHint, OCR_KO_HINT } = require('../lib/explain');
const ocrOf = (koAvailable, texts) => ({ koAvailable, lines: texts.map((text) => ({ text, x: 0, y: 0, w: 10, h: 10 })) });

test('한국어 OCR 안내: 한국어 팩이 없고 글자가 깨져 보이면 한 줄 안내', () => {
  assert.equal(OCR_KO_HINT, 'Windows 설정 → 언어에 한국어를 추가하면 한글 화면을 더 잘 읽습니다');
  const garbled = ocrOf(false, ['LH 7t Ol 2 E-I', 'O| xl ?? 2t', 'S| 4 ol0', '7H LI E- ?']);
  assert.equal(needsKoreanOcrHint(garbled), true);
});

test('한국어 OCR 안내: 영어 화면이 잘 읽혔거나, 한국어 팩이 있거나, 모르면 띄우지 않는다', () => {
  const english = ocrOf(false, ['Process scheduling with round robin', 'Average waiting time drops from 6.67 to 5.33', 'The convoy effect']);
  assert.equal(needsKoreanOcrHint(english), false);
  assert.equal(needsKoreanOcrHint(ocrOf(true, ['LH 7t Ol 2 E-I', 'O| xl ?? 2t', 'S| 4 ol0', '7H LI E- ?'])), false);
  assert.equal(needsKoreanOcrHint(ocrOf(undefined, ['LH 7t Ol 2 E-I', 'O| xl ?? 2t', 'S| 4 ol0', '7H LI E- ?'])), false, '예전 helper (koAvailable 없음)');
  assert.equal(needsKoreanOcrHint(ocrOf(false, ['ok'])), false, '글자가 너무 적으면 판단하지 않는다');
});
