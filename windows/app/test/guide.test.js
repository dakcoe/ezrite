'use strict';
// 사용 가이드 창 크기와 그림 크게 보기
const test = require('node:test');
const assert = require('node:assert/strict');
const { guideSize, GUIDE_SIZE } = require('../lib/ui');
const { zoomAction } = require('../renderer/guide/zoom');

test('가이드 창: 760×860, 화면이 낮으면 작업 영역 높이에 맞추고 폭은 그대로', () => {
  assert.deepEqual(GUIDE_SIZE, { width: 760, height: 860 });
  assert.deepEqual(guideSize({ x: 0, y: 0, width: 1920, height: 1032 }), { width: 760, height: 860 });
  assert.deepEqual(guideSize({ x: 0, y: 0, width: 1366, height: 728 }), { width: 760, height: 728 - 40 });
  assert.deepEqual(guideSize({ x: 0, y: 0, width: 1280, height: 600 }), { width: 760, height: 560 });
  assert.equal(guideSize(null).height, 860, '화면을 모르면 기본 크기');
});

test('그림 크게 보기: 그림을 누르거나 Enter·Space 로 열고, 다시 누르거나 Esc 로 닫는다', () => {
  assert.equal(zoomAction({ open: false, type: 'click', onImage: true }), 'open');
  assert.equal(zoomAction({ open: false, type: 'click', onImage: false }), null);
  assert.equal(zoomAction({ open: false, type: 'keydown', key: 'Enter', onImage: true }), 'open');
  assert.equal(zoomAction({ open: false, type: 'keydown', key: ' ', onImage: true }), 'open');
  assert.equal(zoomAction({ open: false, type: 'keydown', key: 'Enter', onImage: false }), null);
  assert.equal(zoomAction({ open: true, type: 'click' }), 'close');
  assert.equal(zoomAction({ open: true, type: 'keydown', key: 'Escape' }), 'close');
  assert.equal(zoomAction({ open: true, type: 'keydown', key: 'Enter' }), 'close');
  assert.equal(zoomAction({ open: true, type: 'keydown', key: 'ArrowRight' }), 'swallow', '크게 보는 동안 장 넘기기 안 함');
  assert.equal(zoomAction({ open: false, type: 'keydown', key: 'Escape', onImage: true }), null);
});

const { containSize } = require('../renderer/guide/zoom');

test('크게 보기 크기: 세로로 긴 그림은 높이에, 가로로 긴 그림은 폭에 맞추고 비율을 지킨다', () => {
  // 창 760×860, 위 40 · 옆과 아래 16 여백 → 상자 728×804
  assert.deepEqual(containSize(760, 984, 728, 804), { width: Math.round(760 * 804 / 984), height: 804 }); // 지난 기록 (세로로 김)
  assert.deepEqual(containSize(1184, 600, 728, 804), { width: 728, height: Math.round(600 * 728 / 1184) }); // 설명 (가로로 김)
  assert.deepEqual(containSize(100, 100, 728, 804), { width: 728, height: 728 });
  assert.deepEqual(containSize(0, 0, 728, 804), { width: 0, height: 0 });
});

test('크게 보기 모양: 덮개는 스크롤되지 않고, 그림은 창 안 상자에 꼭 맞게 (contain) 놓인다', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'renderer', 'guide', 'guide.css'), 'utf8');
  const rule = (sel) => { const at = css.indexOf(sel + ' {'); return at < 0 ? '' : css.slice(at, css.indexOf('}', at)); };
  const cover = rule('.zoom');
  assert.match(cover, /position:\s*fixed/);
  assert.match(cover, /inset:\s*0/);
  assert.match(cover, /overflow:\s*hidden/);
  const img = rule('.zoom img');
  assert.match(img, /position:\s*absolute/);
  assert.match(img, /inset:\s*40px 16px 16px/);
  assert.match(img, /width:\s*calc\(100% - 32px\)/);
  assert.match(img, /height:\s*calc\(100% - 56px\)/);
  assert.match(img, /object-fit:\s*contain/);
});
