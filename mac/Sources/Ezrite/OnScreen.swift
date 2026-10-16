import AppKit

/// 창이 화면 밖으로 밀려났는지 보고, 그렇다면 화면 안쪽 자리를 돌려준다 (설명 카드·메뉴바 팝업)
enum OnScreen {
    /// 창의 60% 이상이 화면 안이면 nil(그대로). 아니면 가장 가까운 화면 안쪽 자리.
    /// 화면보다 큰 창은 위쪽(제목 막대)이 보이게 맞춘다
    static func pulledIn(_ frame: NSRect, into visible: NSRect, margin: CGFloat = 8) -> NSRect? {
        let inside = frame.intersection(visible)
        let shown = inside.isNull ? 0 : inside.width * inside.height
        guard shown < frame.width * frame.height * 0.6 else { return nil }
        var f = frame
        f.origin.x = min(max(f.minX, visible.minX + margin), visible.maxX - f.width - margin)
        f.origin.y = f.height > visible.height ? visible.maxY - f.height
                                               : min(max(f.minY, visible.minY + margin), visible.maxY - f.height)
        return f
    }

    /// 창이 걸친 화면(없으면 주 화면)의 보이는 영역
    static func visibleFrame(for frame: NSRect) -> NSRect? {
        let best = NSScreen.screens.max { a, b in
            let ia = a.visibleFrame.intersection(frame), ib = b.visibleFrame.intersection(frame)
            return (ia.isNull ? 0 : ia.width * ia.height) < (ib.isNull ? 0 : ib.width * ib.height)
        }
        return (best ?? NSScreen.main)?.visibleFrame
    }
}
