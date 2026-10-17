'use strict';

// 설정에서 고른 서비스로 옮긴다. 실패하면(키 오류 제외) Groq 로 대신한다.
// 실시간 받아쓰기와 다시 받아 적기가 함께 쓴다 (맥 Transcriber.swift Translation.run)

const AI = require('./ai');
const { GroqClient, translationInput, parseTranslation } = require('./groq');

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
    onNotice(`${AI.LABEL[provider]} 번역 실패 → Groq 로 대신했습니다`);
    return groq.translate(lines, context);
  }
}

module.exports = { translate };
