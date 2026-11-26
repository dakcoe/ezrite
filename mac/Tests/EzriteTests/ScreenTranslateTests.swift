import AppKit
import Testing
@testable import Ezrite

/// 화면 번역: 글자 인식 조각을 줄·문단으로 묶고, 옮길 것만 고른다
struct ScreenTranslateTests {
    typealias ST = ScreenTranslate
    static let size = CGSize(width: 1000, height: 1000)

    /// 포인트 상자로 조각을 만든다 (Line.box 는 비율)
    static func frag(_ text: String, _ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, id: Int = 0) -> Explain.Line {
        Explain.Line(id: id, text: text, box: CGRect(x: x / 1000, y: y / 1000, width: w / 1000, height: h / 1000))
    }

    static func row(_ text: String, _ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat = 20) -> ST.Row {
        ST.Row(text: text, rect: CGRect(x: x, y: y, width: w, height: h))
    }

    @Test func 같은_높이에_나란한_조각은_한_줄() {
        let rows = ST.rows([Self.frag("neural networks", 135, 100, 150, 20), Self.frag("Line 12:", 20, 101, 100, 19)], size: Self.size)
        #expect(rows.map(\.text) == ["Line 12: neural networks"])
    }

    @Test func 세로로_세운_글은_옆_글과_잇지_않는다() {
        let rows = ST.rows([Self.frag("$US", 100, 100, 8, 30), Self.frag("200-", 110, 110, 20, 9)], size: Self.size)
        #expect(rows.count == 2)
    }

    @Test func 멀리_떨어진_칸은_다른_줄() {
        let rows = ST.rows([Self.frag("Name", 20, 100, 60, 20), Self.frag("Description", 400, 100, 120, 20)], size: Self.size)
        #expect(rows.count == 2)
    }

    @Test func 이어지는_줄은_한_문단_하이픈은_붙인다() {
        let b = ST.blocks([Self.row("A stationary series is one whose statis-", 50, 100, 800),
                           Self.row("tical properties do not depend on time.", 50, 128, 760)])
        #expect(b.count == 1)
        #expect(b[0].text == "A stationary series is one whose statistical properties do not depend on time.")
    }

    @Test func 목록_머리와_짧게_끝난_문장은_문단을_끊는다() {
        let bullets = ST.blocks([Self.row("• The forward pass", 50, 100, 400), Self.row("• Gradients flow", 50, 128, 400)])
        #expect(bullets.count == 2)
        let ended = ST.blocks([Self.row("This line is long and runs across the page width.", 50, 100, 800),
                               Self.row("Short end.", 50, 128, 200), Self.row("Next paragraph starts here", 50, 156, 700)])
        #expect(ended.count == 2)
    }

    @Test func 글자색이나_크기가_다르면_다른_문단() {
        let rows = [Self.row("Automatic updates", 30, 90, 200, 16), Self.row("Download in the background.", 30, 112, 300, 16)]
        #expect(ST.blocks(rows, ink: [.white, .gray]).count == 2)
        #expect(ST.blocks([Self.row("Title", 30, 40, 200, 36), Self.row("body text", 30, 84, 200, 18)]).count == 2)
    }

    @Test func 코드는_옮기지_않고_주석은_옮긴다() {
        #expect(ST.isCode("def train(model, data, epochs=10):"))
        #expect(ST.isCode("return model"))
        #expect(ST.isCode(#"print(f"epoch {epoch}")"#))
        #expect(!ST.isCode("# Train the model for a few epochs"))
        #expect(!ST.isCode("Return the book to the library by Friday, please."))
        #expect(!ST.isCode("stock price in 2015; (b) Daily change in the Google stock price in 2015;"))
        #expect(ST.isCode("x = (a + b) * c"))
        let code = ST.blocks([Self.row("# Train the model", 20, 20, 400), Self.row("def train(model):", 20, 42, 400)])
        #expect(code.count == 2)
        #expect(ST.translatable(code[0]) && !ST.translatable(code[1]))
    }

    @Test func 한국어와_기호뿐인_글은_옮기지_않는다() {
        #expect(!ST.needsTranslation("이 줄은 이미 한국어라서 그대로 둡니다."))
        #expect(!ST.needsTranslation("12:30 — 3.14"))
        #expect(ST.needsTranslation("Settings"))
        #expect(ST.needsTranslation("設定を保存する"))
        // 그래프 눈금·날짜 줄은 숫자가 더 많다
        #expect(!ST.translatable(ST.Block(rows: [Self.row("Jan 2015 Apr 2015 Jul 2015 Oct 2015", 20, 100, 300)])))
        #expect(ST.translatable(ST.Block(rows: [Self.row("9.1 Stationarity and differencing", 20, 100, 300)])))
    }

    @Test func 기억한_문단과_창_끝에_걸린_문단은_다시_보내지_않는다() {
        let blocks = [ST.Block(rows: [Self.row("Hello  world", 20, 100, 200)]),
                      ST.Block(rows: [Self.row("Hello world", 20, 300, 200)]),          // 띄어쓰기만 다른 같은 글
                      ST.Block(rows: [Self.row("Cut at the bottom", 20, 985, 200)]),
                      ST.Block(rows: [Self.row("Already known", 20, 500, 200)])]
        #expect(ST.pending(blocks, height: 1000, known: ["Already known"]) == ["Hello world"])
        // 도구막대(경계 y=90) 바로 밑에 붙은 문단은 위가 잘렸을 수 있다. 줄 높이만큼 떨어지면 온전한 문단
        let cut = ST.Block(rows: [Self.row("Hudson Bay Company; (h) Quarterly", 20, 95, 600)])
        let whole = ST.Block(rows: [Self.row("Consider the nine series plotted", 20, 140, 600)])
        #expect(ST.pending([cut, whole], height: 1000, edges: [90], known: []) == ["Consider the nine series plotted"])
    }

    /// 흰 바탕 200×200pt(1배) 그림. 검은 띠들을 그린다 (y 는 위에서부터)
    static func image(bars: [CGRect]) -> CGImage {
        let ctx = CGContext(data: nil, width: 200, height: 200, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.setFillColor(.white); ctx.fill(CGRect(x: 0, y: 0, width: 200, height: 200))
        ctx.setFillColor(.black)
        bars.forEach { ctx.fill(CGRect(x: $0.minX, y: 200 - $0.maxY, width: $0.width, height: $0.height)) }
        return ctx.makeImage()!
    }

    @Test func 경계_밑에_읽히지_않은_글자_조각이_있으면_잘린_문단() {
        // 경계 y=40. 문단 첫 줄은 y 60~80. 경계 바로 밑 44~50 에 잘린 줄의 글자 아랫부분
        let row = Self.row("Hudson Bay Company", 20, 60, 150)
        let ink = CGRect(x: 20, y: 64, width: 150, height: 12)
        let cut = ST.Pixels(Self.image(bars: [ink, CGRect(x: 30, y: 44, width: 100, height: 6)]), size: CGSize(width: 200, height: 200))!
        #expect(ST.cutBlocks([ST.Block(rows: [row])], rows: [row], pixels: cut, edges: [40]) == [0])
        let clean = ST.Pixels(Self.image(bars: [ink]), size: CGSize(width: 200, height: 200))!
        #expect(ST.cutBlocks([ST.Block(rows: [row])], rows: [row], pixels: clean, edges: [40]).isEmpty)
    }

    @Test func 창_좌표를_Cocoa_좌표로() {
        #expect(ST.cocoaFrame(CGRect(x: 100, y: 50, width: 300, height: 200), primaryHeight: 900) == CGRect(x: 100, y: 650, width: 300, height: 200))
    }

    @Test func 글자_크기는_x_높이로_짐작한다() {
        #expect(abs(ST.fontSize(band: 10.4, text: "hello world") - 20) < 0.01)
        #expect(abs(ST.fontSize(band: 16, text: "設定を保存") - 20) < 0.01)
        #expect(abs(ST.fontSize(band: 14, text: "ARIMA 2024") - 20) < 0.01)
    }
}
