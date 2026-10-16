import AppKit
import SwiftUI
import WebKit

/// "설명해줘" 한 번의 흐름: 화면 캡처 → 글자 읽기 → Groq 두 요청 → 화면 표시 + 설명 카드
@MainActor
final class Explainer: ObservableObject {
    @Published private(set) var busy = false
    private let groq = GroqClient()
    private var overlay: MarksOverlay?
    private var screen: NSScreen?                  // 설명을 받은 화면 (질문할 때 다시 찍는다)
    private var explanation = ""                   // 보여 준 요약 (질문 때 앞의 설명으로 준다)
    private var history: [(q: String, a: String)] = []
    /// 질문할 때 쓰는 최신 상태: 최근 전사된 음성, 화면 설명 서비스·모델
    var context: (() -> (transcript: [String], provider: Provider, model: String))?
    private var model: OverlayModel?
    private var watch: Task<Void, Never>?          // 표시 자리가 바뀌는지 지켜본다
    private var card: ExplainCard?

    /// transcript: 최근 받아 적은 문장(오래된 것부터). provider 가 Groq 가 아니면 그 서비스에 한 번에 묻고,
    /// 실패하면(키 오류 제외) Groq 로 대신한다. onNotice: 대신 처리했다는 알림
    func run(transcript: [String], provider: Provider = .groq, model: String = "",
             onNotice: @escaping (String) -> Void = { _ in }) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        hideMarks()
        let card = self.card ?? ExplainCard { [weak self] in self?.clear() }
        self.card = card
        history = []
        explanation = ""
        card.onAsk = { [weak self] q in Task { @MainActor in await self?.ask(q) } }

        do {
            let shot = try await ScreenGrab.capture()
            screen = shot.screen
            card.show(on: shot.screen, avoid: AppDelegate.shared?.popupFrame)
            card.render(["loading": "화면을 읽는 중…"])
            let lines = try await Task.detached { try Explain.readText(shot.image) }.value
            card.render(["loading": "설명을 만드는 중…"])
            let jpeg = Self.jpeg(shot.image, maxWidth: 1280)   // 이미지 토큰은 크기와 상관없이 한 장에 약 1,800 (640·1024·1280 실측 같음)

            if provider != .groq, !model.isEmpty {
                do {
                    let text = try await AI.complete(provider, model: model,
                                                     prompt: GroqClient.unifiedPrompt(lines: lines, transcript: transcript),
                                                     image: jpeg, json: true, maxTokens: 3000)
                    let data = Data(text.utf8)
                    return present(card: card, lines: lines, shot: shot, marks: data, visuals: .success(data))
                } catch let e as AI.Failure where AI.shouldFallback(status: e.status) {
                    onNotice("\(provider.label) 설명 실패 → Groq 로 대신했습니다")
                }
            }
            async let marksData = groq.explainMarks(jpeg: jpeg, lines: lines, transcript: transcript)
            async let visualsData = groq.explainVisuals(lines: lines, transcript: transcript)
            let picked = try? await marksData        // 표시가 실패해도 설명 카드는 보여준다
            let visuals: Result<Data, Error>
            do { visuals = .success(try await visualsData) } catch { visuals = .failure(error) }
            present(card: card, lines: lines, shot: shot, marks: picked, visuals: visuals)
        } catch {
            card.render(["error": error.localizedDescription])
        }
    }

    /// 개발용: 설명이 끝난 뒤 질문을 하나 던진다
    var devQuestion: String?

    /// 화면 표시를 그리고 카드에 요약·그림을 채운다
    private func present(card: ExplainCard, lines: [Explain.Line], shot: ScreenGrab.Shot, marks marksData: Data?,
                         visuals: Result<Data, Error>) {
        let marks = marksData.map { Explain.marks(from: $0, lines: lines) } ?? []
        let path = marksData.flatMap { Explain.path(from: $0, lines: lines) }
        var payload: [String: Any] = ["marks": marks.map { ["note": $0.note, "text": $0.line.text] }]
        if let path { payload["path"] = ["note": path.note, "steps": path.steps.map(\.text)] }
        var scenes: [Explain.Scene] = []
        switch visuals {
        case .success(let data):
            let (summary, list) = Explain.visuals(from: data)
            payload["summary"] = summary
            explanation = summary
            payload["visuals"] = list
            scenes = Explain.scenes(from: data, lines: lines, visualCount: list.count)
            payload["scenes"] = scenes.map { sc -> [String: Any] in
                var d: [String: Any] = ["say": sc.say]
                if let v = sc.visual { d["visual"] = v }
                if let r = sc.reveal { d["reveal"] = r }
                return d
            }
        case .failure(let error):
            payload["error"] = "그림 설명을 만들지 못했습니다: \(error.localizedDescription)"
        }
        // 화면 표시: 장면이 있으면 카드가 알려 주는 장면을 따라 바뀌고, 다 본 뒤엔 전체 표시
        let model = OverlayModel(marks: marks, path: path, scenes: scenes)
        if model.hasContent {
            if !scenes.isEmpty { model.scene = 0 }
            let o = MarksOverlay(model: model, screen: shot.screen)
            o.orderFrontRegardless()
            overlay = o
            self.model = model
            watchMarks(shot: shot)
        }
        card.onScene = { [weak self] i in
            guard let m = self?.model else { return }
            m.scene = (0..<m.scenes.count).contains(i) ? i : nil
        }
        card.render(payload)
        if let q = devQuestion {
            devQuestion = nil
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { card.devAsk(q) }
        }
    }

    /// 설명 카드의 질문: 지금 화면을 다시 찍고, 최근 말·앞의 설명·앞의 대화와 함께 묻는다.
    /// 답이 짚은 곳으로 화면 표시를 바꾼다. 실패하면(키 오류 제외) Groq 로 대신한다
    func ask(_ question: String) async {
        guard let card, let ctx = context?() else { return }
        do {
            let shot = try await ScreenGrab.capture(on: screen)
            let lines = try await Task.detached { try Explain.readText(shot.image) }.value
            let prompt = GroqClient.questionPrompt(question, history: history, explanation: explanation,
                                                   lines: lines, transcript: ctx.transcript)
            var data: Data?
            if ctx.provider != .groq, !ctx.model.isEmpty {
                // 답을 읽지 못하면 저절로 한 번 더 묻는다. 두 번째는 생각 단계를 꺼서 토큰이 모자라 답이 잘리는 일을 막는다
                for think in [true, false] where data.flatMap(Explain.answer) == nil {
                    do {
                        let text = try await AI.complete(ctx.provider, model: ctx.model, prompt: prompt,
                                                         image: Self.jpeg(shot.image, maxWidth: 1280), json: true,
                                                         maxTokens: 3000, think: think)
                        data = Data(text.utf8)
                        if Explain.answer(from: data!) == nil { NSLog("Ezrite 질문 답을 읽지 못함: %@", String(text.prefix(400))) }
                    } catch let e as AI.Failure where AI.shouldFallback(status: e.status) {
                        break
                    }
                }
                if data.flatMap(Explain.answer) == nil {
                    data = nil
                    AppDelegate.shared?.state.notice = "\(ctx.provider.label) 답변 실패 → Groq 로 대신했습니다"
                }
            }
            if data == nil { data = try await groq.answer(prompt) }
            guard let data, let text = Explain.answer(from: data) else {
                return card.answer(["error": "답을 읽지 못했습니다. 다시 물어봐 주세요."])
            }
            history.append((question, text))
            let marks = Explain.marks(from: data, lines: lines)
            let path = Explain.path(from: data, lines: lines)
            // 화면 표시를 이 답이 짚은 곳으로 바꾼다
            hideMarks()
            let model = OverlayModel(marks: marks, path: path, scenes: [])
            if model.hasContent {
                let o = MarksOverlay(model: model, screen: shot.screen)
                o.orderFrontRegardless()
                overlay = o
                self.model = model
                watchMarks(shot: shot)
            }
            card.answer(["answer": text, "marks": marks.map { ["note": $0.note, "text": $0.line.text] },
                         "visuals": Explain.visuals(from: data).visuals])
        } catch {
            card.answer(["error": error.localizedDescription])
        }
    }

    /// 개발용: AI 없이 카드에 내용을 바로 띄운다 (그림 틀 모양 확인용)
    func demo(_ payload: [String: Any]) {
        let card = self.card ?? ExplainCard { [weak self] in self?.clear() }
        self.card = card
        if let screen = NSScreen.main { card.show(on: screen, avoid: nil) }
        card.render(payload)
    }

    /// 1초마다 표시 자리만 작게 찍어 처음 모습과 비교한다. 달라졌으면 그 화면 글자를 다시 읽어서
    /// 짚었던 글자가 모두 있으면 표시를 새 자리로 옮기고(스크롤, 창 이동), 없으면 표시만 지운다(슬라이드 넘김).
    /// 카드는 남긴다. 모두 맥 안에서 하고 AI 로는 보내지 않는다
    private func watchMarks(shot: ScreenGrab.Shot) {
        watch?.cancel()
        watch = Task { @MainActor [weak self] in
            guard let first = self?.model else { return }
            var baseline = first.allLines.map { Explain.thumbnail(shot.image, box: $0.box) }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard let self, let model = self.model, self.overlay != nil, !Task.isCancelled else { return }
                let targets = model.allLines
                guard let now = try? await ScreenGrab.capture(on: shot.screen, full: false) else { continue }
                let thumbs = targets.map { Explain.thumbnail(now.image, box: $0.box) }
                guard zip(baseline, thumbs).contains(where: { Explain.changed($0, $1) }) else { continue }

                let lines = (try? await Task.detached { try Explain.readText(now.image) }.value) ?? []
                guard let found = Explain.relocate(targets, in: lines), !Task.isCancelled else {
                    return self.hideMarks()
                }
                model.move(to: Dictionary(found.map { ($0.id, $0.box) }, uniquingKeysWith: { a, _ in a }))
                baseline = model.allLines.map { Explain.thumbnail(now.image, box: $0.box) }
            }
        }
    }

    /// 화면 표시만 지운다 (슬라이드가 넘어감). 카드의 장면 재생은 계속된다
    private func hideMarks() {
        watch?.cancel()
        watch = nil
        overlay?.close()
        overlay = nil
        model = nil
    }

    /// 카드를 닫으면 화면 표시도 지운다
    func clear() {
        hideMarks()
        card?.close()
        card = nil
    }

    /// Groq 이미지 크기 제한 안쪽으로 줄인다. 글자 위치는 원본에서 읽었으니 여기선 모양만 보이면 된다
    static func jpeg(_ image: CGImage, maxWidth: Int) -> Data {
        let scale = min(1, Double(maxWidth) / Double(image.width))
        let w = Int(Double(image.width) * scale), h = Int(Double(image.height) * scale)
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return Data() }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let small = ctx.makeImage() else { return Data() }
        return NSBitmapImageRep(cgImage: small).representation(using: .jpeg, properties: [.compressionFactor: 0.8]) ?? Data()
    }
}

/// 화면 전체를 덮는 투명 창. 클릭은 모두 아래 창으로 통과한다
/// 화면 위 표시 내용. 장면을 고르면 그 장면의 짚은 곳과 화살표만, 아니면(nil) 전체 표시
final class OverlayModel: ObservableObject {
    @Published var marks: [Explain.Mark]
    @Published var path: Explain.Path?
    @Published var scenes: [Explain.Scene]
    @Published var scene: Int?

    init(marks: [Explain.Mark], path: Explain.Path?, scenes: [Explain.Scene]) {
        self.marks = marks
        self.path = path
        self.scenes = scenes
    }

    var hasContent: Bool { !allLines.isEmpty }

    /// 지켜볼 모든 줄 (전체 표시 + 모든 장면). 같은 줄은 한 번만
    var allLines: [Explain.Line] {
        var seen = Set<Int>(), out: [Explain.Line] = []
        let every = marks.map(\.line) + (path?.steps ?? [])
            + scenes.flatMap { $0.focus + [$0.arrow?.from, $0.arrow?.to].compactMap { $0 } }
        for l in every where seen.insert(l.id).inserted { out.append(l) }
        return out
    }

    /// 스크롤·창 이동으로 줄이 옮겨 가면 같은 번호의 줄을 새 자리로
    func move(to boxes: [Int: CGRect]) {
        let f = { (l: Explain.Line) in Explain.Line(id: l.id, text: l.text, box: boxes[l.id] ?? l.box) }
        marks = marks.map { Explain.Mark(line: f($0.line), note: $0.note) }
        path = path.map { Explain.Path(steps: $0.steps.map(f), note: $0.note) }
        scenes = scenes.map { sc in
            var s = sc
            s.focus = sc.focus.map(f)
            s.arrow = sc.arrow.map { (f($0.from), f($0.to)) }
            return s
        }
    }
}

/// 화면 전체를 덮는 투명 창. 클릭은 모두 아래 창으로 통과한다
final class MarksOverlay: NSPanel {
    init(model: OverlayModel, screen: NSScreen) {
        super.init(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = true
        // 녹음 팝업(floating+2)보다 위, 설명 카드(floating+4)보다 아래. 팝업 밑에 가려진 곳을 짚어도 표시가 보인다.
        // 클릭은 통과하니 겹쳐도 팝업 버튼은 그대로 눌린다
        level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 3)

        // 지금 보는 화면(전체 화면 영상 포함)에 뜬다. 다른 데스크톱으로 화면을 넘기지 않는다
        collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary, .ignoresCycle]
        isReleasedWhenClosed = false
        contentView = NSHostingView(rootView: MarksView(model: model))
        setFrame(screen.frame, display: true)
    }
}

private struct MarksView: View {
    @ObservedObject var model: OverlayModel
    static let accent = Color(red: 1, green: 0.42, blue: 0.17)
    static let route = Color(red: 0.18, green: 0.48, blue: 0.97)     // 경로는 파랑: 주황 ①②③ 과 헷갈리지 않게

    var body: some View {
        GeometryReader { geo in
            if let i = model.scene, model.scenes.indices.contains(i) {
                let sc = model.scenes[i]
                let r = Self.layout(sc.focus + [sc.arrow?.from, sc.arrow?.to].compactMap { $0 }, size: geo.size)
                sceneView(sc, number: i + 1, rects: r)
            } else {
                let r = Self.layout(model.marks.map(\.line) + (model.path?.steps ?? []), size: geo.size)
                if let path = model.path { routeView(path, rects: r) }
                ForEach(Array(model.marks.enumerated()), id: \.offset) { i, m in
                    focusBox(r[m.line.id] ?? .zero, label: "\(i + 1)")
                }
            }
        }
        .ignoresSafeArea()
        .animation(.easeInOut(duration: 0.35), value: model.scene)
    }

    /// 장면 하나: 짚은 곳(주황, 장면 번호)과 이어 주는 화살표(파랑)
    @ViewBuilder
    private func sceneView(_ sc: Explain.Scene, number: Int, rects: [Int: CGRect]) -> some View {
        if let a = sc.arrow, let from = rects[a.from.id], let to = rects[a.to.id] {
            RoundedRectangle(cornerRadius: 6).stroke(Self.route, lineWidth: 2.5)
                .frame(width: from.width, height: from.height).position(x: from.midX, y: from.midY)
            Arrow(from: from, to: to)
                .stroke(Self.route, style: StrokeStyle(lineWidth: 3.5, lineCap: .round, lineJoin: .round))
                .shadow(color: Self.route.opacity(0.5), radius: 4)
        }
        ForEach(Array(sc.focus.enumerated()), id: \.offset) { _, l in
            focusBox(rects[l.id] ?? .zero, label: "\(number)")
        }
    }

    private func focusBox(_ r: CGRect, label: String) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8)
                .stroke(Self.accent, lineWidth: 3)
                .shadow(color: Self.accent.opacity(0.6), radius: 6)
                .frame(width: r.width, height: r.height)
                .position(x: r.midX, y: r.midY)
            Text(label)
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 24, height: 24)
                .background(Circle().fill(Self.accent))
                .shadow(radius: 3)
                .position(x: r.minX, y: r.minY)
        }
    }

    /// 라벨을 차례로 화살표로 잇고, 라벨마다 순서 번호를 붙인다
    @ViewBuilder
    private func routeView(_ path: Explain.Path, rects all: [Int: CGRect]) -> some View {
        let rects = path.steps.map { all[$0.id] ?? .zero }
        ForEach(0..<max(rects.count - 1, 0), id: \.self) { i in
            Arrow(from: rects[i], to: rects[i + 1])
                .stroke(Self.route, style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
                .shadow(color: Self.route.opacity(0.5), radius: 4)
        }
        ForEach(Array(rects.enumerated()), id: \.offset) { i, r in
            RoundedRectangle(cornerRadius: 6)
                .stroke(Self.route, lineWidth: 2.5)
                .frame(width: r.width, height: r.height)
                .position(x: r.midX, y: r.midY)
            Text("\(i + 1)")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 22, height: 22)
                .background(Circle().fill(Self.route))
                .shadow(radius: 3)
                .position(x: r.maxX, y: r.minY)
        }
    }

    /// 함께 그릴 줄들의 상자 (줄 번호 → 화면 좌표). 글자보다 조금 넓게 감싸되 이웃 상자와 겹치지 않게 (Explain.padded)
    static func layout(_ lines: [Explain.Line], size: CGSize) -> [Int: CGRect] {
        var seen = Set<Int>(), unique: [Explain.Line] = []
        for l in lines where seen.insert(l.id).inserted { unique.append(l) }
        let raw = unique.map { CGRect(x: $0.box.minX * size.width, y: $0.box.minY * size.height,
                                      width: $0.box.width * size.width, height: $0.box.height * size.height) }
        return Dictionary(uniqueKeysWithValues: zip(unique.map(\.id), Explain.padded(raw)))
    }
}

/// 설명 카드: 화면 오른쪽에 뜨는 작은 창. 옮기고 닫을 수 있고, 눌러도 강의 창의 포커스를 뺏지 않는다
final class ExplainCard: NSObject, NSWindowDelegate {
    private let panel: NSPanel
    private let web = WKWebView()
    private var ready = false
    private var pending: [String: Any]?
    private let onClose: () -> Void

    /// 카드가 장면을 바꿀 때마다 (-1: 전체 보기) — 화면 표시를 그 장면으로 맞춘다
    var onScene: ((Int) -> Void)?
    /// 질문 칸에서 묻기를 누르면
    var onAsk: ((String) -> Void)?
    /// 질문을 시작하면 카드 크기를 더 바꾸지 않는다 (대화가 길어지면 카드 안에서 스크롤)
    private var sizeLocked = false
    /// 직접 닫기 전까지 1초마다 카드가 보이는지 확인한다
    private var keepAlive: Timer?

    init(onClose: @escaping () -> Void) {
        self.onClose = onClose
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 420, height: 560),
                        styleMask: [.titled, .closable, .resizable, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        super.init()
        panel.title = "설명"
        // 도구창(utilityWindow) 버튼은 너무 작아 누르기 어렵다. 일반 크기 닫기만 남긴다
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        // 맨 위: 녹음 팝업(floating+2)과 ①②③ 표시(floating+3)가 설명 글을 가리지 않게
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 4)
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]   // 위 MarksOverlay 와 같은 이유
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        web.setValue(false, forKey: "drawsBackground")
        web.configuration.userContentController.add(HeightRelay(card: self), name: "height")
        web.configuration.userContentController.add(SceneRelay(card: self), name: "scene")
        web.configuration.userContentController.add(AskRelay(card: self), name: "ask")
        web.navigationDelegate = self
        panel.contentView = web
        if let page = Bundle.main.url(forResource: "explain", withExtension: "html", subdirectory: "web") {
            web.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
        }
    }

    /// 처음 한 번만 화면 오른쪽에 놓는다. 그 뒤로는 사용자가 옮긴 자리를 지킨다
    /// avoid: 녹음 팝업 자리. 처음 뜰 때 오른쪽 위에 놓되 팝업과 겹치면 그 왼쪽에 놓는다
    func show(on screen: NSScreen, avoid: NSRect?) {
        if !panel.isVisible {
            let f = screen.visibleFrame
            let h: CGFloat = 150                            // 로딩 중엔 작게. 내용이 오면 그 길이만큼 늘어난다 (fit)
            var frame = NSRect(x: f.maxX - 440, y: f.maxY - h - 20, width: 420, height: h)
            if let avoid, frame.intersects(avoid) {
                frame.origin.x = max(f.minX + 20, avoid.minX - frame.width - 12)
            }
            panel.setFrame(frame, display: true)
        }
        panel.orderFrontRegardless()
        // 다른 앱·전체 화면·데스크톱 전환으로 가려지거나 화면 밖으로 밀려나도, 직접 닫기 전까지는 다시 데려온다
        keepAlive?.invalidate()
        keepAlive = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.stayOnScreen() }
    }

    private func stayOnScreen() {
        if !panel.isVisible { panel.orderFrontRegardless() }
        if let visible = OnScreen.visibleFrame(for: panel.frame),
           let f = OnScreen.pulledIn(panel.frame, into: visible) {
            panel.setFrame(f, display: true, animate: true)
        }
    }

    /// 질문의 답을 대화에 붙인다
    func answer(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("answer(\(json))")
    }

    /// 개발용: 질문 칸에 글을 넣고 묻기를 누른 것처럼 (EZRITE_ASK)
    func devAsk(_ text: String) {
        let lit = String(data: try! JSONSerialization.data(withJSONObject: [text]), encoding: .utf8)!
        web.evaluateJavaScript("q.value = \(lit)[0]; ask()")
    }

    /// 질문을 시작하면 카드를 최대 높이로 늘린 뒤 고정한다 (답이 길어도 카드가 들쭉날쭉하지 않게)
    fileprivate func asked(_ q: String) {
        if !sizeLocked, let screen = panel.screen ?? NSScreen.main {
            let visible = screen.visibleFrame
            var f = panel.frame
            let top = f.maxY, h = visible.height * 0.75
            f.size.height = h
            f.origin.y = max(visible.minY + 10, top - h)
            panel.setFrame(f, display: true, animate: true)
        }
        sizeLocked = true
        onAsk?(q)
    }

    func render(_ payload: [String: Any]) {
        sizeLocked = false
        guard ready else { pending = payload; return }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("render(\(json))")
    }

    func close() {
        keepAlive?.invalidate()
        keepAlive = nil
        panel.delegate = nil
        web.configuration.userContentController.removeScriptMessageHandler(forName: "height")
        web.configuration.userContentController.removeScriptMessageHandler(forName: "scene")
        web.configuration.userContentController.removeScriptMessageHandler(forName: "ask")
        panel.close()
    }

    /// 내용 높이에 맞춰 카드를 늘리거나 줄인다. 위쪽 가장자리는 그대로 두고, 화면 높이를 넘지 않는다
    fileprivate func fit(contentHeight: CGFloat) {
        guard !sizeLocked, let screen = panel.screen ?? NSScreen.main else { return }
        let visible = screen.visibleFrame
        let chrome = panel.frame.height - panel.contentLayoutRect.height     // 제목 막대
        let h = min(max(contentHeight + chrome, 110), visible.height * 0.75)
        var f = panel.frame
        let top = f.maxY
        f.size.height = h
        f.origin.y = max(visible.minY + 10, top - h)
        panel.setFrame(f, display: true, animate: false)
    }

    func windowWillClose(_ notification: Notification) { onClose() }
}

extension ExplainCard: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        ready = true
        if let p = pending { pending = nil; render(p) }
    }
}

/// 두 상자 테두리 사이를 잇는 화살표 (상자 안쪽까지 파고들지 않게 가장자리에서 끊는다)
private struct Arrow: Shape {
    let from: CGRect
    let to: CGRect

    func path(in _: CGRect) -> Path {
        let a = Self.edge(of: from, toward: CGPoint(x: to.midX, y: to.midY))
        let b = Self.edge(of: to, toward: CGPoint(x: from.midX, y: from.midY))
        let angle = atan2(b.y - a.y, b.x - a.x)
        let head: CGFloat = 11
        var p = Path()
        p.move(to: a)
        p.addLine(to: b)
        p.move(to: CGPoint(x: b.x - head * cos(angle - .pi / 7), y: b.y - head * sin(angle - .pi / 7)))
        p.addLine(to: b)
        p.addLine(to: CGPoint(x: b.x - head * cos(angle + .pi / 7), y: b.y - head * sin(angle + .pi / 7)))
        return p
    }

    /// 상자 중심에서 target 쪽으로 나가는 선이 상자 테두리와 만나는 점
    static func edge(of r: CGRect, toward target: CGPoint) -> CGPoint {
        let c = CGPoint(x: r.midX, y: r.midY)
        let dx = target.x - c.x, dy = target.y - c.y
        guard dx != 0 || dy != 0 else { return c }
        let sx = dx == 0 ? CGFloat.infinity : (r.width / 2) / abs(dx)
        let sy = dy == 0 ? CGFloat.infinity : (r.height / 2) / abs(dy)
        let s = min(sx, sy)
        return CGPoint(x: c.x + dx * s, y: c.y + dy * s)
    }
}

/// 웹 화면이 알려 준 내용 높이를 카드에 전한다 (WKUserContentController 가 강하게 잡지 않도록 따로 둔다)
private final class HeightRelay: NSObject, WKScriptMessageHandler {
    weak var card: ExplainCard?
    init(card: ExplainCard) { self.card = card }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        if let h = message.body as? Double { card?.fit(contentHeight: CGFloat(h)) }
        else if let h = message.body as? Int { card?.fit(contentHeight: CGFloat(h)) }
    }
}

/// 카드의 장면 번호를 화면 표시로 전한다
private final class SceneRelay: NSObject, WKScriptMessageHandler {
    weak var card: ExplainCard?
    init(card: ExplainCard) { self.card = card }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        let i = (message.body as? Int) ?? (message.body as? Double).map(Int.init) ?? -1
        card?.onScene?(i)
    }
}

/// 질문 칸에서 보낸 질문을 앱으로 전한다
private final class AskRelay: NSObject, WKScriptMessageHandler {
    weak var card: ExplainCard?
    init(card: ExplainCard) { self.card = card }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        if let q = message.body as? String { card?.asked(q) }
    }
}
