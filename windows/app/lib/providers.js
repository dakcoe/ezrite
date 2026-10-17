'use strict';

// 키 저장·확인과 기능별 서비스·모델 고르기 (맥 App.swift saveKey·checkModel·defaultModel, MenuPopover FeatureRow).
// 상태(ai 설정)를 받아 새 상태를 돌려준다. 키 자체는 다루지 않는다 (keystore 와 AIClient 가 읽는다).

const AI = require('./ai');

const KEY_MAX = 512;
const BAD_SHAPE = '✕ 키 모양이 아닙니다 (공백 없이 한 줄)';
const FEATURE_LABEL = Object.freeze({ explain: '화면 설명', translate: '번역' });
const providerKey = (f) => `${f}Provider`;
const modelKey = (f) => `${f}Model`;

const clone = (ai) => ({
  ...ai, providerModels: { ...ai.providerModels }, providerDefaults: { ...ai.providerDefaults },
});

/** 붙여넣은 키가 키 모양인가. 아니면 안내 글 (키는 글에 넣지 않는다) */
function keyShapeError(trimmed) {
  return trimmed.length > KEY_MAX || /\s/.test(trimmed) ? BAD_SHAPE : null;
}

/** 서비스를 바꾸면 그 서비스에서 용도에 맞는 모델을 기본으로: 키 저장 때 정한 것 → 받아 온 목록에서 고른 것 → 빈 글 */
function defaultModel(ai, p, feature) {
  return ai.providerDefaults[`${p}.${feature}`] ?? AI.pick(ai.providerModels[p] ?? [], feature) ?? '';
}

/** 그 기능에서 고를 수 있는 모델: 순위대로, 지금 모델이 목록 밖이면 맨 앞 (맥 FeatureRow.models) */
function modelChoices(ai, feature) {
  const p = ai[providerKey(feature)];
  const list = AI.ranked(ai.providerModels[p] ?? [], feature);
  const m = ai[modelKey(feature)];
  return !m || list.includes(m) ? list : [m, ...list];
}

/**
 * 설정 화면에서 고른 것을 반영한다. choice: { feature, provider } 또는 { feature, model }.
 * hasKey(p): 키가 있는 서비스만 고를 수 있다 (Groq 는 늘). check: 바로 불러 볼 {provider, model, feature} 또는 null
 */
function applyChoice(ai, choice, hasKey) {
  const f = choice?.feature;
  if (!AI.FEATURES.includes(f)) return { ai, check: null };
  if (typeof choice.provider === 'string') {
    const p = choice.provider;
    if (!AI.isProvider(p) || (p !== 'groq' && !hasKey(p))) return { ai, check: null };
    const next = clone(ai);
    next[providerKey(f)] = p;
    next[modelKey(f)] = p === 'groq' ? '' : defaultModel(ai, p, f);
    return { ai: next, check: { provider: p, model: next[modelKey(f)], feature: f } };
  }
  if (typeof choice.model === 'string') {
    const p = ai[providerKey(f)];
    if (p === 'groq' || !modelChoices(ai, f).includes(choice.model)) return { ai, check: null };
    const next = clone(ai);
    next[modelKey(f)] = choice.model;
    return { ai: next, check: { provider: p, model: choice.model, feature: f } };
  }
  return { ai, check: null };
}

/** 화면에 보낼 고르기 칸 (키는 없고 있다/없다만) */
function featureView(ai, feature, hasKey) {
  return {
    providers: AI.PROVIDERS.filter((p) => p === 'groq' || hasKey(p)).map((p) => ({ value: p, label: AI.LABEL[p] })),
    provider: ai[providerKey(feature)],
    model: ai[modelKey(feature)],
    models: ai[providerKey(feature)] === 'groq' ? [] : modelChoices(ai, feature),
  };
}

/** 키를 지운 뒤: 그 서비스를 쓰던 기능은 Groq 로, 받아 둔 목록도 지운다 */
function afterRemove(ai, p) {
  const next = clone(ai);
  delete next.providerModels[p];
  for (const f of AI.FEATURES) {
    if (next[providerKey(f)] === p) {
      next[providerKey(f)] = 'groq';
      next[modelKey(f)] = '';
    }
  }
  return next;
}

/**
 * 키를 저장한 뒤 확인: 모델 목록을 받고(키 확인 겸), Groq 가 아니면 용도별로 실제로 답하는 모델을 정한다.
 * client: AIClient (models·firstWorking). onProgress(글): 중간 상태.
 * { status, models(실패면 null), defaults: { explain, translate } } — 설정에는 withVerified 로 반영한다 (그 사이 바뀐 고르기를 지키려고)
 */
async function verifyKey(p, client, onProgress = () => {}) {
  let models;
  try {
    models = await client.models(p);
  } catch (e) {
    return { status: `✕ ${e.message}`, models: null, defaults: {} };
  }
  if (p === 'groq') return { status: '연결됨', models, defaults: {} };
  onProgress('연결됨 · 쓸 수 있는 모델 확인 중');
  const parts = [];
  const defaults = {};
  let why = null;
  for (const f of ['explain', 'translate']) {
    const { model, reason } = await client.firstWorking(p, models, f);
    defaults[f] = model;
    if (!model) why = reason;
    parts.push(`${FEATURE_LABEL[f]} ${model ?? '쓸 수 없음'}`);
  }
  return { status: `연결됨 · ${parts.join(' · ')}${why ? ` (${why})` : ''}`, models, defaults };
}

/** verifyKey 결과를 (확인이 끝난 때의) 최신 설정에 반영한다. 그 서비스를 쓰는 기능이면 모델도 그것으로 */
function withVerified(ai, p, { models, defaults }) {
  if (!models) return ai;
  const next = clone(ai);
  next.providerModels[p] = models;
  for (const [f, model] of Object.entries(defaults)) {
    if (model) {
      next.providerDefaults[`${p}.${f}`] = model;
      if (next[providerKey(f)] === p) next[modelKey(f)] = model;
    } else {
      delete next.providerDefaults[`${p}.${f}`];
    }
  }
  return next;
}

/** 모델 확인 결과 한 줄 (맥 checkModel) */
const checkLine = (reason) => (reason == null ? '✓ 쓸 수 있음' : `✕ 쓸 수 없음 — ${reason}`);

module.exports = {
  KEY_MAX, BAD_SHAPE, keyShapeError, defaultModel, modelChoices, applyChoice, featureView, afterRemove, verifyKey, withVerified, checkLine,
};
