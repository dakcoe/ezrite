import AppKit
import Carbon
import Combine
import ScreenCaptureKit

/// 실험 기능 "화면 번역": 고른 창 하나의 글자를 읽어 한국어로 옮기고, 그 문단 자리에 번역을 덮는다 (묶기·자리 잡기는 ScreenTranslateLayout).
/// 창이 바뀌면(스크롤·넘김) 멈춘 뒤 다시 읽는다. 한 번 옮긴 문단은 기억해 두고 다시 보내지 않는다 (기억은 메모리에만, 끄면 지운다)
enum ScreenTranslate {
    /// 한 번에 보내는 문단 수. 창에 문단이 많아도 응답이 잘리지 않게 나눠 보낸다
    static let batch = 40
    /// 살펴보는 간격(초)
    static let tick: TimeInterval = 0.5

    struct Window: Equatable {
        let id: CGWindowID
        let pid: pid_t
        let app: String
        /// Cocoa 좌표 (왼쪽 아래 원점, 포인트)
        let frame: CGRect
        let onScreen: Bool
    }

    // ── 순수 함수 (테스트) ──

    /// 기억 열쇠: 글자 인식이 매번 띄어쓰기를 조금씩 다르게 읽어도 같은 문단으로 본다
    static func key(_ text: String) -> String {
        text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// 옮길 만한 글인가: 한국어가 아닌 글자가 두 자 이상 있고, 이미 한국어인 글은 아니다
    static func needsTranslation(_ text: String) -> Bool {
        var hangul = 0, other = 0
        for u in text.unicodeScalars {
            if (0xAC00...0xD7A3).contains(u.value) || (0x3131...0x318E).contains(u.value) { hangul += 1 }
            else if u.properties.isAlphabetic { other += 1 }
        }
        return other >= 2 && hangul * 2 < other
    }

    /// 창 위·아래 끝이나 도구막대 경계(edges)에 붙은 문단은 스크롤에 잘려 있을 수 있으니 옮기지 않는다 (다 보이면 그때).
    /// 줄 단위로 잘리면 남은 줄은 멀쩡해 보이므로, 경계와 첫(끝) 줄 사이가 줄 높이의 0.5배 안쪽이면 잘린 것으로 본다
    static func touchesEdge(_ b: Block, height: CGFloat, edges: [CGFloat] = []) -> Bool {
        let near = 0.5 * b.rowHeight
        if b.rect.minY < 3 || b.rect.maxY > height - 3 { return true }
        return edges.contains { e in (b.rect.minY - e > -3 && b.rect.minY - e < near) || (e - b.rect.maxY > -3 && e - b.rect.maxY < near) }
    }

    /// 아직 옮기지 않은 문단 글 (겹치지 않게, 위에서부터)
    static func pending(_ blocks: [Block], height: CGFloat, edges: [CGFloat] = [], cut: Set<Int> = [], known: Set<String>) -> [String] {
        var seen = known, out: [String] = []
        for i in readingOrder(blocks) where !cut.contains(i) {
            let b = blocks[i]
            guard translatable(b), !touchesEdge(b, height: height, edges: edges) else { continue }
            let k = key(b.text)
            if seen.insert(k).inserted { out.append(k) }
        }
        return out
    }

    /// CGWindow 좌표(주 화면 왼쪽 위 원점) → Cocoa 좌표(왼쪽 아래 원점)
    static func cocoaFrame(_ cg: CGRect, primaryHeight: CGFloat) -> CGRect {
        CGRect(x: cg.minX, y: primaryHeight - cg.maxY, width: cg.width, height: cg.height)
    }

    /// 창 그림을 6×6 칸으로 나눈 작은 흑백 그림들. 한 줄만 바뀌어도 그 칸이 달라진다
    static func grid(_ image: CGImage) -> [[UInt8]] {
        let n = 6
        return (0..<n * n).map { i in
            Explain.thumbnail(image, box: CGRect(x: CGFloat(i % n) / CGFloat(n), y: CGFloat(i / n) / CGFloat(n),
                                                 width: 1 / CGFloat(n), height: 1 / CGFloat(n)))
        }
    }

    static func differs(_ a: [[UInt8]], _ b: [[UInt8]]) -> Bool {
        guard a.count == b.count else { return true }
        return zip(a, b).contains { x, y in
            guard x.count == y.count, !x.isEmpty else { return true }
            return Double(zip(x, y).reduce(0) { $0 + abs(Int($1.0) - Int($1.1)) }) / Double(x.count) > 2.5
        }
    }

    // ── 창 찾기·찍기 ──

    /// 화면에 보이는 보통 창들, 앞에서 뒤 순서. 우리 앱 창은 뺀다
    static func windows() -> [Window] {
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return list.compactMap(window(from:)).filter { $0.pid != ProcessInfo.processInfo.processIdentifier }
    }

    static func window(id: CGWindowID) -> Window? {
        let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]] ?? []
        return list.first.flatMap(window(from:))
    }

    static func window(at point: NSPoint) -> Window? {
        windows().first { $0.frame.contains(point) }
    }

    private static func window(from d: [String: Any]) -> Window? {
        guard (d[kCGWindowLayer as String] as? Int) == 0,
              let id = d[kCGWindowNumber as String] as? CGWindowID,
              let pid = d[kCGWindowOwnerPID as String] as? pid_t,
              let b = d[kCGWindowBounds as String] as? NSDictionary,
              let cg = CGRect(dictionaryRepresentation: b), cg.width > 40, cg.height > 40 else { return nil }
        let primary = NSScreen.screens.first?.frame.height ?? 0
        return Window(id: id, pid: pid, app: d[kCGWindowOwnerName as String] as? String ?? "?",
                      frame: cocoaFrame(cg, primaryHeight: primary), onScreen: d[kCGWindowIsOnscreen as String] as? Bool ?? false)
    }

    static func screen(for frame: CGRect) -> NSScreen? {
        NSScreen.screens.max { area($0.frame.intersection(frame)) < area($1.frame.intersection(frame)) }
    }

    private static func area(_ r: CGRect) -> CGFloat { r.isNull ? 0 : r.width * r.height }

    /// 창 하나만 찍는다 (앞을 가린 다른 창·우리 덮개는 찍히지 않는다)
    static func capture(_ w: SCWindow, size: CGSize, scale: CGFloat) async throws -> CGImage {
        let filter = SCContentFilter(desktopIndependentWindow: w)
        let config = SCStreamConfiguration()
        config.width = max(1, Int(size.width * scale))
        config.height = max(1, Int(size.height * scale))
        config.showsCursor = false
        if #available(macOS 14, *) {
            config.ignoreShadowsSingleWindow = true
            return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        }
        return try await OneFrame.capture(filter: filter, config: config)
    }

    static func scWindow(_ id: CGWindowID) async throws -> SCWindow {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        guard let w = content.windows.first(where: { $0.windowID == id }) else { throw Explain.Failure("창을 찾지 못했습니다") }
        return w
    }
}

// ── 덮개 ──

final class TranslateOverlayModel: ObservableObject {
    @Published var items: [ScreenTranslate.Item] = []
    /// 마우스를 올린 문단: 그 문단만 원문이 보이게 덮개를 뺀다
    @Published var hovered: Int?
    /// 앞을 가린 다른 창 (덮개 창 안 좌표, 왼쪽 위 원점). 그 밑의 문단은 덮지 않는다
    @Published var covered: [CGRect] = []

    var visible: [ScreenTranslate.Item] {
        items.filter { it in it.id != hovered && !covered.contains { $0.intersects(it.rect) } }
    }
}

/// 덮개 그리기. 개발용 그림과 같은 ScreenTranslate.draw 를 쓴다
final class TranslateOverlayView: NSView {
    private let model: TranslateOverlayModel
    private var sink: AnyCancellable?

    init(model: TranslateOverlayModel) {
        self.model = model
        super.init(frame: .zero)
        sink = model.objectWillChange.sink { [weak self] in DispatchQueue.main.async { self?.needsDisplay = true } }
    }

    required init?(coder: NSCoder) { nil }

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        model.visible.forEach(ScreenTranslate.draw)
    }
}

/// 고른 창 위에 딱 맞춰 뜨는 투명 창. 클릭은 아래 창으로 통과한다
final class TranslateOverlay: NSPanel {
    init(model: TranslateOverlayModel, frame: CGRect) {
        super.init(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = true
        // 녹음 팝업(floating+2)·설명 카드보다 아래
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        isReleasedWhenClosed = false
        contentView = TranslateOverlayView(model: model)
    }
}

// ── 창 고르기 ──

/// 화면마다 덮는 고르기 창. 마우스 밑 창을 파랗게 칠하고, 누르면 그 창, Esc 는 취소
final class WindowPicker {
    private var panels: [NSPanel] = []
    private let done: (ScreenTranslate.Window?) -> Void
    /// 메뉴바 앱은 앞으로 나오지 못해(macOS 가 막는다) 키가 고르기 창에 오지 않는다.
    /// 고르는 동안만 Esc 를 시스템 단축키로 잡는다 (권한 필요 없음)
    private var escKey: EventHotKeyRef?
    private var escHandler: EventHandlerRef?
    private static weak var current: WindowPicker?

    init(done: @escaping (ScreenTranslate.Window?) -> Void) {
        self.done = done
        for screen in NSScreen.screens {
            let p = PickerPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            p.isOpaque = false
            p.backgroundColor = .clear
            p.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 5)
            p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            p.isReleasedWhenClosed = false
            p.acceptsMouseMovedEvents = true
            let v = PickerView(frame: CGRect(origin: .zero, size: screen.frame.size))
            v.screenOrigin = screen.frame.origin
            v.finish = { [weak self] w in self?.finish(w) }
            p.contentView = v
            p.orderFrontRegardless()
            panels.append(p)
        }
        panels.first?.makeKey()
        NSCursor.crosshair.push()
        Self.current = self
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let h = InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            DispatchQueue.main.async { WindowPicker.current?.finish(nil) }
            return noErr
        }, 1, &spec, nil, &escHandler)
        let k = RegisterEventHotKey(UInt32(kVK_Escape), 0, EventHotKeyID(signature: OSType(0x455A_5254), id: 1),
                                    GetApplicationEventTarget(), 0, &escKey)
        if h != noErr || k != noErr { Log.warn("화면 번역", "Esc 단축키 못 걺 (\(h), \(k))") }
    }

    fileprivate func finish(_ w: ScreenTranslate.Window?) {
        guard !panels.isEmpty else { return }           // Esc 와 클릭이 겹쳐도 한 번만
        if let escKey { UnregisterEventHotKey(escKey) }
        if let escHandler { RemoveEventHandler(escHandler) }
        escKey = nil; escHandler = nil
        NSCursor.pop()
        panels.forEach { $0.close() }
        panels = []
        done(w)
    }
}

private final class PickerPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

private final class PickerView: NSView {
    var screenOrigin: CGPoint = .zero
    var finish: ((ScreenTranslate.Window?) -> Void)?
    private var hover: ScreenTranslate.Window?

    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .activeAlways, .inVisibleRect], owner: self))
        window?.makeFirstResponder(self)
    }

    override func mouseMoved(with event: NSEvent) {
        let w = ScreenTranslate.window(at: NSEvent.mouseLocation)
        guard w != hover else { return }
        // 다른 화면의 고르기 창도 다시 그린다 (창이 화면 둘에 걸칠 수 있다)
        NSApp.windows.compactMap { $0.contentView as? PickerView }.forEach { $0.show(w) }
    }

    func show(_ w: ScreenTranslate.Window?) {
        hover = w
        needsDisplay = true
    }

    override func mouseDown(with event: NSEvent) { finish?(ScreenTranslate.window(at: NSEvent.mouseLocation)) }
    override func keyDown(with event: NSEvent) { if event.keyCode == 53 { finish?(nil) } }
    override func rightMouseDown(with event: NSEvent) { finish?(nil) }      // 오른쪽 클릭도 취소

    override func draw(_ dirty: NSRect) {
        NSColor.black.withAlphaComponent(0.12).setFill()
        bounds.fill()
        if let w = hover {
            let r = w.frame.offsetBy(dx: -screenOrigin.x, dy: -screenOrigin.y)
            NSColor.systemBlue.withAlphaComponent(0.18).setFill()
            r.fill()
            NSColor.systemBlue.setStroke()
            let path = NSBezierPath(rect: r.insetBy(dx: 1.5, dy: 1.5))
            path.lineWidth = 3
            path.stroke()
        }
        let hint = "번역할 창을 누르세요 · Esc·오른쪽 클릭 취소" as NSString
        let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 15, weight: .semibold), .foregroundColor: NSColor.white]
        let size = hint.size(withAttributes: attrs)
        let box = CGRect(x: bounds.midX - size.width / 2 - 14, y: bounds.maxY - 90, width: size.width + 28, height: size.height + 14)
        NSColor.black.withAlphaComponent(0.7).setFill()
        NSBezierPath(roundedRect: box, xRadius: 10, yRadius: 10).fill()
        hint.draw(at: CGPoint(x: box.minX + 14, y: box.minY + 7), withAttributes: attrs)
    }
}

// ── 돌리기 ──

/// 창 하나를 지켜보며 번역을 덮는다. stop() 이나 창이 닫히면 끝난다
@MainActor
final class ScreenTranslator {
    private let state: AppState
    private let groq = GroqClient()
    private var task: Task<Void, Never>?
    private var hoverTimer: Timer?
    private var overlay: TranslateOverlay?
    private let model = TranslateOverlayModel()
    private var picker: WindowPicker?
    /// 원문 열쇠 → 번역. 이 실행 동안만 (창 위아래로 옮겨도 다시 보내지 않는다)
    private var cache: [String: String] = [:]
    /// 두 번 실패한 문단은 다시 보내지 않는다
    private var failures: [String: Int] = [:]
    private var translating = false
    private var failStreak = 0
    /// 지금 화면을 읽은 결과 (문단·화소)
    private var page = ScreenTranslate.Page()
    private var target: ScreenTranslate.Window?
    /// 개발용(EZRITE_TRANSLATE_FAKE): AI 없이 "번역:" 을 붙여 위치만 본다
    private let fake = ProcessInfo.processInfo.environment["EZRITE_TRANSLATE_FAKE"] != nil

    init(state: AppState) { self.state = state }

    /// 팝업 버튼: 꺼져 있으면 창 고르기, 켜져 있으면 끈다
    func toggle() {
        if task != nil { return stop("끔") }
        guard picker == nil else { return }
        picker = WindowPicker { [weak self] w in
            guard let self else { return }
            self.picker = nil
            guard let w else { return Log.info("화면 번역", "창 고르기 취소") }
            self.start(w)
        }
    }

    func start(_ w: ScreenTranslate.Window) {
        stop(nil)
        target = w
        state.screenTranslating = true
        Log.info("화면 번역", "시작 — \(w.app) 창 \(Int(w.frame.width))×\(Int(w.frame.height))\(fake ? " (가짜 번역)" : "")")
        let o = TranslateOverlay(model: model, frame: w.frame)
        o.orderFrontRegardless()
        overlay = o
        hoverTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.trackMouse() }
        }
        task = Task { [weak self] in await self?.loop(w.id) }
    }

    func stop(_ why: String?) {
        if let why, task != nil { Log.info("화면 번역", "끝 (\(why)) — 기억한 문단 \(cache.count)개") }
        task?.cancel()
        task = nil
        hoverTimer?.invalidate()
        hoverTimer = nil
        overlay?.close()
        overlay = nil
        model.items = []
        model.hovered = nil
        cache = [:]
        failures = [:]
        page = ScreenTranslate.Page()
        target = nil
        state.screenTranslating = false
    }

    private var known: Set<String> { Set(cache.keys).union(failures.filter { $0.value >= 2 }.keys) }

    private func loop(_ id: CGWindowID) async {
        var sc: SCWindow?
        var last: [[UInt8]] = []
        var dirty = true            // 화면이 바뀌어 아직 다시 읽지 않았다
        var failing = false
        while !Task.isCancelled {
            guard let w = ScreenTranslate.window(id: id) else { return stop("창이 닫힘") }
            follow(w)
            if w.onScreen {
                do {
                    if sc == nil { sc = try await ScreenTranslate.scWindow(id) }
                    if let sc {
                        let small = try await ScreenTranslate.capture(sc, size: w.frame.size, scale: 0.5)
                        let now = ScreenTranslate.grid(small)
                        if ScreenTranslate.differs(now, last) {
                            // 움직이는 중: 덮개가 엉뚱한 자리에 남지 않게 걷고, 멈출 때까지 기다린다
                            last = now
                            dirty = true
                            if !model.items.isEmpty { model.items = [] }
                        } else if dirty {
                            dirty = false
                            await read(sc, w)
                        }
                    }
                    if failing { Log.info("화면 번역", "찍기 다시 됨"); failing = false }
                } catch {
                    if !failing { Log.warn("화면 번역", "찍기 실패: \(error.localizedDescription)") }
                    failing = true
                    sc = nil
                    dirty = true
                    if !model.items.isEmpty { model.items = [] }
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                }
            }
            try? await Task.sleep(nanoseconds: UInt64(ScreenTranslate.tick * 1e9))
        }
    }

    /// 창을 원래 해상도로 찍어 글자를 읽고, 아는 문단은 바로 덮고, 모르는 문단은 옮기러 보낸다
    private func read(_ sc: SCWindow, _ w: ScreenTranslate.Window) async {
        let scale = ScreenTranslate.screen(for: w.frame)?.backingScaleFactor ?? 2
        let size = w.frame.size
        guard let shot = try? await ScreenTranslate.capture(sc, size: size, scale: scale), !Task.isCancelled else { return }
        let t0 = Date()
        let found = await Task.detached { () -> ScreenTranslate.Page in
            ScreenTranslate.analyze(shot, size: size, lines: Explain.readText(shot))
        }.value
        guard !Task.isCancelled else { return }
        page = found
        let todo = ScreenTranslate.pending(found.blocks, height: size.height, edges: found.edges, cut: found.cut, known: known)
        Log.info("화면 번역", String(format: "읽음 줄 %d · 문단 %d (%.1f초), 새로 옮길 문단 %d개", found.rows.count, found.blocks.count,
                                    Date().timeIntervalSince(t0), todo.count))
        redraw()
        pump()
    }

    /// 아직 옮기지 않은 문단을 한 묶음씩. 한 번에 하나만 보낸다 (강의 번역과 같은 한도를 쓴다)
    private func pump() {
        guard !translating, task != nil, let target else { return }
        let todo = Array(ScreenTranslate.pending(page.blocks, height: target.frame.height, edges: page.edges, cut: page.cut, known: known).prefix(ScreenTranslate.batch))
        guard !todo.isEmpty else { return }
        translating = true
        let t0 = Date()
        Task { [weak self] in
            guard let self else { return }
            let out: [String?]
            do {
                if self.fake { out = todo.map { "번역: " + $0 } }
                else {
                    let prompt = ScreenTranslate.prompt(context: self.page.blocks, skip: Set(todo))
                    out = try await ScreenTranslate.checked(todo) {
                        try await Translation.run(todo, context: [], state: self.state, groq: self.groq, prompt: prompt,
                                                  models: GroqClient.screenModels)
                    }
                }
            } catch {
                out = todo.map { _ in nil }
                Log.error("화면 번역", "문단 \(todo.count)개 실패: \(error)")
                self.state.notice = "화면 번역 실패: \(error.localizedDescription)"
            }
            self.translating = false
            guard self.task != nil else { return }
            var got = 0
            for (k, t) in zip(todo, out) {
                if let t { self.cache[k] = t; got += 1 } else { self.failures[k, default: 0] += 1 }
            }
            Log.info("화면 번역", String(format: "문단 %d개 중 %d개 옮김 (%.1f초)", todo.count, got, Date().timeIntervalSince(t0)))
            // shortcut: 기억이 2000 문단을 넘으면 통째로 비운다. 아주 긴 문서를 오래 볼 때만 다시 보낸다
            if self.cache.count > 2000 { self.cache = [:] }
            self.redraw()
            // 실패한 묶음은 잠깐 쉬고 다시
            // 연달아 실패하면(분당 한도 등) 3·6·12·24·30초로 늘려 쉰다
            self.failStreak = got == 0 ? self.failStreak + 1 : 0
            if got == 0 { try? await Task.sleep(nanoseconds: UInt64(min(3 * pow(2, Double(self.failStreak - 1)), 30) * 1e9)) }
            self.pump()
        }
    }

    /// 아는 번역으로 덮개를 다시 만든다
    private func redraw() {
        guard let pixels = page.pixels, let target else { return }
        model.items = page.blocks.enumerated().compactMap { i, b in
            let k = ScreenTranslate.key(b.text)
            // 그대로 돌려받은 글(코드·이름)은 덮지 않는다
            guard ScreenTranslate.translatable(b), !page.cut.contains(i), !ScreenTranslate.touchesEdge(b, height: target.frame.height, edges: page.edges),
                  let t = cache[k], ScreenTranslate.key(t) != k else { return nil }
            return ScreenTranslate.layout(b, id: i, translation: t, pixels: pixels, boldRatio: page.boldRatio, size: page.sizes[i], others: page.others(i))
        }
    }

    /// 창을 따라 덮개를 옮기고, 앞을 가린 창 자리를 알린다
    private func follow(_ w: ScreenTranslate.Window) {
        guard let overlay else { return }
        if w.frame.size != target?.frame.size { model.items = [] }
        target = w
        if overlay.frame != w.frame { overlay.setFrame(w.frame, display: false) }
        if w.onScreen != overlay.isVisible { w.onScreen ? overlay.orderFrontRegardless() : overlay.orderOut(nil) }
        let front = ScreenTranslate.windows().prefix { $0.id != w.id }
        let covered = front.filter { $0.frame.intersects(w.frame) }.map { f in
            CGRect(x: f.frame.minX - w.frame.minX, y: w.frame.maxY - f.frame.maxY, width: f.frame.width, height: f.frame.height)
        }
        if covered != model.covered { model.covered = covered }
    }

    private func trackMouse() {
        guard let target else { return }
        let m = NSEvent.mouseLocation
        let p = CGPoint(x: m.x - target.frame.minX, y: target.frame.maxY - m.y)
        let id = model.items.first { $0.rect.contains(p) }?.id
        if id != model.hovered { model.hovered = id }
    }
}
