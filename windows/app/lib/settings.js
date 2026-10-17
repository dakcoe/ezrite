'use strict';

// 다음 실행 때도 그대로 둘 설정 (맥 AppState 의 UserDefaults 자리). %APPDATA%\Ezrite\settings.json
// 키는 여기 두지 않는다 (keystore.js). 파일이 깨졌거나 값이 틀리면 그 값만 기본값으로 돌린다.

const fs = require('node:fs');
const path = require('node:path');
const { PROVIDERS, FEATURES } = require('./ai');

const LANGUAGES = ['한국어', 'English', '日本語'];
const THEMES = ['system', 'light', 'dark']; // 화면 테마 (설정 → 옵션)
const theme = (v) => (THEMES.includes(v) ? v : 'system');
// 맥은 길이 제한이 없다. 설명 요청마다 들어가므로 아주 긴 글은 잘라 둔다
const GUIDE_MAX = 4000;
const guide = (v) => (typeof v === 'string' ? v.slice(0, GUIDE_MAX) : '');

// 기능별 AI: 번역·화면 설명마다 서비스와 모델 (맥 translateProvider·explainModel 등). 키는 여기 두지 않는다
const AI_DEFAULTS = Object.freeze({
  translateProvider: 'groq', translateModel: '', explainProvider: 'groq', explainModel: '',
  providerModels: Object.freeze({}), providerDefaults: Object.freeze({}),
});
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const provider = (v) => (PROVIDERS.includes(v) ? v : 'groq');
const str = (v) => (typeof v === 'string' ? v : '');
/** 서비스 → 모델 이름 목록 (키 확인 때 받아 온 것) */
function models(v) {
  const out = {};
  if (!isObj(v)) return out;
  for (const p of PROVIDERS) if (Array.isArray(v[p])) out[p] = v[p].filter((m) => typeof m === 'string');
  return out;
}
/** "서비스.용도" → 키 저장 때 실제로 불러 보고 정한 모델 */
function defaults(v) {
  const out = {};
  if (!isObj(v)) return out;
  for (const p of PROVIDERS) for (const f of FEATURES) if (typeof v[`${p}.${f}`] === 'string') out[`${p}.${f}`] = v[`${p}.${f}`];
  return out;
}
function ai(v) {
  const a = isObj(v) ? v : {};
  return {
    translateProvider: provider(a.translateProvider), translateModel: str(a.translateModel),
    explainProvider: provider(a.explainProvider), explainModel: str(a.explainModel),
    providerModels: models(a.providerModels), providerDefaults: defaults(a.providerDefaults),
  };
}

const DEFAULTS = Object.freeze({
  language: '한국어',
  sourceId: null,
  notesFolder: '', // 빈 글이면 기본 위치 (notes.defaultDir)
  userGuide: '', // AI 지침: ✨ 설명과 질문 답에 함께 들어간다 (맥 userGuide)
  theme: 'system',
  welcomed: false, // 처음 한 번 팝업과 사용 가이드를 보여줬나 (맥 welcomed)
  options: Object.freeze({ autoTranslate: true, askBeforeRecord: true, includeMic: false }),
  ai: AI_DEFAULTS,
});

function load(file) {
  let raw = {};
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) raw = v;
  } catch {
    // 없거나 깨짐: 기본값
  }
  const options = { ...DEFAULTS.options };
  for (const k of Object.keys(options)) {
    if (typeof raw.options?.[k] === 'boolean') options[k] = raw.options[k];
  }
  return {
    language: LANGUAGES.includes(raw.language) ? raw.language : DEFAULTS.language,
    sourceId: typeof raw.sourceId === 'string' && raw.sourceId ? raw.sourceId : null,
    notesFolder: typeof raw.notesFolder === 'string' ? raw.notesFolder : '',
    userGuide: guide(raw.userGuide),
    theme: theme(raw.theme),
    welcomed: raw.welcomed === true,
    options,
    ai: ai(raw.ai),
  };
}

/** 임시 파일에 쓰고 바꿔 끼운다 */
function save(file, settings) {
  const out = {
    language: settings.language ?? DEFAULTS.language,
    sourceId: settings.sourceId ?? null,
    notesFolder: settings.notesFolder ?? '',
    userGuide: guide(settings.userGuide),
    theme: theme(settings.theme),
    welcomed: settings.welcomed === true,
    options: { ...DEFAULTS.options, ...settings.options },
    ai: ai(settings.ai),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { DEFAULTS, LANGUAGES, THEMES, GUIDE_MAX, load, save };
