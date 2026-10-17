import AppKit

/// 화면 테마. 앱 전체(팝업, 창, 설명 카드의 웹 화면까지)가 NSApp.appearance 를 따른다
enum Theme {
    static let options: [(tag: String, label: String)] = [("system", "시스템 설정 따르기"), ("light", "밝게"), ("dark", "어둡게")]

    static func appearance(_ theme: String) -> NSAppearance? {
        switch theme {
        case "light": return NSAppearance(named: .aqua)
        case "dark": return NSAppearance(named: .darkAqua)
        default: return nil
        }
    }

    static func apply(_ theme: String) { NSApp.appearance = appearance(theme) }
}
