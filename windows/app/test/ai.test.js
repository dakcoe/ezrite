'use strict';

// 여러 AI 서비스(Claude, Gemini, GPT, Groq): 요청 본문 만들기와 응답 읽기.
// 맥 Tests/EzriteTests/ProviderTests.swift 전부 + 맥이 실제로 만든 요청·받은 응답(fixtures/mac-providers)과 글자 그대로 비교
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AI = require('../lib/ai');
const { GroqClient, translationInput, parseTranslation } = require('../lib/groq');
const G = require('../lib/groq-explain');

const JPEG = Buffer.from([0xFF, 0xD8, 0xFF]);
const FIX = path.join(__dirname, '..', '..', 'fixtures', 'mac-providers');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
// git 이 Windows 에서 CRLF 로 꺼내도 같게 본다
const fixtureText = (name) => fs.readFileSync(path.join(FIX, name), 'utf8').replace(/\r\n/g, '\n');
const SLIDE = fs.readFileSync(path.join(FIX, 'slide.jpg'));

// ── ProviderTests.swift ──

test('Claude 요청은 이미지를 base64 블록으로 붙이고 키는 헤더로 보낸다', () => {
  const req = AI.request('claude', { model: 'claude-sonnet-5-5', key: 'k', prompt: '설명해', image: JPEG, json: true, maxTokens: 900 });
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.headers['x-api-key'], 'k');
  assert.ok(req.headers['anthropic-version']);
  assert.equal(req.body.max_tokens, 900);
  const content = req.body.messages[0].content;
  const image = content.find((c) => c.type === 'image');
  assert.equal(image.source.media_type, 'image/jpeg');
  assert.equal(image.source.data, JPEG.toString('base64'));
});

test('번역처럼 단순한 요청은 Claude 생각 단계를 끈다', () => {
  const off = AI.request('claude', { model: 'm', key: 'k', prompt: 'p', image: null, json: false, maxTokens: 9, think: false });
  const on = AI.request('claude', { model: 'm', key: 'k', prompt: 'p', image: null, json: false, maxTokens: 9 });
  assert.equal(off.body.thinking?.type, 'disabled');
  assert.equal(on.body.thinking, undefined);
});

test('GPT 와 Gemini 는 같은 채팅 형식에 주소만 다르다', () => {
  const gpt = AI.request('openai', { model: 'm', key: 'k', prompt: 'p', image: JPEG, json: true, maxTokens: 500 });
  const gem = AI.request('gemini', { model: 'm', key: 'k', prompt: 'p', image: null, json: false, maxTokens: 500 });
  assert.equal(gpt.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(gem.url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(gpt.headers.Authorization, 'Bearer k');
  assert.equal(gpt.body.response_format?.type, 'json_object');
  const url = gpt.body.messages[0].content.find((c) => c.type === 'image_url')?.image_url?.url;
  assert.equal(url, `data:image/jpeg;base64,${JPEG.toString('base64')}`);
});

test('서비스마다 다른 응답에서 본문과 쓴 토큰을 읽는다', () => {
  const claude = { content: [{ type: 'text', text: '안녕' }], usage: { input_tokens: 10, output_tokens: 5 } };
  const chat = { choices: [{ message: { content: 'hi' } }], usage: { total_tokens: 42 } };
  assert.deepEqual(AI.reply('claude', claude), { text: '안녕', tokens: 15 });
  assert.deepEqual(AI.reply('openai', chat), { text: 'hi', tokens: 42 });
  assert.deepEqual(AI.reply('gemini', chat), { text: 'hi', tokens: 42 });
});

test('코드블록으로 감싼 JSON 도 벗겨서 읽는다', () => {
  assert.equal(AI.stripFences('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(AI.stripFences('설명입니다\n```\n{"a":1}\n```'), '{"a":1}');
  assert.equal(AI.stripFences('{"a":1}'), '{"a":1}');
});

test('모델 목록에서 용도에 맞는 기본 모델을 고른다', () => {
  const claude = ['claude-opus-5-5', 'claude-sonnet-4-6', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-haiku-5-5'];
  assert.equal(AI.pick(claude, 'explain'), 'claude-sonnet-5-5');
  assert.equal(AI.pick(claude, 'translate'), 'claude-haiku-5-5');
  assert.equal(AI.pick([], 'explain'), null);
});

test('Gemini 는 그림 생성·음성 모델을 빼고 버전 숫자로 고른다', () => {
  const gemini = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-3.1-pro-preview',
    'gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-3.8-flash-tts', 'gemini-3.8-live',
    'gemini-omni-flash-preview', 'gemini-nano-banana-2.1', 'nano-banana-pro-preview', 'gemma-4-31b-it'];
  assert.deepEqual(AI.ranked(gemini, 'explain').slice(0, 2), ['gemini-3.1-pro-preview', 'gemini-2.5-pro']);
  assert.deepEqual(AI.ranked(gemini, 'translate').slice(0, 3), ['gemini-3.8-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash']);
});

test('GPT 는 비싼 pro·코딩용·검색용·날짜 붙은 사본을 피한다', () => {
  const gpt = ['gpt-5.5', 'gpt-5.5-2026-04-23', 'gpt-5.5-pro', 'gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17',
    'gpt-5.3-codex', 'gpt-5-search-api', 'gpt-5.6-luna', 'gpt-5.2-chat-latest', 'gpt-4o-mini-tts'];
  assert.equal(AI.pick(gpt, 'explain'), 'gpt-5.5'); // luna 는 가벼운 등급이라 설명에 안 고른다
  assert.equal(AI.pick(gpt, 'translate'), 'gpt-5.6-luna');
});

test('GPT 새 별칭은 sol 을 화면 설명에, luna 를 번역에', () => {
  const gpt = ['gpt-5.5', 'gpt-5.4-mini', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra',
    'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-5.5-pro'];
  assert.equal(AI.pick(gpt, 'explain'), 'gpt-6.1-sol');
  assert.equal(AI.pick(gpt, 'translate'), 'gpt-6-luna');
  assert.ok(AI.ranked(gpt, 'explain').includes('gpt-6-astra')); // 별칭 모델은 목록에서 직접 고를 수 있다
});

test('Gemini 는 틀린 키에 400 을 줘도 키 오류로 본다', () => {
  const gemini = '{"error":{"code":400,"message":"Please pass a valid API key","status":"INVALID_ARGUMENT"}}';
  assert.equal(AI.keyRejected(400, gemini), true);
  assert.equal(AI.keyRejected(400, '{"error":{"message":"image too large"}}'), false);
  assert.equal(AI.keyRejected(401, ''), true);
});

test('키가 틀린 오류만 빼고는 Groq 로 대신 처리한다', () => {
  assert.equal(AI.shouldFallback(401), false);
  assert.equal(AI.shouldFallback(403), false);
  assert.equal(AI.shouldFallback(429), true);
  assert.equal(AI.shouldFallback(500), true);
  assert.equal(AI.shouldFallback(null), true); // 네트워크 오류
});

test('번역 요청 본문: 앞줄은 번호 없이 참고로 주고 옮길 줄만 번호를 붙인다', () => {
  const text = translationInput(['one at a time.', 'First, we look at all the tumors.'], ['the algorithm is going to look at the classes']);
  assert.ok(text.includes('the algorithm is going to look at the classes'));
  assert.ok(!text.includes('1. the algorithm'));
  assert.ok(text.includes('1. one at a time.'));
  assert.ok(text.includes('2. First, we look at all the tumors.'));
  assert.equal(translationInput(['Hello.'], []), '1. Hello.');
});

// ── 오류 설명·키 가리기 ──

test('오류 설명: error.message, 글자 error, Gemini 의 배열 감싸기', () => {
  assert.equal(AI.errorMessage('{"error":{"message":"bad"}}'), 'bad');
  assert.equal(AI.errorMessage('[{"error":{"message":"gem"}}]'), 'gem');
  assert.equal(AI.errorMessage('{"error":"plain"}'), 'plain');
  assert.equal(AI.errorMessage('<html>'), '');
});

test('redact: 여러 키를 모두 가리고, 빈 키는 무시한다', () => {
  assert.equal(AI.redact('a sk-ant-123 b gsk_9 c', ['sk-ant-123', 'gsk_9', '', null]), 'a *** b *** c');
});

// ── 맥이 실제로 만든 요청과 글자 그대로 같다 (fixtures/mac-providers) ──

const LINES = [{ id: 1, text: '10.3 Kernel PCA' }, { id: 2, text: 'Center the kernel matrix: K = HKH' }];
const TRANSCRIPT = ['So kernel PCA lets us do PCA in a high dimensional feature space.'];
const KEY = '<KEY>';

/** 맥 요청 파일과 같은 모양: url·method·headers·body. 헤더 이름은 소문자로 맞춘다 (HTTP 헤더는 대소문자를 가리지 않는다) */
function normalize(req) {
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]).sort());
  return { url: req.url, method: req.method, headers, body: JSON.parse(JSON.stringify(req.body)) };
}

const BUILD = {
  translate: (p, model) => AI.request(p, {
    model, key: KEY, prompt: `${GroqClient.TRANSLATE_PROMPT}\n\n${translationInput(['So kernel PCA lets us do PCA.', 'We center the kernel matrix.'], ['Last time we covered PCA.'])}`,
    image: null, json: false, maxTokens: AI.TRANSLATE_MAX_TOKENS, think: false,
  }),
  explain: (p, model) => AI.request(p, {
    model, key: KEY, prompt: G.unifiedPrompt(LINES, TRANSCRIPT), image: SLIDE, json: true, maxTokens: AI.EXPLAIN_MAX_TOKENS,
  }),
  'ask-retry-nothink': (p, model) => AI.request(p, {
    model, key: KEY, prompt: G.questionPrompt('H 가 왜 필요해?', [], '커널 행렬을 중심화합니다.', LINES, TRANSCRIPT),
    image: SLIDE, json: true, maxTokens: AI.EXPLAIN_MAX_TOKENS, think: false,
  }),
  check: (p, model) => AI.checkRequest(p, model, KEY),
};

for (const p of ['claude', 'openai', 'gemini']) {
  for (const kind of Object.keys(BUILD)) {
    const file = `request-${p}-${kind}.json`;
    test(`맥 요청과 같다: ${file}`, () => {
      const mac = fixture(file);
      const ours = normalize(BUILD[kind](p, mac.body.model));
      const want = normalize(mac);
      assert.deepEqual(ours, want);
    });
  }
}

// ── 맥이 받은 응답을 같은 결과로 읽는다 (response-* → parsed-*) ──

test('Claude 번역 응답 → 맥이 읽은 줄과 같다', () => {
  const r = AI.reply('claude', fixture('response-claude-translate-200.json'));
  const lines = parseTranslation(r.text, 2, { context: true });
  assert.equal(lines.map((t, i) => `${i + 1}. ${t}`).join('\n'), fixtureText('parsed-claude-translate.txt'));
  assert.equal(r.tokens, 172 + 70);
});

for (const kind of ['explain', 'ask']) {
  test(`Claude ${kind} 응답 → 코드블록을 벗긴 JSON 이 맥이 읽은 것과 같다`, () => {
    const r = AI.reply('claude', fixture(`response-claude-${kind}-200.json`));
    const parsed = fixtureText(`parsed-claude-${kind}.txt`);
    assert.equal(AI.stripFences(r.text), parsed);
    assert.doesNotThrow(() => JSON.parse(parsed));
  });
}

test('Claude 질문 응답: 생각(thinking) 블록은 빼고 text 만 잇는다', () => {
  const raw = fixture('response-claude-ask-200.json');
  assert.ok(raw.content.some((c) => c.type === 'thinking'));
  const text = raw.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  assert.equal(AI.reply('claude', raw).text, text);
  assert.ok(text.startsWith('{'));
});

test('Claude 틀린 키 401 → 키 오류, 읽은 글 없음 (parsed 가 비어 있다)', () => {
  const raw = fs.readFileSync(path.join(FIX, 'response-claude-badkey-401.json'), 'utf8');
  assert.equal(AI.keyRejected(401, raw), true);
  assert.equal(AI.errorMessage(raw), 'invalid x-api-key');
  assert.equal(fixtureText('parsed-claude-badkey.txt'), '');
});

test('Claude 모델 목록 → 이름순, 번역은 haiku-5-5·설명은 sonnet-5-5 (맥 사용자 설정과 같다)', () => {
  const list = AI.modelIds(fixture('response-claude-models.json'));
  assert.deepEqual(list, [...list].sort());
  assert.ok(list.includes('claude-haiku-5-5'));
  assert.equal(AI.pick(list, 'translate'), 'claude-haiku-5-5');
  assert.equal(AI.pick(list, 'explain'), 'claude-sonnet-5-5');
  assert.deepEqual(AI.modelIds({ data: [{ id: 'models/gemini-3.8-flash' }, { id: 'gemini-2.5-pro' }] }), ['gemini-2.5-pro', 'gemini-3.8-flash']);
});
