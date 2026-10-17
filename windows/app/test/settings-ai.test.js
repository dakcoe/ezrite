'use strict';

// 기능별 AI (맥 AppState translateProvider·translateModel·explainProvider·explainModel·providerModels·providerDefaults)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Settings = require('../lib/settings');

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-set-')), 'settings.json');

test('기본은 번역·화면 설명 모두 Groq, 모델은 비어 있다', () => {
  const s = Settings.load(file());
  assert.deepEqual(s.ai, {
    translateProvider: 'groq', translateModel: '', explainProvider: 'groq', explainModel: '',
    providerModels: {}, providerDefaults: {},
  });
  assert.deepEqual(Settings.DEFAULTS.ai, s.ai);
});

test('고른 서비스·모델, 서비스별 모델 목록, 용도별 기본 모델을 저장했다 다시 읽는다', () => {
  const f = file();
  const ai = {
    translateProvider: 'claude', translateModel: 'claude-haiku-5-5', explainProvider: 'gemini', explainModel: 'gemini-3.1-pro-preview',
    providerModels: { claude: ['claude-haiku-5-5', 'claude-sonnet-5-5'], gemini: ['gemini-3.1-pro-preview'] },
    providerDefaults: { 'claude.translate': 'claude-haiku-5-5', 'claude.explain': 'claude-sonnet-5-5' },
  };
  Settings.save(f, { ...Settings.DEFAULTS, ai });
  assert.deepEqual(Settings.load(f).ai, ai);
  assert.ok(!fs.readFileSync(f, 'utf8').match(/sk-|gsk_|AIza/)); // 키는 설정 파일에 없다
});

test('모르는 서비스·글 아닌 모델·틀린 목록은 버리고 기본값으로', () => {
  const f = file();
  fs.writeFileSync(f, JSON.stringify({ ai: {
    translateProvider: 'llama', translateModel: 5, explainProvider: 'openai', explainModel: 'gpt-6.1-sol',
    providerModels: { claude: ['a', 3, 'b'], evil: ['x'], gemini: 'nope' },
    providerDefaults: { 'claude.translate': 'a', 'claude.cook': 'b', 'evil.explain': 'c', 'gemini.explain': 4 },
  } }));
  assert.deepEqual(Settings.load(f).ai, {
    translateProvider: 'groq', translateModel: '', explainProvider: 'openai', explainModel: 'gpt-6.1-sol',
    providerModels: { claude: ['a', 'b'] }, providerDefaults: { 'claude.translate': 'a' },
  });
});
