'use strict';
require('./guard'); // 오류가 나도 화면에 창을 띄우지 않고 종료 코드 1
// 화면 번역 그림 시험 (맥 EZRITE_TRANSLATE_IMAGE 와 같은 방식). 사용자 화면은 건드리지 않는다: 그림 파일만 읽는다.
//   EZRITE_TRANSLATE_IMAGE=<png 또는 폴더> EZRITE_TRANSLATE_OUT=<폴더> [EZRITE_TRANSLATE_FAKE=1] [EZRITE_TRANSLATE_SCALE=2] npx electron scripts/translate-image.js
// 그림마다 <이름>.covered.png(덮은 그림)·<이름>.boxes.png(빨강 낱말·초록 줄·파랑 문단) 와 결과 JSON 한 줄.
// 같은 폴더에 truth.json(scripts/make-translate-samples.js)이 있으면 문단별 글자 크기 추정 오차도 낸다.
// 스크롤 기억 시험: 그림을 위로 37pt 밀어 다시 읽고, 처음 읽은 문단 중 몇 개가 같은 열쇠로 다시 나오는지 (맥 1차 실패 1).
// FAKE 가 아니면 Groq 로 옮긴다 (설정의 Groq 키, 키는 어디에도 남기지 않는다).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow, nativeImage } = require('electron');
const ST = require('../lib/screentx');
const { helperCandidates } = require('../lib/ui');

const IMAGE = process.env.EZRITE_TRANSLATE_IMAGE;
const OUT = process.env.EZRITE_TRANSLATE_OUT || path.join(os.tmpdir(), 'ezrite-translate-out');
const FAKE = ['1', 'true'].includes(String(process.env.EZRITE_TRANSLATE_FAKE ?? '').toLowerCase());
const SCALE = Number(process.env.EZRITE_TRANSLATE_SCALE) || 2;
const SCROLL_PT = 37;

const helper = helperCandidates({ packaged: false, appDir: path.join(__dirname, '..') }).find((p) => fs.existsSync(p));
const ocrOf = (file) => JSON.parse(execFileSync(helper, ['ocr', file], { encoding: 'utf8', windowsHide: true }));

/** 가짜 번역: 영어 글자 수의 0.55배쯤 되는 한글 (실제 번역과 비슷한 길이로 자리 맞추기를 본다) */
function fake(text) {
  const syl = '가나다라마바사아자차카타파하거너더러머버서어저처';
  const n = Math.max(2, Math.round(text.replace(/\s/g, '').length * 0.55));
  let s = '';
  for (let i = 0; i < n; i++) s += syl[(i * 7 + text.length) % syl.length] + ((i % 4 === 3 && i < n - 1) ? ' ' : '');
  return `${s}.`;
}

let groq = null;
async function translate(texts) {
  if (FAKE) return texts.map(fake);
  if (!groq) {
    const { GroqClient } = require('../lib/groq');
    const { KeyStore } = require('../lib/keystore');
    const ks = new KeyStore();
    groq = new GroqClient({ getKey: () => ks.read('groq') });
  }
  return groq.translate(texts, [], { prompt: ST.SCREEN_PROMPT, models: require('../lib/groq').SCREEN_MODELS });
}

function bitmapOf(img) {
  const { width, height } = img.getSize();
  return { width, height, data: img.toBitmap() };
}

/** 그림을 위로 dy 픽셀 민 그림 (아래는 그 그림 맨 아래 줄 색으로) → 임시 png */
function scrolled(img, dy, file) {
  const { width, height } = img.getSize();
  const src = img.toBitmap();
  const out = Buffer.alloc(src.length);
  src.copy(out, 0, dy * width * 4);
  const last = src.subarray((height - 1) * width * 4);
  for (let y = height - dy; y < height; y++) last.copy(out, y * width * 4);
  fs.writeFileSync(file, nativeImage.createFromBitmap(out, { width, height }).toPNG());
}

const area = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

async function one(file, win, truthAll) {
  const name = path.basename(file, '.png');
  const img = nativeImage.createFromPath(file);
  const bitmap = bitmapOf(img);
  const t0 = Date.now();
  const ocr = ocrOf(file);
  const ocrMs = Date.now() - t0;
  const r = ST.analyze({ ocr, bitmap, scale: SCALE });
  const memory = new Map();
  const t1 = Date.now();
  let failed = null;
  for (const keys of ST.pending(r.blocks, memory)) {
    try {
      const out = await translate(keys);
      keys.forEach((k, i) => { if (out[i] != null) memory.set(k, out[i]); });
    } catch (e) {
      failed = e.message;
    }
  }
  const trMs = Date.now() - t1;
  const items = r.blocks.filter((b) => b.translate && ST.covers(b, memory.get(b.key))).map((block) => ({ block, text: memory.get(block.key) }));
  const src = `data:image/png;base64,${img.toPNG().toString('base64')}`;
  const drawn = await win.webContents.executeJavaScript(`render(${JSON.stringify({
    src, items, scale: SCALE, boxes: { words: r.lines.flatMap((l) => l.words), lines: r.lines.map((l) => l.box), blocks: r.blocks.map((b) => b.box) },
  })})`);
  for (const k of ['covered', 'boxes']) fs.writeFileSync(path.join(OUT, `${name}.${k}.png`), Buffer.from(drawn[k].split(',')[1], 'base64'));

  // 스크롤 기억: 위로 37pt 밀어 다시 읽었을 때 같은 열쇠로 나오는 문단
  const tmp = path.join(OUT, `${name}.scrolled.tmp.png`);
  const shift = Math.round(SCROLL_PT * SCALE);
  scrolled(img, shift, tmp);
  const again = ST.analyze({ ocr: ocrOf(tmp), bitmap: bitmapOf(nativeImage.createFromPath(tmp)), scale: SCALE });
  fs.rmSync(tmp, { force: true });
  // 밀린 뒤에도 다 보이는 문단만 센다 (위로 밀려 나간 문단은 다시 안 나오는 게 맞다)
  const firstKeys = r.blocks.filter((b) => b.translate && b.box.y - shift > 3 * SCALE).map((b) => b.key);
  const againKeys = new Set(again.blocks.map((b) => b.key));
  const kept = firstKeys.filter((k) => againKeys.has(k)).length;

  const res = {
    image: name,
    ocr: { lines: ocr.lines.length, words: ocr.lines.reduce((n, l) => n + (l.words?.length ?? 0), 0), ms: ocrMs },
    segments: r.segments.length,
    lines: r.lines.length,
    paragraphs: r.blocks.length,
    kinds: r.blocks.map((b) => `${b.kind}${b.list ? '·목록' : ''}${b.korean ? '·한국어' : ''}${b.cut ? '·잘림' : ''}${b.bold ? '·굵게' : ''}`),
    translated: items.length,
    translateMs: trMs,
    failed,
    painted: drawn.done.map((d) => `${d.size.toFixed(1)}${d.overflow ? '!' : ''}${d.widened ? '→' : ''}/${d.lines}줄`),
    scroll: { first: firstKeys.length, kept },
  };
  // 글자 크기 추정 오차 (truth.json)
  const truth = truthAll?.[name];
  if (truth) {
    res.sizes = truth.map((t) => {
      const hit = r.blocks.map((b) => [b, area(b.box, t.box)]).sort((a, b) => b[1] - a[1])[0];
      return hit && hit[1] > 0 ? { want: t.size, got: Number(hit[0].size.toFixed(1)) } : { want: t.size, got: null };
    });
    const errs = res.sizes.filter((s) => s.got != null).map((s) => Math.abs(s.got - s.want) / s.want);
    res.sizeError = { mean: Number((errs.reduce((a, b) => a + b, 0) / Math.max(1, errs.length) * 100).toFixed(1)), max: Number((Math.max(0, ...errs) * 100).toFixed(1)), missed: res.sizes.filter((s) => s.got == null).length };
  }
  if (process.env.EZRITE_TRANSLATE_TEXT) res.texts = r.blocks.map((b) => [b.text, memory.get(b.key) ?? null]); // 개발 중에만 (기록에는 남기지 않는다)
  return res;
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  if (!IMAGE) throw new Error('EZRITE_TRANSLATE_IMAGE 가 없습니다');
  fs.mkdirSync(OUT, { recursive: true });
  const files = fs.statSync(IMAGE).isDirectory()
    ? fs.readdirSync(IMAGE).filter((n) => /\.png$/i.test(n) && !/\.(covered|boxes|scrolled\.tmp)\.png$/i.test(n)).map((n) => path.join(IMAGE, n))
    : [IMAGE];
  const truthFile = path.join(fs.statSync(IMAGE).isDirectory() ? IMAGE : path.dirname(IMAGE), 'truth.json');
  const truth = fs.existsSync(truthFile) ? JSON.parse(fs.readFileSync(truthFile, 'utf8')) : null;
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadFile(path.join(__dirname, 'translate-image.html'));
  const results = [];
  for (const f of files) results.push(await one(f, win, truth));
  for (const r of results) console.log(JSON.stringify(r));
  app.exit(0);
});
