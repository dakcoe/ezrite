'use strict';

// "설명해줘" 한 번의 흐름 (맥 ExplainUI.swift Explainer): 화면 찍기 → 글자 읽기 → Groq → 화면 표시 + 설명 카드.
// 창·화면 찍기·글자 읽기는 main.js 가 넣어 준다 (여기는 Electron 을 모른다).
//   grab({ display, full }) → { display, bitmap: {width,height,data BGRA}, png(), jpeg(maxWidth) }
//     display 가 null 이면 마우스가 있는 화면. full=false 는 지켜보기용 작은 사진
//   ocr(png) → helper ocr 출력 JSON
//   createCard({ onClose, onAsk, onScene }) → { show(display, avoid), render(p), answer(p), devAsk(q), close() }
//   createOverlay(display, model) → { update(model), hide(), show(), close() }
//   dock: 화면 나누기 (1.2.1, 맥 WindowDock). dock() → 창을 줄인 화면(display) 또는 null(전체 화면·실패), restore()

const { EventEmitter } = require('node:events');
const E = require('./explain');
const G = require('./groq-explain');
const AI = require('./ai');

const LOADING_READ = '화면을 읽는 중…';
const LOADING_MAKE = '설명을 만드는 중…';
const ANSWER_FAILED = '답을 읽지 못했습니다. 다시 물어봐 주세요.';
const JPEG_WIDTH = 1280; // 이미지 토큰은 크기와 상관없이 한 장에 약 1,800 (맥 실측)
const WATCH_MS = 400;
const WATCH_HIDDEN_MS = 600;

class Explainer extends EventEmitter {
  // ai: Claude·Gemini·GPT 호출 (lib/ai.js AIClient). context() 의 provider·model 이 Groq 가 아니면 그쪽에 묻는다
  constructor({ groq, ai = null, onNotice = () => {}, grab, ocr, createCard, createOverlay, context, popupFrame = () => null,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)), devQuestion = null, askDelay = 6000, onUsed = () => {}, watch = true,
    dock = null }) {
    super();
    // watch=false: 표시를 그린 뒤 화면을 지켜보지 않는다 (EZRITE_CAPTURABLE 녹화용 — 찍을 때마다 카드·표시를 빼서 깜박인다)
    Object.assign(this, { groq, ai, onNotice, grab, ocr, createCard, createOverlay, context, popupFrame, sleep, devQuestion, askDelay, onUsed, watch, dock });
    this.busy = false;
    this.card = null;
    this.overlay = null;
    this.model = null;
    this.display = null; // 설명을 받은 화면 (질문할 때 다시 찍는다)
    this.explanation = '';
    this.history = [];
    this.watchToken = null;
    this.watching = Promise.resolve();
  }

  /** 설명·질문을 Groq 가 아닌 서비스에 묻나 (모델이 비면 Groq) */
  usesOther(provider, model) {
    return Boolean(this.ai) && provider !== 'groq' && AI.isProvider(provider) && Boolean(model);
  }

  setBusy(b) {
    this.busy = b;
    this.emit('busy', b);
  }

  ensureCard() {
    if (!this.card) {
      this.card = this.createCard({
        onClose: () => this.clear({ closeCard: false }),
        onAsk: (q) => this.ask(q),
        onScene: (i) => this.scene(i),
      });
    }
    return this.card;
  }

  /**
   * 화면 글자 줄. 읽지 못하면(helper 오류) 빈 목록 — 설명·질문은 그림만으로 계속하고 ①②③ 표시만 빠진다 (맥 1.1.4 readText).
   * helper 가 먼저 작게 다시 그려 한 번 더 읽어 본다 (win_ocr.rs)
   */
  async lines(png) {
    let ocr = null;
    try {
      ocr = await this.ocr(png);
    } catch {
      // 오류로 멈추지 않는다
    }
    this.lastOcr = ocr;
    return E.linesFromOcr(ocr);
  }

  async run() {
    if (this.busy) return;
    this.setBusy(true);
    try {
      this.hideMarks();
      const card = this.ensureCard();
      this.history = [];
      this.explanation = '';
      const { transcript, guide, provider, model, split } = this.context();
      try {
        // 화면 나누기: 보던 창을 왼쪽으로 줄이고 카드를 오른쪽에 붙인 뒤 찍는다 (줄인 뒤 화면이라 표시 자리가 맞는다).
        // 못 붙이면(전체 화면·helper 오류) 예전처럼 마우스 화면에 떠 있는 카드
        const docked = split && this.dock ? await this.dock.dock().catch(() => null) : null;
        const shot = await this.grab({ display: docked, full: true });
        this.display = shot.display;
        card.show(shot.display, this.popupFrame(), docked != null);
        card.render({ loading: LOADING_READ });
        const lines = await this.lines(shot.png());
        const hint = E.needsKoreanOcrHint(this.lastOcr) ? E.OCR_KO_HINT : null;
        card.render({ loading: LOADING_MAKE });
        const jpeg = shot.jpeg(JPEG_WIDTH);
        const args = { jpeg, lines, transcript, guide, onUsed: this.onUsed };

        // 다른 서비스: 한 번에 묻는다. Groq 규칙·글자 섞임 고치기는 붙이지 않는다 (맥과 같다). 움직이는 그림 안내는 여기만 (1.2.1)
        if (this.usesOther(provider, model)) {
          try {
            const text = await this.ai.complete(provider, {
              model, prompt: G.unifiedPrompt(lines, transcript, guide, true), image: jpeg, json: true, maxTokens: AI.EXPLAIN_MAX_TOKENS,
            });
            this.present(card, lines, shot, text, { data: text }, hint);
            return;
          } catch (e) {
            if (!AI.fallsBack(e)) throw e;
            this.onNotice(`${AI.LABEL[provider]} 설명 실패 → Groq 로 대신했습니다`);
          }
        }

        // qwen 한 번으로. 실패하거나 빈 답이면 두 모델에 나눠 묻는다
        const data = await G.explainUnified(this.groq, args).catch(() => null);
        if (data != null && (E.marks(data, lines).length || E.visuals(data).summary)) {
          this.present(card, lines, shot, data, { data }, hint);
          return;
        }
        const [picked, visuals] = await Promise.all([
          G.explainMarks(this.groq, args).catch(() => null), // 표시가 실패해도 설명 카드는 보여준다
          G.explainVisuals(this.groq, args).then((d) => ({ data: d }), (error) => ({ error })),
        ]);
        this.present(card, lines, shot, picked, visuals, hint);
      } catch (e) {
        card.render({ error: e.message });
      }
    } finally {
      this.setBusy(false);
    }
  }

  /** hint: 카드 맨 위 한 줄 안내 (한국어 글자 인식 팩이 없을 때) */
  present(card, lines, shot, marksData, visualsResult, hint = null) {
    const { payload, model, explanation } = E.presentation(marksData, visualsResult, lines);
    if (hint) payload.hint = hint;
    this.explanation = explanation;
    if (model) this.showMarks(shot, model);
    card.render(payload);
    if (this.devQuestion) {
      const q = this.devQuestion;
      this.devQuestion = null;
      setTimeout(() => this.card === card && card.devAsk(q), this.askDelay);
    }
  }

  /** 카드의 장면 번호 (-1: 전체 보기) */
  scene(i) {
    if (!this.model || !this.overlay) return;
    this.model = { ...this.model, scene: i >= 0 && i < this.model.scenes.length ? i : null };
    this.overlay.update(this.model);
  }

  /** 설명 카드의 질문: 같은 화면을 다시 찍고, 최근 말·앞의 설명·앞의 대화와 함께 묻는다 */
  async ask(question) {
    const card = this.card;
    if (!card) return;
    try {
      const shot = await this.grab({ display: this.display, full: true });
      const lines = await this.lines(shot.png());
      const { transcript, guide, provider, model } = this.context();
      // Groq 로 묻거나 대신할 때는 움직이는 그림 안내를 뺀 가벼운 질문 (한도에 덜 걸리게, 맥 1.2.1)
      const prompt = (rich) => G.questionPrompt(question, this.history, this.explanation, lines, transcript, guide, rich);
      const jpeg = shot.jpeg(JPEG_WIDTH);
      let a = null;
      if (this.usesOther(provider, model)) {
        // 답을 읽지 못하면 한 번 더 묻는다. 두 번째는 생각 단계를 꺼서 토큰이 모자라 답이 잘리는 일을 막는다
        for (const think of [true, false]) {
          try {
            const text = await this.ai.complete(provider, { model, prompt: prompt(true), image: jpeg, json: true, maxTokens: AI.EXPLAIN_MAX_TOKENS, think });
            a = E.answerPresentation(text, lines);
            if (a) break;
          } catch (e) {
            if (!AI.fallsBack(e)) throw e;
            break;
          }
        }
        if (!a) this.onNotice(`${AI.LABEL[provider]} 답변 실패 → Groq 로 대신했습니다`);
      }
      if (!a) {
        const data = await G.answer(this.groq, prompt(false), { jpeg, lines, transcript, onUsed: this.onUsed });
        a = E.answerPresentation(data, lines);
      }
      if (!a) {
        card.answer({ error: ANSWER_FAILED });
        return;
      }
      this.history.push({ q: question, a: a.text });
      this.hideMarks();
      if (a.model) this.showMarks(shot, a.model);
      card.answer(a.payload);
    } catch (e) {
      card.answer({ error: e.message });
    }
  }

  /** 개발용: AI 없이 카드에 내용을 바로 띄운다 (EZRITE_CARD) */
  demo(payload) {
    const card = this.ensureCard();
    card.show(null, null);
    card.render(payload);
  }

  showMarks(shot, model) {
    this.model = model;
    this.overlay = this.createOverlay(shot.display, model);
    if (this.watch) this.watchMarks(shot);
  }

  /**
   * 0.4초마다 표시 자리만 작게 찍어 지난번 모습과 비교한다. 달라졌으면 글자를 다시 읽어서 짚었던 글자가
   * 있으면 표시를 새 자리로 옮기고(스크롤, 창 이동), 하나도 없으면 숨긴다(슬라이드 넘김, 다른 창).
   * 숨긴 동안에는 0.6초마다 살펴 다시 보이면 되살린다. 모두 이 PC 안에서 하고 AI 로는 보내지 않는다
   */
  watchMarks(shot) {
    const token = { cancelled: false };
    this.watchToken = token;
    this.watching = (async () => {
      let baseline = E.allLines(this.model).map((l) => E.thumbnail(shot.bitmap, l.box));
      let hidden = false;
      while (!token.cancelled) {
        await this.sleep(hidden ? WATCH_HIDDEN_MS : WATCH_MS);
        if (token.cancelled || !this.model || !this.overlay) return;
        const targets = E.allLines(this.model);
        let now;
        try {
          now = await this.grab({ display: shot.display, full: false });
        } catch {
          continue;
        }
        if (token.cancelled) return;
        const thumbs = targets.map((l) => E.thumbnail(now.bitmap, l.box));
        if (!thumbs.some((t, i) => E.changed(baseline[i] ?? [], t))) continue;
        baseline = thumbs; // 화면이 그대로면 다음엔 글자를 다시 읽지 않는다

        const lines = await this.lines(now.png()); // 못 읽으면 빈 목록 → 못 찾은 것으로
        if (token.cancelled) return;
        const found = E.relocate(targets, lines);
        if (!found) {
          if (!hidden) {
            this.overlay.hide();
            hidden = true;
          }
          continue;
        }
        const boxes = new Map();
        for (const l of found) if (!boxes.has(l.id)) boxes.set(l.id, l.box);
        const ids = new Set(found.map((l) => l.id));
        this.model = { ...E.moveModel(this.model, boxes), missing: targets.map((l) => l.id).filter((id) => !ids.has(id)) };
        baseline = E.allLines(this.model).map((l) => E.thumbnail(now.bitmap, l.box));
        this.overlay.update(this.model);
        if (hidden) {
          this.overlay.show();
          hidden = false;
        }
      }
    })();
  }

  /** 화면 표시를 지운다 (새 설명·답, 카드 닫기). 카드의 장면 재생은 계속된다 */
  hideMarks() {
    if (this.watchToken) this.watchToken.cancelled = true;
    this.watchToken = null;
    this.overlay?.close();
    this.overlay = null;
    this.model = null;
  }

  /**
   * 카드를 닫으면 화면 표시도 지우고, 줄였던 창을 원래대로 (끝날 때 기다릴 수 있게 그 약속을 돌려준다).
   * closeCard=false: 사용자가 이미 카드 창을 닫았다
   */
  clear({ closeCard = true } = {}) {
    this.hideMarks();
    const restored = this.dock ? this.dock.restore().catch(() => {}) : Promise.resolve();
    const card = this.card;
    this.card = null;
    if (closeCard) card?.close();
    return restored;
  }
}

module.exports = { Explainer, LOADING_READ, LOADING_MAKE, ANSWER_FAILED, JPEG_WIDTH };
