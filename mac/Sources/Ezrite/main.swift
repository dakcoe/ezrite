import AppKit

// SwiftUI App 장면을 쓰지 않는다. 장면이 하나라도 있으면(빈 Settings 라도) 창을 모두 닫았을 때
// macOS 가 그 장면의 빈 창("Ezrite 설정")을 대신 띄운다. 메뉴바 팝업과 창은 AppDelegate 가 직접 만든다
let app = NSApplication.shared

// 편집 메뉴가 있어야 입력칸에서 ⌘V·⌘C·⌘X·⌘A·⌘Z 가 동작한다 (메뉴바 앱이라 메뉴 자체는 보이지 않는다)
let mainMenu = NSMenu()
let editItem = NSMenuItem()
let edit = NSMenu(title: "편집")
edit.addItem(withTitle: "실행 취소", action: Selector(("undo:")), keyEquivalent: "z")
edit.addItem(withTitle: "실행 복귀", action: Selector(("redo:")), keyEquivalent: "Z")
edit.addItem(.separator())
edit.addItem(withTitle: "오려두기", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
edit.addItem(withTitle: "복사하기", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
edit.addItem(withTitle: "붙여넣기", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
edit.addItem(withTitle: "전체 선택", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
editItem.submenu = edit
mainMenu.addItem(editItem)
app.mainMenu = mainMenu

let delegate = AppDelegate()
app.delegate = delegate
app.run()
