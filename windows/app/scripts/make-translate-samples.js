'use strict';
require('./guard'); // 오류가 나도 화면에 창을 띄우지 않고 종료 코드 1
// 화면 번역 시험 그림 5장을 만든다 (맥 시험 그림과 같은 성격, 2배 해상도). 창은 띄우지 않는다 (offscreen).
//   npx electron scripts/make-translate-samples.js <폴더>
//   → <폴더>/slide.png · web.png · dark.png · code.png · mixed.png 와 truth.json (그림마다 글 덩어리의 실제 글자 크기(1배 px) · 자리(그림 px))
// 1배 px = 맥 pt. 그림은 2배로 그려서 맥 Retina 그림과 같은 크기가 된다.
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const OUT = path.resolve(process.argv.find((a, i) => i > 1 && !a.startsWith('-') && !a.endsWith('.js')) || 'translate-samples');
const W = 900;
const H = 600;

const BASE = `* { margin: 0; box-sizing: border-box; } body { width: ${W}px; height: ${H}px; overflow: hidden; zoom: 2; -webkit-font-smoothing: antialiased; }
[data-size] { display: block; }`;

// data-size: 그 덩어리의 글자 크기 (1배 px). data-kind: 시험에서 기대하는 것 (code 는 번역하지 않는다)
const PAGES = {
  slide: `<style>${BASE} body { background: #fff; color: #1d1d1f; font-family: 'Segoe UI'; padding: 48px 60px; }
    h1 { font-size: 40px; font-weight: 700; margin-bottom: 28px; } li[data-size] { display: list-item; font-size: 26px; margin: 0 0 14px 30px; line-height: 1.3; }
    p.cap { font-size: 18px; color: #86868b; position: absolute; left: 60px; bottom: 36px; }</style>
    <h1 data-size="40">Gradient Descent in Practice</h1>
    <ul><li data-size="26">Compute the gradient of the loss</li>
    <li data-size="26">Update every weight with a small learning rate so that the loss keeps going down</li>
    <li data-size="26">Repeat until the validation error stops improving</li></ul>
    <p class="cap" data-size="18">Figure 2. Loss curve over 50 epochs</p>`,
  web: `<style>${BASE} body { background: #fbfaf7; color: #222; font-family: Georgia, serif; padding: 40px 70px; }
    h1 { font-size: 30px; color: #b3261e; font-weight: 400; margin-bottom: 20px; } p { font-size: 19px; line-height: 28px; margin-bottom: 18px; }</style>
    <h1 data-size="30">Why Attention Changed Everything</h1>
    <p data-size="19">Before transformers, sequence models read one word at a time and struggled to remember what came long before.</p>
    <p data-size="19">Attention lets every position look at every other position, so distant words can influence each other directly.</p>
    <p data-size="19">This simple idea made training faster and models far more capable.</p>`,
  dark: `<style>${BASE} body { background: #1e1f22; color: #f2f2f2; font-family: 'Segoe UI'; padding: 36px 48px; }
    h2 { font-size: 24px; font-weight: 600; margin-bottom: 24px; } .row { display: flex; align-items: center; justify-content: space-between; padding: 14px 0; border-bottom: 1px solid #333; }
    .t { font-size: 16px; } .d { font-size: 13px; color: #9a9ca3; margin-top: 4px; } .b { background: #3b82f6; color: #fff; font-size: 14px; padding: 7px 16px; border-radius: 6px; }</style>
    <h2 data-size="24">Privacy and Security</h2>
    <div class="row"><div><span class="t" data-size="16">Location services</span><span class="d" data-size="13">Allow apps to use your precise location</span></div><span class="b" data-size="14">Manage</span></div>
    <div class="row"><div><span class="t" data-size="16">Camera access</span><span class="d" data-size="13">Choose which apps can use the camera</span></div><span class="b" data-size="14">Change</span></div>
    <div class="row"><div><span class="t" data-size="16">Diagnostic data</span><span class="d" data-size="13">Send optional usage data to help improve the product</span></div><span class="b" data-size="14">Settings</span></div>`,
  code: `<style>${BASE} body { background: #ffffff; color: #24292f; font-family: Consolas, monospace; padding: 30px 40px; }
    pre { font-family: inherit; font-size: 14px; line-height: 21px; } .c { color: #6a737d; } .k { color: #cf222e; } p { font-family: 'Segoe UI'; font-size: 15px; margin: 0 0 16px; }</style>
    <p data-size="15">The function below trains the model for a fixed number of steps and returns the final loss.</p>
<pre data-size="14"><span class="c"># Train with plain gradient descent</span>
<span class="k">def</span> train(model, data, steps=100, lr=0.01):
    <span class="c"># loop over the data and update the weights</span>
    <span class="k">for</span> step <span class="k">in</span> range(steps):
        loss = model.loss(data)
        model.update(-lr * model.grad(loss))
    <span class="k">return</span> loss</pre>`,
  // 브라우저 (맥 2차 실패 사례): 도구막대 아래로 스크롤에 반쯤 잘린 문단(옮기면 안 된다), 그래프 세로 축 이름(옮기지 않는다),
  // "(a) …; (b) …" 그림 설명(코드가 아니다), 탭 제목·주소(도구막대 안, 멀쩡하다)
  browser: `<style>${BASE} body { background: #fff; color: #202124; font-family: 'Segoe UI'; }
    .bar { position: absolute; left: 0; right: 0; top: 0; height: 76px; background: #dee1e6; border-bottom: 1px solid #b9bdc3; z-index: 2; }
    .tab { position: absolute; left: 12px; top: 8px; font-size: 13px; background: #fff; padding: 6px 14px; border-radius: 8px 8px 0 0; }
    .url { position: absolute; left: 12px; top: 44px; right: 12px; font-size: 14px; background: #fff; padding: 5px 12px; border-radius: 14px; }
    .page { position: absolute; left: 70px; right: 70px; top: 63px; font-size: 18px; line-height: 27px; }
    .page p { margin: 0 0 18px; } .axis { position: absolute; left: 70px; top: 380px; font-size: 15px; transform-origin: left top; transform: rotate(-90deg) translate(-120px, 0); white-space: nowrap; }
    .plot { position: absolute; left: 110px; top: 250px; width: 360px; height: 130px; border-left: 2px solid #555; border-bottom: 2px solid #555; }
    .cap { position: absolute; left: 110px; top: 420px; font-size: 15px; color: #444; }</style>
    <div class="bar"><span class="tab" data-size="13">Attention Is All You Need</span><span class="url" data-size="14">https://example.com/papers/attention</span></div>
    <div class="page"><p data-kind="cut">Recurrent models compute hidden states one step at a time, which makes training slow on long sequences and hard to parallelize.</p>
    <p data-size="18">The transformer replaces recurrence with attention, so every position can be processed at the same time.</p></div>
    <div class="plot"></div><span class="axis" data-kind="vertical">Validation loss</span>
    <p class="cap" data-size="15">Figure 3. (a) training loss; (b) validation loss over 20 epochs.</p>`,
  mixed: `<style>${BASE} body { background: #fff; color: #111; font-family: 'Segoe UI', 'Malgun Gothic'; padding: 44px 56px; }
    p { font-size: 20px; line-height: 30px; margin-bottom: 20px; } mark { background: #fff176; color: #111; padding: 2px 0; }
    .src { font-size: 11px; color: #8a8a8a; position: absolute; left: 56px; bottom: 30px; }</style>
    <p data-size="20" data-kind="korean">이 문단은 이미 한국어라서 번역하지 않아도 됩니다.</p>
    <p data-size="20"><mark>Overfitting happens when a model memorizes the training data.</mark></p>
    <p data-size="20">Regularization and early stopping are two common ways to prevent it.</p>
    <p class="src" data-size="11">Source: Deep Learning, Goodfellow et al., 2016</p>`,
};

app.on('window-all-closed', () => {}); // 그림마다 창을 닫아도 끝내지 않는다
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const truth = {};
  for (const [name, html] of Object.entries(PAGES)) {
    const win = new BrowserWindow({ show: false, width: W * 2, height: H * 2, useContentSize: true, webPreferences: { offscreen: true } });
    const file = path.join(OUT, `${name}.html`);
    fs.writeFileSync(file, `<!doctype html><meta charset="utf-8">${html}`);
    await win.loadFile(file);
    fs.rmSync(file, { force: true });
    await new Promise((r) => setTimeout(r, 600));
    // 글 덩어리의 실제 자리 (그림 px: CSS zoom 2 에서 getBoundingClientRect 는 확대된 좌표를 준다)
    truth[name] = await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-size]')].map((e) => {
      const r = e.getBoundingClientRect(), z = 2; return { size: Number(e.dataset.size), kind: e.dataset.kind || null, text: e.innerText,
        box: { x: Math.round(r.x * z) / 2, y: Math.round(r.y * z) / 2, w: Math.round(r.width * z) / 2, h: Math.round(r.height * z) / 2 } }; })`);
    win.webContents.invalidate();
    await new Promise((r) => setTimeout(r, 300));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: W * 2, height: H * 2 });
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    win.destroy();
  }
  fs.writeFileSync(path.join(OUT, 'truth.json'), JSON.stringify(truth, null, 1));
  console.log(JSON.stringify({ ok: true, out: OUT, pages: Object.keys(truth) }));
  app.exit(0);
});
