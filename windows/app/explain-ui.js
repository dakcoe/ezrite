'use strict';

// "설명해줘"의 Electron 쪽 (맥 ScreenGrab · MarksOverlay · ExplainCard). 흐름은 lib/explainer.js 가 맡는다.
const { BrowserWindow, desktopCapturer, ipcMain, nativeTheme, screen } = require('electron');
const path = require('path');
const E = require('./lib/explain');
const MarkStyle = require('./lib/markstyle');

const round = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });

const CARD_BG = { light: '#ffffff', dark: '#1c1c1e' }; // explain.css --bg

/**
 * 마우스가 있는 화면(또는 display)을 원래 해상도로 찍는다. full=false 는 절반 크기 (지켜보기용).
 * 찍는 동안 우리 창(ours(full))은 setContentProtection 으로 사진에서 뺀다 (맥 ScreenGrab: 앱 창 제외).
 * 설명 카드·표시 창은 처음부터 빠져 있어 여기서 껐다 켜지 않는다 (0.4초마다 찍는 동안 녹화·화면 공유에서 깜박이지 않게)
 */
async function grab({ display, full }, ours) {
  const d = display ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const k = d.scaleFactor * (full ? 1 : 0.5);
  const size = { width: Math.round(d.bounds.width * k), height: Math.round(d.bounds.height * k) };
  const hidden = ours(full).filter((w) => !w.isDestroyed() && w.isVisible());
  for (const w of hidden) w.setContentProtection(true);
  let sources;
  try {
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  } finally {
    for (const w of hidden) if (!w.isDestroyed()) w.setContentProtection(false);
  }
  const src = sources.find((s) => s.display_id === String(d.id)) ?? (sources.length === 1 ? sources[0] : null);
  if (!src || src.thumbnail.isEmpty()) throw new Error('화면을 찾지 못했습니다');
  const img = src.thumbnail;
  const real = img.getSize();
  return {
    display: d,
    bitmap: { width: real.width, height: real.height, data: img.toBitmap() }, // Windows: BGRA
    png: () => img.toPNG(),
    jpeg: (maxWidth) => {
      const s = E.scaledSize(real, maxWidth);
      return (s.width < real.width ? img.resize({ width: s.width, height: s.height, quality: 'best' }) : img).toJPEG(80);
    },
  };
}

/** 표시 창: 화면 전체를 덮는 투명 창. 클릭은 모두 아래로 통과하고 포커스도 가져가지 않는다 */
function createOverlay(display, model, { onShown, capturable = false }) {
  const b = display.bounds;
  const win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    focusable: false, skipTaskbar: true, thickFrame: false, alwaysOnTop: true,
    title: 'Ezrite 표시',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  // 녹음 팝업보다 위, 설명 카드보다 아래 (카드는 onShown 에서 다시 맨 위로)
  win.setAlwaysOnTop(true, 'pop-up-menu');
  win.setIgnoreMouseEvents(true);
  if (!capturable) win.setContentProtection(true);
  win.setBounds(b); // 배율이 다른 화면에서 크기가 어긋나지 않게 한 번 더
  let current = model;
  let loaded = false;
  let hidden = false;
  const draw = () => {
    if (!loaded || win.isDestroyed()) return;
    // 예전 방식은 SVG 도형, 그 밖의 설명 표시 방식(1.3.0)은 marks.js 가 그릴 자료
    const size = { width: b.width, height: b.height };
    const style = MarkStyle.normalize(current.style);
    const payload = style === 'classic'
      ? { style, shapes: E.shapes(current, size), scene: current.scene != null }
      : { style, data: E.markData(current, size) };
    win.webContents.executeJavaScript(`draw(${JSON.stringify(payload)})`).catch(() => {});
  };
  const show = () => {
    if (win.isDestroyed() || hidden) return;
    win.showInactive();
    onShown?.();
  };
  win.webContents.once('did-finish-load', () => {
    loaded = true;
    draw();
    setTimeout(show, 30); // 첫 그림이 올라간 뒤에 보인다
  });
  win.loadFile(path.join(__dirname, 'renderer', 'explain', 'overlay.html'));
  return {
    win,
    update(m) {
      current = m;
      draw();
    },
    hide() {
      hidden = true;
      if (!win.isDestroyed()) win.hide();
    },
    show() {
      hidden = false;
      if (loaded) show();
    },
    close() {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}

/**
 * 설명 카드: 420 폭, 닫기만 있는 작은 창. 처음엔 화면 오른쪽 위, 내용 높이에 맞춘다 (맥 ExplainCard).
 * 글자를 읽으면 화면 글자가 가장 적게 가려지는 자리로 옮긴다 (1.3.0 place, 사용자가 끌어 옮긴 뒤로는 그대로).
 * 카드 안 ⌃ 로 접으면 지금 자막 두 줄만 남기고, ⌄ 로 접기 전 높이로 (1.3.0 fold)
 */
function createCard({ onClose, onAsk, onScene, onHover = () => {}, onAnchors = () => {} }, { capturable = false } = {}) {
  const win = new BrowserWindow({
    width: E.CARD.width, height: E.CARD.initial, show: false,
    title: '설명',
    icon: path.join(__dirname, 'assets', 'app.ico'),
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
    // 포커스를 뺏지 않는 창 (1.3.0, 맥 nonactivatingPanel): 카드를 눌러도 뒤 앱(강의 창)이 키를 받는다. 질문 칸을 누를 때만 받는다
    focusable: false,
    minWidth: 320, minHeight: E.CARD.min,
    backgroundColor: CARD_BG[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'],
    webPreferences: {
      preload: path.join(__dirname, 'preload-card.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false,
    },
  });
  // 녹음 팝업과 같은 층 (1.3.0, 맥 floating+4): 둘이 겹치면 누른 쪽이 앞에 온다
  win.setAlwaysOnTop(true, 'floating');
  win.removeMenu();
  if (!capturable) win.setContentProtection(true);
  let ready = false;
  let pending = null;
  let locked = false; // 질문을 시작하면 크기를 더 바꾸지 않는다
  let autoPlace = true; // 사용자가 카드를 끌어 옮기면 그 뒤로는 자리를 옮기지 않는다 (맥 autoPlace)
  let folded = null; // 접었을 때 접기 전 높이
  let anchors = null; // 카드 글의 세로 자리 (CSS px, 선 긋기 방식)
  let closing = false;
  let pendingPartial = null; // 받는 중인 답 글 (0.08초에 한 번만 그린다)

  const work = () => screen.getDisplayMatching(win.getBounds()).workArea;
  const call = (fn, payload) => win.webContents.executeJavaScript(`${fn}(${JSON.stringify(payload)})`).catch(() => {});
  const from = (e) => !win.isDestroyed() && e.sender === win.webContents;

  const onHeight = (e, h) => {
    // 접은 동안은 질문 뒤 고정 높이(locked)여도 자막 두 줄 높이로 줄인다
    if (!from(e) || (locked && folded == null) || !Number.isFinite(h)) return;
    const outer = win.getBounds();
    const chrome = outer.height - win.getContentBounds().height; // 제목 막대
    win.setBounds(round(E.cardFit(outer, h, chrome, work())));
  };
  /** 카드 글의 세로 자리(CSS px) → 화면 자리 (카드 왼쪽 가장자리, DIP) */
  const sendAnchors = () => {
    if (!anchors || win.isDestroyed()) return;
    const c = win.getContentBounds();
    const out = {};
    for (const [k, y] of Object.entries(anchors)) if (Number.isFinite(y)) out[k] = { x: c.x, y: c.y + y };
    onAnchors(out);
  };
  const onAnchorsMsg = (e, v) => {
    if (!from(e) || !v || typeof v !== 'object') return;
    anchors = Object.fromEntries(Object.entries(v).filter(([k, y]) => /^(?:m\d{1,2}|say)$/.test(k) && Number.isFinite(y)).slice(0, 20));
    sendAnchors();
  };
  const onHoverMsg = (e, ref) => {
    if (from(e)) onHover(typeof ref === 'string' ? ref.slice(0, 8) : '');
  };
  const unfold = () => {
    if (folded == null || win.isDestroyed()) return;
    const h = folded;
    folded = null;
    win.setBounds(round(E.withHeight(win.getBounds(), h, work())));
  };
  const onFold = (e, on) => {
    if (!from(e)) return;
    if (on) {
      if (folded == null) folded = win.getBounds().height;
    } else unfold();
  };
  // 질문 칸을 누르면 그때만 키 입력을 받는다 (맥 typing). 다른 창으로 가면 다시 포커스를 받지 않는 창으로
  const onTyping = (e) => {
    if (!from(e)) return;
    win.setFocusable(true);
    win.focus();
  };
  const onFront = (e) => {
    if (from(e)) win.moveTop();
  };
  win.on('blur', () => { if (!win.isDestroyed()) win.setFocusable(false); });
  // 사용자가 제목 막대를 끌 때만 온다 (setBounds 로 옮길 때는 오지 않는다)
  win.on('will-move', () => { autoPlace = false; });
  win.on('move', sendAnchors);
  win.on('resize', sendAnchors);
  const onSceneMsg = (e, i) => {
    if (from(e)) onScene(Number.isFinite(i) ? Math.trunc(i) : -1);
  };
  const onAskMsg = (e, q) => {
    if (!from(e) || typeof q !== 'string' || !q.trim()) return;
    if (!locked && folded == null) win.setBounds(round(E.cardAsked(win.getBounds(), work())));
    locked = true;
    onAsk(q.slice(0, 4000));
  };
  ipcMain.on('card:height', onHeight);
  ipcMain.on('card:scene', onSceneMsg);
  ipcMain.on('card:ask', onAskMsg);
  ipcMain.on('card:hover', onHoverMsg);
  ipcMain.on('card:anchors', onAnchorsMsg);
  ipcMain.on('card:fold', onFold);
  ipcMain.on('card:typing', onTyping);
  ipcMain.on('card:front', onFront);

  // 다른 창에 가려지거나 화면 밖으로 밀려나도, 직접 닫기 전까지는 다시 데려온다
  const keepAlive = setInterval(() => {
    if (win.isDestroyed()) return;
    if (!win.isVisible()) win.showInactive();
    const f = win.getBounds();
    const v = work();
    const p = E.pulledIn({ x: f.x, y: f.y, w: f.width, h: f.height }, { x: v.x, y: v.y, w: v.width, h: v.height });
    if (p) win.setBounds({ x: Math.round(p.x), y: Math.round(p.y), width: f.width, height: f.height });
  }, 1000);

  const cleanup = () => {
    clearInterval(keepAlive);
    ipcMain.removeListener('card:height', onHeight);
    ipcMain.removeListener('card:scene', onSceneMsg);
    ipcMain.removeListener('card:ask', onAskMsg);
    ipcMain.removeListener('card:hover', onHoverMsg);
    ipcMain.removeListener('card:anchors', onAnchorsMsg);
    ipcMain.removeListener('card:fold', onFold);
    ipcMain.removeListener('card:typing', onTyping);
    ipcMain.removeListener('card:front', onFront);
  };
  win.on('closed', () => {
    cleanup();
    if (!closing) onClose();
  });
  win.webContents.on('did-finish-load', () => {
    ready = true;
    if (pending) {
      const p = pending;
      pending = null;
      call('render', p);
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'explain', 'explain.html'));

  return {
    win,
    show(display, avoid) {
      if (win.isDestroyed()) return;
      if (!win.isVisible()) {
        const d = display ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        // 맥은 창 폭 = 내용 폭 420. Windows 창 폭에는 테두리(보이지 않는 크기 조절 띠 포함)가 들어 있어 그만큼 넓힌다
        const f = E.cardFrame(d.workArea, avoid ?? null);
        const border = win.getBounds().width - win.getContentBounds().width;
        win.setBounds(round({ ...f, x: f.x - border, width: f.width + border }));
      }
      win.showInactive(); // 강의 창의 포커스를 뺏지 않는다 (맥 nonactivatingPanel)
      win.moveTop();
    },
    /**
     * 글자를 읽은 뒤: 화면 글자(lines, 화면 비율)를 가장 적게 가리는 자리로 (맥 place(avoiding:)). 녹음 팝업은 무겁게 피한다.
     * 카드 창은 건드리지 않는다. 사용자가 끌어 옮겼으면 그대로
     */
    place(lines, display, avoid) {
      if (!autoPlace || win.isDestroyed() || !display) return;
      const f = win.getBounds();
      const spot = E.cardSpot(E.screenBoxes(lines, display.bounds), display.workArea, { width: f.width, height: f.height }, avoid ?? null);
      if (Math.round(spot.x) !== f.x || Math.round(spot.y) !== f.y) win.setBounds(round({ ...f, x: spot.x, y: spot.y }));
    },
    render(payload) {
      locked = false;
      anchors = null;
      // 새 설명이 오면 저절로 펼친다 (불러오는 중 글은 접힌 채로 두지 않는다)
      if (folded != null) {
        unfold();
        call('fold', false);
      }
      if (!ready) pending = payload;
      else call('render', payload);
    },
    /** 설정에서 표시 방식을 바꿨다 (카드는 질문 대화가 없을 때만 같은 장면으로 다시 그린다) */
    restyle(style) {
      if (ready) call('restyle', style);
    },
    /** 받는 중인 답 글 (1.3.0). 조각마다 다시 그리면 무거워서 0.08초에 한 번만 그린다 */
    partial(text) {
      const scheduled = pendingPartial != null;
      pendingPartial = String(text);
      if (scheduled) return;
      setTimeout(() => {
        const t = pendingPartial;
        pendingPartial = null;
        if (t != null && ready && !win.isDestroyed()) call('partial', t);
      }, 80);
    },
    answer(payload) {
      pendingPartial = null; // 다 받은 답 뒤에 늦은 조각이 덮어쓰지 않게
      call('answer', payload);
    },
    devAsk(q) {
      win.webContents.executeJavaScript(`q.value = ${JSON.stringify(q)}; ask()`).catch(() => {});
    },
    raise() {
      if (!win.isDestroyed() && win.isVisible()) win.moveTop();
    },
    close() {
      closing = true;
      cleanup();
      if (!win.isDestroyed()) win.destroy();
    },
  };
}

module.exports = { grab, createOverlay, createCard };
