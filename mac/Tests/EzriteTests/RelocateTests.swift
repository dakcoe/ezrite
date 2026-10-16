import CoreGraphics
import Testing
@testable import Ezrite

/// 슬라이드를 스크롤하거나 창을 옮겼을 때, 짚었던 글자를 새 화면에서 다시 찾아 표시를 옮긴다
struct RelocateTests {
    typealias L = Explain.Line
    static func line(_ id: Int, _ text: String, y: CGFloat, x: CGFloat = 0.1) -> L {
        L(id: id, text: text, box: CGRect(x: x, y: y, width: 0.4, height: 0.04))
    }

    @Test func 위아래로_움직인_글자를_새_자리에서_찾는다() throws {
        let before = [Self.line(3, "파레토 효율: 누군가를 더 나쁘게", y: 0.30), Self.line(5, "MRS_A = MRS_B", y: 0.50)]
        let after = [Self.line(0, "7.2 파레토 효율성", y: 0.05), Self.line(1, "파레토 효율: 누군가를 더 나쁘게", y: 0.22),
                     Self.line(2, "MRS_A = MRS_B", y: 0.42)]
        let moved = try #require(Explain.relocate(before, in: after))
        #expect(moved.map(\.box.minY) == [0.22, 0.42])
    }

    @Test func 글자_인식이_조금_달라도_같은_줄로_본다() throws {
        let before = [Self.line(3, "후생경제학 제1정리: 경쟁균형은 파레토 효율적이다", y: 0.7)]
        let after = [Self.line(9, "후생경제학 제1정리 : 경쟁균형은 파레토 효을적이다", y: 0.6)]   // 띄어쓰기·오타
        #expect(Explain.relocate(before, in: after)?.first?.box.minY == 0.6)
    }

    @Test func 같은_글자가_여러_곳이면_원래_자리에_가까운_쪽() throws {
        let before = [Self.line(1, "정리", y: 0.40)]
        let after = [Self.line(7, "정리", y: 0.10), Self.line(8, "정리", y: 0.45)]
        #expect(Explain.relocate(before, in: after)?.first?.box.minY == 0.45)
    }

    @Test func 하나라도_못_찾으면_옮기지_않는다() {
        let before = [Self.line(3, "파레토 효율", y: 0.3), Self.line(5, "MRS_A = MRS_B", y: 0.5)]
        let after = [Self.line(1, "파레토 효율", y: 0.2), Self.line(2, "다음 슬라이드 제목", y: 0.4)]
        #expect(Explain.relocate(before, in: after) == nil)
    }
}
