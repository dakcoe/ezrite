'use strict';
// 화면 번역 (실험 기능): 줄·문단·글자 크기·덮개 자리. 시험 그림 5장(scripts/make-translate-samples.js)과 그 OCR 결과를
// test/fixtures/screentx 에 두고 Electron·helper 없이 본다 (맥 시험 그림과 같은 성격, 2배).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ST = require('../lib/screentx');
const { decodePNG } = require('../lib/png');
const P = require('../renderer/translate/paint');

const F = path.join(__dirname, 'fixtures', 'screentx');
const OCR = JSON.parse(fs.readFileSync(path.join(F, 'ocr.json'), 'utf8'));
const TRUTH = JSON.parse(fs.readFileSync(path.join(F, 'truth.json'), 'utf8'));
const cache = {};
function run(name) {
  cache[name] ??= ST.analyze({ ocr: OCR[name], bitmap: decodePNG(fs.readFileSync(path.join(F, `${name}.png`))), scale: 2 });
  return cache[name];
}
const area = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const blockAt = (r, box) => r.blocks.map((b) => [b, area(b.box, box)]).sort((a, b) => b[1] - a[1])[0][0];

test('슬라이드: 제목·목록 3개(감긴 줄은 한 문단)·캡션 = 5문단, 머리표는 덮지 않는다, 제목은 굵게', () => {
  const r = run('slide');
  assert.equal(r.lines.length, 6);
  assert.equal(r.blocks.length, 5);
  assert.deepEqual(r.blocks.map((b) => b.list), [false, true, true, true, false]);
  assert.equal(r.blocks[2].lines, 2, '감긴 목록은 두 줄 한 문단');
  assert.ok(r.blocks.every((b) => !b.text.startsWith('•')), '머리표는 글에서 뺀다');
  // 머리표(글보다 왼쪽)는 덮개 밖
  for (const b of r.blocks.slice(1, 4)) assert.ok(b.box.x > 240, `덮개가 머리표를 덮음: ${b.box.x}`);
  assert.equal(r.blocks[0].bold, true);
  assert.ok(r.blocks.slice(1).every((b) => !b.bold));
});

test('웹 글: 제목 + 문단 3개, 여러 줄 문단은 원래 줄 간격(28/19 ≈ 1.5배)을 지킨다, 붉은 제목색', () => {
  const r = run('web');
  assert.equal(r.blocks.length, 4);
  assert.deepEqual(r.blocks.map((b) => b.lines), [1, 2, 2, 1]);
  const gap = r.blocks[1].lineGap * r.blocks[1].size;
  assert.ok(Math.abs(gap - 28) < 1.5, `줄 간격 ${gap}`);
  const [red, green, blue] = r.blocks[0].color;
  assert.ok(red > 140 && green < 80 && blue < 80, `제목색 ${r.blocks[0].color}`);
});

test('어두운 설정: 줄마다 따로 (제목·항목·설명·단추), 단추 글은 가운데, 바탕은 단추 파랑과 어두운 바탕', () => {
  const r = run('dark');
  assert.equal(r.blocks.length, 10);
  const buttons = r.blocks.filter((b) => ['Manage', 'Change', 'Settings'].includes(b.text));
  assert.equal(buttons.length, 3);
  for (const b of buttons) {
    assert.equal(b.center, true, b.text);
    assert.ok(b.bg[2] > 200 && b.bg[0] < 100, `단추 바탕 ${b.bg}`);
  }
  assert.ok(r.blocks.filter((b) => !buttons.includes(b)).every((b) => !b.center && b.bg[0] < 50));
});

test('코드: 코드 줄은 번역하지 않고, 주석(#)은 따로, 위 설명 문단은 번역', () => {
  const r = run('code');
  const kinds = r.blocks.map((b) => b.kind);
  assert.equal(kinds.filter((k) => k === 'comment').length, 2);
  assert.ok(kinds.includes('code'));
  assert.ok(r.blocks.filter((b) => b.kind === 'code').every((b) => !b.translate));
  assert.ok(r.blocks.filter((b) => b.kind === 'comment').every((b) => b.translate));
  assert.equal(r.blocks[0].translate, true);
  // 한국어 OCR 이 읽은 "100p" 는 번역 전에 loop 로
  assert.ok(r.blocks.some((b) => b.text === '# loop over the data and update the weights'));
});

test('섞음: 한국어 문단은 안 보내고, 형광펜 줄 바탕은 노랑(가운데 맞춤 아님), 11pt 출처', () => {
  const r = run('mixed');
  assert.equal(r.blocks.length, 4);
  assert.equal(r.blocks[0].korean, true);
  assert.equal(r.blocks[0].translate, false);
  const hl = r.blocks[1];
  assert.ok(hl.bg[0] > 240 && hl.bg[1] > 220 && hl.bg[2] < 160, `형광펜 바탕 ${hl.bg}`);
  assert.equal(hl.center, false);
  assert.equal(hl.room, 0, '형광펜 밖(흰 바탕)으로 넓히지 않는다');
});

test('글자 크기 추정: 시험 그림 29덩어리 평균 오차 6% 안, 가장 큰 오차 11% 안 (Georgia 는 x 높이가 낮아 작게 나온다)', () => {
  const errs = [];
  for (const [name, items] of Object.entries(TRUTH)) {
    const r = run(name);
    for (const t of items) errs.push(Math.abs(blockAt(r, t.box).size - t.size) / t.size);
  }
  assert.equal(errs.length, 29);
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  assert.ok(mean < 0.06, `평균 ${(mean * 100).toFixed(1)}%`);
  assert.ok(Math.max(...errs) < 0.11, `최대 ${(Math.max(...errs) * 100).toFixed(1)}%`);
});

test('덮개는 원래 글자를 다 덮는다 (첫 글자 놓침 보정·한글 높이): 덮개 밖 바로 옆에 글자색 화소가 없다', () => {
  for (const name of Object.keys(TRUTH)) {
    const r = run(name);
    const bmp = decodePNG(fs.readFileSync(path.join(F, `${name}.png`)));
    for (const b of r.blocks.filter((x) => x.translate)) {
      // 덮개 왼쪽·오른쪽 2px 밖 열에 글자색에 가까운 화소가 있으면 삐져나온 것
      for (const x of [Math.floor(b.box.x) - 2, Math.ceil(b.box.x + b.box.w) + 1]) {
        let hits = 0;
        for (let y = Math.ceil(b.box.y); y < b.box.y + b.box.h; y++) {
          const i = (y * bmp.width + x) * 4;
          const p = [bmp.data[i + 2], bmp.data[i + 1], bmp.data[i]];
          if (ST.dist(p, b.color) < 0.25) hits++;
        }
        assert.ok(hits <= 1, `${name} "${b.text.slice(0, 20)}" x=${x} 에 원래 글자 ${hits}점`);
      }
    }
  }
});

test('줄: 먼 낱말(1.6×높이 넘게 떨어짐)은 자르고, 같은 줄 조각은 다시 합친다', () => {
  const w = (text, x, h = 20) => ({ text, x, y: 100, w: text.length * 10, h });
  const parts = ST.splitLine({ text: 'Camera access Change', words: [w('Camera', 0), w('access', 70), w('Change', 600)] });
  assert.deepEqual(parts.map((p) => p.text), ['Camera access', 'Change']);
  const merged = ST.mergeSegments([...ST.splitLine({ text: 'Gradients', words: [w('Gradients', 0)] }), ...ST.splitLine({ text: 'flow', words: [w('flow', 100)] })]);
  assert.deepEqual(merged.map((l) => l.text), ['Gradients flow']);
});

test('코드 줄·주석·목록 머리·한국어 판단', () => {
  for (const t of ['loss = model.loss(data)', 'for step in range(steps):', 'def train(model):', 'x = {a: [1, 2]};']) assert.equal(ST.kindOf(t), 'code', t);
  for (const t of ['# Train with plain gradient descent', '// fetch the data']) assert.equal(ST.kindOf(t), 'comment', t);
  for (const t of ['• first item', '1. Install', 'a) option']) assert.equal(ST.kindOf(t), 'list', t);
  for (const t of ['The model (shown above) works well.', 'Figure 2. Loss curve', 'Figure 3. (a) training loss; (b) validation loss', 'Results (see Table 2) improve.']) assert.equal(ST.kindOf(t), 'text', t);
  for (const t of ['model.update(-lr * model.grad(loss))', 'x = 1']) assert.equal(ST.kindOf(t), 'code', t);
  assert.equal(ST.isKorean('이미 한국어 문장 with API'), true);
  assert.equal(ST.isKorean('Mostly English 문장'), false);
});

test('OCR 글자 혼동 고치기: 소문자 낱말 속 0·1·5, tWO → two. 숫자만·숫자+단위는 그대로', () => {
  assert.equal(ST.fixOcr('# 100p over 0f the data'), '# loop over of the data');
  assert.equal(ST.fixOcr('are tWO ways tO go'), 'are two ways to go');
  assert.equal(ST.fixOcr('rate 50 that 1055 in 5ms for 10k users, 1st'), 'rate 50 that 1055 in 5ms for 10k users, 1st');
});

test('기억: 같은 글(공백만 다른 것)은 한 번만 옮기고, 12개씩 묶는다. 원문과 같은 번역은 덮지 않는다', () => {
  const blocks = Array.from({ length: 14 }, (_, i) => ({ key: ST.memoryKey(`line  ${i}`), translate: true }));
  blocks.push({ key: ST.memoryKey('line 0'), translate: true }, { key: 'code', translate: false });
  const memory = new Map([['line 1', '줄 1']]);
  const batches = ST.pending(blocks, memory);
  assert.deepEqual(batches.map((b) => b.length), [12, 1]);
  assert.ok(!batches.flat().includes('line 1'));
  assert.equal(ST.covers({ key: 'Goodfellow et al., 2016' }, 'Goodfellow  et al., 2016'), false);
  assert.equal(ST.covers({ key: 'Hello' }, '안녕'), true);
});

test('문단 끝에 걸린(창 위·아래 3pt 안) 문단은 번역하지 않는다', () => {
  const bitmap = { width: 400, height: 200, data: Buffer.alloc(400 * 200 * 4, 255) };
  const ocr = { lines: [{ text: 'Half visible line at the top', x: 10, y: 1, w: 300, h: 20, words: [] }, { text: 'Fully visible line', x: 10, y: 80, w: 200, h: 20, words: [] }] };
  const r = ST.analyze({ ocr, bitmap, scale: 1 });
  assert.deepEqual(r.blocks.map((b) => [b.cut, b.translate]), [[true, false], [false, true]]);
});

test('그리기 맞추기: 한글은 어절 단위로 줄바꿈, 긴 어절은 글자 단위, 안 들어가면 0.5pt 씩 60% 까지, 그 전에 오른쪽 빈자리부터', () => {
  const measure = (t) => [...t].length * 10;
  assert.deepEqual(P.wrap('가나다 라마 바사아자차카', 60, measure), ['가나다 라마', '바사아자차카']);
  assert.deepEqual(P.wrap('가나다 라마 바사', 50, measure), ['가나다', '라마 바사']);
  assert.deepEqual(P.wrap('가나다라마바사아', 30, measure), ['가나다', '라마바', '사아']);
  const block = { size: 10, lineGap: 1.25, box: { x: 0, y: 0, w: 50, h: 12 }, baseline: 9, room: 0 };
  const at = (t, s) => [...t].length * s;
  const f = P.fit(block, '가나다라마바사', 1, at); // 70 > 50: 줄여서 한 줄
  assert.ok(f.size < 10 && f.size >= 6 - 1e-9, `크기 ${f.size}`);
  const wide = P.fit({ ...block, room: 40 }, '가나다라마바사', 1, at); // 오른쪽이 비어 있으면 줄이지 않고 넓힌다
  assert.equal(wide.size, 10);
  assert.equal(wide.width, 70);
});

test('브라우저: 도구막대 아래 스크롤에 잘린 문단은 옮기지 않는다 (OCR 이 못 읽은 윗줄 조각이 경계 밑에 있다). 탭 제목·주소·다음 문단·그림 설명은 옮긴다', () => {
  const r = run('browser');
  const by = (re) => r.blocks.find((b) => re.test(b.text));
  assert.equal(by(/^sequences and hard/).cut, true);
  assert.equal(by(/^sequences and hard/).translate, false);
  assert.equal(by(/^The transformer/).translate, true);
  assert.equal(by(/You Need/).translate, true, '경계 위 탭 제목은 멀쩡하다');
  const cap = by(/^Figure 3/);
  assert.equal(cap.kind, 'text', '"(a) …; (b) …" 그림 설명은 코드가 아니다');
  assert.equal(cap.translate, true);
});

test('세로 축 이름(상자가 폭×0.9 보다 높다)은 옮기지 않고, 대문자·숫자가 많은 줄은 대문자 높이로 크기를 잰다', () => {
  const W = 300;
  const H = 300;
  const data = Buffer.alloc(W * H * 4, 255);
  // 검은 막대 하나: 높이 20 (40..60) — 소문자 줄이면 x 높이, 대문자 줄이면 대문자 높이로 본다
  for (let y = 40; y < 60; y++) for (let x = 20; x < 120; x++) { const i = (y * W + x) * 4; data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; }
  const bitmap = { width: W, height: H, data };
  const line = (text) => ({ lines: [{ text, x: 20, y: 36, w: 100, h: 28, words: [] }] });
  const lower = ST.analyze({ ocr: line('lower case words'), bitmap, scale: 1 }).blocks[0];
  const upper = ST.analyze({ ocr: line('NASA USA 2024'), bitmap, scale: 1 }).blocks[0];
  assert.ok(Math.abs(lower.size - 20 / 0.52) < 1.5 || lower.size <= 28 * 1.3, `소문자 ${lower.size}`);
  assert.ok(Math.abs(upper.size - 20 / 0.7) < 1.5, `대문자 ${upper.size}`);
  const axis = ST.analyze({ ocr: { lines: [{ text: 'Validation loss', x: 200, y: 40, w: 20, h: 150, words: [] }] }, bitmap, scale: 1 }).blocks[0];
  assert.equal(axis.vertical, true);
  assert.equal(axis.translate, false);
});

test('잘림 판단 (맥과 맞춤): 창 위 끝도 경계, 사이에 다른 인식 줄이 있으면 조각이 아니다, 경계선 자체는 3pt 떨어져 세지 않는다', () => {
  const W = 400;
  const H = 300;
  const make = (paint) => {
    const data = Buffer.alloc(W * H * 4, 255);
    paint((x0, x1, y0, y1) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * W + x) * 4; data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; }
    });
    return { width: W, height: H, data };
  };
  const para = { text: 'second line of a paragraph', x: 20, y: 40, w: 300, h: 20, words: [] };
  // 창 위 끝(경계) 바로 밑에 읽지 못한 글자 조각 (반쯤 잘린 윗줄의 아랫부분)
  const frag = make((fill) => { fill(20, 300, 8, 14); fill(20, 300, 44, 56); });
  assert.equal(ST.analyze({ ocr: { lines: [para] }, bitmap: frag, scale: 1 }).blocks[0].cut, true);
  // 그 자리에 다른 인식 줄이 있으면 그 줄이지 조각이 아니다
  const other = { text: 'A heading', x: 20, y: 6, w: 120, h: 10, words: [] };
  const r = ST.analyze({ ocr: { lines: [other, para] }, bitmap: frag, scale: 1 });
  assert.equal(r.blocks.find((b) => b.text.startsWith('second')).cut, false);
  // 도구막대 경계선(폭 전체 검은 선, y 50) 바로 밑 문단: 선 자체는 세지 않는다
  const bar = make((fill) => { fill(0, W, 50, 52); fill(20, 300, 74, 86); });
  const below = { text: 'first line below the toolbar', x: 20, y: 70, w: 300, h: 20, words: [] };
  assert.equal(ST.contentEdges(bar).top, 52);
  assert.equal(ST.analyze({ ocr: { lines: [below] }, bitmap: bar, scale: 1 }).blocks[0].cut, false);
});
