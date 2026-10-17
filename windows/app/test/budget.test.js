'use strict';

// 하루 토큰·하루 음성 시간 (맥 BudgetTests · ExplainBudgetTests · UsesLeftTests 이식) + 아래 줄 게이지 글
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Budget } = require('../lib/budget');
const Usage = require('../lib/usage');

const t0 = 1_800_000_000_000; // ms
const H = 3600 * 1000;

// --- 맥 BudgetTests ---

test('[mac BudgetTests] 쓴_만큼_차고_시간이_지나면_일정하게_빠진다', () => {
  const b = new Budget();
  b.note('m', 'tokens', 100_000, t0);
  assert.equal(b.used('m', 'tokens', t0), 100_000);
  assert.ok(Math.abs(b.used('m', 'tokens', t0 + 12 * H)) < 1); // 하루 20만 → 12시간이면 10만 회복
  assert.equal(b.used('m', 'tokens', t0 + 48 * H), 0); // 0 아래로 내려가지 않는다
});

test('[mac BudgetTests] 남은_비율은_모델들의_한도를_합쳐서_낸다', () => {
  const b = new Budget();
  b.note('a', 'audio', 28_800, t0);
  assert.equal(b.fraction(['a', 'b'], 'audio', t0), 0.5);
});

test('[mac BudgetTests] 게이지는_호출_횟수와_양_중_덜_남은_쪽을_따른다', () => {
  assert.equal(Usage.combined(0.9, 0.3), 0.3);
  assert.equal(Usage.combined(null, 0.7), 0.7);
  assert.equal(Usage.combined(0.4, null), 0.4);
  assert.equal(Usage.combined(null, null), null);
});

test('[mac BudgetTests] 저장했다_읽어도_같다', () => {
  const b = new Budget();
  b.note('m', 'tokens', 1234, t0);
  const back = Budget.fromJSON(JSON.parse(JSON.stringify(b)));
  assert.equal(back.used('m', 'tokens', t0), 1234);
});

// --- 맥 ExplainBudgetTests ---

test('[mac ExplainBudgetTests] 함께_쓰는_모델은_가장_적게_남은_쪽을_보인다', () => {
  const b = new Budget();
  b.note('vision', 'tokens', 2_000, t0);
  b.note('reason', 'tokens', 150_000, t0);
  assert.ok(Math.abs(b.lowest(['vision', 'reason'], 'tokens', t0) - 0.25) < 0.001);
  assert.ok(b.fraction(['vision', 'reason'], 'tokens', t0) > 0.5);
});

// --- 맥 UsesLeftTests ---

test('[mac UsesLeftTests] 남은_토큰을_한_번_평균으로_나눈다', () => {
  const b = new Budget();
  b.note('qwen', 'tokens', 52_000, t0);
  assert.equal(b.usesLeft('explain', 'qwen', t0), 40);
  assert.equal(b.usesLeft('ask', 'qwen', t0), 42);
});

test('[mac UsesLeftTests] 쓸_때마다_평균을_실제_양_쪽으로_고친다', () => {
  const b = new Budget();
  b.average('explain', 5_700);
  assert.ok(Math.abs(b.perUse('explain') - 4_300) < 1e-9);
  assert.equal(b.perUse('ask'), 3_500);
});

test('[mac UsesLeftTests] 시간이_지나면_한도가_차올라_횟수가_는다', () => {
  const b = new Budget();
  const then = 1_000_000_000;
  b.note('qwen', 'tokens', 200_000, then);
  assert.equal(b.usesLeft('explain', 'qwen', then), 0);
  assert.equal(b.usesLeft('explain', 'qwen', then + H), 2);
});

test('[mac UsesLeftTests] 예전_저장_파일도_읽힌다 (맥 usage.json 모양 그대로)', () => {
  const b = Budget.fromJSON({ rows: { 'qwen|tokens': [1000, 1792135734] } });
  assert.equal(b.perUse('explain'), 3_700);
  assert.equal(b.used('qwen', 'tokens', 1792135734 * 1000), 1000);
});

test('저장 파일: 없거나 깨졌으면 빈 기록, 저장하면 다음에 그대로', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-budget-'));
  try {
    const file = path.join(dir, 'Ezrite', 'usage.json');
    assert.equal(Budget.load(file).used('m', 'tokens', t0), 0);
    const b = new Budget();
    b.note('m', 'audio', 60, t0);
    b.average('ask', 4_000);
    b.save(file);
    const back = Budget.load(file);
    assert.equal(back.used('m', 'audio', t0), 60);
    assert.equal(back.perUse('ask'), 3_500 * 0.7 + 4_000 * 0.3);
    fs.writeFileSync(file, '{ 깨짐');
    assert.equal(Budget.load(file).used('m', 'audio', t0), 0);
    fs.writeFileSync(file, JSON.stringify({ rows: { 'm|audio': ['x', 1] }, avg: { explain: -5 } }));
    assert.equal(Budget.load(file).used('m', 'audio', t0), 0);
    assert.equal(Budget.load(file).perUse('explain'), 3_700);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('0 이하·숫자 아닌 양은 적지 않는다', () => {
  const b = new Budget();
  b.note('m', 'tokens', 0, t0);
  b.note('m', 'tokens', NaN, t0);
  b.average('explain', 0);
  assert.equal(b.used('m', 'tokens', t0), 0);
  assert.equal(b.perUse('explain'), 3_700);
});

// --- 아래 줄 게이지 (맥 UsageFooter) ---

test('[mac UsageFooter] 게이지 값은 호출 횟수와 하루 양 중 덜 남은 쪽, 마우스를 올리면 맥과 같은 글', () => {
  const b = new Budget();
  b.note('whisper-large-v3', 'audio', 28_800 * 0.5, t0); // 두 모델 합쳐 음성 75% 남음
  b.note('qwen/qwen3.8-27b', 'tokens', 52_000, t0); // 74% 남음 → 설명 40번, 질문 42번
  const f = Usage.footer({
    'whisper-large-v3': { remaining: 1800, limit: 2000 },
    'whisper-large-v3-turbo': { remaining: 2000, limit: 2000 },
    'qwen/qwen3.8-27b': { remaining: 500, limit: 1000 },
  }, b, t0);
  assert.equal(f.audio, 0.75);
  assert.equal(f.translate, 1);
  assert.equal(f.explain, 0.5);
  assert.equal(f.uses, '설명 40 · 질문 42');
  assert.equal(f.captions.audio, '받아쓰기 한도 75% 남음');
  assert.equal(f.captions.translate, '번역 한도 100% 남음');
  assert.equal(f.captions.explain, '화면 설명 50% 남음 · 설명 약 40번, 질문 약 42번');
});

test('[mac Usage.level] 절반 아래 노랑, 십분의 일 아래 빨강', () => {
  assert.equal(Usage.level(0.5), 'plenty');
  assert.equal(Usage.level(0.49), 'half');
  assert.equal(Usage.level(0.1), 'half');
  assert.equal(Usage.level(0.09), 'low');
});
