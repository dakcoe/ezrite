'use strict';

// 하루 토큰(TPD)·하루 음성 시간(ASD). 맥 Usage.swift 의 Budget 이식.
// Groq 는 이 둘을 응답 헤더로 알려주지 않아 앱이 직접 센다. 쓴 양은 응답에 실린 값(채팅 usage.total_tokens,
// 받아쓰기 duration)이고 추정이 아니다. 한도는 자정에 초기화되지 않고 24시간에 걸쳐 일정하게 회복되므로
// "지금 찬 양 + 적은 시각"만 둔다. 저장 모양은 맥 usage.json 과 같다 ({rows:{"모델|종류":[양, 초]}, avg})

const fs = require('node:fs');
const path = require('node:path');

/** 무료 등급 하루 상한: 토큰 20만, 음성 28,800초(8시간) */
const CAP = Object.freeze({ tokens: 200_000, audio: 28_800 });
const WINDOW = 24 * 3600; // 초
/** 처음 평균: 쉬운·어려운 화면에서 잰 값의 가운데 (설명 3,000~4,400, 질문 3,000~4,000) */
const FIRST_GUESS = Object.freeze({ explain: 3_700, ask: 3_500 });

const key = (model, kind) => `${model}|${kind}`;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

class Budget {
  constructor() {
    this.rows = {}; // "모델|종류" → [찬 양, 그때 시각(초)]
    this.avg = {}; // 설명·질문 한 번에 쓴 토큰의 평균
  }

  static cap(kind) {
    return CAP[kind];
  }

  /** 지금 찬 양. 마지막 기록 뒤 흐른 시간만큼 빠지고, 0 아래로는 내려가지 않는다 */
  used(model, kind, now = Date.now()) {
    const r = this.rows[key(model, kind)];
    if (!r) return 0;
    const rate = CAP[kind] / WINDOW;
    return Math.max(0, r[0] - rate * (now / 1000 - r[1]));
  }

  note(model, kind, amount, now = Date.now()) {
    if (!finite(amount) || amount <= 0 || !CAP[kind]) return;
    this.rows[key(model, kind)] = [this.used(model, kind, now) + amount, now / 1000];
  }

  /** 번갈아 쓰는 모델들의 남은 비율(0~1) */
  fraction(models, kind, now = Date.now()) {
    const cap = CAP[kind] * models.length;
    const used = models.reduce((n, m) => n + Math.min(CAP[kind], this.used(m, kind, now)), 0);
    return Math.max(0, (cap - used) / cap);
  }

  /** 함께 써야 하는 모델들(하나라도 바닥나면 기능이 멈춘다)의 남은 비율: 가장 적게 남은 쪽 */
  lowest(models, kind, now = Date.now()) {
    return models.length ? Math.min(...models.map((m) => this.fraction([m], kind, now))) : 1;
  }

  perUse(use) {
    return this.avg[use] ?? FIRST_GUESS[use];
  }

  /** 실제로 쓴 양 쪽으로 평균을 고친다 (최근 것에 30%) */
  average(use, tokens) {
    if (!finite(tokens) || tokens <= 0 || !(use in FIRST_GUESS)) return;
    this.avg[use] = this.perUse(use) * 0.7 + tokens * 0.3;
  }

  /** 남은 한도로 몇 번 더 할 수 있나. 한도는 24시간에 걸쳐 차오르니 시간이 지나면 는다 */
  usesLeft(use, model, now = Date.now()) {
    const left = CAP.tokens - Math.min(CAP.tokens, this.used(model, 'tokens', now));
    return Math.floor(left / this.perUse(use));
  }

  toJSON() {
    return { rows: this.rows, avg: this.avg };
  }

  /** 맥 파일 모양도 읽는다. 틀린 줄은 버린다 */
  static fromJSON(obj) {
    const b = new Budget();
    const rows = obj && typeof obj === 'object' ? obj.rows : null;
    if (rows && typeof rows === 'object') {
      for (const [k, v] of Object.entries(rows)) {
        if (Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1])) b.rows[k] = [v[0], v[1]];
      }
    }
    const avg = obj && typeof obj === 'object' ? obj.avg : null;
    if (avg && typeof avg === 'object') {
      for (const use of Object.keys(FIRST_GUESS)) if (finite(avg[use]) && avg[use] > 0) b.avg[use] = avg[use];
    }
    return b;
  }

  static load(file) {
    try {
      return Budget.fromJSON(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return new Budget();
    }
  }

  /** 임시 파일에 쓰고 바꿔 끼운다 */
  save(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this));
    fs.renameSync(tmp, file);
  }
}

module.exports = { Budget, CAP, WINDOW, FIRST_GUESS };
