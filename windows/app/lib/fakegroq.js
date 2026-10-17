'use strict';

// 개발용: EZRITE_FAKE_GROQ=1 이면 GroqClient 에 이 가짜 fetch 를 넣는다. 네트워크에 나가지 않고
// 정해 둔 문장을 돌려주어 키 없이 받아쓰기 화면을 확인한다. 실제 Groq 응답과 같은 모양(verbose_json,
// 채팅 choices, 남은 요청 수 헤더)으로 만든다.

const { GroqClient } = require('./groq');

/** [원문, 번역] — 맥 홍보 화면에 쓰던 강의 말투 */
const SAMPLE_LINES = Object.freeze([
  ["Today we're going to talk about how neural networks actually learn from data.", '오늘은 신경망이 데이터에서 실제로 어떻게 배우는지 이야기해 보겠습니다.'],
  ['The key idea is gradient descent: we nudge every weight a little in the direction that lowers the loss.', '핵심은 경사 하강법입니다. 손실을 줄이는 쪽으로 모든 가중치를 조금씩 움직입니다.'],
  ['If the learning rate is too large, the loss bounces around and never settles.', '학습률이 너무 크면 손실이 오르내리기만 하고 자리를 잡지 못합니다.'],
  ['So in practice we start small and use a schedule that decays it over time.', '그래서 실제로는 작게 시작하고 시간이 갈수록 줄여 가는 일정을 씁니다.'],
  ["Let's look at the plot on the slide. The blue line is the training loss.", '슬라이드의 그래프를 보죠. 파란 선이 학습 손실입니다.'],
  ['Notice how the validation loss starts going up again after epoch twenty.', '검증 손실이 스무 번째 에폭 뒤로 다시 오르는 것을 보세요.'],
  ["That's overfitting, and next week we'll see a few ways to prevent it.", '그게 과적합이고, 다음 주에는 그걸 막는 몇 가지 방법을 보겠습니다.'],
]);

const TRANSLATIONS = new Map(SAMPLE_LINES);

/** "설명해줘" 요청(JSON 답): 프롬프트의 화면 글자 줄 번호로 앞의 세 줄을 짚는 정해 둔 설명 (그림 없이 화면 표시 확인용) */
function explainReply(prompt) {
  const section = /Text lines on screen \(id: text\):\n([\s\S]*?)(?:\n\n|$)/.exec(prompt)?.[1] ?? '';
  const lines = section.split('\n').map((l) => /^(\d+): (.*)$/.exec(l)).filter(Boolean).map(([, id, text]) => ({ id: Number(id), text }));
  const picked = lines.slice(0, 3);
  const marks = picked.map((l) => ({ id: l.id, note: `(예시 설명) ‘${l.text}’ 가 지금 다루는 내용입니다.` }));
  if (prompt.includes('The student now asks:')) {
    return { answer: '(예시 답) 화면의 첫 줄을 다시 짚었습니다.\n\n가짜 Groq 응답이라 내용은 정해져 있습니다.', marks: marks.slice(0, 1), visuals: [] };
  }
  return {
    marks,
    summary: '(예시 설명) 가짜 Groq 응답입니다. 화면에서 읽은 글자 앞쪽 줄을 짚어 표시가 제자리에 그려지는지 확인합니다.',
    visuals: [{ type: 'steps', title: '확인할 것', items: ['짚은 줄에 주황 상자', '장면마다 번호가 바뀜', '전체 보기에서 ①②③'] }],
    scenes: [
      { say: '첫 번째로 짚은 줄입니다.', focus: picked.slice(0, 1).map((l) => l.id), arrow: null, visual: 0, reveal: 1 },
      { say: '두 번째 줄과 이어 봅니다.', focus: picked.slice(1, 2).map((l) => l.id),
        arrow: picked.length > 1 ? { from: picked[0].id, to: picked[1].id } : null, visual: 0, reveal: 2 },
      { say: '세 번째 줄까지 모두 짚었습니다.', focus: picked.slice(2, 3).map((l) => l.id), arrow: null, visual: 0, reveal: 3 },
    ],
  };
}

function respond(body, limit, remaining, delayMs) {
  const res = new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-ratelimit-limit-requests': String(limit),
      'x-ratelimit-remaining-requests': String(remaining),
    },
  });
  return new Promise((r) => setTimeout(() => r(res), delayMs));
}

/** 가짜 fetch. delayMs: 응답까지 걸리는 시간 (실제처럼 "받아 적는 중…"이 잠깐 보이게) */
function fakeFetch({ delayMs = 400 } = {}) {
  let n = 0;
  const left = { audio: 2000, chat: 1000 };
  return async (url, init) => {
    if (url === GroqClient.TRANSCRIBE_URL) {
      const [text] = SAMPLE_LINES[n % SAMPLE_LINES.length];
      n += 1;
      left.audio -= 1;
      return respond({
        text, duration: 6,
        segments: [{ text: ` ${text}`, start: 0, end: 6, no_speech_prob: 0.01 }],
      }, 2000, left.audio, delayMs);
    }
    if (url === GroqClient.CHAT_URL) {
      // 요청 본문의 "N. 원문" 줄(GroqClient.translationInput 형식)을 읽어 같은 번호로 돌려준다
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.response_format) {
        const msg = body.messages?.[0]?.content;
        const prompt = Array.isArray(msg) ? msg.find((c) => c.type === 'text')?.text ?? '' : String(msg ?? '');
        left.chat -= 1;
        return respond({ choices: [{ message: { content: JSON.stringify(explainReply(prompt)) } }], usage: { total_tokens: 900 } },
          1000, left.chat, delayMs);
      }
      const input = body.messages?.find((m) => m.role === 'user')?.content ?? '';
      const lines = String(input).split('\n')
        .map((l) => /^(\d+)\. (.*)$/.exec(l))
        .filter(Boolean)
        .map(([, num, text]) => `${num}. ${TRANSLATIONS.get(text) ?? `(예시 번역) ${text}`}`);
      left.chat -= 1;
      return respond({ choices: [{ message: { content: lines.join('\n') } }], usage: { total_tokens: 120 } },
        1000, left.chat, delayMs);
    }
    throw new Error(`가짜 Groq 는 ${url} 을 받지 않습니다`);
  };
}

module.exports = { fakeFetch, SAMPLE_LINES };
