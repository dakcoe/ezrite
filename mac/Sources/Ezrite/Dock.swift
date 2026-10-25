import AppKit
import ApplicationServices

/// 화면 나누기: 설명 카드가 슬라이드를 가리지 않게, 그 화면의 창들을 같은 비율로 왼쪽에 줄여 넣고 오른쪽 빈 자리에 카드를 붙인다.
/// 화면을 가로로 s 배 누른 것처럼 x' = 왼쪽 끝 + (x − 왼쪽 끝) × s, 너비' = 너비 × s (세로는 그대로).
/// 픽셀을 누르는 공개 API 는 없어서 창 자리·크기만 바꾼다 — 창 안 내용은 앱이 다시 배치한다.
/// 다른 앱의 창을 옮기려면 손쉬운 사용(Accessibility) 권한이 필요하다. 카드를 닫거나 앱을 끄면 모두 원래 자리·크기로 돌려 놓는다.
/// 맨 앞 창이 전체 화면이면 그대로 둔다 (카드는 예전처럼 위에 뜬다)
@MainActor
final class WindowDock {
    static let shared = WindowDock()
    nonisolated static let cardWidth: CGFloat = 440
    private var saved: [(window: AXUIElement, origin: CGPoint, size: CGSize)] = []
    private var docked = false

    /// 권한이 있는지. ask 면 없을 때 시스템 설정으로 안내하는 창을 띄운다
    nonisolated static func trusted(ask: Bool) -> Bool {
        AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: ask] as CFDictionary)
    }

    /// 카드가 붙을 오른쪽 자리 (화면 좌표)
    nonisolated static func cardFrame(on screen: NSScreen) -> NSRect {
        let f = screen.visibleFrame
        return NSRect(x: f.maxX - cardWidth, y: f.minY, width: cardWidth, height: f.height)
    }

    /// screen 위의 창들을 왼쪽(카드 자리를 뺀 곳)으로 비율대로 줄인다.
    /// 카드를 옆에 붙여도 되면 true (권한 없음·맨 앞 창이 전체 화면이면 false)
    func dock(on screen: NSScreen) -> Bool {
        if docked { return true }
        guard Self.trusted(ask: false) else { return false }
        let me = ProcessInfo.processInfo.processIdentifier
        if let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier != me,
           let win = Self.window(AXUIElementCreateApplication(front.processIdentifier), kAXFocusedWindowAttribute),
           Self.flag(win, "AXFullScreen") == true { return false }
        let left = Self.leftArea(of: screen), area = Self.area(of: screen)
        let s = left.width / area.width
        for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular && app.processIdentifier != me {
            for win in Self.windows(AXUIElementCreateApplication(app.processIdentifier)) {
                guard Self.flag(win, kAXMinimizedAttribute) != true, Self.flag(win, "AXFullScreen") != true,
                      let origin = Self.point(win), let size = Self.size(win),
                      CGRect(origin: origin, size: size).intersects(area) else { continue }
                saved.append((win, origin, size))
                let to = CGPoint(x: area.minX + (origin.x - area.minX) * s, y: origin.y)
                // 위치를 먼저 옮기고 크기를 줄인다. 크기를 바꾸며 자리를 옮기는 앱이 있어 위치를 한 번 더 맞춘다
                Self.set(win, kAXPositionAttribute, to)
                Self.set(win, kAXSizeAttribute, CGSize(width: size.width * s, height: size.height))
                Self.set(win, kAXPositionAttribute, to)
            }
        }
        docked = true
        return true
    }

    /// 줄였던 창들을 원래대로
    func restore() {
        for w in saved {
            Self.set(w.window, kAXSizeAttribute, w.size)
            Self.set(w.window, kAXPositionAttribute, w.origin)
        }
        saved = []
        docked = false
    }

    /// 손쉬운 사용 좌표(주 화면 왼쪽 위가 0, 아래로 +)로 바꾼 화면 전체(메뉴 막대·Dock 제외)
    private static func area(of screen: NSScreen) -> CGRect {
        let f = screen.visibleFrame
        let top = (NSScreen.screens.first?.frame.maxY ?? f.maxY) - f.maxY
        return CGRect(x: f.minX, y: top, width: f.width, height: f.height)
    }

    private static func windows(_ app: AXUIElement) -> [AXUIElement] {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &v) == .success,
              let list = v as? [AXUIElement] else { return [] }
        return list
    }

    /// 손쉬운 사용 좌표(주 화면 왼쪽 위가 0, 아래로 +)로 바꾼 왼쪽 자리
    private static func leftArea(of screen: NSScreen) -> CGRect {
        let f = screen.visibleFrame
        let top = (NSScreen.screens.first?.frame.maxY ?? f.maxY) - f.maxY
        return CGRect(x: f.minX, y: top, width: f.width - cardWidth - 8, height: f.height)
    }

    private static func window(_ app: AXUIElement, _ attr: String) -> AXUIElement? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, attr as CFString, &v) == .success, let v,
              CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }

    private static func flag(_ el: AXUIElement, _ attr: String) -> Bool? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return nil }
        return v as? Bool
    }

    private static func point(_ el: AXUIElement) -> CGPoint? {
        var v: CFTypeRef?, p = CGPoint.zero
        guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &v) == .success, let v,
              CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetValue(v as! AXValue, .cgPoint, &p) else { return nil }
        return p
    }

    private static func size(_ el: AXUIElement) -> CGSize? {
        var v: CFTypeRef?, s = CGSize.zero
        guard AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &v) == .success, let v,
              CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetValue(v as! AXValue, .cgSize, &s) else { return nil }
        return s
    }

    private static func set(_ el: AXUIElement, _ attr: String, _ p: CGPoint) {
        var p = p
        if let v = AXValueCreate(.cgPoint, &p) { AXUIElementSetAttributeValue(el, attr as CFString, v) }
    }

    private static func set(_ el: AXUIElement, _ attr: String, _ s: CGSize) {
        var s = s
        if let v = AXValueCreate(.cgSize, &s) { AXUIElementSetAttributeValue(el, attr as CFString, v) }
    }
}
