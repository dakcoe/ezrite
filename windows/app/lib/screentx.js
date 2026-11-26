'use strict';

// 화면 번역 (실험 기능, 1.3.2 예정, 맥 ScreenTranslate 와 같이 맞춰 가는 중): 창 그림의 글자 인식 결과 → 줄 → 문단 → 덮을 자리.
// Electron 없이 시험한다. 좌표는 그림 픽셀. scale = 그림 픽셀 / 1배 px (맥 pt). 2배 그림이면 2.
//
// Windows.Media.Ocr 는 맥과 달리 줄(OcrLine)과 그 안 낱말(OcrWord) 상자를 준다 (helper ocr 의 words).
//   - 맥 1차의 "한 줄이 여러 조각으로 쪼개짐" 은 Windows 에서는 거의 없다. 대신 OCR 이 먼 칸(두 단·표·설정 줄의 단추)을
//     한 줄로 묶을 수 있어, 낱말 사이가 줄 높이의 1.6배를 넘으면 그 줄을 자른다 (splitLine).
//   - 자른 조각은 맥 규칙(세로 60% 겹침·높이 비 1.5 미만·가로 사이 -0.5~1.6×높이)으로 다시 합친다 (mergeSegments).
// 문단 묶기·코드·목록·글자색·바탕색·굵기·글자 크기·첫 글자 놓침 보정 수치는 맥 2차 방식과 같다 (handoff-windows-screen-translate.md).

const LINE = Object.freeze({ overlap: 0.6, heightRatio: 1.5, gapMin: -0.5, gapMax: 1.6 });
const PARA = Object.freeze({ heightRatio: 1.3, gap: 0.9, left: 1.0, color: 0.22, shortLine: 0.7 }); // heightRatio: 잰 글자 크기 비
const EDGE_PT = 3; // 창 위·아래 끝에 걸린 문단은 반쯤 잘렸다고 보고 번역하지 않는다
const BATCH = 12; // 한 번에 옮길 문단 수
const X_HEIGHT = 0.52; // 라틴 x 높이 / 글자 크기
const CJK_HEIGHT = 0.8; // 한중일 글자 몸통 / 글자 크기
const CAP_HEIGHT = 0.7; // 대문자·숫자 높이 / 글자 크기 (대문자·숫자가 소문자보다 많은 줄)
const COVER_PAD = 0.12; // 덮개 위아래 여백 (× 줄 높이)

const SCREEN_PROMPT = 'Translate numbered paragraphs of on-screen text (UI labels, documents, slides, web pages) into natural Korean. '
  + 'Output only "N. translation", one per line, for every number. The text comes from OCR, so fix obvious recognition slips '
  + '(0 for o, 5 for s, 1 for l) silently. Keep code, commands, file names, URLs, numbers, math, and proper nouns as they are. '
  // 맥 2차: 모델이 문맥에서 내용을 보태거나(잘린 조각을 완성해 같은 내용이 두 번 보임) 제목·메뉴를 그대로 두던 것.
  // "translate the fragment as it is" 라고 썼더니 "as it is" 를 원문 그대로 두라는 뜻으로 읽었다 (그 말은 쓰지 않는다)
  + 'Translate only the text of each paragraph. Do not add or complete content from context or other paragraphs; '
  + 'if a paragraph looks like a cut-off fragment, translate just that fragment into Korean. '
  + 'Book titles, headings, menus, and buttons are ordinary words: translate them too. Leave text unchanged only when it is '
  + 'already Korean or is pure code, a URL, a number, or a name. '
  // 맥 Haiku: "9.1 정상성과 차분 (Stationarity and differencing)" 처럼 영어를 붙여 글이 길어졌다
  + 'You may add the English term in parentheses only the first time it appears inside a sentence; never in titles, headings, menus, or labels. No notes.';

// ── 상자 ──

const right = (b) => b.x + b.w;
const bottom = (b) => b.y + b.h;
function union(boxes) {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map(right)) - x, h: Math.max(...boxes.map(bottom)) - y };
}
function median(v) {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const vOverlap = (a, b) => Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y));

// ── 줄: OCR 줄을 먼 낱말 사이에서 자르고, 같은 줄의 조각을 다시 합친다 ──

/** OCR 줄 하나 → 조각들 { box, words, text }. 낱말 사이가 줄 높이 × gapMax 를 넘으면 자른다 */
function splitLine(line) {
  const words = (line.words?.length ? line.words : [{ text: line.text, x: line.x, y: line.y, w: line.w, h: line.h }])
    .filter((w) => w.w > 0 && w.h > 0).sort((a, b) => a.x - b.x);
  if (!words.length) return [];
  const h = median(words.map((w) => w.h)) || line.h;
  const parts = [[words[0]]];
  for (const w of words.slice(1)) {
    const prev = parts.at(-1).at(-1);
    if (w.x - right(prev) > LINE.gapMax * h) parts.push([w]);
    else parts.at(-1).push(w);
  }
  if (parts.length === 1) return [{ box: union(words), words, text: String(line.text ?? words.map((w) => w.text).join(' ')).trim() }];
  return parts.map((ws) => ({ box: union(ws), words: ws, text: joinWords(ws) }));
}

/** 낱말 잇기: 라틴은 띄우고, 한중일 글자끼리 붙어 있던 것은 그대로 붙인다 (OCR 이 한글 어절을 낱말로 준다) */
function joinWords(ws) {
  let out = '';
  for (const w of ws) out += (out ? ' ' : '') + w.text;
  return out.trim();
}

/** 맥 줄 합치기: 세로 60% 넘게 겹침, 높이 비 1.5 미만, 가로 사이 -0.5 ~ 1.6 × 높이 */
function sameLine(a, b) {
  // 세로로 선 조각(높이 > 폭×1.2, 그래프 축 이름 등)은 옆 조각과 잇지 않는다 (맥)
  if (a.box.h > a.box.w * 1.2 || b.box.h > b.box.w * 1.2) return false;
  const h = Math.min(a.box.h, b.box.h);
  const H = Math.max(a.box.h, b.box.h);
  if (vOverlap(a.box, b.box) < LINE.overlap * h || H / h >= LINE.heightRatio) return false;
  const [l, r] = a.box.x <= b.box.x ? [a, b] : [b, a];
  const gap = r.box.x - right(l.box);
  return gap >= LINE.gapMin * H && gap <= LINE.gapMax * H;
}

/** 조각들 → 줄들 (같은 줄 조각은 왼쪽부터 잇는다). 위에서 아래, 왼쪽에서 오른쪽 */
function mergeSegments(segments) {
  const lines = [];
  const sorted = [...segments].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  for (const s of sorted) {
    const hit = lines.find((l) => sameLine(l, s));
    if (!hit) {
      lines.push({ ...s, words: [...s.words] });
      continue;
    }
    const [first, second] = hit.box.x <= s.box.x ? [hit, s] : [s, hit];
    hit.text = `${first.text} ${second.text}`.trim();
    hit.words = [...first.words, ...second.words];
    hit.box = union([hit.box, s.box]);
  }
  return lines.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}

/** OCR 결과({ lines: [{ text, x, y, w, h, words }] }) → 줄 */
function linesFromOcr(ocr) {
  const segments = (ocr?.lines ?? []).flatMap(splitLine);
  return { segments, lines: mergeSegments(segments) };
}

// ── 그림 화소 ──

/** bitmap: { width, height, data: BGRA } */
function pixel(bmp, x, y) {
  const i = (y * bmp.width + x) * 4;
  return [bmp.data[i + 2], bmp.data[i + 1], bmp.data[i]];
}
/** 두 색의 차 (0~1, 채널 차의 최대) */
const dist = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])) / 255;
const clampBox = (bmp, b) => {
  const x0 = Math.max(0, Math.floor(b.x));
  const y0 = Math.max(0, Math.floor(b.y));
  const x1 = Math.min(bmp.width, Math.ceil(b.x + b.w));
  const y1 = Math.min(bmp.height, Math.ceil(b.y + b.h));
  return { x0, y0, x1, y1 };
};

/** 바탕색: 상자 바로 바깥 띠(1~4 px 밖)의 화소를 16단계로 나눈 최빈값의 평균 (형광펜·선택 강조도 맞게) */
function background(bmp, box) {
  const counts = new Map();
  const add = (x, y) => {
    if (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) return;
    const p = pixel(bmp, x, y);
    const k = ((p[0] >> 4) << 8) | ((p[1] >> 4) << 4) | (p[2] >> 4);
    const c = counts.get(k) ?? { n: 0, s: [0, 0, 0] };
    c.n += 1;
    c.s[0] += p[0]; c.s[1] += p[1]; c.s[2] += p[2];
    counts.set(k, c);
  };
  const { x0, y0, x1, y1 } = clampBox(bmp, box);
  for (let d = 1; d <= 4; d++) {
    for (let x = x0 - d; x < x1 + d; x++) { add(x, y0 - d); add(x, y1 - 1 + d); }
    for (let y = y0; y < y1; y++) { add(x0 - d, y); add(x1 - 1 + d, y); }
  }
  let best = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return best ? best.s.map((v) => Math.round(v / best.n)) : [255, 255, 255];
}

/** 글자색: 줄 가운데 60% 띠에서 바탕과 0.3 넘게 다른 화소 중, 가장 먼 것의 75% 이상만 평균 (번진 가장자리 제외) */
function textColor(bmp, box, bg) {
  const { x0, x1 } = clampBox(bmp, box);
  const ya = Math.max(0, Math.floor(box.y + box.h * 0.2));
  const yb = Math.min(bmp.height, Math.ceil(box.y + box.h * 0.8));
  const ink = [];
  let far = 0;
  for (let y = ya; y < yb; y++) {
    for (let x = x0; x < x1; x++) {
      const p = pixel(bmp, x, y);
      const d = dist(p, bg);
      if (d > 0.3) {
        ink.push([p, d]);
        if (d > far) far = d;
      }
    }
  }
  const keep = ink.filter(([, d]) => d >= 0.75 * far);
  if (!keep.length) return bg.reduce((a, b) => a + b, 0) / 3 > 128 ? [0, 0, 0] : [255, 255, 255];
  const s = [0, 0, 0];
  for (const [p] of keep) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; }
  return s.map((v) => Math.round(v / keep.length));
}

/**
 * 첫·끝 글자 놓침 보정: 상자 밖으로 줄 높이 1.2배까지 걸어가며 글자색과 비슷한 화소가 있는 열을 따라 넓힌다
 * (빈 열이 0.3×높이 넘게 이어지면 멈춤). "바탕과 다른 화소" 기준은 형광펜 띠 바깥 흰색을 글자로 봐서 실패했다 (맥)
 */
/**
 * 목록 머리표(•·▪ 그림): OCR 은 글자가 아니라서 읽지 않는다. 줄 왼쪽 1.6×높이 안에 떨어져 있는 작은 덩어리
 * (폭·높이 0.6×높이 이하, 글자와 0.2×높이 넘게 떨어짐)가 있으면 머리표. 그 오른쪽 끝 x, 없으면 null
 */
function bullet(bmp, box, bg) {
  const h = box.h;
  const ya = Math.max(0, Math.floor(box.y));
  const yb = Math.min(bmp.height, Math.ceil(box.y + h));
  const inkRows = (x) => {
    const rows = [];
    for (let y = ya; y < yb; y++) if (dist(pixel(bmp, x, y), bg) > 0.3) rows.push(y);
    return rows;
  };
  const x0 = Math.floor(box.x);
  let x = x0 - 1;
  const gapEnd = x0 - Math.ceil(0.2 * h);
  // 글자 바로 왼쪽은 비어 있어야 한다 (붙어 있으면 놓친 첫 글자)
  for (; x > gapEnd && x >= 0; x--) if (inkRows(x).length) return null;
  let blob = null;
  for (; x >= Math.max(0, x0 - 1.6 * h); x--) {
    const rows = inkRows(x);
    if (rows.length) {
      blob = blob ?? { right: x, left: x, top: rows[0], bottom: rows.at(-1) };
      blob.left = x;
      blob.top = Math.min(blob.top, rows[0]);
      blob.bottom = Math.max(blob.bottom, rows.at(-1));
    } else if (blob) break;
  }
  if (!blob) return null;
  const w = blob.right - blob.left + 1;
  const bh = blob.bottom - blob.top + 1;
  return w <= 0.6 * h && bh <= 0.6 * h && w >= 0.08 * h ? blob.right : null;
}

function extend(bmp, box, color, bg, stopLeft = -Infinity) {
  const ya = Math.max(0, Math.floor(box.y));
  const yb = Math.min(bmp.height, Math.ceil(box.y + box.h));
  const near = (x) => {
    for (let y = ya; y < yb; y++) {
      const p = pixel(bmp, x, y);
      if (dist(p, color) < 0.25 && dist(p, color) < dist(p, bg)) return true;
    }
    return false;
  };
  const walk = (start, step) => {
    let edge = start;
    let empty = 0;
    for (let d = 1; d <= 1.2 * box.h; d++) {
      const x = start + step * d;
      if (x < 0 || x >= bmp.width || x <= stopLeft) break;
      if (near(x)) {
        edge = x;
        empty = 0;
      } else if (++empty > 0.3 * box.h) break;
    }
    return edge;
  };
  const x0 = Math.floor(box.x);
  const x1 = Math.ceil(box.x + box.w) - 1;
  // 번진 가장자리(글자색과 덜 비슷한 화소)까지 덮게 양옆 max(2, 0.08×높이) (머리표 쪽은 넘지 않게)
  const m = Math.max(2, Math.ceil(0.08 * box.h));
  const l = Math.max(walk(x0, -1) - m, Number.isFinite(stopLeft) ? stopLeft + 1 : 0, 0);
  const r = Math.min(walk(x1, 1) + m, bmp.width - 1);
  return { x: l, y: box.y, w: r - l + 1, h: box.h };
}

const isCJK = (c) => /[぀-ヿ㐀-鿿가-힣ᄀ-ᇿ㄰-㆏]/.test(c);
const isLatin = (c) => /[A-Za-z]/.test(c);

/**
 * 줄의 글자 크기 (1배 px): 글자 화소 행 분포에서 가장 빽빽한 띠(최대값의 40% 이상인 행이 이어진 것, 최대 행을 품는 것)
 * = 라틴 x 높이 → 띠 / 0.52. 한중일 글자가 과반이면 / 0.8. 상자 높이로 정하면 g·p 꼬리 유무로 들쭉날쭉했다 (맥)
 * 함께 굵기 판단용 글자 화소 비율(ink)도 돌려준다
 */
function measure(bmp, box, bg, text, scale) {
  const { x0, y0, x1, y1 } = clampBox(bmp, box);
  const rows = [];
  let total = 0;
  for (let y = y0; y < y1; y++) {
    let n = 0;
    for (let x = x0; x < x1; x++) if (dist(pixel(bmp, x, y), bg) > 0.3) n++;
    rows.push(n);
    total += n;
  }
  const max = Math.max(0, ...rows);
  const peak = rows.indexOf(max);
  let a = peak;
  let b = peak;
  while (a > 0 && rows[a - 1] >= 0.4 * max) a--;
  while (b < rows.length - 1 && rows[b + 1] >= 0.4 * max) b++;
  const band = max ? b - a + 1 : box.h * X_HEIGHT;
  const chars = [...String(text)];
  const cjk = chars.filter(isCJK).length > chars.filter((c) => /\S/.test(c)).length / 2;
  // 대문자·숫자가 소문자보다 많으면 빽빽한 띠는 x 높이가 아니라 대문자 높이 (맥 2차: 띠 / 0.7)
  const caps = !cjk && chars.filter((c) => /[A-Z0-9]/.test(c)).length > chars.filter((c) => /[a-z]/.test(c)).length;
  // 글자 줄(baseline) = 빽빽한 띠의 아래 끝 (라틴 x 높이 띠·한글 몸통 아래). 번역도 이 줄에 맞춰 쓴다
  const baseline = max ? y0 + b + 1 : box.y + box.h * 0.8;
  return { size: band / (cjk ? CJK_HEIGHT : caps ? CAP_HEIGHT : X_HEIGHT) / scale, ink: total / Math.max(1, (x1 - x0) * (y1 - y0)), cjk, baseline };
}

// ── 줄 종류 ──

const LIST_HEAD = /^\s*(?:[•·–\-*▪◦●○■□➢►]|\(?\d{1,3}[.)]|[a-zA-Z][.)])\s+/;
const BULLET_WORD = /^[•·▪◦●○■□➢►▸‣\-–*]$/;
const COMMENT = /^\s*(?:#|\/\/|--\s)/;
const KEYWORD = /^\s*(?:def|return|import|from|func|function|let|var|const|class|for|while|if|elif|else|try|except|catch|public|private|static|void|int|fn|use|package|#include)\b/;

/** 코드 줄: 기호 =(){};[]<> 3개 이상, 또는 키워드로 시작하고 기호 1개 이상, 또는 호출(foo(x))로 끝나며 : = ; { 가 있다 */
function isCode(text) {
  const t = String(text);
  if (COMMENT.test(t)) return false;
  const sym = (t.match(/[={}[\]<>;]/g) ?? []).length;
  const call = /[A-Za-z_][\w]*\(/.test(t); // 이름( — "(a)" 처럼 괄호만인 것은 아니다
  const method = /\w\.\w+\(/.test(t); // model.update(
  if (sym >= 2 || method) return true;
  if (/^\s*[A-Za-z_][\w.[\]]*\s*[-+*/]?=\s*\S/.test(t)) return true; // 대입 (x = 1, lr += 0.1)
  if (sym >= 1 && call) return true;
  if (KEYWORD.test(t) && (sym >= 1 || call)) return true;
  return call && /[:;{]\s*$/.test(t);
}

function kindOf(text) {
  if (COMMENT.test(text)) return 'comment';
  if (isCode(text)) return 'code';
  if (LIST_HEAD.test(text)) return 'list';
  return 'text';
}

/** 이미 한국어인 글 (한글이 라틴 글자의 절반 이상) */
function isKorean(text) {
  const c = [...String(text)];
  const ko = c.filter((x) => /[가-힣]/.test(x)).length;
  return ko > 0 && ko >= c.filter(isLatin).length / 2;
}

/**
 * 한국어 OCR 로 영어를 읽을 때 생기는 글자 혼동 고치기 (Windows: 영어 인식 팩이 없는 PC 가 많다).
 *   소문자 낱말에 0·1·5·| 가 섞이면 o·l·s·l ("100p"→"loop", "0f"→"of", "|00k"→"look"), 소문자로 시작해 대문자가 이어지면 소문자 ("tWO"→"two").
 *   숫자+단위(10k·5ms·50px·1st)와 숫자만인 것(1055, 50)은 그대로 — 그건 번역 모델에 맡긴다 (프롬프트에 적었다)
 */
const UNIT = /^\d+(?:k|m|s|ms|px|pt|em|kb|mb|gb|x|st|nd|rd|th|min|h|d|g|kg|cm|mm|km|fps|hz)$/;
function fixOcr(text) {
  return String(text).split(/(\s+)/).map((tok) => {
    const m = /^([("'[]*)(.*?)([)"'\].,:;!?]*)$/.exec(tok);
    if (!m || !m[2]) return tok;
    let w = m[2];
    if (/^[a-z015|]+$/.test(w) && /[a-z]/.test(w) && /[015|]/.test(w) && !UNIT.test(w)) w = w.replace(/0/g, 'o').replace(/[1|]/g, 'l').replace(/5/g, 's');
    else if (/^[a-z][A-Z]+$/.test(w)) w = w.toLowerCase();
    return m[1] + w + m[3];
  }).join('');
}

/** 기억 열쇠: 공백 정규화한 문단 글 */
const memoryKey = (text) => String(text).replace(/\s+/g, ' ').trim();

// ── 문단 ──

/** 윗줄 다음에 이 줄을 같은 문단으로 이어 붙일까 (맥 문단 묶기) */
function continues(para, line) {
  const last = para.lines.at(-1);
  if (para.kind === 'code' || para.kind === 'comment' || line.kind !== 'text') return false;
  const h = Math.min(last.box.h, line.box.h);
  const H = Math.max(last.box.h, line.box.h);
  // 높이 비는 OCR 상자가 아니라 잰 글자 크기로: 꼬리·윗부분 없는 짧은 끝줄("be trained.")은 상자가 낮아 1.3배로 나와 잘렸다 (100% 배율 시험)
  const sa = last.size ?? last.box.h;
  const sb = line.size ?? line.box.h;
  if (Math.max(sa, sb) / Math.min(sa, sb) >= PARA.heightRatio) return false;
  const gap = line.box.y - bottom(last.box);
  if (gap < -0.3 * h || gap >= PARA.gap * H) return false;
  if (Math.abs(line.box.x - para.box.x) >= PARA.left * H && Math.abs(line.box.x - last.box.x) >= PARA.left * H) return false;
  if (dist(last.color, line.color) >= PARA.color) return false;
  // 윗줄이 문단 폭의 70% 미만에서 . ! ? : 로 끝나면 문단 끝
  if (/[.!?:]\s*$/.test(last.text) && last.box.w < PARA.shortLine * para.box.w) return false;
  return true;
}

/** 줄 글 잇기: 줄 끝 하이픈 + 소문자 시작이면 낱말을 붙인다 */
function joinLines(lines) {
  let out = '';
  for (const l of lines) {
    const t = l.text.trim();
    if (!out) out = t;
    else if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(t)) out = out.slice(0, -1) + t;
    else out += ` ${t}`;
  }
  return out;
}

/** 줄들 → 문단들. 한 줄씩 위에서 내려오며, 바로 위에서 이어지는 열린 문단에 붙인다 (두 단이면 각 단의 문단에) */
function paragraphs(lines) {
  const paras = [];
  for (const line of lines) {
    const open = paras.filter((p) => p.lines.at(-1).box.y < line.box.y && continues(p, line));
    // 가장 가까운(아래 끝이 가장 아래인) 문단
    const p = open.sort((a, b) => bottom(b.lines.at(-1).box) - bottom(a.lines.at(-1).box))[0];
    if (p) {
      p.lines.push(line);
      p.box = union([p.box, line.box]);
    } else {
      // 코드 줄은 이어진 코드 줄끼리 한 덩어리 (번역하지 않는다)
      const code = line.kind === 'code' && paras.find((q) => q.kind === 'code' && Math.abs(line.box.y - bottom(q.box)) < PARA.gap * line.box.h);
      if (code) {
        code.lines.push(line);
        code.box = union([code.box, line.box]);
        continue;
      }
      paras.push({ kind: line.kind === 'list' ? 'text' : line.kind, list: line.kind === 'list', lines: [line], box: { ...line.box } });
    }
  }
  for (const p of paras) p.text = p.kind === 'code' ? joinLines(p.lines) : fixOcr(joinLines(p.lines));
  return paras;
}

/** 비슷한(±12%) 크기의 문단끼리 같은 크기로 (작은 것부터 묶어 묶음의 중앙값) */
function harmonize(sizes) {
  const order = sizes.map((s, i) => [s, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(sizes.length);
  let group = [];
  const flush = () => {
    const m = median(group.map(([s]) => s));
    for (const [, i] of group) out[i] = m;
    group = [];
  };
  for (const g of order) {
    if (group.length && g[0] > group[0][0] * 1.12) flush();
    group.push(g);
  }
  if (group.length) flush();
  return out;
}

/**
 * x0~x1 · y0~y1 띠에 글자색에 가깝고(0.25 안) 바탕과 다른(0.3 넘게) 화소가 띠 넓이의 0.3% 넘게(최소 6점) 있나 (읽지 못한 글자 조각, 맥과 같은 수치).
 * 바탕과 다르기만 한 것으로 세면 단추 위 어두운 바탕을 글자로 봤다 (설정 화면 [Change])
 */
function inkBetween(bmp, x0, x1, y0, y1, bg, color) {
  const ya = Math.max(0, Math.floor(y0));
  const yb = Math.min(bmp.height, Math.ceil(y1));
  const xa = Math.max(0, Math.floor(x0));
  const xb = Math.min(bmp.width, Math.ceil(x1));
  if (yb <= ya || xb <= xa) return false;
  let n = 0;
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const q = pixel(bmp, x, y);
      if (dist(q, bg) > 0.3 && dist(q, color) < 0.25) n++;
    }
  }
  return n > Math.max(6, 0.003 * (yb - ya) * (xb - xa));
}

/**
 * 내용 칸의 위·아래 경계 (맥 2차): 그림 위 30%·아래 20% 에서, 폭의 85% 넘는 열이 윗줄과 색이 바뀌는 가로선.
 * 브라우저 도구막대·탭 줄 아래(위 경계는 가장 아래 것), 상태 막대 위(아래 경계는 가장 위 것). 없으면 null
 */
function contentEdges(bmp) {
  const changed = (y) => {
    let n = 0;
    let all = 0;
    for (let x = 0; x < bmp.width; x += 2) {
      all++;
      if (dist(pixel(bmp, x, y), pixel(bmp, x, y - 1)) > 0.06) n++;
    }
    return n > 0.85 * all;
  };
  let top = null;
  for (let y = 1; y < Math.floor(bmp.height * 0.3); y++) if (changed(y)) top = y;
  let end = null;
  for (let y = bmp.height - 1; y > Math.ceil(bmp.height * 0.8); y--) if (changed(y)) end = y;
  return { top, bottom: end };
}

/**
 * 그림 한 장 분석: OCR + 화소 → 줄·문단·덮을 덩어리.
 * 돌려주는 blocks: { key, text, kind, translate(옮길지), cut(끝에 걸림), box(덮을 자리), bg, color, bold, size(1배 px), lineGap(× size), lines }
 */
function analyze({ ocr, bitmap, scale = 1 }) {
  const { segments, lines } = linesFromOcr(ocr);
  for (const l of lines) {
    l.kind = kindOf(l.text);
    // Windows OCR 은 머리표 "•" 를 낱말로 읽는다: 글·덮개에서 빼고(머리표는 그대로 보이게) 목록 머리로
    if (l.words.length > 1 && BULLET_WORD.test(l.words[0].text)) {
      l.words = l.words.slice(1);
      l.box = union(l.words);
      l.text = l.text.replace(/^\s*\S+\s*/, '');
      if (l.kind === 'text') l.kind = 'list';
    }
    l.bg = background(bitmap, l.box);
    l.color = textColor(bitmap, l.box, l.bg);
    // 머리표가 있으면 목록 머리 (머리표는 덮지 않는다: 넓히기가 그 앞에서 멈춘다)
    const mark = bullet(bitmap, l.box, l.bg);
    if (mark != null && l.kind === 'text') l.kind = 'list';
    l.box = extend(bitmap, l.box, l.color, l.bg, mark ?? -Infinity);
    const m = measure(bitmap, l.box, l.bg, l.text, scale);
    l.size = m.size;
    l.baseline = m.baseline;
    l.ink = m.ink;
    l.cjk = m.cjk;
  }
  // 굵기: 글자 화소 비율이 이 화면 줄들의 중앙값 × 1.3 을 넘으면 (절대 임계값은 글꼴마다 달라 실패, 맥)
  const inkMid = median(lines.map((l) => l.ink));
  for (const l of lines) l.bold = l.ink > inkMid * 1.3;

  const paras = paragraphs(lines);
  // 문단 크기: 줄별 추정의 가운데값 (두 줄이면 작은 쪽, 맥 2차), 줄 상자 높이 × 1.3 을 넘지 않게
  const sizes = harmonize(paras.map((p) => {
    const est = p.lines.length === 2 ? Math.min(...p.lines.map((l) => l.size)) : median(p.lines.map((l) => l.size));
    return Math.min(est, (median(p.lines.map((l) => l.box.h)) / scale) * 1.3);
  }));
  const edges = contentEdges(bitmap);
  /**
   * 오른쪽 빈자리 (Windows 에서 더한 것): 번역이 원문보다 길 때 글자를 줄이기 전에 덮개를 오른쪽으로 넓힌다.
   * 덮개 높이 안의 열이 모두 바탕색(차 0.08 미만)인 동안, 다른 문단에 닿기 전까지, 창 오른쪽 끝 4pt 앞까지
   */
  const roomRight = (box, bg, others) => {
    const ya = Math.max(0, Math.floor(box.y));
    const yb = Math.min(bitmap.height, Math.ceil(box.y + box.h));
    const limit = Math.min(bitmap.width - 4 * scale, ...others.filter((o) => vOverlap(o, box) > 0 && o.x >= right(box)).map((o) => o.x - 2 * scale));
    let x = Math.ceil(right(box));
    for (; x < limit; x++) {
      let clear = true;
      for (let y = ya; y < yb && clear; y += 2) if (dist(pixel(bitmap, x, y), bg) >= 0.08) clear = false;
      if (!clear) break;
    }
    // 원래 폭의 1.6배까지 (맥 2차)
    return Math.min(Math.round(0.6 * box.w), Math.max(0, x - Math.ceil(right(box)) - Math.round(2 * scale)));
  };
  const blocks = paras.map((p, i) => {
    const h = median(p.lines.map((l) => l.box.h));
    const tops = p.lines.map((l) => l.box.y);
    const gaps = tops.slice(1).map((t, k) => t - tops[k]);
    const size = sizes[i];
    const pad = COVER_PAD * h;
    // 덮개 위아래: OCR 상자 + 0.12×높이 에 더해, 번역 한글이 들어갈 만큼 (글자 줄 위 0.9·아래 0.22 × 크기).
    // 꼬리 없는 영어 줄(Location services)은 OCR 상자가 낮아 한글 윗부분이 잘렸다
    const S = size * scale;
    const top = Math.min(p.box.y - pad, p.lines[0].baseline - 0.9 * S);
    const end = Math.max(bottom(p.box) + pad, p.lines.at(-1).baseline + 0.22 * S);
    // 잘림: 창 위·아래 끝, 또는 브라우저 도구막대 같은 가로 경계에 줄 높이 0.5배 안으로 붙은 문단 (스크롤에 잘린 것, 맥 2차).
    // Windows 에서 찾은 것(맥도 받아들임): OCR 은 반쯤 가려진 줄을 아예 안 읽어서 문단이 둘째 줄부터 시작한다 (경계에서 1줄 넘게 떨어짐).
    // 그래서 바로 위(아래) 경계 하나와 문단 사이(줄 높이 2.5배 안)에 다른 인식 줄이 없는데 글자색에 가까운 화소가 있으면 잘린 것.
    // 창 위·아래 끝도 경계로 본다. 경계선·그림자는 세지 않게 경계에서 3pt 떨어진 곳부터 센다 (맥 오탐 보정)
    const upper = edges.top != null && p.box.y >= edges.top ? edges.top : 0;
    const lower = edges.bottom != null && bottom(p.box) <= edges.bottom ? edges.bottom : bitmap.height;
    const others = (y0, y1) => lines.some((l) => !p.lines.includes(l) && l.box.y < y1 && bottom(l.box) > y0 && l.box.x < right(p.box) && right(l.box) > p.box.x);
    const fragment = (y0, y1, ln) => y1 - y0 < 2.5 * h && !others(y0, y1)
      && inkBetween(bitmap, p.box.x, right(p.box), y0, y1, ln.bg, ln.color);
    const cut = top < EDGE_PT * scale || end > bitmap.height - EDGE_PT * scale
      || (edges.top != null && p.box.y >= edges.top && p.box.y - edges.top < 0.5 * h)
      || (edges.bottom != null && bottom(p.box) <= edges.bottom && edges.bottom - bottom(p.box) < 0.5 * h)
      || fragment(upper + EDGE_PT * scale, p.box.y - 2, p.lines[0])
      || fragment(bottom(p.box) + 2, lower - EDGE_PT * scale, p.lines.at(-1));
    // 그래프 세로 축 이름 (상자가 폭×0.9 보다 높다)은 옮기지 않는다
    const vertical = p.box.h > p.box.w * 0.9;
    const korean = isKorean(p.text);
    return {
      key: memoryKey(p.text),
      text: p.text,
      kind: p.kind,
      list: p.list,
      korean,
      cut,
      vertical,
      // 숫자가 글자보다 많은 문단(그래프 눈금·날짜 줄 "Jan 2015 Apr 2015 …")은 옮기지 않는다 (맥)
      numeric: (p.text.match(/\d/g) ?? []).length > (p.text.match(/\p{L}/gu) ?? []).length,
      translate: p.kind !== 'code' && !korean && !cut && !vertical && /[A-Za-z]{2,}/.test(p.text)
        && (p.text.match(/\d/g) ?? []).length <= (p.text.match(/\p{L}/gu) ?? []).length,
      box: { x: p.box.x, y: top, w: p.box.w, h: end - top },
      baseline: p.lines[0].baseline, // 첫 줄 글자 줄 (그림 px)
      bg: p.lines[0].bg,
      color: p.lines[0].color,
      bold: p.lines.filter((l) => l.bold).length * 2 > p.lines.length,
      size,
      // 여러 줄: 원래 줄 머리 사이 중앙값 (글자 크기 비율로 유지). 한 줄: 1.25
      lineGap: gaps.length ? median(gaps) / scale / size : 1.25,
      lines: p.lines.length,
      lineH: h, // 원래 줄 상자 높이 (그림 px)
      pad, // 덮개 위아래 여백 (그림 px)
    };
  });
  const roomLeft = (box, bg) => {
    const ya = Math.max(0, Math.floor(box.y));
    const yb = Math.min(bitmap.height, Math.ceil(box.y + box.h));
    let x = Math.floor(box.x) - 1;
    for (; x >= 0; x--) {
      let clear = true;
      for (let y = ya; y < yb && clear; y += 2) if (dist(pixel(bitmap, x, y), bg) >= 0.08) clear = false;
      if (!clear) break;
    }
    return Math.floor(box.x) - 1 - x;
  };
  for (const b of blocks) {
    b.room = roomRight(b.box, b.bg, blocks.filter((o) => o !== b).map((o) => o.box));
    // 단추·칸 속 가운데 글: 한 줄이고 양옆 빈자리가 둘 다 2×줄 높이 안쪽이며 비슷하면(차 25% 안) 번역도 가운데에
    const left = roomLeft(b.box, b.bg);
    const rightRoom = b.room + Math.round(2 * scale);
    // (형광펜처럼 양옆 여백이 없는 칸은 아니다: 둘 다 0.3×줄 높이 넘게 비어야)
    b.center = b.lines === 1 && Math.min(left, rightRoom) >= 0.3 * b.lineH && left < 2 * b.lineH && rightRoom < 2 * b.lineH
      && Math.abs(left - rightRoom) <= 0.25 * Math.max(left, rightRoom) + 2 * scale;
    if (b.center) b.room = 0; // 칸 안에서만
  }
  return { segments, lines, blocks };
}

/** 옮길 문단 (기억에 없는 것만, 같은 글은 한 번). 12개씩 */
function pending(blocks, memory) {
  const keys = [...new Set(blocks.filter((b) => b.translate && !memory.has(b.key)).map((b) => b.key))];
  const batches = [];
  for (let i = 0; i < keys.length; i += BATCH) batches.push(keys.slice(i, i + BATCH));
  return batches;
}

/** 번역이 원문과 같으면(코드·이름) 덮지 않는다 */
function covers(block, translated) {
  return translated != null && memoryKey(translated) !== block.key && memoryKey(translated).length > 0;
}

module.exports = {
  LINE, PARA, BATCH, SCREEN_PROMPT, X_HEIGHT, CJK_HEIGHT,
  contentEdges, splitLine, mergeSegments, linesFromOcr, background, textColor, bullet, extend, measure, isCode, kindOf, isKorean, memoryKey, fixOcr,
  paragraphs, joinLines, harmonize, analyze, pending, covers, union, median, dist,
};
