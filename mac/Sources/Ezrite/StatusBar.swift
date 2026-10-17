import AppKit
import Combine
import SwiftUI

/// 메뉴바 아이콘과 그 아래 팝업. 시스템 메뉴바 팝업(MenuBarExtra)은 바깥을 누르면 닫혀서 직접 만든다.
/// 아이콘을 누르면 열리고, 다시 누를 때까지 떠 있다. 눌러도 강의 창의 포커스를 뺏지 않는다
final class StatusBar: NSObject {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let panel: NSPanel
    private var bag: Set<AnyCancellable> = []
    private var placing = false                 // 코드로 옮기는 중엔 사용자가 옮긴 자리로 저장하지 않는다
    private static let originKey = "popupOrigin"

    private static let idle = icon("MenuIcon", template: true)
    private static let recording = icon("MenuIconRec", template: false)

    init(state: AppState, updater: Updater) {
        panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        super.init()
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        // 메뉴바 층(.statusBar)은 전체 화면에서 메뉴바와 함께 숨는다. 화면 표시(floating+3)·설명 카드(floating+4) 아래
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 2)
        // 열 때마다 지금 보는 화면(전체 화면 영상 포함)으로 데려온다. 창이 있는 데스크톱으로 화면이 넘어가지 않게 한다
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false

        let host = FirstClickHostingView(rootView: AnyView(MenuPopover().environmentObject(state).environmentObject(updater)))
        let size = host.fittingSize
        let blur = NSVisualEffectView(frame: NSRect(origin: .zero, size: size))
        blur.material = .popover
        blur.state = .active
        // 레이어를 깎으면 창 그림자는 네모로 남아 모서리에 반투명한 각이 보인다. 마스크 그림으로 창 모양 자체를 둥글게 한다
        blur.maskImage = Self.roundedMask(radius: 12)
        host.frame = blur.bounds
        host.autoresizingMask = [.width, .height]
        blur.addSubview(host)
        panel.contentView = blur
        panel.setContentSize(size)

        // 사용자가 끌어서 옮긴 자리를 기억한다
        // queue: nil — 옮기는 그 자리에서 바로 불려야 placing 으로 코드가 옮긴 것을 걸러낼 수 있다
        NotificationCenter.default.addObserver(forName: NSWindow.didMoveNotification, object: panel, queue: nil) {
            [weak self] _ in
            guard let self, !self.placing else { return }
            UserDefaults.standard.set(NSStringFromPoint(self.panel.frame.origin), forKey: Self.originKey)
        }

        // 새 버전 띠·저장됨 띠가 나타나고 사라질 때, 작은 창에서 새 문장·번역이 올 때 팝업 높이를 맞춘다 (위쪽 가장자리는 그대로)
        Publishers.Merge4(updater.$available.map { _ in () }, state.$compact.map { _ in () },
                          state.$entries.filter { [weak state] _ in state?.compact == true }.map { _ in () },
                          state.$savedSession.map { _ in () })
            .receive(on: DispatchQueue.main).sink { [weak self, weak host] _ in
            DispatchQueue.main.async {
                guard let self, let host else { return }
                let size = host.fittingSize
                var f = self.panel.frame
                f.origin.y += f.height - size.height
                f.size = size
                // 긴 문장으로 아래로 길어져 화면 밖으로 나가면 위로 올린다
                if let screen = self.panel.screen?.visibleFrame, f.minY < screen.minY {
                    f.size.height = min(f.height, screen.height)
                    f.origin.y = screen.minY
                }
                self.placing = true
                self.panel.setFrame(f, display: true)
                self.placing = false
                self.panel.invalidateShadow()
            }
        }.store(in: &bag)

        item.button?.image = Self.idle
        item.button?.target = self
        item.button?.action = #selector(toggle)
        state.$listening
            .receive(on: DispatchQueue.main)
            .sink { [weak self] on in self?.item.button?.image = on ? Self.recording : Self.idle }
            .store(in: &bag)
    }

    @objc func toggle() {
        // 화면 밖으로 끌어내 안 보이는 팝업은 닫지 말고 화면 안으로 다시 데려온다
        let offScreen = OnScreen.visibleFrame(for: panel.frame).flatMap { OnScreen.pulledIn(panel.frame, into: $0) } != nil
        panel.isVisible && !offScreen ? hide() : show()
    }

    /// 옮겨 둔 자리가 있으면 거기, 없으면 아이콘 바로 아래. 어느 쪽이든 화면 밖으로 나가지 않게 한다
    func show() {
        guard let button = item.button, let window = button.window, let screen = window.screen else { return }
        let anchor = window.convertToScreen(button.convert(button.bounds, to: nil))
        let size = panel.frame.size
        let visible = screen.visibleFrame
        var origin = NSPoint(x: anchor.midX - size.width / 2, y: anchor.minY - size.height - 6)
        // 전체 화면에서 메뉴바가 숨어 있으면 아이콘 위치를 믿을 수 없다. 그땐 오른쪽 위에 둔다
        if !screen.frame.insetBy(dx: -1, dy: -40).contains(NSPoint(x: anchor.midX, y: anchor.midY)) {
            origin = NSPoint(x: visible.maxX - size.width - 8, y: visible.maxY - size.height - 8)
        }
        if let saved = UserDefaults.standard.string(forKey: Self.originKey) { origin = NSPointFromString(saved) }
        if OnScreen.pulledIn(NSRect(origin: origin, size: size), into: visible) != nil {
            UserDefaults.standard.removeObject(forKey: Self.originKey)   // 화면 밖 자리는 잊는다
        }
        origin.x = min(max(origin.x, visible.minX + 8), visible.maxX - size.width - 8)
        origin.y = min(max(origin.y, visible.minY + 8), visible.maxY - size.height)
        placing = true
        panel.setFrameOrigin(origin)
        placing = false
        panel.orderFrontRegardless()
        panel.invalidateShadow()                         // 둥근 마스크를 따라 그림자를 다시 만든다
        button.highlight(true)
    }

    /// 떠 있을 때의 자리. 설명 카드가 겹치지 않게 피한다
    var frame: NSRect? { panel.isVisible ? panel.frame : nil }

    func hide() {
        panel.orderOut(nil)
        item.button?.highlight(false)
    }

    /// 늘어나는 둥근 사각형 마스크 (모서리만 고정, 가운데는 늘린다)
    private static func roundedMask(radius: CGFloat) -> NSImage {
        let side = radius * 2 + 1
        let img = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
            NSColor.black.setFill()
            NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
            return true
        }
        img.capInsets = NSEdgeInsets(top: radius, left: radius, bottom: radius, right: radius)
        img.resizingMode = .stretch
        return img
    }

    /// 앱 아이콘의 마이크·말풍선 선만 뽑은 그림. 평소엔 메뉴바 색을 따르고, 녹음 중엔 빨갛다
    private static func icon(_ name: String, template: Bool) -> NSImage {
        let img = Bundle.main.url(forResource: name, withExtension: "png").flatMap(NSImage.init(contentsOf:))
            ?? NSImage(systemSymbolName: "mic", accessibilityDescription: nil)!
        img.size = NSSize(width: 18, height: 18)     // 36px 그림을 레티나 2배로 쓴다
        img.isTemplate = template
        return img
    }
}

/// 이 영역을 잡고 끌면 창이 움직인다 (테두리 없는 팝업에는 제목 막대가 없어서)
struct WindowDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { DragView() }
    func updateNSView(_ nsView: NSView, context: Context) {}

    final class DragView: NSView {
        override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    }
}

/// 마우스가 들어오고 나가는 것을 알린다. SwiftUI onHover 는 포커스 없는 팝업에서 안 불릴 수 있어서
/// 앱이 활성이 아니어도 동작하는 추적 영역(.activeAlways)을 쓴다
/// 영역 안 마우스의 가로 위치(왼쪽부터, 밖이면 nil)를 알린다
struct HoverArea: NSViewRepresentable {
    let onMove: (CGFloat?) -> Void

    func makeNSView(context: Context) -> TrackView { TrackView(onMove: onMove) }
    func updateNSView(_ view: TrackView, context: Context) { view.onMove = onMove }

    final class TrackView: NSView {
        var onMove: (CGFloat?) -> Void
        init(onMove: @escaping (CGFloat?) -> Void) {
            self.onMove = onMove
            super.init(frame: .zero)
            addTrackingArea(NSTrackingArea(rect: .zero,
                                           options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect],
                                           owner: self, userInfo: nil))
        }
        required init?(coder: NSCoder) { fatalError() }
        override func mouseEntered(with event: NSEvent) { report(event) }
        override func mouseMoved(with event: NSEvent) { report(event) }
        override func mouseExited(with event: NSEvent) { onMove(nil) }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }   // 클릭은 아래 버튼으로 통과
        private func report(_ event: NSEvent) { onMove(convert(event.locationInWindow, from: nil).x) }
    }
}

/// 포커스를 받지 않는 창이라, 첫 클릭이 창 활성화에 쓰이지 않고 바로 버튼에 가게 한다
final class FirstClickHostingView: NSHostingView<AnyView> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
