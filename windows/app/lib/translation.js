'use strict';

// 설정에서 고른 서비스로 옮긴다. 실패하면(키 오류 제외) Groq 로 대신한다.
// 실시간 받아쓰기와 다시 받아 적기가 함께 쓴다 (맥 Transcriber.swift Translation.run)

const AI = require('./ai');
const { GroqClient, translationInput, parseTranslation, SCREEN_MODELS } = require('./groq');
const { SCREEN_PROMPT } = require('./screentx');
const log = require('./applog');

/**
 * lines: 옮길 줄, context: 바로 앞 줄 (참고로만). provider·model: 설정의 번역 서비스.
 * groq.translate(lines, context), ai.complete(p, opts), onNotice(글)
 */
async function translate(lines, context, { provider, model, groq, ai, onNotice = () => {} }) {
  if (provider === 'groq' || !AI.isProvider(provider) || !model) return groq.translate(lines, context);
  const input = translationInput(lines, context);
  try {
    const out = await ai.complete(provider, {
      model, prompt: `${GroqClient.TRANSLATE_PROMPT}\n\n${input}`, json: false, maxTokens: AI.TRANSLATE_MAX_TOKENS, think: false,
    });
    return parseTranslation(out, lines.length, { context: context.length > 0 });
  } catch (e) {
    if (!AI.fallsBack(e)) throw e;
    log.warn('번역', `${AI.LABEL[provider]} ${lines.length}줄 실패 → Groq: ${log.err(e)}`);
    onNotice(`${AI.LABEL[provider]} 번역 실패 → Groq 로 대신했습니다`);
    return groq.translate(lines, context);
  }
}

/**
 * 화면 번역 (실험 기능): 설정의 번역 서비스로 옮기고, 실패하면(키 오류 제외) Groq(120b → qwen)로 대신한다 (맥과 같다).
 * 다른 서비스는 지시와 번호 목록이 한 메시지라, 목록 바로 앞에 "모두 N개" 머리말을 붙인다 — Haiku 가 화면 글의 "1 Getting started"
 * 같은 줄과 헷갈려 1번 하나만 돌려줬다 (맥 실측). 답이 길어서 출력 한도 max(2000, 문단 수 × 200)
 */
async function translateScreen(texts, { provider, model, groq, ai, onNotice = () => {} }) {
  const viaGroq = () => groq.translate(texts, [], { prompt: SCREEN_PROMPT, models: SCREEN_MODELS });
  if (provider === 'groq' || !AI.isProvider(provider) || !model) return viaGroq();
  const input = `Items to translate — all ${texts.length} of them, numbered 1 to ${texts.length}:\n${translationInput(texts, [])}`;
  try {
    const out = await ai.complete(provider, {
      model, prompt: `${SCREEN_PROMPT}\n\n${input}`, json: false, maxTokens: Math.max(AI.TRANSLATE_MAX_TOKENS, texts.length * 200), think: false,
    });
    return parseTranslation(out, texts.length);
  } catch (e) {
    if (!AI.fallsBack(e)) throw e;
    log.warn('화면 번역', `${AI.LABEL[provider]} ${texts.length}문단 실패 → Groq: ${log.err(e)}`);
    onNotice(`${AI.LABEL[provider]} 화면 번역 실패 → Groq 로 대신했습니다`);
    return viaGroq();
  }
}

module.exports = { translate, translateScreen };
