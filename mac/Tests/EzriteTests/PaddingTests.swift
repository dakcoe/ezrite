import CoreGraphics
import Testing
@testable import Ezrite

/// 표시 상자는 글자보다 조금 넓게 그리되, 이웃 상자와 겹치지 않게 여백을 줄인다
struct PaddingTests {
    static func overlaps(_ r: [CGRect]) -> Bool {
        for i in r.indices { for j in r.indices where j > i && r[i].intersects(r[j]) { return true } }
        return false
    }

    @Test func 떨어져_있으면_원래_여백() {
        let out = Explain.padded([CGRect(x: 0, y: 0, width: 100, height: 20), CGRect(x: 0, y: 100, width: 100, height: 20)])
        #expect(out[0] == CGRect(x: -8, y: -6, width: 116, height: 32))
    }

    @Test func 위아래로_붙은_줄은_사이_간격의_절반까지만() {
        // 도식처럼 줄 사이가 6px 밖에 없다
        let raw = [CGRect(x: 0, y: 0, width: 100, height: 20), CGRect(x: 10, y: 26, width: 80, height: 20)]
        let out = Explain.padded(raw)
        #expect(!Self.overlaps(out))
        #expect(out[0].maxY <= 23 && out[1].minY >= 23)
        #expect(out[0].minX == -8)                                   // 옆 여백은 그대로
    }

    @Test func 좌우로_붙은_라벨도_겹치지_않는다() {
        let raw = [CGRect(x: 0, y: 0, width: 50, height: 20), CGRect(x: 54, y: 2, width: 50, height: 20)]
        #expect(!Self.overlaps(Explain.padded(raw)))
    }

    @Test func 같은_줄을_두_번_짚은_건_그대로_겹친다() {
        let r = CGRect(x: 0, y: 0, width: 100, height: 20)
        let out = Explain.padded([r, r, CGRect(x: 0, y: 23, width: 100, height: 20)])
        #expect(out[0] == out[1])
        #expect(!out[0].intersects(out[2]))
    }

    @Test func 글자_인식이_원래부터_조금_겹치게_잡은_줄도_나눠서_겹치지_않게() {
        // 도식의 "명반응" 아래 "↓ ATP · NADPH" — 인식 영역이 4px 겹친다. 아래 줄이 더 넓다
        let raw = [CGRect(x: 40, y: 0, width: 60, height: 20), CGRect(x: 0, y: 16, width: 140, height: 20)]
        let out = Explain.padded(raw)
        #expect(!Self.overlaps(out), "\(out)")
        #expect(out[0].maxY <= 18 && out[1].minY >= 18)              // 겹친 4px 의 한가운데(18)에서 나뉜다
    }
}
