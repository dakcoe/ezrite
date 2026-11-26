'use strict';

// 화면 번역 (실험 기능, 1.3.2 예정, 맥 ScreenTranslate): 고른 창의 글자를 읽어 옮기고, 원래 문단 자리에 번역을 덮는다.
// 같은 문단은 다시 옮기지 않고(기억), 스크롤 등으로 새 글이 나오면 그것만 옮긴다. 덮개에 마우스를 올리면 그 문단만 원문.
// Electron 없이 시험한다: 창 찍기·글자 읽기·번역·덮개·지켜보기·마우스 위치는 바깥에서 넣는다.
//
//   grab(hwnd) → { rect: {x,y,w,h} (물리 픽셀), bitmap: {width,height,data BGRA}, file }   (helper grab, 그 창만)
//   ocr(file) → helper ocr 결과                     translate(texts) → 같은 길이 배열 (못 옮긴 것은 null)
//   watch(hwnd, onLine) → { kill() }                 helper screen-watch: 0.5초마다 { x,y,w,h, sig, front } / { min } / { gone }
//   overlay: { show(rect, items, scale), hide(), move(rect), reveal(key|null) }
//   cursor() → {x,y} 물리 픽셀                      scaleOf(rect) → 그 화면 배율 (그림 픽셀 / 1배 px)
//
// 바뀜 감지 (맥과 같다): 6×6 칸 평균 차가 2.5 를 넘으면 바뀐 것 → 덮개를 걷고, 한 번 그대로이면 다시 읽는다.
// 창 이동만이면(크기·내용 그대로) 다시 읽지 않고 덮개만 따라간다. 앞에 있는 창에 걸친 문단은 덮지 않는다.
// 기록(applog [화면 번역])에는 개수·시간만 (화면 글·번역 글은 남기지 않는다).

const { EventEmitter } = require('node:events');
const ST = require('./screentx');
const log = require('./applog');

const CHANGE = 2.5;
const HOVER_MS = 100;
const BACKOFF = [3000, 6000, 12000, 24000, 30000];

/** 두 6×6×rgb 칸 평균의 평균 차 */
function sigDiff(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

class ScreenTranslate extends EventEmitter {
  constructor({
    grab, ocr, translate, watch, overlay, cursor = () => null, scaleOf = () => 1, ownPid = null, setInterval: si = setInterval, clearInterval: ci = clearInterval,
    setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout, now = () => Date.now(),
  }) {
    super();
    Object.assign(this, { grab, ocr, translate, watch, overlay, cursor, scaleOf, ownPid, si, ci, st, ct, now });
    this.target = null;
  }

  /**
   * 한 묶음 옮기기 + 안전장치 (맥과 같다): 4개 이상 묶음에서 절반 넘게 원문 그대로 오면 한 번 더 묻고,
   * 또 그러면 원문 그대로인 것은 실패(null)로 — 기억에 넣으면 그 문단은 다시는 옮기지 않기 때문이다
   */
  async ask(keys) {
    const same = (out) => keys.filter((k, i) => out?.[i] != null && ST.memoryKey(out[i]) === k).length;
    let out = await this.translate(keys);
    if (keys.length >= 4 && same(out) * 2 > keys.length) {
      log.warn('화면 번역', `원문 그대로 ${same(out)}/${keys.length} — 한 번 더`);
      out = await this.translate(keys);
      if (same(out) * 2 > keys.length) {
        log.warn('화면 번역', `또 원문 그대로 ${same(out)}/${keys.length} — 그것들은 실패로`);
        out = out.map((t, i) => (t != null && ST.memoryKey(t) === keys[i] ? null : t));
      }
    }
    return out;
  }

  /** 연달아 실패하면 3·6·12·24·30초 쉬었다가 다시 읽는다 (Groq 분당 한도) */
  backoff() {
    this.failures = (this.failures ?? 0) + 1;
    const wait = BACKOFF[Math.min(this.failures, BACKOFF.length) - 1];
    this.ct(this.retryTimer);
    this.retryUntil = this.now() + wait;
    this.retryTimer = this.st(() => {
      this.retryUntil = 0;
      this.read();
    }, wait);
    log.info('화면 번역', `${wait / 1000}초 쉬고 다시 (연속 실패 ${this.failures}번)`);
  }

  get active() {
    return Boolean(this.target);
  }

  /** target: { hwnd, title } */
  start(target) {
    this.stop();
    this.target = target;
    this.memory = new Map();
    this.blocks = null;
    this.shot = null; // 마지막으로 읽은 그림의 자리 (물리 픽셀)
    this.rect = null; // 지금 창 자리
    this.sig = null;
    this.dirty = false;
    this.front = [];
    this.revealed = null;
    this.reading = null;
    this.again = false;
    this.reads = 0;
    this.started = Date.now();
    log.info('화면 번역', '시작');
    this.watcher = this.watch(target.hwnd, (line) => this.onWatch(line));
    this.hoverTimer = this.si(() => this.hover(), HOVER_MS);
    this.emit('change', this.status());
    this.read();
  }

  stop(reason = null) {
    if (!this.target) return;
    this.watcher?.kill();
    this.ci(this.hoverTimer);
    this.ct(this.retryTimer);
    this.failures = 0;
    this.retryUntil = 0;
    this.overlay.hide();
    log.info('화면 번역', `끝 — ${((Date.now() - this.started) / 1000).toFixed(1)}초, 읽기 ${this.reads}번, 기억 ${this.memory.size}문단${reason ? `, ${reason}` : ''}`);
    this.target = null;
    this.emit('change', this.status(reason));
  }

  status(reason = null) {
    return { active: this.active, title: this.target?.title ?? null, reason };
  }

  /** screen-watch 한 줄 */
  onWatch(line) {
    if (!this.target) return;
    if (line.gone) {
      this.stop('창이 닫혔습니다');
      return;
    }
    if (line.min) {
      this.overlay.hide();
      this.dirty = true; // 다시 열리면 새로 읽는다
      this.sig = null;
      return;
    }
    if (line.error) {
      if (!this.grabFailed) log.warn('화면 번역', '찍기 실패 (지켜보기)');
      this.grabFailed = true;
      return;
    }
    if (this.grabFailed) log.info('화면 번역', '찍기 다시 됨');
    this.grabFailed = false;
    const rect = { x: line.x, y: line.y, w: line.w, h: line.h };
    const front = (line.front ?? []).filter((f) => f[4] == null || f[4] !== this.ownPid)
      .map(([l, t, r, b]) => ({ x: l, y: t, w: r - l, h: b - t }));
    const resized = this.rect && (rect.w !== this.rect.w || rect.h !== this.rect.h);
    const changed = resized || sigDiff(this.sig, line.sig) > CHANGE;
    const moved = this.rect && !resized && (rect.x !== this.rect.x || rect.y !== this.rect.y);
    const frontChanged = JSON.stringify(front) !== JSON.stringify(this.front);
    this.rect = rect;
    this.front = front;
    const first = this.sig == null;
    this.sig = line.sig;
    if (first && !this.dirty) return; // 처음 줄: 읽기는 start 가 이미 시작했다
    if (changed && !first) {
      // 바뀌었다: 덮개를 걷고, 한 번 그대로일 때까지 기다린다
      if (!this.dirty) this.overlay.hide();
      this.dirty = true;
      return;
    }
    if (this.dirty) {
      this.dirty = false;
      this.read();
      return;
    }
    if (moved && this.shot) {
      // 창만 옮겼다: 다시 읽지 않고 덮개만 따라간다
      this.shot = { ...this.shot, x: rect.x, y: rect.y };
      this.overlay.move(this.shot);
    }
    if (frontChanged || moved) this.render();
  }

  /** 창을 찍어 읽고, 아는 번역은 바로 덮고, 새 문단만 옮긴다 */
  async read() {
    if (!this.target) return;
    if (this.reading) {
      this.again = true;
      return;
    }
    const target = this.target;
    this.reading = (async () => {
      const t0 = Date.now();
      let shot;
      let result;
      try {
        shot = await this.grab(target.hwnd);
        if (this.target !== target) return;
        const ocr = await this.ocr(shot.file);
        result = ST.analyze({ ocr, bitmap: shot.bitmap, scale: this.scaleOf(shot.rect) });
      } catch (e) {
        log.warn('화면 번역', `찍기·읽기 실패: ${log.err(e)}`);
        this.dirty = true; // 다음 지켜보기 줄에서 다시
        return;
      }
      if (this.target !== target) return;
      this.reads += 1;
      this.shot = shot.rect;
      this.scale = this.scaleOf(shot.rect);
      this.blocks = result.blocks;
      const batches = ST.pending(result.blocks, this.memory);
      const fresh = batches.reduce((n, b) => n + b.length, 0);
      log.info('화면 번역', `읽음 — 줄 ${result.lines.length}, 문단 ${result.blocks.length}, ${Date.now() - t0}ms, 새로 옮길 ${fresh}`);
      this.render();
      // 쉬는 중이면 아는 번역만 덮고 기다린다 (쉬는 시간이 끝나면 다시 읽는다)
      if (this.retryUntil > this.now()) return;
      for (const keys of batches) {
        const t1 = Date.now();
        let out;
        try {
          out = await this.ask(keys);
        } catch (e) {
          log.error('화면 번역', `옮기기 실패 — ${keys.length}문단: ${log.err(e)}`);
          if (!this.failures) this.emit('notice', '화면 번역을 하지 못했습니다');
          if (this.target === target) this.backoff();
          return;
        }
        if (this.target !== target) return;
        let ok = 0;
        keys.forEach((k, i) => {
          if (out?.[i] != null) {
            this.memory.set(k, out[i]);
            ok += 1;
          }
        });
        log.info('화면 번역', `옮김 — 묶음 ${keys.length}, 성공 ${ok}, ${Date.now() - t1}ms`);
        this.render();
        if (ok === 0) {
          this.backoff();
          return;
        }
        this.failures = 0;
      }
    })();
    try {
      await this.reading;
    } finally {
      this.reading = null;
      if (this.again && this.target) {
        this.again = false;
        this.read();
      }
    }
  }

  /** 덮을 것: 옮겼고, 원문과 다르고, 앞 창에 안 걸린 문단. 바뀌는 중이면 덮지 않는다 */
  items() {
    if (!this.blocks || !this.shot || this.dirty) return [];
    return this.blocks
      .filter((b) => b.translate && ST.covers(b, this.memory.get(b.key)))
      .filter((b) => {
        const abs = { x: this.shot.x + b.box.x, y: this.shot.y + b.box.y, w: b.box.w + (b.room ?? 0), h: b.box.h };
        return !this.front.some((f) => overlaps(abs, f));
      })
      .map((block) => ({ block, text: this.memory.get(block.key) }));
  }

  render() {
    if (!this.target) return;
    const items = this.items();
    this.shown = items;
    if (!items.length) this.overlay.hide();
    else this.overlay.show(this.shot, items, this.scale);
  }

  /** 0.1초마다: 마우스가 올라간 문단만 덮개를 뺀다 (원문 보기). 덮개는 클릭 통과 */
  hover() {
    if (!this.shown?.length || !this.shot) return;
    const p = this.cursor();
    let key = null;
    if (p) {
      const x = p.x - this.shot.x;
      const y = p.y - this.shot.y;
      const hit = this.shown.find(({ block: b }) => x >= b.box.x && x < b.box.x + b.box.w + (b.room ?? 0) && y >= b.box.y && y < b.box.y + b.box.h);
      key = hit ? hit.block.key : null;
    }
    if (key !== this.revealed) {
      this.revealed = key;
      this.overlay.reveal(key);
    }
  }
}

module.exports = { ScreenTranslate, sigDiff, CHANGE };
