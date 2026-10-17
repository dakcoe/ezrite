'use strict';

// 키 저장·확인과 기능별 서비스·모델 고르기 (맥 App.swift saveKey·checkModel·defaultModel, MenuPopover FeatureRow)
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/providers');
const { DEFAULTS } = require('../lib/settings');
const { AIFailure } = require('../lib/ai');

const base = () => JSON.parse(JSON.stringify(DEFAULTS.ai));
const CLAUDE = ['claude-haiku-4-5-20251001', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-4-6', 'claude-sonnet-5-5'];

test('키 모양: 공백 없는 한 줄, 512자 이하. 아니면 안내 (키는 글에 넣지 않는다)', () => {
  assert.equal(P.keyShapeError('sk-ant-abc'), null);
  assert.equal(P.keyShapeError('a b'), '✕ 키 모양이 아닙니다 (공백 없이 한 줄)');
  assert.equal(P.keyShapeError('x'.repeat(513)), '✕ 키 모양이 아닙니다 (공백 없이 한 줄)');
});

test('defaultModel: 키 저장 때 정한 기본 → 없으면 받아 온 목록에서 고른다 → 없으면 빈 글', () => {
  const ai = base();
  assert.equal(P.defaultModel(ai, 'claude', 'explain'), '');
  ai.providerModels.claude = CLAUDE;
  assert.equal(P.defaultModel(ai, 'claude', 'explain'), 'claude-sonnet-5-5');
  ai.providerDefaults['claude.explain'] = 'claude-opus-5-5';
  assert.equal(P.defaultModel(ai, 'claude', 'explain'), 'claude-opus-5-5');
});

test('서비스 고르기: 키가 있는 서비스만. 바꾸면 그 서비스의 용도별 기본 모델, Groq 면 빈 모델 · 바로 불러 볼 것을 돌려준다', () => {
  const ai = base();
  ai.providerModels.claude = CLAUDE;
  const has = (p) => p === 'groq' || p === 'claude';
  let r = P.applyChoice(ai, { feature: 'translate', provider: 'claude' }, has);
  assert.equal(r.ai.translateProvider, 'claude');
  assert.equal(r.ai.translateModel, 'claude-haiku-5-5');
  assert.deepEqual(r.check, { provider: 'claude', model: 'claude-haiku-5-5', feature: 'translate' });
  r = P.applyChoice(r.ai, { feature: 'translate', provider: 'gemini' }, has); // 키 없음: 그대로
  assert.equal(r.ai.translateProvider, 'claude');
  assert.equal(r.check, null);
  r = P.applyChoice(r.ai, { feature: 'translate', provider: 'groq' }, has);
  assert.deepEqual([r.ai.translateProvider, r.ai.translateModel], ['groq', '']);
  assert.deepEqual(r.check, { provider: 'groq', model: '', feature: 'translate' });
});

test('모델 고르기: 지금 서비스의 순위 목록에 있는 이름만 (또는 지금 모델). 고르면 바로 불러 본다', () => {
  const ai = { ...base(), explainProvider: 'claude', explainModel: 'claude-sonnet-5-5', providerModels: { claude: CLAUDE } };
  const has = () => true;
  let r = P.applyChoice(ai, { feature: 'explain', model: 'claude-sonnet-4-6' }, has);
  assert.equal(r.ai.explainModel, 'claude-sonnet-4-6');
  assert.deepEqual(r.check, { provider: 'claude', model: 'claude-sonnet-4-6', feature: 'explain' });
  r = P.applyChoice(r.ai, { feature: 'explain', model: 'claude-opus-5-5' }, has); // 설명 순위 밖 (맥 목록에도 없다)
  assert.equal(r.ai.explainModel, 'claude-sonnet-4-6');
  r = P.applyChoice(r.ai, { feature: 'explain', model: 'evil"model' }, has);
  assert.equal(r.ai.explainModel, 'claude-sonnet-4-6');
  assert.equal(r.check, null);
  r = P.applyChoice({ ...base() }, { feature: 'explain', model: 'claude-opus-5-5' }, has); // Groq 는 모델을 고르지 않는다
  assert.equal(r.ai.explainModel, '');
});

test('featureView: 화면에 보낼 고르기 칸 — 쓸 수 있는 서비스와 순위대로 모델 (지금 모델이 목록 밖이면 맨 앞)', () => {
  const ai = { ...base(), explainProvider: 'claude', explainModel: 'claude-old', providerModels: { claude: CLAUDE } };
  const v = P.featureView(ai, 'explain', (p) => p !== 'openai');
  assert.deepEqual(v.providers, [{ value: 'groq', label: 'Groq' }, { value: 'claude', label: 'Claude' }, { value: 'gemini', label: 'Gemini' }]);
  assert.equal(v.provider, 'claude');
  assert.deepEqual(v.models, ['claude-old', 'claude-sonnet-5-5', 'claude-sonnet-4-6']);
  assert.equal(v.model, 'claude-old');
});

test('키를 지우면 그 서비스를 쓰던 기능은 Groq 로, 받아 둔 모델 목록도 지운다', () => {
  const ai = { ...base(), translateProvider: 'claude', translateModel: 'm', explainProvider: 'gemini', explainModel: 'g', providerModels: { claude: CLAUDE } };
  const out = P.afterRemove(ai, 'claude');
  assert.deepEqual([out.translateProvider, out.translateModel, out.explainProvider], ['groq', '', 'gemini']);
  assert.equal(out.providerModels.claude, undefined);
});

function fakeClient({ list = CLAUDE, listError = null, working = {} } = {}) {
  return {
    models: async () => { if (listError) throw listError; return list; },
    firstWorking: async (p, models, feature) => working[feature] ?? { model: null, reason: '맞는 모델이 없습니다' },
  };
}

test('verifyKey(Claude): 목록을 받고 용도별로 실제 답하는 모델을 정한다', async () => {
  const progress = [];
  const r = await P.verifyKey('claude', fakeClient({ working: {
    explain: { model: 'claude-sonnet-5-5', reason: null }, translate: { model: null, reason: '429 quota' },
  } }), (s) => progress.push(s));
  assert.deepEqual(progress, ['연결됨 · 쓸 수 있는 모델 확인 중']);
  assert.equal(r.status, '연결됨 · 화면 설명 claude-sonnet-5-5 · 번역 쓸 수 없음 (429 quota)');
  assert.deepEqual(r.models, CLAUDE);
  assert.deepEqual(r.defaults, { explain: 'claude-sonnet-5-5', translate: null });
});

test('withVerified: 확인이 끝난 때의 최신 설정에 반영한다. 그 서비스를 쓰는 기능이면 모델도 바꾼다', () => {
  const latest = { ...base(), explainProvider: 'claude', explainModel: '', translateProvider: 'gemini', translateModel: 'g',
    providerDefaults: { 'claude.translate': 'old' } };
  const out = P.withVerified(latest, 'claude', { models: CLAUDE, defaults: { explain: 'claude-sonnet-5-5', translate: null } });
  assert.deepEqual(out.providerModels.claude, CLAUDE);
  assert.equal(out.providerDefaults['claude.explain'], 'claude-sonnet-5-5');
  assert.equal('claude.translate' in out.providerDefaults, false);
  assert.equal(out.explainModel, 'claude-sonnet-5-5');
  assert.equal(out.translateModel, 'g'); // 다른 서비스를 쓰는 기능은 그대로
  assert.deepEqual(P.withVerified(latest, 'claude', { models: null, defaults: {} }), latest); // 확인 실패: 그대로
});

test('verifyKey(Groq): 모델 목록만 받아 "연결됨" (맥과 같다)', async () => {
  const r = await P.verifyKey('groq', fakeClient({ list: ['whisper-large-v3'] }), () => {});
  assert.equal(r.status, '연결됨');
  assert.deepEqual(r.models, ['whisper-large-v3']);
  assert.deepEqual(r.defaults, {});
});

test('verifyKey: 틀린 키·확인 실패는 그 이유를 상태로 (키는 저장된 채 둔다)', async () => {
  const r = await P.verifyKey('gemini', fakeClient({ listError: new AIFailure(401, '키가 맞지 않습니다') }), () => {});
  assert.deepEqual(r, { status: '✕ 키가 맞지 않습니다', models: null, defaults: {} });
});

test('checkLine: 모델 확인 결과 글 (맥 checkModel)', () => {
  assert.equal(P.checkLine(null), '✓ 쓸 수 있음');
  assert.equal(P.checkLine('404 model not found'), '✕ 쓸 수 없음 — 404 model not found');
});
