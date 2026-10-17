'use strict';

// "설명해줘" 규칙 (순수 코드). 맥 Explain.swift(Explain enum) · OnScreen.swift · MarksView 의 배치 계산 이식.
//   줄(line):  { id, text, box: {x, y, w, h} }  box 는 화면 크기에 대한 비율(0~1), 왼쪽 위가 원점
//   AI 응답은 JSON 글이나 객체를 그대로 받는다 (맥은 Data)
//
// 맥과 다른 점:
// - 글자 인식은 Windows.Media.Ocr(helper ocr)이 픽셀 좌표로 준다 → linesFromOcr 로 비율로 바꾼다
//   (맥 Vision 은 왼쪽 아래가 원점이라 topLeft 로 뒤집었다. Windows 는 처음부터 왼쪽 위라 필요 없다)
// - 썸네일은 CoreGraphics 대신 BGRA 픽셀 버퍼를 직접 평균 내서 줄인다
// - pulledIn: Windows 는 위쪽이 원점이라, 화면 밖으로 나간 창을 위아래 모두 8px 안쪽으로 데려온다

const Hallucination = require('./hallucination');
const { graphemes } = require('./text');

const MAX_SCENES = 6;
const MAX_MARKS = 3;
const MAX_PATH_STEPS = 10;
const MAX_VISUALS = 4; // 프롬프트는 2개까지 요청한다. 넘쳐도 카드가 터지지 않게 막는 상한
const THUMB = { w: 24, h: 12 };
const CHANGE_LIMIT = 20; // 흑백 0~255 평균 차이가 이보다 크면 바뀐 것
const SAME_TEXT = 0.8;

/** JSON 글이면 읽고, 객체면 그대로. 객체(배열 아님)가 아니면 null */
function obj(data) {
  let v = data;
  if (typeof data === 'string' || Buffer.isBuffer(data)) {
    try {
      v = JSON.parse(String(data));
    } catch {
      return null;
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const int = (v) => (isNum(v) ? Math.trunc(v) : null);
const byId = (lines) => {
  const m = new Map();
  for (const l of lines) if (!m.has(l.id)) m.set(l.id, l);
  return m;
};

// --- 글자 인식 결과 ---

/** helper ocr 출력 {width, height, lines:[{text,x,y,w,h}]} → 줄. 번호는 인식 순서 그대로 (빈 줄도 번호를 쓴다, 맥과 같다) */
function linesFromOcr(ocr) {
  if (!ocr || !(ocr.width > 0) || !(ocr.height > 0) || !Array.isArray(ocr.lines)) return [];
  const out = [];
  ocr.lines.forEach((l, i) => {
    if (typeof l.text !== 'string' || !l.text.trim()) return;
    out.push({ id: i, text: l.text, box: { x: l.x / ocr.width, y: l.y / ocr.height, w: l.w / ocr.width, h: l.h / ocr.height } });
  });
  return out;
}

// --- 표시 자리가 바뀌었나 ---

/** 표시 자리(box: 비율)를 24×12 흑백으로 줄인다. image: { width, height, data: BGRA 버퍼 } */
function thumbnail(image, box) {
  const { width: W, height: H, data } = image;
  const x0 = Math.max(0, Math.floor(box.x * W));
  const y0 = Math.max(0, Math.floor(box.y * H));
  const x1 = Math.min(W, Math.ceil((box.x + box.w) * W));
  const y1 = Math.min(H, Math.ceil((box.y + box.h) * H));
  if (x1 <= x0 || y1 <= y0) return [];
  const out = new Array(THUMB.w * THUMB.h).fill(0);
  for (let ty = 0; ty < THUMB.h; ty++) {
    const sy0 = y0 + Math.floor(((y1 - y0) * ty) / THUMB.h);
    const sy1 = Math.max(sy0 + 1, y0 + Math.floor(((y1 - y0) * (ty + 1)) / THUMB.h));
    for (let tx = 0; tx < THUMB.w; tx++) {
      const sx0 = x0 + Math.floor(((x1 - x0) * tx) / THUMB.w);
      const sx1 = Math.max(sx0 + 1, x0 + Math.floor(((x1 - x0) * (tx + 1)) / THUMB.w));
      let sum = 0;
      let n = 0;
      for (let y = sy0; y < sy1; y++) {
        for (let x = sx0; x < sx1; x++) {
          const i = (y * W + x) * 4;
          sum += 0.114 * data[i] + 0.587 * data[i + 1] + 0.299 * data[i + 2];
          n += 1;
        }
      }
      out[ty * THUMB.w + tx] = Math.round(sum / n);
    }
  }
  return out;
}

function changed(a, b) {
  if (a.length !== b.length || a.length === 0) return true;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
  return diff / a.length > CHANGE_LIMIT;
}

// --- 표시 상자 여백 ---

/** 겹친 넓이가 있나 (모서리만 닿은 것은 겹친 게 아니다) */
function intersects(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** 겹친 넓이가 작은 상자의 80% 이상이면 같은 자리 (같은 줄을 두 번 짚음) */
function sameSpot(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w < 0 || h < 0) return false;
  return w * h >= 0.8 * Math.min(a.w * a.h, b.w * b.h);
}

/**
 * 글자 상자(화면 좌표)를 조금 넓혀 그릴 상자로. 이웃 상자와 겹치면 그쪽 여백을 사이 간격의 절반까지 줄인다.
 * 원래부터 조금 겹치게 잡힌 줄은 겹친 부분 한가운데를 경계로 나눈다(여백이 음수)
 */
function padded(raw, dx = 8, dy = 6) {
  return raw.map((a, i) => {
    let left = dx;
    let right = dx;
    let top = dy;
    let bottom = dy;
    raw.forEach((b, j) => {
      if (j === i || sameSpot(a, b)) return;
      const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)); // 양수면 떨어져 있고, 음수면 겹친 폭
      const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
      if (gapY >= gapX) { // 위아래로 나누는 쪽이 덜 깎인다
        if (b.y + b.h / 2 >= a.y + a.h / 2) bottom = Math.min(bottom, gapY / 2 - 0.5);
        else top = Math.min(top, gapY / 2 - 0.5);
      } else if (b.x + b.w / 2 >= a.x + a.w / 2) right = Math.min(right, gapX / 2 - 0.5);
      else left = Math.min(left, gapX / 2 - 0.5);
    });
    // 너무 깎여 뒤집히지 않게 글자 상자의 절반까지만
    top = Math.max(top, -a.h / 2);
    bottom = Math.max(bottom, -a.h / 2);
    left = Math.max(left, -a.w / 2);
    right = Math.max(right, -a.w / 2);
    return { x: a.x - left, y: a.y - top, w: a.w + left + right, h: a.h + top + bottom };
  });
}

// --- 움직인 표시 따라가기 ---

/** 1 - 편집 거리 / 긴 쪽 길이 (글자는 자소 묶음 단위) */
function similarity(a, b) {
  const x = graphemes(a);
  const y = graphemes(b);
  if (!x.length || !y.length) return !x.length && !y.length ? 1 : 0;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}

/** 같은 줄인가 (a, b 는 normalize 한 글자). 확대·창 폭이 바뀌면 줄이 다른 곳에서 끊기고 수식 인식이 흔들린다 */
function sameLine(a, b) {
  if (similarity(a, b) >= SAME_TEXT) return true;
  const ga = graphemes(a);
  const gb = graphemes(b);
  const n = Math.min(ga.length, gb.length);
  if (n >= 8 && similarity(ga.slice(0, n).join(''), gb.slice(0, n).join('')) >= SAME_TEXT) return true;
  // 앞의 한글 낱말(4글자 이상, 예: "출력층오차")이 똑같다
  const label = (g) => {
    const out = [];
    for (const ch of g) {
      if (ch >= '가' && ch <= '힣') out.push(ch);
      else break;
    }
    return out.join('');
  };
  const la = label(ga);
  return graphemes(la).length >= 4 && la === label(gb);
}

const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** 짚었던 줄들을 새 화면 글자에서 다시 찾는다. 못 찾은 줄은 빼고, 하나도 못 찾으면 null (슬라이드가 넘어감) */
function relocate(targets, lines) {
  const out = [];
  for (const t of targets) {
    const key = Hallucination.normalize(t.text);
    let best = null;
    let bestScore = null;
    for (const l of lines) {
      const k = Hallucination.normalize(l.text);
      if (!sameLine(key, k)) continue;
      const c1 = center(l.box);
      const c2 = center(t.box);
      const score = [similarity(key, k), -Math.hypot(c1.x - c2.x, c1.y - c2.y)];
      if (!bestScore || score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) {
        best = l;
        bestScore = score;
      }
    }
    if (best) out.push({ id: t.id, text: t.text, box: best.box });
  }
  return out.length ? out : null;
}

// --- 응답 검사 ---

/**
 * Groq 모델이 내부 줄 번호를 쓰면("25번 줄에", "(28번)") 그 줄의 글자로 바꾸거나 지운다. 없는 번호는 둔다.
 * JSON 글 그대로에 써도 깨지지 않게 넣는 글자에서 역슬래시는 빼고 따옴표는 ” 로 바꾼다
 */
function dropLineRefs(s, lines) {
  const text = new Map();
  for (const l of lines) if (!text.has(l.id)) text.set(l.id, l.text);
  const safe = (t) => t.replace(/\\/g, '').replace(/"/g, '”');
  const sub = (re, str, make) => str.replace(re, (whole, num) => {
    const line = text.get(Number(num));
    return line === undefined ? whole : make(line);
  });
  let named = String(s);
  // "N번 화면/스크린"도 줄 번호로 본다 (gpt-oss 가 "(0번 화면)"처럼 쓴다. 맥과 같은 규칙)
  for (const re of [/(?:화면|스크린)\s*(\d+)번(?:\s*(?:줄|라인))?/g, /(\d+)번\s*(?:줄|라인|화면|스크린)/g, /\bline\s+(\d+)/gi]) {
    named = sub(re, named, (t) => `‘${safe(t)}’`);
  }
  const dropped = sub(/\s*\((\d+)번\)/g, named, () => '');
  // 위에서 바꾸지 못한(없는 번호) 괄호 속 "N번 화면/줄"은 지운다
  return dropped.replace(/\s*\(\d+번\s*(?:화면|스크린|줄|라인)\)/g, '');
}

/**
 * 모델이 JSON 글 안에 수식 역슬래시를 그대로 써서(\delta, \frac) 깨진 JSON 을 고쳐 읽는다. 고친 JSON 글 또는 null.
 * 올바른 이스케이프(\" \\ \/ \uXXXX, 뒤에 글자가 이어지지 않는 \n \t 등)는 두고, 나머지 역슬래시는 글자로 만든다
 */
function lenientJSON(text) {
  const t = String(text);
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const s = t.slice(start, end + 1);
  let out = '';
  let i = 0;
  const isHex = (c) => /[0-9a-fA-F]/.test(c);
  while (i < s.length) {
    const c = s[i];
    if (c !== '\\' || i + 1 >= s.length) {
      out += c;
      i += 1;
      continue;
    }
    const n = s[i + 1];
    const after = i + 2 < s.length ? s[i + 2] : ' ';
    const valid = n === '\\' || n === '"' || n === '/'
      || (n === 'u' && i + 5 < s.length && [...s.slice(i + 2, i + 6)].every(isHex))
      || ('bfnrt'.includes(n) && !/[A-Za-z]/.test(after));
    if (valid) {
      out += c + n;
      i += 2;
    } else {
      out += '\\\\';
      i += 1;
    }
  }
  return obj(out) ? out : null;
}

/** AI 가 고른 줄 번호 → 표시. 화면에 없는 번호와 중복은 버리고 3개까지만 */
function marks(data, lines) {
  const raw = obj(data)?.marks;
  if (!Array.isArray(raw)) return [];
  const map = byId(lines);
  const out = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const id = int(m.id);
    const line = map.get(id);
    if (!line || out.some((x) => x.line.id === id)) continue;
    out.push({ line, note: typeof m.note === 'string' ? m.note : '' });
    if (out.length === MAX_MARKS) break;
  }
  return out;
}

/** AI 가 고른 라벨 순서 → 경로. 화면에 없는 번호와 바로 앞과 같은 번호는 뺀다(한 바퀴 돌아오는 건 둔다) */
function path(data, lines) {
  const raw = obj(data)?.path;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.ids) || !raw.ids.every(isNum)) return null;
  const map = byId(lines);
  const steps = [];
  for (const id of raw.ids.map(Math.trunc)) {
    const line = map.get(id);
    if (!line || steps.at(-1)?.id === id) continue;
    steps.push(line);
    if (steps.length === MAX_PATH_STEPS) break;
  }
  return steps.length >= 2 ? { steps, note: typeof raw.note === 'string' ? raw.note : '' } : null;
}

/** 장면 대본. 화면에 없는 줄·빈 자막은 버리고, 그림 번호와 단계 수는 범위 안으로. 6개까지 */
function scenes(data, lines, visualCount) {
  const raw = obj(data)?.scenes;
  if (!Array.isArray(raw)) return [];
  const map = byId(lines);
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const say = typeof r.say === 'string' ? r.say.trim() : '';
    if (!say) continue;
    const focus = Array.isArray(r.focus) && r.focus.every(isNum) ? r.focus.map((v) => map.get(Math.trunc(v))).filter(Boolean) : [];
    let arrow = null;
    if (r.arrow && typeof r.arrow === 'object') {
      const f = map.get(int(r.arrow.from));
      const t = map.get(int(r.arrow.to));
      if (f && t && f.id !== t.id) arrow = { from: f, to: t };
    }
    const v = int(r.visual);
    const visual = v != null && v >= 0 && v < visualCount ? v : null;
    const rv = int(r.reveal);
    const reveal = visual == null ? null : rv != null && rv > 0 ? rv : null;
    out.push({ say, focus: focus.slice(0, MAX_MARKS), arrow, visual, reveal });
    if (out.length === MAX_SCENES) break;
  }
  return out;
}

/** 질문에 대한 답 본문 */
function answer(data) {
  const a = obj(data)?.answer;
  if (typeof a !== 'string' || !a.trim()) return null;
  return a.trim().replace(/\\n/g, '\n');
}

const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** 설명 카드에 넣을 요약과 그림. 모르는 형식, 필수 칸이 빈 그림은 버린다 */
function visuals(data) {
  const o = obj(data);
  if (!o) return { summary: '', visuals: [] };
  const summary = typeof o.summary === 'string' ? o.summary : '';
  const raw = Array.isArray(o.visuals) && o.visuals.every((v) => v && typeof v === 'object' && !Array.isArray(v)) ? o.visuals : [];
  const ok = raw.filter((v) => {
    switch (v.type) {
      case 'steps': return strings(v.items) && v.items.length > 0;
      case 'table': return Array.isArray(v.rows) && v.rows.every(Array.isArray) && v.rows.length > 0 && strings(v.headers) && v.headers.length > 0;
      case 'card': return typeof v.formula === 'string' || typeof v.body === 'string'
        || (Array.isArray(v.terms) && v.terms.every(strings) && v.terms.length > 0);
      case 'mermaid': return typeof v.code === 'string' && v.code.length > 0;
      default: return false;
    }
  });
  return { summary, visuals: ok.slice(0, MAX_VISUALS) };
}

// --- 화면 밖으로 밀려난 창 (맥 OnScreen) ---

/** 창의 60% 이상이 화면 안이면 null(그대로). 아니면 가장 가까운 화면 안쪽 자리. 화면보다 큰 창은 위쪽에 맞춘다 */
function pulledIn(f, v, margin = 8) {
  const w = Math.min(f.x + f.w, v.x + v.w) - Math.max(f.x, v.x);
  const h = Math.min(f.y + f.h, v.y + v.h) - Math.max(f.y, v.y);
  const shown = w > 0 && h > 0 ? w * h : 0;
  if (shown >= f.w * f.h * 0.6) return null;
  const x = Math.min(Math.max(f.x, v.x + margin), v.x + v.w - f.w - margin);
  const y = f.h > v.h ? v.y : Math.min(Math.max(f.y, v.y + margin), v.y + v.h - f.h - margin);
  return { x, y, w: f.w, h: f.h };
}

// --- 화면 위 표시 도형 (맥 MarksView) ---

/** 함께 그릴 줄들의 상자 (줄 번호 → 화면 좌표). 화면 밖으로 나간 줄(hide)은 뺀다 */
function layout(lines, size, hide = []) {
  const seen = new Set(hide);
  const unique = [];
  for (const l of lines) {
    if (seen.has(l.id)) continue;
    seen.add(l.id);
    unique.push(l);
  }
  const raw = unique.map((l) => ({ x: l.box.x * size.width, y: l.box.y * size.height, w: l.box.w * size.width, h: l.box.h * size.height }));
  const out = new Map();
  padded(raw).forEach((r, i) => out.set(unique[i].id, r));
  return out;
}

/** 상자 중심에서 target 쪽으로 나가는 선이 상자 테두리와 만나는 점 (화살표가 상자 안으로 파고들지 않게) */
function edge(r, target) {
  const c = center(r);
  const dx = target.x - c.x;
  const dy = target.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const sx = dx === 0 ? Infinity : r.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : r.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

const arrowShape = (a, b) => ({ kind: 'arrow', from: edge(a, center(b)), to: edge(b, center(a)) });

/**
 * 표시 창에 그릴 도형. 장면을 고르면 그 장면의 짚은 곳(주황, 장면 번호)과 화살표(파랑)만,
 * 아니면 전체: 짚은 곳 ①②③ 과 그림 속 경로(파란 상자·순서 번호·화살표)
 *   { kind: 'focus'|'route', rect, label } · { kind: 'arrow', from, to }
 */
function shapes(model, size) {
  const hide = model.missing ?? [];
  const out = [];
  const sc = model.scene != null ? model.scenes?.[model.scene] : null;
  if (sc) {
    const r = layout([...sc.focus, ...(sc.arrow ? [sc.arrow.from, sc.arrow.to] : [])], size, hide);
    if (sc.arrow && r.has(sc.arrow.from.id) && r.has(sc.arrow.to.id)) {
      const a = r.get(sc.arrow.from.id);
      out.push({ kind: 'route', rect: a, label: null }, arrowShape(a, r.get(sc.arrow.to.id)));
    }
    for (const l of sc.focus) if (r.has(l.id)) out.push({ kind: 'focus', rect: r.get(l.id), label: String(model.scene + 1) });
    return out;
  }
  const steps = model.path?.steps ?? [];
  const r = layout([...(model.marks ?? []).map((m) => m.line), ...steps], size, hide);
  // 경로는 한 칸이라도 화면 밖이면 통째로 숨긴다 (끊긴 화살표는 헷갈린다)
  if (steps.length && steps.every((l) => r.has(l.id))) {
    const rects = steps.map((l) => r.get(l.id));
    for (let i = 0; i + 1 < rects.length; i++) out.push(arrowShape(rects[i], rects[i + 1]));
    rects.forEach((rect, i) => out.push({ kind: 'route', rect, label: String(i + 1) }));
  }
  (model.marks ?? []).forEach((m, i) => {
    if (r.has(m.line.id)) out.push({ kind: 'focus', rect: r.get(m.line.id), label: String(i + 1) });
  });
  return out;
}

/** 지켜볼 모든 줄 (전체 표시 + 모든 장면). 같은 줄은 한 번만 */
function allLines(model) {
  const every = [
    ...(model.marks ?? []).map((m) => m.line),
    ...(model.path?.steps ?? []),
    ...(model.scenes ?? []).flatMap((s) => [...(s.focus ?? []), ...(s.arrow ? [s.arrow.from, s.arrow.to] : [])]),
  ];
  const seen = new Set();
  return every.filter((l) => !seen.has(l.id) && seen.add(l.id));
}

/** 스크롤·창 이동으로 줄이 옮겨 가면 같은 번호의 줄을 새 자리로 (boxes: Map id → box) */
function moveModel(model, boxes) {
  const f = (l) => ({ ...l, box: boxes.get(l.id) ?? l.box });
  return {
    ...model,
    marks: (model.marks ?? []).map((m) => ({ ...m, line: f(m.line) })),
    path: model.path ? { ...model.path, steps: model.path.steps.map(f) } : null,
    scenes: (model.scenes ?? []).map((s) => ({ ...s, focus: s.focus.map(f), arrow: s.arrow ? { from: f(s.arrow.from), to: f(s.arrow.to) } : null })),
  };
}

// --- 카드에 보낼 내용과 화면 표시 (맥 Explainer.present · ask) ---

const cardMarks = (ms) => ms.map((m) => ({ note: m.note, text: m.line.text }));
const hasContent = (model) => allLines(model).length > 0;

/**
 * 설명 결과 → 카드 내용(payload), 화면 표시(model, 그릴 것이 없으면 null), 질문 때 줄 앞의 설명(explanation).
 * visualsResult: { data } 또는 { error } (그림 설명이 실패해도 표시는 보여준다)
 */
function presentation(marksData, visualsResult, lines) {
  const ms = marksData != null ? marks(marksData, lines) : [];
  const p = marksData != null ? path(marksData, lines) : null;
  const payload = { marks: cardMarks(ms) };
  if (p) payload.path = { note: p.note, steps: p.steps.map((l) => l.text) };
  let sc = [];
  let explanation = '';
  if (visualsResult && 'data' in visualsResult) {
    const v = visuals(visualsResult.data);
    payload.summary = v.summary;
    explanation = v.summary;
    payload.visuals = v.visuals;
    sc = scenes(visualsResult.data, lines, v.visuals.length);
    payload.scenes = sc.map((s) => ({ say: s.say, ...(s.visual != null ? { visual: s.visual } : {}), ...(s.reveal != null ? { reveal: s.reveal } : {}) }));
  } else {
    payload.error = `그림 설명을 만들지 못했습니다: ${visualsResult?.error?.message ?? visualsResult?.error ?? ''}`;
  }
  const model = { marks: ms, path: p, scenes: sc, scene: sc.length ? 0 : null, missing: [] };
  return { payload, model: hasContent(model) ? model : null, explanation };
}

/** 질문의 답 → 카드에 붙일 답과 그 답이 짚은 곳. 답 글을 못 읽으면 null */
function answerPresentation(data, lines) {
  const text = answer(data);
  if (text == null) return null;
  const ms = marks(data, lines);
  const model = { marks: ms, path: path(data, lines), scenes: [], scene: null, missing: [] };
  return {
    text,
    payload: { answer: text, marks: cardMarks(ms), visuals: visuals(data).visuals },
    model: hasContent(model) ? model : null,
  };
}

// --- 설명 카드 자리 (맥 ExplainCard). Windows 좌표: 위가 0, 단위는 DIP ---

const CARD = { width: 420, initial: 150, min: 110, max: 0.75 };

const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** 처음 뜰 자리: 작업 영역 오른쪽 위. 녹음 팝업(avoid)과 겹치면 그 왼쪽 */
function cardFrame(work, avoid) {
  const f = { x: work.x + work.width - CARD.width - 20, y: work.y + 20, width: CARD.width, height: CARD.initial };
  if (avoid && overlaps(f, avoid)) f.x = Math.max(work.x + 20, avoid.x - CARD.width - 12);
  return f;
}

/** 높이 h 로 바꾸되 위쪽 가장자리는 두고, 아래가 작업 영역을 넘으면 올린다 (아래 10 띄움) */
function withHeight(frame, h, work) {
  return { ...frame, height: h, y: Math.max(work.y, Math.min(frame.y, work.y + work.height - 10 - h)) };
}

/** 내용 높이 + 제목 막대(chrome)에 맞춘다. 110 이상, 작업 영역의 75% 이하 */
function cardFit(frame, contentHeight, chrome, work) {
  return withHeight(frame, Math.min(Math.max(contentHeight + chrome, CARD.min), work.height * CARD.max), work);
}

/** 질문을 시작하면 75% 높이로 늘리고 고정한다 */
function cardAsked(frame, work) {
  return withHeight(frame, work.height * CARD.max, work);
}

/** AI 에 보낼 사진 크기: 폭이 maxWidth 를 넘을 때만 줄인다 */
function scaledSize(size, maxWidth) {
  const s = Math.min(1, maxWidth / size.width);
  return { width: Math.round(size.width * s), height: Math.round(size.height * s) };
}

// ── 한국어 글자 인식 팩이 없는 PC ──
// 영어 인식기가 한글을 읽으면 "LH 7t Ol" 처럼 짧은 글자·기호 조각이 된다. 그래서 낱말(영문 3자 이상)과 숫자가
// 조각의 40% 도 안 되거나, '?'·대체 문자가 5% 넘게 섞였으면 "깨졌다"고 본다 (글자 조각 8개 미만이면 판단하지 않는다)
const OCR_KO_HINT = 'Windows 설정 → 언어에 한국어를 추가하면 한글 화면을 더 잘 읽습니다';

function needsKoreanOcrHint(ocr) {
  if (!ocr || ocr.koAvailable !== false || !Array.isArray(ocr.lines)) return false;
  const text = ocr.lines.map((l) => String(l?.text ?? '')).join(' ');
  if (/[가-힣]/.test(text)) return false; // 한글이 읽혔다
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 8) return false;
  const real = tokens.filter((t) => /^[("'\[]?[A-Za-z]{3,}[.,:;!?)'"\]]*$/.test(t) || /^[\d.,%:+\-]+$/.test(t)).length;
  const chars = text.replace(/\s/g, '');
  const odd = (chars.match(/[?�]/g) ?? []).length;
  return real / tokens.length < 0.4 || odd / chars.length > 0.05;
}

module.exports = {
  OCR_KO_HINT, needsKoreanOcrHint,
  MAX_SCENES, MAX_MARKS, MAX_PATH_STEPS, MAX_VISUALS, THUMB, CHANGE_LIMIT,
  linesFromOcr, thumbnail, changed, intersects, padded, similarity, sameLine, relocate,
  dropLineRefs, lenientJSON, marks, path, scenes, answer, visuals, pulledIn,
  layout, edge, shapes, allLines, moveModel,
  presentation, answerPresentation, CARD, cardFrame, cardFit, cardAsked, scaledSize,
};
