'use strict';

// 다음 실행 때도 그대로 둘 설정 (맥 AppState 의 UserDefaults 자리). %APPDATA%\Ezrite\settings.json
// 키는 여기 두지 않는다 (keystore.js). 파일이 깨졌거나 값이 틀리면 그 값만 기본값으로 돌린다.

const fs = require('node:fs');
const path = require('node:path');

const LANGUAGES = ['한국어', 'English', '日本語'];
const THEMES = ['system', 'light', 'dark']; // 화면 테마 (설정 → 옵션)
const theme = (v) => (THEMES.includes(v) ? v : 'system');
// 맥은 길이 제한이 없다. 설명 요청마다 들어가므로 아주 긴 글은 잘라 둔다
const GUIDE_MAX = 4000;
const guide = (v) => (typeof v === 'string' ? v.slice(0, GUIDE_MAX) : '');

const DEFAULTS = Object.freeze({
  language: '한국어',
  sourceId: null,
  notesFolder: '', // 빈 글이면 기본 위치 (notes.defaultDir)
  userGuide: '', // AI 지침: ✨ 설명과 질문 답에 함께 들어간다 (맥 userGuide)
  theme: 'system',
  welcomed: false, // 처음 한 번 팝업과 사용 가이드를 보여줬나 (맥 welcomed)
  options: Object.freeze({ autoTranslate: true, askBeforeRecord: true, includeMic: false }),
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
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { DEFAULTS, LANGUAGES, THEMES, GUIDE_MAX, load, save };
