import CoreGraphics
import Foundation
import Testing
@testable import Ezrite

/// ①②③ 표시 자리가 바뀌었는지: 그 자리를 작게 줄인 흑백 그림끼리 비교한다
struct ChangeTests {
    /// 왼쪽 절반은 검정, 오른쪽 절반은 흰색인 그림 (left 를 바꾸면 반대)
    static func image(width: Int = 400, height: Int = 200, darkLeft: Bool) -> CGImage {
        let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
        ctx.setFillColor(gray: 1, alpha: 1); ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        ctx.setFillColor(gray: 0, alpha: 1)
        ctx.fill(CGRect(x: darkLeft ? 0 : width / 2, y: 0, width: width / 2, height: height))
        return ctx.makeImage()!
    }

    @Test func 같은_자리가_그대로면_바뀌지_않은_것이다() {
        let box = CGRect(x: 0.1, y: 0.2, width: 0.3, height: 0.5)
        let a = Explain.thumbnail(Self.image(darkLeft: true), box: box)
        let b = Explain.thumbnail(Self.image(width: 200, height: 100, darkLeft: true), box: box)   // 해상도만 다름
        #expect(!Explain.changed(a, b))
    }

    @Test func 표시_자리가_달라지면_바뀐_것이다() {
        let box = CGRect(x: 0.1, y: 0.2, width: 0.3, height: 0.5)        // 왼쪽 절반 안쪽
        let a = Explain.thumbnail(Self.image(darkLeft: true), box: box)
        let b = Explain.thumbnail(Self.image(darkLeft: false), box: box)
        #expect(Explain.changed(a, b))
    }

    @Test func 표시_밖이_바뀌는_건_상관없다() {
        let box = CGRect(x: 0.05, y: 0.1, width: 0.2, height: 0.3)       // 왼쪽 끝
        let left = Self.image(darkLeft: true)
        // 오른쪽 절반만 회색으로 칠한 그림
        let ctx = CGContext(data: nil, width: 400, height: 200, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
        ctx.draw(left, in: CGRect(x: 0, y: 0, width: 400, height: 200))
        ctx.setFillColor(gray: 0.5, alpha: 1); ctx.fill(CGRect(x: 200, y: 0, width: 200, height: 200))
        #expect(!Explain.changed(Explain.thumbnail(left, box: box), Explain.thumbnail(ctx.makeImage()!, box: box)))
    }
}
