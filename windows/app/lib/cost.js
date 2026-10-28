'use strict';

// 이번 실행 AI 비용 (1.2.3, 맥과 같다). 팝업 아래 줄의 게이지와 작게 보기·종료 버튼 사이에 "$0.03" 처럼 보인다.
// Claude 는 아래 단가표(입력/출력 $ / 백만 토큰, 위에서부터 먼저 맞는 것), Groq 는 0(무료),
// GPT·Gemini 와 표에 없는 Claude 모델은 값을 모른다 → 금액 뒤에 "+". 0 이고 모르는 것도 없으면 숨긴다.

const CLAUDE = [
  ['fable', 10, 50],
  ['opus-5-5', 4, 20],
  ['opus', 5, 25],
  ['sonnet-5', 2, 10],
  ['sonnet', 3, 15],
  ['haiku-5-5', 0.1, 0.5],
  ['haiku', 1, 5],
];

/** { input, output } ($/백만 토큰) 또는 null(모름) */
function price(provider, model) {
  if (provider === 'groq') return { input: 0, output: 0 };
  if (provider !== 'claude') return null;
  const hit = CLAUDE.find(([name]) => String(model).includes(name));
  return hit ? { input: hit[1], output: hit[2] } : null;
}

const count = (n) => (Number.isFinite(n) && n > 0 ? n : 0);

class CostMeter {
  constructor() {
    this.dollars = 0;
    this.unknown = false; // 값을 모르는 서비스를 썼다
  }

  add(provider, model, input, output) {
    const p = price(provider, model);
    if (!p) {
      this.unknown = true;
      return;
    }
    this.dollars += (count(input) * p.input + count(output) * p.output) / 1e6;
  }

  /** "$0.03" · "$1.23+" · "<$0.01" · null(숨김) */
  label() {
    if (this.dollars <= 0 && !this.unknown) return null;
    const plus = this.unknown ? '+' : '';
    if (this.dollars > 0 && this.dollars < 0.005) return `<$0.01${plus}`;
    return `$${this.dollars.toFixed(2)}${plus}`;
  }

  caption() {
    return `이번 실행 AI 비용 (Claude 요금 기준${this.unknown ? ', GPT·Gemini 는 빠짐' : ''})`;
  }
}

module.exports = { price, CostMeter, CLAUDE };
