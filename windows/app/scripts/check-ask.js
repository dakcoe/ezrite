'use strict';
require('./guard'); // 오류가 나도 화면에 창을 띄우지 않고 종료 코드 1
// 1.3.0 설명 카드 질문을 실제 창으로 본다 (AI 없음, 창은 화면에 띄우지 않는다).
//   npx electron scripts/check-ask.js   → 결과 JSON 한 줄, 하나라도 틀리면 종료 코드 1
// test/ask-ui.test.js 가 부른다:
//   받는 중인 답 글(partial)은 0.08초에 한 번만 그리고, 다 받은 답(answer)이 바꿔 끼운다 (늦은 조각이 덮어쓰지 않는다)
//   카드보다 넓은 블록 수식은 70% 까지 줄이고 그래도 넓으면 옆으로 밀어 본다, \nabla 는 줄바꿈으로 깨지지 않는다
//   카드는 포커스를 받지 않는 창이고, 질문 칸을 누를 때만 받는다. 카드를 누르면 앞으로(같은 층)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezrite-ask-'));
const { app, BrowserWindow, screen } = require('electron');
for (const m of ['show', 'showInactive', 'focus']) BrowserWindow.prototype[m] = function noop() {};
app.setPath('userData', path.join(tmp, 'userData'));
const ExplainUI = require('../explain-ui');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(50);
  }
  return null;
}

async function main() {
  const out = { ok: false };
  try {
    await app.whenReady();
    const asked = [];
    const card = ExplainUI.createCard({ onClose() {}, onAsk: (q) => asked.push(q), onScene() {} });
    const wc = card.win.webContents;
    const js = (s) => wc.executeJavaScript(s);
    await until(() => !wc.isLoading());
    card.show(screen.getPrimaryDisplay(), null);
    card.render({ summary: '역전파 설명입니다.', marks: [], visuals: [], style: 'trail' });
    await until(() => js('document.getElementById("ask").classList.contains("on")'));
    out.focusableAtStart = card.win.isFocusable();
    // 질문 칸을 누르면 그때만 키를 받는 창이 된다
    await js('document.getElementById("q").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))');
    out.focusableAfterTyping = await until(() => card.win.isFocusable(), 3000);
    card.win.emit('blur');
    out.focusableAfterBlur = card.win.isFocusable();
    // 질문 → 받는 중인 글 세 번(0.08초 안) → 한 번만 그린다
    await js('q.value = "왜 그래?"; ask()');
    await until(() => asked.length === 1, 3000);
    const draws = 'window.__draws = 0; const _p = partial; partial = (t) => { window.__draws++; _p(t); }; 0';
    await js(draws);
    card.partial('첫');
    card.partial('첫 조각');
    card.partial('첫 조각 둘째 $\\nabla f$ 입니다');
    await wait(250);
    out.partial = await js('({ draws: window.__draws, live: document.querySelector(".a.live")?.innerText ?? null, loading: !!document.querySelector(".qa .loading") })');
    // 다 받은 답이 오면 live 를 바꿔 끼우고, 늦은 조각은 버린다
    const wide = String.raw`$$\sum_{i=1}^{n} \frac{\partial L}{\partial w_i} \cdot \frac{\partial w_i}{\partial z_i} \cdot \frac{\partial z_i}{\partial a_i} \cdot \frac{\partial a_i}{\partial x_i} + \lambda \lVert W \rVert_2^2 + \gamma \sum_{j=1}^{m} \beta_j^2 + \cdots$$`;
    card.partial('늦은 조각');
    card.answer({ answer: `끝난 답 \\nabla 그대로\\n다음 줄\n\n${wide}`, marks: [], visuals: [], style: 'trail' });
    await wait(300);
    out.answer = await js(`(() => { const a = [...document.querySelectorAll('.qa .a')];
      const d = document.querySelector('.math.disp');
      return { count: a.length, live: a.filter((x) => x.classList.contains('live')).length, text: [...(a.at(-1)?.querySelector('p')?.childNodes ?? [])].map((n) => (n.nodeType === 3 ? n.data : n.classList?.contains('math') ? '[수식]' : '')).join(''),
        disp: !!d, fontSize: d ? parseFloat(d.style.fontSize) : null, scroll: d ? d.scrollWidth > d.clientWidth : null }; })()`);
    // 카드를 누르면 앞으로 (moveTop)
    let moved = 0;
    const mt = card.win.moveTop.bind(card.win);
    card.win.moveTop = () => { moved++; mt(); };
    await js('document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))');
    out.front = await until(() => moved > 0, 2000);
    card.close();

    out.checks = {
      notFocusable: out.focusableAtStart === false,
      typingFocuses: out.focusableAfterTyping === true,
      blurReleases: out.focusableAfterBlur === false,
      partialThrottled: out.partial.draws === 1 && out.partial.live?.includes('첫 조각 둘째') && !out.partial.loading,
      nablaKept: out.partial.live?.includes('∇') || out.partial.live?.includes('nabla'),
      answerReplacesLive: out.answer.count === 1 && out.answer.live === 0 && out.answer.text === '끝난 답 [수식] 그대로\n다음 줄', // \nabla 는 줄바꿈이 아니라 수식
      wideMathShrinks: out.answer.disp && out.answer.fontSize >= 1.12 * 0.7 - 1e-6 && out.answer.fontSize < 1.12,
      clickToFront: Boolean(out.front),
    };
    out.ok = Object.values(out.checks).every(Boolean);
  } catch (e) {
    out.error = e.stack;
  }
  console.log(JSON.stringify(out));
  app.exit(out.ok ? 0 : 1);
}

main();
app.on('quit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 다음에 */ } });
