'use strict';

// "설명해줘" 한 번의 흐름 (맥 ExplainUI.swift Explainer): 화면 찍기 → 글자 읽기 → Groq → 화면 표시 + 설명 카드.
// 창·화면 찍기·글자 읽기는 main.js 가 넣어 준다 (여기는 Electron 을 모른다).
//   grab({ display, full }) → { display, bitmap: {width,height,data BGRA}, png(), jpeg(maxWidth) }
//     display 가 null 이면 마우스가 있는 화면. full=false 는 지켜보기용 작은 사진
//   ocr(png) → helper ocr 출력 JSON
//   createCard({ onClose, onAsk, onScene, onHover, onAnchors }) → { show(display, avoid), place(lines, display, avoid), render(p),
//     answer(p), restyle(style), devAsk(q), close() }. onAnchors(points): 카드 글의 화면 자리 (DIP, 선 긋기 방식)
//   createOverlay(display, model) → { update(model), hide(), show(), close() }
//   context() → { transcript, guide, provider, model, style }  style: 설명 표시 방식 (1.3.0, lib/markstyle.js)
//   화면 나누기(1.2.1 dock)는 1.3.0 에서 없앴다 (맥과 같다). 대신 카드를 화면 글자가 적은 자리에 띄운다 (card.place)
//   desktop: 가상 데스크톱 (1.2.2). watch(display, onChange) → { stop() } 또는 null(알 수 없음).
//     onChange(on): 설명한 화면(그때 앞에 있던 창)의 데스크톱이 지금 보이는지. 카드·표시 창은 작업 표시줄에 없는 창이라
//     Windows 가 모든 데스크톱에 보인다 — 카드는 그대로 두고(따라온다), 표시만 원래 데스크톱에서 보이게 한다

const { EventEmitter } = require('node:events');
const E = require('./explain');
const G = require('./groq-explain');
const AI = require('./ai');
const MarkStyle = require('./markstyle');

const LOADING_READ = '화면을 읽는 중…';
const LOADING_MAKE = '설명을 만드는 중…';
const LOADING_REMAKE = '설명을 다시 만드는 중…'; // 생각을 끄고 한 번 더 물을 때 (1.3.0, 맥과 같다)
const ANSWER_FAILED = '답을 읽지 못했습니다. 다시 물어봐 주세요.';
const EMPTY_EXPLANATION = '설명을 만들지 못했습니다. ✨ 를 다시 눌러 주세요.';
const JPEG_WIDTH = 1280; // 이미지 토큰은 크기와 상관없이 한 장에 약 1,800 (맥 실측)
const MAP_WIDTH = 560; // 카드 속 지도에 넣는 축소 화면 (1.3.0, 맥과 같다)
const WATCH_MS = 400;
const WATCH_HIDDEN_MS = 600;

class Explainer extends EventEmitter {
  // ai: Claude·Gemini·GPT 호출 (lib/ai.js AIClient). context() 의 provider·model 이 Groq 가 아니면 그쪽에 묻는다
  constructor({ groq, ai = null, onNotice = () => {}, grab, ocr, createCard, createOverlay, context, popupFrame = () => null,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)), devQuestion = null, askDelay = 6000, onUsed = () => {}, watch = true,
    desktop = null }) {
    super();
    // watch=false: 표시를 그린 뒤 화면을 지켜보지 않는다 (EZRITE_CAPTURABLE 녹화용 — 찍을 때마다 카드·표시를 빼서 깜박인다)
    Object.assign(this, { groq, ai, onNotice, grab, ocr, createCard, createOverlay, context, popupFrame, sleep, devQuestion, askDelay, onUsed, watch, desktop });
    this.away = false; // 설명한 화면의 데스크톱을 떠나 있다 (1.2.2)
    this.marksHidden = false; // 지켜보기가 짚은 글자를 못 찾아 표시를 숨겼다
    this.deskWatch = null;
    this.busy = false;
    this.card = null;
    this.overlay = null;
    this.model = null;
    this.display = null; // 설명을 받은 화면 (질문할 때 다시 찍는다)
    this.explanation = '';
    this.history = [];
    this.style = MarkStyle.FALLBACK; // 이번 설명의 표시 방식 (설정에서 바꾸면 restyle)
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
        onHover: (ref) => this.hover(ref),
        onAnchors: (points) => this.anchors(points),
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
      const { transcript, guide, provider, model, style } = this.context();
      this.style = MarkStyle.normalize(style);
      // 말풍선·여백 메모·판서만 장면 꼬리표를 받는다 (출력 토큰 절약, 맥 sceneTags)
      const tags = MarkStyle.wantsTags(this.style);
      try {
        const shot = await this.grab({ display: null, full: true });
        if (this.card !== card) return; // 기다리는 사이 카드를 닫았다 (1.2.3)
        this.display = shot.display;
        this.followDesktop(shot.display);
        card.show(shot.display, this.popupFrame());
        card.render({ loading: LOADING_READ });
        const lines = await this.lines(shot.png());
        if (this.card !== card) return;
        // 글자를 읽었으면 카드를 화면 글자가 가장 적게 가려지는 자리로 (1.3.0, 사용자가 끌어 옮겼으면 그대로)
        card.place(lines, shot.display, this.popupFrame());
        const hint = E.needsKoreanOcrHint(this.lastOcr) ? E.OCR_KO_HINT : null;
        card.render({ loading: LOADING_MAKE });
        const jpeg = shot.jpeg(JPEG_WIDTH);
        const args = { jpeg, lines, transcript, guide, tags, onUsed: this.onUsed };

        // 다른 서비스: 한 번에 묻는다. Groq 규칙·글자 섞임 고치기는 붙이지 않는다 (맥과 같다). 움직이는 그림 안내는 여기만 (1.2.1).
        // 요약이 비면(생각만 하고 본문을 안 줌) 생각을 끄고 한 번 더, 그래도 비면 Groq 로 대신한다 (1.2.3)
        if (this.usesOther(provider, model)) {
          try {
            let text = null;
            for (const think of [true, false]) {
              const t = await this.ai.complete(provider, {
                model, prompt: G.unifiedPrompt(lines, transcript, guide, true, tags), image: jpeg, json: true, maxTokens: AI.EXPLAIN_MAX_TOKENS, think,
              });
              if (this.card !== card) return;
              if (E.visuals(t).summary.trim()) {
                text = t;
                break;
              }
              if (think) card.render({ loading: LOADING_REMAKE });
            }
            if (text != null) {
              this.present(card, lines, shot, text, { data: text }, hint);
              return;
            }
            this.onNotice(`${AI.LABEL[provider]} 설명을 읽지 못함 → Groq 로 대신했습니다`);
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
        if (this.card === card) card.render({ error: e.message });
      }
    } finally {
      this.setBusy(false);
    }
  }

  /** hint: 카드 맨 위 한 줄 안내 (한국어 글자 인식 팩이 없을 때) */
  present(card, lines, shot, marksData, visualsResult, hint = null) {
    // 답을 기다리는 사이 카드를 닫았으면 표시·지켜보기를 새로 띄우지 않는다 (1.2.3, 맥과 같다)
    if (this.card !== card) return;
    const { payload, model, explanation } = E.presentation(marksData, visualsResult, lines, { style: this.style });
    // 요약도 그림도 없으면 빈 카드 대신 다시 눌러 달라고 (1.2.3)
    if (!payload.error && !payload.summary?.trim() && !payload.visuals?.length) {
      card.render({ error: EMPTY_EXPLANATION });
      return;
    }
    if (hint) payload.hint = hint;
    this.explanation = explanation;
    if (model) {
      // 카드 속 지도 (지도 방식. 설정에서 바꿔도 그릴 수 있게 늘 넣는다)
      const size = shot.bitmap;
      payload.map = E.mapPayload(model, `data:image/jpeg;base64,${Buffer.from(shot.jpeg(MAP_WIDTH)).toString('base64')}`, size.width / size.height);
      this.showMarks(shot, { ...model, others: lines.map((l) => l.box) });
    }
    card.render(payload);
    if (this.devQuestion) {
      const q = this.devQuestion;
      this.devQuestion = null;
      setTimeout(() => this.card === card && card.devAsk(q), this.askDelay);
    }
  }

  /** 카드에서 마우스를 올린 항목 ("m0" 짚은 곳·"s2" 장면·"p1" 경로·"say" 자막, "" 없음) */
  hover(ref) {
    if (!this.model || !this.overlay) return;
    const h = typeof ref === 'string' && /^(?:[msp]\d{1,2}|say)$/.test(ref) ? ref : null;
    if ((this.model.hover ?? null) === h) return;
    this.model = { ...this.model, hover: h };
    this.overlay.update(this.model);
  }

  /** 카드 글의 화면 자리 (DIP) → 표시 창 좌표 (선 긋기 방식) */
  anchors(points) {
    if (!this.model || !this.overlay || !this.display) return;
    const b = this.display.bounds;
    const out = {};
    for (const [k, p] of Object.entries(points ?? {})) out[k] = { x: p.x - b.x, y: p.y - b.y };
    this.model = { ...this.model, anchors: out };
    this.overlay.update(this.model);
  }

  /** 설정에서 표시 방식을 바꿨다: 떠 있는 화면 표시를 다시 그리고 카드도 맞춘다 (질문 답이 떠 있으면 카드는 그대로) */
  restyle(style) {
    this.style = MarkStyle.normalize(style);
    if (this.model && this.overlay) {
      this.model = { ...this.model, style: this.style };
      this.overlay.update(this.model);
    }
    this.card?.restyle(this.style);
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
    // 기다리는 사이 카드를 닫았으면 답이 와도 아무것도 띄우지 않는다 (1.2.3)
    const closed = () => this.card !== card;
    try {
      const shot = await this.grab({ display: this.display, full: true });
      if (closed()) return;
      this.followDesktop(shot.display); // 질문한 그때 화면이 기준
      const lines = await this.lines(shot.png());
      const { transcript, guide, provider, model } = this.context();
      // Groq 로 묻거나 대신할 때는 움직이는 그림 안내를 뺀 가벼운 질문 (한도에 덜 걸리게, 맥 1.2.1)
      const prompt = (rich) => G.questionPrompt(question, this.history, this.explanation, lines, transcript, guide, rich);
      const jpeg = shot.jpeg(JPEG_WIDTH);
      let a = null;
      if (this.usesOther(provider, model)) {
        // 답을 읽지 못하면 한 번 더 묻는다. 두 번째는 생각 단계를 꺼서 토큰이 모자라 답이 잘리는 일을 막는다 (한도 8000, 1.3.0)
        for (const think of [true, false]) {
          try {
            // 답 글은 오는 대로 카드에 채운다. 화면 표시·그림은 다 받은 뒤에 붙는다 (1.3.0 맥 AI.stream)
            const text = await this.ai.stream(provider, { model, prompt: prompt(true), image: jpeg, json: true, maxTokens: AI.EXPLAIN_MAX_TOKENS, think }, (soFar) => {
              const part = E.partialAnswer(soFar);
              if (part != null && !closed()) card.partial(E.dropLineRefs(part, lines));
            });
            a = this.readAnswer(text, lines);
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
        a = E.answerPresentation(data, lines, { style: this.style });
      }
      if (closed()) return;
      if (!a) {
        card.answer({ error: ANSWER_FAILED });
        return;
      }
      this.history.push({ q: question, a: a.text });
      this.hideMarks();
      if (a.model) this.showMarks(shot, { ...a.model, others: lines.map((l) => l.box) });
      card.answer(a.payload);
    } catch (e) {
      if (!closed()) card.answer({ error: e.message });
    }
  }

  /**
   * Claude·Gemini·GPT 의 답 글 → 카드에 붙일 답 (맥 ask). 줄 번호("8번 줄")는 그 줄 글자로, 수식 역슬래시 하나(\le)로 깨진 JSON 은
   * 고쳐 읽고, 그래도 못 읽었지만 답 글은 끝까지 받았으면 그 글로 끝낸다 (다시 물으면 보던 답이 지워지고 처음부터 다시 채워진다)
   */
  readAnswer(text, lines) {
    const opts = { style: this.style };
    let data = E.dropLineRefs(text, lines);
    let a = E.answerPresentation(data, lines, opts);
    if (!a) {
      const fixed = E.lenientJSON(data);
      if (fixed) a = E.answerPresentation(fixed, lines, opts);
    }
    if (!a) {
      const closed = E.closedAnswer(text);
      if (closed != null) data = JSON.stringify({ answer: closed });
      if (closed != null) a = E.answerPresentation(data, lines, opts);
    }
    return a;
  }

  /** 개발용: AI 없이 카드에 내용을 바로 띄운다 (EZRITE_CARD) */
  demo(payload) {
    const card = this.ensureCard();
    card.show(null, null);
    card.render(payload);
  }

  showMarks(shot, model) {
    this.model = model;
    this.marksHidden = false;
    this.overlay = this.createOverlay(shot.display, model);
    if (this.away) this.overlay.hide(); // 다른 데스크톱에 가 있으면 보이기 전에 숨겨 둔다
    if (this.watch) this.watchMarks(shot);
  }

  /**
   * 가상 데스크톱 (1.2.2): 이 화면을 설명한 데스크톱이 지금 보이는지 지켜본다. 앞의 지켜보기는 끝낸다.
   * 기다리지 않는다 (창 목록을 읽는 동안 설명을 늦추지 않게). 알 수 없으면(null·오류) 예전처럼 늘 보인다고 친다
   */
  followDesktop(display) {
    this.stopDesktop();
    if (!this.desktop) return;
    const token = {};
    this.deskToken = token;
    Promise.resolve()
      .then(() => this.desktop.watch(display, (on) => { if (this.deskToken === token) this.onDesktop(on); }))
      .then((w) => {
        if (this.deskToken === token) this.deskWatch = w;
        else w?.stop();
      }, () => {});
  }

  stopDesktop() {
    this.deskToken = null;
    this.deskWatch?.stop();
    this.deskWatch = null;
    this.onDesktop(true);
  }

  /** 떠나면 표시를 숨기고, 돌아오면 되살린다 (지켜보기가 글자를 못 찾아 숨긴 표시는 그대로) */
  onDesktop(on) {
    if (this.away === !on) return;
    this.away = !on;
    if (!this.overlay) return;
    if (this.away) this.overlay.hide();
    else if (!this.marksHidden) this.overlay.show();
  }

  /**
   * 0.4초마다 표시 자리만 작게 찍어 지난번 모습과 비교한다. 달라졌으면 글자를 다시 읽어서 짚었던 글자가
   * 있으면 표시를 새 자리로 옮기고(스크롤, 창 이동), 하나도 없으면 숨긴다(슬라이드 넘김, 다른 창).
   * 숨긴 동안에는 0.6초마다 살펴 다시 보이면 되살린다. 모두 이 PC 안에서 하고 AI 로는 보내지 않는다.
   * 다른 가상 데스크톱에 가 있는 동안은 찍지 않는다 (그 화면을 읽을 까닭이 없다, 1.2.2)
   */
  watchMarks(shot) {
    const token = { cancelled: false };
    this.watchToken = token;
    this.watching = (async () => {
      let baseline = E.allLines(this.model).map((l) => E.thumbnail(shot.bitmap, l.box));
      while (!token.cancelled) {
        await this.sleep(this.marksHidden || this.away ? WATCH_HIDDEN_MS : WATCH_MS);
        if (token.cancelled || !this.model || !this.overlay) return;
        if (this.away) continue;
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
          if (!this.marksHidden) {
            this.overlay.hide();
            this.marksHidden = true;
          }
          continue;
        }
        const boxes = new Map();
        for (const l of found) if (!boxes.has(l.id)) boxes.set(l.id, l.box);
        const ids = new Set(found.map((l) => l.id));
        this.model = {
          ...E.moveModel(this.model, boxes), missing: targets.map((l) => l.id).filter((id) => !ids.has(id)), others: lines.map((l) => l.box),
        };
        baseline = E.allLines(this.model).map((l) => E.thumbnail(now.bitmap, l.box));
        this.overlay.update(this.model);
        if (this.marksHidden) {
          this.marksHidden = false;
          if (!this.away) this.overlay.show();
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

  /** 카드를 닫으면 화면 표시도 지운다. closeCard=false: 사용자가 이미 카드 창을 닫았다 */
  clear({ closeCard = true } = {}) {
    this.hideMarks();
    this.stopDesktop();
    const card = this.card;
    this.card = null;
    if (closeCard) card?.close();
  }
}

module.exports = { Explainer, LOADING_READ, LOADING_MAKE, LOADING_REMAKE, ANSWER_FAILED, EMPTY_EXPLANATION, JPEG_WIDTH, MAP_WIDTH };
