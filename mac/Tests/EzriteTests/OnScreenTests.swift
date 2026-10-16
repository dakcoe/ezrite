import AppKit
import Testing
@testable import Ezrite

/// 창이 화면 밖으로 밀려나면 화면 안으로 다시 데려온다 (설명 카드·팝업)
struct OnScreenTests {
    let screen = NSRect(x: 0, y: 0, width: 1440, height: 875)

    @Test func 대부분_화면_안이면_그대로_둔다() {
        #expect(OnScreen.pulledIn(NSRect(x: 1100, y: 300, width: 420, height: 500), into: screen) == nil)
    }

    @Test func 절반_넘게_밖으로_나가면_화면_안으로_옮긴다() {
        let moved = OnScreen.pulledIn(NSRect(x: 1300, y: 300, width: 420, height: 500), into: screen)
        #expect(moved == NSRect(x: 1440 - 420 - 8, y: 300, width: 420, height: 500))
    }

    @Test func 완전히_밖에_있으면_가까운_가장자리_안쪽으로() {
        let moved = OnScreen.pulledIn(NSRect(x: -900, y: -800, width: 420, height: 500), into: screen)
        #expect(moved == NSRect(x: 8, y: 8, width: 420, height: 500))
    }

    @Test func 화면보다_큰_창은_위쪽에_맞춘다() {
        let moved = OnScreen.pulledIn(NSRect(x: 200, y: 600, width: 420, height: 1200), into: screen)
        #expect(moved?.maxY == 875)
    }
}
