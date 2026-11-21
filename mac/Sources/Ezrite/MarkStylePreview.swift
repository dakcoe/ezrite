import AppKit
import SwiftUI

/// 설정의 "설명 표시 방식" 미리보기: 가짜 슬라이드 위에서 실제 화면 표시(MarksView)를 그대로 돌린다. AI·화면 캡처는 쓰지 않는다.
/// 가상 화면(size) 왼쪽은 슬라이드, 오른쪽은 설명 카드 자리(지금 자막). 보일 때는 폭에 맞춰 줄인다
final class MarkPreviewModel: ObservableObject {
    static let size = CGSize(width: 760, height: 400)
    static let slideWidth: CGFloat = 580
    /// 장면 하나를 보여 주는 시간(초). 네 장면 뒤에 전체 보기 한 번
    static let period: TimeInterval = 3.4

    struct Item { let line: Explain.Line; let font: NSFont; let origin: CGPoint }

    let overlay: OverlayModel
    @Published private(set) var say = ""
    private var timer: Timer?
    private var step = 0
    private var token = 0

    init() {
        overlay = OverlayModel(marks: Self.marks, path: Self.path, scenes: Self.scenes, style: .fallback)
        overlay.others = Self.items.map(\.line.box)
    }

    /// 그 방식으로 첫 장면부터 다시 돌린다
    func start(_ style: MarkStyle) {
        timer?.invalidate()
        overlay.style = style
        // 선 긋기: 카드 자리의 자막·목록 위치에서 선이 나간다
        overlay.anchors = ["say": CGPoint(x: Self.slideWidth + 14, y: 62),
                           "m0": CGPoint(x: Self.slideWidth + 14, y: 62), "m1": CGPoint(x: Self.slideWidth + 14, y: 96)]
        step = 0
        apply()
        let t = Timer(timeInterval: Self.period, repeats: true) { [weak self] _ in self?.advance() }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        token += 1
    }

    private func advance() {
        step = (step + 1) % (Self.scenes.count + 1)
        apply()
    }

    private func apply() {
        token += 1
        let mine = token
        let i: Int? = step < Self.scenes.count ? step : nil
        overlay.hover = nil
        overlay.scene = i
        say = i.map { Self.scenes[$0].say } ?? "전체 보기"
        // 마우스를 올린 곳만: 장면 중간에 카드 자막에 마우스를 올린 것처럼
        guard overlay.style == .hover else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.1) { [weak self] in
            guard let self, self.token == mine else { return }
            self.overlay.hover = i == nil ? "m0" : "say"
        }
    }

    func scale(for width: CGFloat) -> CGFloat { width / Self.size.width }

    // ── 가짜 슬라이드 ──

    private static func item(_ id: Int, _ text: String, _ font: NSFont, x: CGFloat, y: CGFloat) -> Item {
        let s = (text as NSString).size(withAttributes: [.font: font])
        let box = CGRect(x: x / size.width, y: y / size.height, width: s.width / size.width, height: s.height / size.height)
        return Item(line: Explain.Line(id: id, text: text, box: box), font: font, origin: CGPoint(x: x, y: y))
    }

    /// 그림의 동그라미 가운데 (x, h, ŷ, L)
    static let nodes: [CGPoint] = [80, 210, 340, 470].map { CGPoint(x: $0, y: 312) }
    static let radius: CGFloat = 30

    static let items: [Item] = {
        let title = NSFont.systemFont(ofSize: 27, weight: .bold), body = NSFont.systemFont(ofSize: 19)
        let label = NSFont.systemFont(ofSize: 22, weight: .medium)
        var out = [item(0, "역전파 — 연쇄법칙으로 기울기 구하기", title, x: 36, y: 30),
                   item(1, "• 순전파: 입력 x → 은닉 h → 출력 ŷ → 손실 L", body, x: 44, y: 96),
                   item(2, "• ∂L/∂W₁ = ∂L/∂h · ∂h/∂W₁", body, x: 44, y: 138),
                   item(3, "• 기울기는 출력에서 입력 방향으로 전달된다", body, x: 44, y: 180)]
        for (k, t) in ["x", "h", "ŷ", "L"].enumerated() {
            let s = (t as NSString).size(withAttributes: [.font: label])
            out.append(item(4 + k, t, label, x: nodes[k].x - s.width / 2, y: nodes[k].y - s.height / 2))
        }
        return out
    }()

    static func line(_ id: Int) -> Explain.Line { items[id].line }

    static let marks = [Explain.Mark(line: line(2), note: "연쇄법칙"), Explain.Mark(line: line(7), note: "손실")]
    static let path = Explain.Path(steps: [line(7), line(6), line(5), line(4)], note: "역전파 길")
    static let scenes: [Explain.Scene] = [
        Explain.Scene(say: "먼저 입력 x 가 h, ŷ 를 거쳐 손실 L 이 된다", focus: [line(1)], arrow: nil, visual: nil, reveal: nil, tag: "순전파"),
        Explain.Scene(say: "역전파는 손실 L 에서 출발한다", focus: [line(7)], arrow: nil, visual: nil, reveal: nil, tag: "출발점"),
        Explain.Scene(say: "받은 값에 자기 몫만 곱하면 h 의 기울기", focus: [line(2)], arrow: (line(6), line(5)), visual: nil, reveal: nil, tag: "넘어온 값 × 내 몫"),
        Explain.Scene(say: "그래서 기울기는 출력에서 입력 쪽으로", focus: [line(3)], arrow: (line(5), line(4)), visual: nil, reveal: nil, tag: "출력 → 입력"),
    ]

    /// 슬라이드(흰 바탕·글·그림). 카드 자리는 화면 표시 위에 따로 그린다 (실제 카드도 표시 위에 뜬다)
    func drawBackdrop(_ g: inout GraphicsContext) {
        g.fill(Path(CGRect(x: 0, y: 0, width: Self.slideWidth, height: Self.size.height)), with: .color(.white))
        Self.drawSlide(&g)
    }

    static func drawSlide(_ g: inout GraphicsContext) {
        let ink = Color(white: 0.12), gray = Color(white: 0.5)
        for it in items {
            g.draw(Text(it.line.text).font(Font(it.font as CTFont)).foregroundColor(ink), at: it.origin, anchor: .topLeading)
        }
        for (k, c) in nodes.enumerated() {
            g.stroke(Path(ellipseIn: CGRect(x: c.x - radius, y: c.y - radius, width: radius * 2, height: radius * 2)), with: .color(ink), lineWidth: 2.5)
            guard k + 1 < nodes.count else { continue }
            let a = CGPoint(x: c.x + radius + 6, y: c.y), b = CGPoint(x: nodes[k + 1].x - radius - 6, y: c.y)
            var p = Path()
            p.move(to: a); p.addLine(to: b)
            p.move(to: CGPoint(x: b.x - 9, y: b.y - 6)); p.addLine(to: b); p.addLine(to: CGPoint(x: b.x - 9, y: b.y + 6))
            g.stroke(p, with: .color(gray), lineWidth: 2)
        }
    }

    /// 설명 카드 자리: 지금 자막. 카드 속 지도 방식이면 축소 화면도
    func drawCard(_ g: inout GraphicsContext) {
        let card = CGRect(x: Self.slideWidth + 10, y: 10, width: Self.size.width - Self.slideWidth - 20, height: Self.size.height - 20)
        g.fill(Path(roundedRect: card, cornerRadius: 14), with: .color(Color(nsColor: .windowBackgroundColor)))
        g.stroke(Path(roundedRect: card, cornerRadius: 14), with: .color(Color(nsColor: .separatorColor)), lineWidth: 1)
        g.draw(Text("설명").font(.system(size: 13, weight: .semibold)).foregroundColor(.secondary),
               at: CGPoint(x: card.midX, y: card.minY + 18))
        let text = Text(say).font(.system(size: 16, weight: .semibold)).foregroundColor(.primary)
        g.draw(g.resolve(text), in: CGRect(x: card.minX + 14, y: card.minY + 40, width: card.width - 28, height: 110))
        guard overlay.style == .minimap else { return }
        let k: CGFloat = (card.width - 28) / Self.slideWidth
        let map = CGRect(x: card.minX + 14, y: card.maxY - 14 - Self.size.height * k, width: Self.slideWidth * k, height: Self.size.height * k)
        g.drawLayer { m in
            m.translateBy(x: map.minX, y: map.minY)
            m.scaleBy(x: k, y: k)
            m.fill(Path(CGRect(x: 0, y: 0, width: Self.slideWidth, height: Self.size.height)), with: .color(.white))
            Self.drawSlide(&m)
            for l in focusLines() {
                let r = CGRect(x: l.box.minX * Self.size.width - 6, y: l.box.minY * Self.size.height - 5,
                               width: l.box.width * Self.size.width + 12, height: l.box.height * Self.size.height + 10)
                m.stroke(Path(roundedRect: r, cornerRadius: 8), with: .color(MarksView.accent), lineWidth: 6)
            }
        }
        g.stroke(Path(map), with: .color(Color(nsColor: .separatorColor)), lineWidth: 1)
    }

    private func focusLines() -> [Explain.Line] {
        guard let i = overlay.scene, Self.scenes.indices.contains(i) else { return Self.marks.map(\.line) }
        return Self.scenes[i].focus
    }
}

struct MarkStylePreview: View {
    @ObservedObject var model: MarkPreviewModel

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                Canvas { g, _ in model.drawBackdrop(&g) }
                MarksView(model: model.overlay)
                Canvas { g, _ in model.drawCard(&g) }
            }
            .frame(width: MarkPreviewModel.size.width, height: MarkPreviewModel.size.height)
            .scaleEffect(model.scale(for: geo.size.width), anchor: .topLeading)
        }
        .aspectRatio(MarkPreviewModel.size, contentMode: .fit)
        .background(Color(nsColor: .underPageBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .allowsHitTesting(false)
    }
}
