import AppKit
import Testing
@testable import Ezrite

/// 화면 테마: 시스템 설정 따르기 / 밝게 / 어둡게
struct ThemeTests {
    @Test func 시스템이면_앱이_모양을_정하지_않는다() {
        #expect(Theme.appearance("system") == nil)
    }

    @Test func 밝게_어둡게는_그_모양으로_고정한다() {
        #expect(Theme.appearance("light")?.name == .aqua)
        #expect(Theme.appearance("dark")?.name == .darkAqua)
    }

    @Test func 모르는_값은_시스템으로_본다() {
        #expect(Theme.appearance("sepia") == nil)
    }
}
