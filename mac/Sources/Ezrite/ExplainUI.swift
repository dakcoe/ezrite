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
    /// 화면 표시 방식 (설정). 떠 있는 표시도 바로 바꾼다. 카드의 목록 모양은 다음 설명부터
    var style: MarkStyle = .fallback { didSet { model?.style = style; card?.restyle(style) } }

    /// transcript: 최근 받아 적은 문장(오래된 것부터). provider 가 Groq 가 아니면 그 서비스에 한 번에 묻고,
    /// 실패하면(키 오류 제외) Groq 로 대신한다. onNotice: 대신 처리했다는 알림
    func run(transcript: [String], provider: Provider = .groq, model: String = "",
             onNotice: @escaping (String) -> Void = { _ in }) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        hideMarks()
        GroqClient.sceneTags = style.wantsTags
        let card = self.card ?? ExplainCard { [weak self] in self?.clear() }
        self.card = card
        history = []
        explanation = ""
        card.onAsk = { [weak self] q in Task { @MainActor in await self?.ask(q) } }

        do {
            let mouse = NSEvent.mouseLocation
            let target = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) ?? NSScreen.main
            let shot = try await ScreenGrab.capture(on: target)
            screen = shot.screen
            card.show(on: shot.screen, avoid: AppDelegate.shared?.popupFrame)
            card.render(["loading": "화면을 읽는 중…"])
            let t0 = Date()
            let lines = await Task.detached { Explain.readText(shot.image) }.value
            Log.info("설명", String(format: "화면 %.0f×%.0f, 글자 줄 %d개 (%.1f초), 표시 방식 %@", shot.screen.frame.width, shot.screen.frame.height,
                                  lines.count, Date().timeIntervalSince(t0), style.rawValue))
            card.place(avoiding: lines.map(\.box), on: shot.screen, popup: AppDelegate.shared?.popupFrame)
            card.render(["loading": "설명을 만드는 중…"])
            let jpeg = Self.jpeg(shot.image, maxWidth: 1280)   // 이미지 토큰은 크기와 상관없이 한 장에 약 1,800 (640·1024·1280 실측 같음)

            if provider != .groq, !model.isEmpty {
                // 생각 단계가 출력 토큰을 다 쓰면 JSON 이 중간에 잘려 요약이 비고 카드가 빈 채로 뜬다 (한도 3000 에서 잘려 8000 으로 올렸다).
                // 읽지 못하면 생각을 끄고 한 번 더, 그래도 안 되면 Groq 로 대신한다 (질문 ask 와 같다)
                let prompt = GroqClient.unifiedPrompt(lines: lines, transcript: transcript, rich: true)
                do {
                    for think in [true, false] {
                        let text = try await AI.complete(provider, model: model, prompt: prompt,
                                                         image: jpeg, json: true, maxTokens: 8000, think: think)
                        let data = Data(text.utf8)
                        if !Explain.visuals(from: data).summary.isEmpty {
                            return present(card: card, lines: lines, shot: shot, marks: data, visuals: .success(data))
                        }
                        Log.warn("설명", "\(provider.label) 답을 읽지 못함 (생각 \(think), \(text.count)자, 끝이 } 인가 \(text.hasSuffix("}")))")
                        if think { card.render(["loading": "설명을 다시 만드는 중…"]) }
                    }
                    onNotice("\(provider.label) 설명을 읽지 못함 → Groq 로 대신했습니다")
                } catch let e as AI.Failure where AI.shouldFallback(status: e.status) {
                    Log.warn("설명", "\(provider.label) 실패 → Groq: \(e.localizedDescription)")
                    onNotice("\(provider.label) 설명 실패 → Groq 로 대신했습니다")
                }
            }
            // Groq: qwen 한 번으로. 한도에 걸리거나 실패하면 예전처럼 두 모델에 나눠 묻는다
            if let data = try? await groq.explainUnified(jpeg: jpeg, lines: lines, transcript: transcript),
               !Explain.marks(from: data, lines: lines).isEmpty || !Explain.visuals(from: data).summary.isEmpty {
                return present(card: card, lines: lines, shot: shot, marks: data, visuals: .success(data))
            }
            Log.warn("설명", "Groq 한 번에 묻기 실패 → 두 모델에 나눠 묻기")
            async let marksData = groq.explainMarks(jpeg: jpeg, lines: lines, transcript: transcript)
            async let visualsData = groq.explainVisuals(lines: lines, transcript: transcript)
            let picked = try? await marksData        // 표시가 실패해도 설명 카드는 보여준다
            let visuals: Result<Data, Error>
            do { visuals = .success(try await visualsData) } catch {
                Log.error("설명", "Groq 설명 실패: \(error)")
                visuals = .failure(error)
            }
            present(card: card, lines: lines, shot: shot, marks: picked, visuals: visuals)
        } catch {
            Log.error("설명", "실패: \(error)")
            card.render(["error": error.localizedDescription])
        }
    }

    /// 개발용: 설명이 끝난 뒤 질문을 하나 던진다
    var devQuestion: String?

    /// 화면 표시를 그리고 카드에 요약·그림을 채운다
    private func present(card: ExplainCard, lines: [Explain.Line], shot: ScreenGrab.Shot, marks marksData: Data?,
                         visuals: Result<Data, Error>) {
        // 설명을 기다리는 사이 카드를 닫았으면 화면 표시를 만들지 않는다 (닫힌 뒤 표시와 화면 감시가 남아 CPU 를 쓴다)
        guard self.card === card else { return }
        let marks = marksData.map { Explain.marks(from: $0, lines: lines) } ?? []
        let path = marksData.flatMap { Explain.path(from: $0, lines: lines) }
        var payload: [String: Any] = ["marks": marks.map { ["note": $0.note, "text": $0.line.text] }, "style": style.rawValue]
        if let path { payload["path"] = ["note": path.note, "steps": path.steps.map(\.text)] }
        var scenes: [Explain.Scene] = []
        switch visuals {
        case .success(let data):
            let (summary, list) = Explain.visuals(from: data)
            if summary.isEmpty && list.isEmpty {         // 읽을 게 없으면 빈 카드 대신 다시 누르라고 알린다
                payload["error"] = "설명을 만들지 못했습니다. ✨ 를 다시 눌러 주세요."
            }
            payload["summary"] = summary
            explanation = summary
            payload["visuals"] = list
            // 개발용(EZRITE_DEMO): 정해 둔 장면부터 ("all" 은 전체 보기)
            if let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let first = o["scene"] { payload["scene"] = first }
            scenes = Explain.scenes(from: data, lines: lines, visualCount: list.count)
            payload["scenes"] = scenes.map { sc -> [String: Any] in
                // mark: 이 장면이 짚은 줄 중 첫 번째 '짚은 곳'의 순번 (색 짝 방식이 자막 번호를 그 색으로 칠한다)
                let mark = sc.focus.compactMap { f in marks.firstIndex { $0.line.id == f.id } }.first ?? -1
                var d: [String: Any] = ["say": sc.say, "mark": mark]
                if let v = sc.visual { d["visual"] = v }
                if let r = sc.reveal { d["reveal"] = r }
                return d
            }
        case .failure(let error):
            payload["error"] = "그림 설명을 만들지 못했습니다: \(error.localizedDescription)"
        }
        payload["map"] = Self.minimap(shot.image, marks: marks, path: path, scenes: scenes)
        // 화면 표시: 장면이 있으면 카드가 알려 주는 장면을 따라 바뀌고, 다 본 뒤엔 전체 표시
        let model = OverlayModel(marks: marks, path: path, scenes: scenes, style: style)
        model.others = lines.map(\.box)
        if model.hasContent {
            if !scenes.isEmpty { model.scene = 0 }
            show(model, on: shot)
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
        Log.info("질문", "시작 (\(ctx.provider), \(ctx.model), 질문 \(question.count)자, 앞 대화 \(history.count)개)")
        let t0 = Date()
        defer { Log.info("질문", String(format: "끝 %.1f초", Date().timeIntervalSince(t0))) }
        do {
            let shot = try await ScreenGrab.capture(on: screen)
            let lines = await Task.detached { Explain.readText(shot.image) }.value
            // Groq 로 묻거나 대신할 때는 움직이는 그림 안내를 뺀 가벼운 질문 (한도에 덜 걸리게)
            let ask = { (rich: Bool) in GroqClient.questionPrompt(question, history: self.history, explanation: self.explanation,
                                                                lines: lines, transcript: ctx.transcript, rich: rich) }
            let prompt = ask(true)
            var data: Data?
            if ctx.provider != .groq, !ctx.model.isEmpty {
                // 답을 읽지 못하면 저절로 한 번 더 묻는다. 두 번째는 생각 단계를 꺼서 토큰이 모자라 답이 잘리는 일을 막는다.
                // 한도 8000: 생각 + LaTeX 단계별 답이 3000 에서 잘렸다
                for think in [true, false] where data.flatMap(Explain.answer) == nil {
                    do {
                        // 답 글은 오는 대로 카드에 채운다. 화면 표시·그림은 다 받은 뒤에 붙는다
                        let text = try await AI.stream(ctx.provider, model: ctx.model, prompt: prompt,
                                                       image: Self.jpeg(shot.image, maxWidth: 1280), json: true,
                                                       maxTokens: 8000, think: think) { soFar in
                            guard let a = Explain.partialAnswer(soFar) else { return }
                            let shown = Explain.dropLineRefs(a, lines: lines)
                            Task { @MainActor in card.partial(shown) }
                        }
                        // 줄 번호("8번 줄")는 학생에게 뜻이 없다. Groq 답처럼 그 줄 글자로 바꾼다
                        data = Data(Explain.dropLineRefs(text, lines: lines).utf8)
                        // 수식 역슬래시를 하나만 써서(\le) 깨진 JSON 은 고쳐 읽는다
                        if Explain.answer(from: data!) == nil, let fixed = Explain.lenientJSON(String(decoding: data!, as: UTF8.self)) {
                            data = fixed
                        }
                        // 그래도 못 읽었지만 답 글은 끝까지 받았으면 그 글로 끝낸다 (다시 물으면 보던 답이 지워지고 처음부터 다시 채워진다)
                        if Explain.answer(from: data!) == nil, let a = Explain.closedAnswer(text),
                           let d = try? JSONSerialization.data(withJSONObject: ["answer": a]) {
                            Log.warn("질문", "JSON 은 깨졌지만 답 글만 씀 (\(text.count)자)")
                            data = d
                        }
                        if Explain.answer(from: data!) == nil { Log.warn("질문", "\(ctx.provider.label) 답을 읽지 못함 (생각 \(think), \(text.count)자, 끝이 } 인가 \(text.hasSuffix("}")))") }
                    } catch let e as AI.Failure where AI.shouldFallback(status: e.status) {
                        Log.warn("질문", "\(ctx.provider.label) 실패 → Groq: \(e.localizedDescription)")
                        break
                    }
                }
                if data.flatMap(Explain.answer) == nil {
                    data = nil
                    AppDelegate.shared?.state.notice = "\(ctx.provider.label) 답변 실패 → Groq 로 대신했습니다"
                }
            }
            if data == nil {
                data = try await groq.answer(ask(false), jpeg: Self.jpeg(shot.image, maxWidth: 1280), lines: lines, transcript: ctx.transcript)
            }
            guard let data, let text = Explain.answer(from: data) else {
                Log.error("질문", "답을 읽지 못함 (Groq 까지)")
                return card.answer(["error": "답을 읽지 못했습니다. 다시 물어봐 주세요."])
            }
            guard self.card === card else { return }      // 답을 기다리는 사이 카드를 닫았다
            history.append((question, text))
            let marks = Explain.marks(from: data, lines: lines)
            let path = Explain.path(from: data, lines: lines)
            // 화면 표시를 이 답이 짚은 곳으로 바꾼다
            hideMarks()
            let model = OverlayModel(marks: marks, path: path, scenes: [], style: style)
            model.others = lines.map(\.box)
            if model.hasContent { show(model, on: shot) }
            card.answer(["answer": text, "marks": marks.map { ["note": $0.note, "text": $0.line.text] }, "style": style.rawValue,
                         "visuals": Explain.visuals(from: data).visuals])
        } catch {
            Log.error("질문", "실패: \(error)")
            card.answer(["error": error.localizedDescription])
        }
    }

    /// 화면 표시 창을 띄우고, 카드의 마우스·글 위치를 표시에 잇는다
    private func show(_ model: OverlayModel, on shot: ScreenGrab.Shot) {
        let o = MarksOverlay(model: model, screen: shot.screen)
        o.orderFrontRegardless()
        overlay = o
        self.model = model
        card?.onHover = { [weak model] ref in model?.hover = ref }
        let frame = shot.screen.frame
        card?.onAnchors = { [weak model] pts in
            // 카드가 다른 화면에 있으면 선을 긋지 않는다
            model?.anchors = pts.filter { frame.contains($0.value) }
                .mapValues { CGPoint(x: $0.x - frame.minX, y: frame.maxY - $0.y) }
        }
        card?.requestAnchors()
        watchMarks(shot: shot)
    }

    /// 카드 속 지도 방식: 찍은 화면을 작게 줄여 넣고, 장면마다 짚은 줄·화살표를 비율 좌표로 준다
    static func minimap(_ image: CGImage, marks: [Explain.Mark], path: Explain.Path?, scenes: [Explain.Scene]) -> [String: Any] {
        let box = { (l: Explain.Line) -> [Double] in [l.box.minX, l.box.minY, l.box.width, l.box.height].map { Double($0) } }
        let jpeg = Self.jpeg(image, maxWidth: 560)
        return [
            "img": "data:image/jpeg;base64," + jpeg.base64EncodedString(),
            "aspect": Double(image.width) / Double(max(1, image.height)),
            "marks": marks.map { box($0.line) },
            "path": (path?.steps ?? []).map(box),
            "scenes": scenes.map { sc -> [String: Any] in
                var d: [String: Any] = ["focus": sc.focus.map(box)]
                if let a = sc.arrow { d["arrow"] = [box(a.from), box(a.to)] }
                return d
            },
        ]
    }

    /// 개발용(EZRITE_DEMO): AI 없이 정해 둔 설명을 지금 화면에 띄운다. JSON 은 AI 답과 같은 모양이되 줄 번호 대신 글자로 적는다
    /// {"summary", "marks":[{"text","note"}], "path":{"texts":[…],"note"}, "scenes":[{"say","focus":[글자],"arrow":{"from","to"},"tag"}]}
    func demoScreen(_ url: URL) async {
        guard let raw = FileManager.default.contents(atPath: url.path),
              var obj = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any] else { Log.error("개발", "데모 JSON 을 읽지 못함"); return }
        hideMarks()
        let card = self.card ?? ExplainCard { [weak self] in self?.clear() }
        self.card = card
        do {
            let shot = try await ScreenGrab.capture()
            screen = shot.screen
            card.show(on: shot.screen, avoid: AppDelegate.shared?.popupFrame)
            let lines = await Task.detached { Explain.readText(shot.image) }.value
            card.place(avoiding: lines.map(\.box), on: shot.screen, popup: AppDelegate.shared?.popupFrame)
            func id(_ text: Any?) -> Int? {
                guard let t = (text as? String)?.replacingOccurrences(of: " ", with: ""), !t.isEmpty else { return nil }
                let flat = { (s: String) in s.replacingOccurrences(of: " ", with: "") }
                // 한두 글자(그림 속 라벨)는 정확히 같은 줄만. 긴 글은 그 글을 품은 줄
                return (lines.first { flat($0.text) == t } ?? (t.count >= 3 ? lines.first { flat($0.text).contains(t) } : nil))?.id
            }
            obj["marks"] = ((obj["marks"] as? [[String: Any]]) ?? []).compactMap { m in id(m["text"]).map { ["id": $0, "note": m["note"] ?? ""] } }
            if let p = obj["path"] as? [String: Any] { obj["path"] = ["ids": ((p["texts"] as? [Any]) ?? []).compactMap(id), "note": p["note"] ?? ""] }
            obj["scenes"] = ((obj["scenes"] as? [[String: Any]]) ?? []).map { sc in
                var d = sc
                d["focus"] = ((sc["focus"] as? [Any]) ?? []).compactMap(id)
                if let a = sc["arrow"] as? [String: Any], let f = id(a["from"]), let t = id(a["to"]) { d["arrow"] = ["from": f, "to": t] } else { d["arrow"] = NSNull() }
                return d
            }
            let data = try JSONSerialization.data(withJSONObject: obj)
            present(card: card, lines: lines, shot: shot, marks: data, visuals: .success(data))
        } catch { card.render(["error": error.localizedDescription]) }
    }

    /// 개발용: AI 없이 카드에 내용을 바로 띄운다 (그림 틀 모양 확인용)
    func demo(_ payload: [String: Any]) {
        let card = self.card ?? ExplainCard { [weak self] in self?.clear() }
        self.card = card
        if let screen = NSScreen.main { card.show(on: screen, avoid: nil) }
        card.render(payload)
    }

    /// 0.4초마다 표시 자리만 작게 찍어 지난번 모습과 비교한다. 달라졌으면 그 화면 글자를 다시 읽어서
    /// 짚었던 글자가 모두 있으면 표시를 새 자리로 옮기고(스크롤, 창 이동), 없으면 표시만 숨긴다(슬라이드 넘김, 다른 창).
    /// 숨긴 동안에도 0.6초마다 살펴서 그 글자가 다시 보이면 되살린다. 카드를 닫을 때까지 계속한다.
    /// 모두 맥 안에서 하고 AI 로는 보내지 않는다
    private func watchMarks(shot: ScreenGrab.Shot) {
        watch?.cancel()
        watch = Task { @MainActor [weak self] in
            guard let first = self?.model else { return }
            var baseline = first.allLines.map { Explain.thumbnail(shot.image, box: $0.box) }
            var hidden = false
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: hidden ? 600_000_000 : 400_000_000)
                guard let self, let model = self.model, let overlay = self.overlay, !Task.isCancelled else { return }
                let targets = model.allLines
                guard let now = try? await ScreenGrab.capture(on: shot.screen, full: false) else { continue }
                let thumbs = targets.map { Explain.thumbnail(now.image, box: $0.box) }
                guard zip(baseline, thumbs).contains(where: { Explain.changed($0, $1) }) else { continue }
                baseline = thumbs                       // 화면이 그대로면 다음엔 글자를 다시 읽지 않는다

                let lines = await Task.detached { Explain.readText(now.image, correct: false) }.value
                guard !Task.isCancelled else { return }
                guard let found = Explain.relocate(targets, in: lines) else {
                    if !hidden { overlay.orderOut(nil); hidden = true }
                    continue
                }
                model.move(to: Dictionary(found.map { ($0.id, $0.box) }, uniquingKeysWith: { a, _ in a }))
                model.others = lines.map(\.box)
                model.missing = Set(targets.map(\.id)).subtracting(found.map(\.id))
                baseline = model.allLines.map { Explain.thumbnail(now.image, box: $0.box) }
                if hidden { overlay.orderFrontRegardless(); hidden = false }
            }
        }
    }

    /// 화면 표시를 지운다 (새 설명·답, 카드 닫기). 카드의 장면 재생은 계속된다
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
    @Published var scene: Int? {
        didSet {
            guard scene != oldValue else { return }
            previous = oldValue.map { i in scenes.indices.contains(i) ? scenes[i].focus.map(\.id) + [scenes[i].arrow?.from.id, scenes[i].arrow?.to.id].compactMap { $0 } : [] } ?? []
            restart()
        }
    }
    /// 화면 밖으로 나가 지금 못 찾은 줄 (그 표시만 숨긴다)
    @Published var missing: Set<Int> = []
    /// 표시 방식. 바꾸면 처음부터 다시 그린다
    @Published var style: MarkStyle { didSet { if style != oldValue { previous = []; restart() } } }
    /// 카드에서 마우스를 올린 항목 ("m0", "s2", "p1", "say")
    @Published var hover: String?
    /// 카드 글의 위치 (오버레이 좌표). 선 긋기 방식이 쓴다
    @Published var anchors: [String: CGPoint] = [:]
    /// 화면의 다른 글자 줄 (비율). 글을 놓을 빈 자리를 찾을 때 피한다
    @Published var others: [CGRect] = []
    /// 장면·방식이 바뀐 때 (움직임 시간 기준)와, 움직임이 다 끝나 다시 그리지 않아도 되는지
    @Published private(set) var started = Date()
    @Published private(set) var settled = false
    /// 바로 전 장면이 짚은 줄 (스포트라이트가 그 자리에서 미끄러져 온다)
    private(set) var previous: [Int] = []
    private var token = 0

    init(marks: [Explain.Mark], path: Explain.Path?, scenes: [Explain.Scene], style: MarkStyle = .classic) {
        self.marks = marks
        self.path = path
        self.scenes = scenes
        self.style = style
        restart()
    }

    /// 움직임을 처음부터. 정해진 시간이 지나면 멈춘다 (전체 화면 창을 계속 다시 그리지 않게)
    func restart() {
        token += 1
        let mine = token
        started = Date()
        settled = false
        DispatchQueue.main.asyncAfter(deadline: .now() + MarksRenderer.settleTime(style)) { [weak self] in
            if self?.token == mine { self?.settled = true }
        }
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

        // 모든 데스크톱(전체 화면 영상 포함)에 함께 있다. 설명을 기다리는 사이 데스크톱을 넘겨도 따라오고,
        // 짚은 글자가 안 보이는 데스크톱에서는 watchMarks 가 표시를 숨겼다가 돌아오면 되살린다
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        isReleasedWhenClosed = false
        contentView = NSHostingView(rootView: MarksView(model: model))
        setFrame(screen.frame, display: true)
    }
}

struct MarksView: View {
    @ObservedObject var model: OverlayModel
    static let accent = Color(red: 1, green: 0.42, blue: 0.17)
    static let route = Color(red: 0.18, green: 0.48, blue: 0.97)     // 경로는 파랑: 주황 ①②③ 과 헷갈리지 않게

    var body: some View {
        if model.style == .classic { classic } else { drawn }
    }

    /// 예전 방식 밖의 표시는 Canvas 한 장에 그린다. 움직임이 끝나면(settled) 다시 그리지 않는다
    private var drawn: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 40, paused: model.settled)) { tl in
            Canvas { g, size in
                MarksRenderer(model: model, t: tl.date.timeIntervalSince(model.started), size: size).draw(&g)
            }
        }
        .ignoresSafeArea()
    }

    private var classic: some View {
        GeometryReader { geo in
            if let i = model.scene, model.scenes.indices.contains(i) {
                let sc = model.scenes[i]
                let r = Self.layout(sc.focus + [sc.arrow?.from, sc.arrow?.to].compactMap { $0 }, size: geo.size, hide: model.missing)
                sceneView(sc, number: i + 1, rects: r)
            } else {
                let r = Self.layout(model.marks.map(\.line) + (model.path?.steps ?? []), size: geo.size, hide: model.missing)
                // 경로는 한 칸이라도 화면 밖이면 통째로 숨긴다 (끊긴 화살표는 헷갈린다)
                if let path = model.path, path.steps.allSatisfy({ r[$0.id] != nil }) { routeView(path, rects: r) }
                ForEach(Array(model.marks.enumerated()), id: \.offset) { i, m in
                    if let box = r[m.line.id] { focusBox(box, label: "\(i + 1)") }
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
            if let box = rects[l.id] { focusBox(box, label: "\(number)") }
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
    static func layout(_ lines: [Explain.Line], size: CGSize, hide: Set<Int> = []) -> [Int: CGRect] {
        var seen = hide, unique: [Explain.Line] = []
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
    /// 카드 항목에 마우스를 올리면 ("m0" 짚은 곳, "s2" 장면, "p1" 경로 칸, "say" 지금 자막, nil 내려놓음)
    var onHover: ((String?) -> Void)?
    /// 카드 글의 화면 위치 (맥 화면 좌표, 카드 왼쪽 가장자리). 선 긋기 표시가 쓴다
    var onAnchors: (([String: CGPoint]) -> Void)?
    /// 질문을 시작하면 카드 크기를 더 바꾸지 않는다 (대화가 길어지면 카드 안에서 스크롤)
    private var sizeLocked = false
    /// 직접 닫기 전까지 1초마다 카드가 보이는지 확인한다
    private var keepAlive: Timer?
    /// 새로 뜬 카드는 글자를 읽은 뒤 빈 쪽으로 옮긴다. 사용자가 끌어 옮기면 그 자리를 지킨다
    private var autoPlace = false
    /// 접기: 자막 한 줄만 남긴다. 펼치면 접기 전 높이로
    private var folded = false
    private var unfoldedHeight: CGFloat?
    private let foldButton = NSButton()

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
        // 맨 위: ①②③ 표시(floating+3)가 설명 글을 가리지 않게. 녹음 팝업과 같은 층이라 둘 중 누른 쪽이 앞에 온다
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 4)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]   // 어느 데스크톱에서도 보인다 (위 MarksOverlay 와 같은 이유)
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        web.setValue(false, forKey: "drawsBackground")
        web.configuration.userContentController.add(HeightRelay(card: self), name: "height")
        web.configuration.userContentController.add(SceneRelay(card: self), name: "scene")
        web.configuration.userContentController.add(AskRelay(card: self), name: "ask")
        web.configuration.userContentController.add(TypingRelay(card: self), name: "typing")
        web.configuration.userContentController.add(HoverRelay(card: self), name: "hover")
        web.configuration.userContentController.add(AnchorRelay(card: self), name: "anchors")
        web.navigationDelegate = self
        panel.contentView = web
        foldButton.isBordered = false
        foldButton.target = self
        foldButton.action = #selector(toggleFold)
        foldButton.frame = NSRect(x: 0, y: 0, width: 30, height: 22)
        let bar = NSTitlebarAccessoryViewController()
        bar.view = foldButton
        bar.layoutAttribute = .trailing
        panel.addTitlebarAccessoryViewController(bar)
        setFold(false)
        if let page = Bundle.main.url(forResource: "explain", withExtension: "html", subdirectory: "web") {
            web.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
        }
    }

    /// 처음 한 번만 화면 오른쪽에 놓는다. 그 뒤로는 사용자가 옮긴 자리를 지킨다
    /// avoid: 녹음 팝업 자리. 처음 뜰 때 오른쪽 위에 놓되 팝업과 겹치면 그 왼쪽에 놓는다
    func show(on screen: NSScreen, avoid: NSRect?) {
        if !panel.isVisible {
            autoPlace = true
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

    /// 글자를 읽은 뒤: 카드를 화면 글자가 가장 적게 가려지는 자리로 옮긴다 (창은 건드리지 않는다).
    /// boxes 는 스크린샷 기준 0~1 (왼쪽 위 원점)
    func place(avoiding boxes: [CGRect], on screen: NSScreen, popup: NSRect?) {
        guard autoPlace else { return }
        let f = screen.frame
        var text = boxes.map { CGRect(x: f.minX + $0.minX * f.width, y: f.maxY - $0.maxY * f.height,
                                      width: $0.width * f.width, height: $0.height * f.height) }
        if let popup { text.append(contentsOf: Array(repeating: popup, count: 20)) }     // 녹음 팝업은 글자 여러 줄만큼 피한다
        let origin = Self.freeSpot(text: text, in: screen.visibleFrame, card: panel.frame.size)
        guard origin != panel.frame.origin else { return }
        panel.setFrame(NSRect(origin: origin, size: panel.frame.size), display: true, animate: true)
    }

    /// 카드가 화면 글자를 가리는 넓이가 가장 작은 자리 (카드 왼쪽 아래, 화면 좌표).
    /// 카드는 내용이 오면 위 가장자리를 고정한 채 아래로 늘어나므로, 늘어난 높이(화면의 60%)로 가린 넓이를 잰다. 같으면 오른쪽 위
    nonisolated static func freeSpot(text: [CGRect], in visible: CGRect, card: CGSize) -> CGPoint {
        let w = card.width, grown = max(card.height, visible.height * 0.6), m: CGFloat = 20
        var best = CGPoint(x: visible.maxX - w - m, y: visible.maxY - card.height - m), least = CGFloat.infinity
        for top in [visible.maxY - m, visible.minY + m + grown] {
            var x = visible.maxX - w - m
            while x >= visible.minX + m {
                let r = CGRect(x: x, y: top - grown, width: w, height: grown)
                let hidden = text.reduce(CGFloat(0)) { s, t in
                    let i = r.intersection(t)
                    return i.isNull ? s : s + i.width * i.height
                }
                if hidden < least - 1 { least = hidden; best = CGPoint(x: x, y: top - card.height) }
                x -= 20
            }
        }
        return best
    }

    @objc private func toggleFold() { setFold(!folded) }

    private func setFold(_ on: Bool) {
        let was = folded
        folded = on
        foldButton.image = NSImage(systemSymbolName: on ? "chevron.down" : "chevron.up", accessibilityDescription: on ? "펼치기" : "접기")
        foldButton.toolTip = on ? "펼치기" : "접기 — 지금 자막 한 줄만 남깁니다"
        guard was != on else { return }
        if on { unfoldedHeight = panel.frame.height }
        else if let h = unfoldedHeight {
            var f = panel.frame
            f.origin.y = f.maxY - h
            f.size.height = h
            panel.setFrame(f, display: true, animate: true)
            unfoldedHeight = nil
        }
        if ready { web.evaluateJavaScript("fold(\(on))") }
    }

    private func stayOnScreen() {
        if !panel.isVisible { panel.orderFrontRegardless() }
        if let visible = OnScreen.visibleFrame(for: panel.frame),
           let f = OnScreen.pulledIn(panel.frame, into: visible) {
            panel.setFrame(f, display: true, animate: true)
        }
    }

    private var pendingPartial: String?

    /// 받는 중인 답 글. 조각마다 다시 그리면 무거워서 0.08초에 한 번만 그린다
    func partial(_ text: String) {
        let scheduled = pendingPartial != nil
        pendingPartial = text
        guard !scheduled else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in
            guard let self, let t = self.pendingPartial,
                  let lit = try? JSONSerialization.data(withJSONObject: [t]) else { return }
            self.pendingPartial = nil
            self.web.evaluateJavaScript("partial(\(String(decoding: lit, as: UTF8.self))[0])")
        }
    }

    /// 질문의 답을 대화에 붙인다
    func answer(_ payload: [String: Any]) {
        pendingPartial = nil        // 다 받은 답 뒤에 늦은 조각이 덮어쓰지 않게
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("answer(\(json))")
    }

    /// 개발용: 질문 칸에 글을 넣고 묻기를 누른 것처럼 (EZRITE_ASK)
    func devAsk(_ text: String) {
        let lit = String(data: try! JSONSerialization.data(withJSONObject: [text]), encoding: .utf8)!
        web.evaluateJavaScript("q.value = \(lit)[0]; ask()")
    }

    fileprivate func typing() {
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKey()
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

    /// 표시 방식이 바뀌면 카드의 목록 모양·마우스 반응도 맞춘다 (질문 대화는 그대로)
    func restyle(_ style: MarkStyle) { if ready { web.evaluateJavaScript("restyle('\(style.rawValue)')") } }
    /// 카드 글 위치를 다시 알려 달라고 한다 (화면 표시를 새로 띄울 때)
    func requestAnchors() { if ready { web.evaluateJavaScript("postAnchors()") } }

    func render(_ payload: [String: Any]) {
        setFold(false)          // 새 설명은 펼쳐서 보여 준다
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
        for name in ["typing", "hover", "anchors"] { web.configuration.userContentController.removeScriptMessageHandler(forName: name) }
        panel.close()
    }

    /// 내용 높이에 맞춰 카드를 늘리거나 줄인다. 위쪽 가장자리는 그대로 두고, 화면 높이를 넘지 않는다
    fileprivate func fit(contentHeight: CGFloat) {
        guard !sizeLocked || folded, let screen = panel.screen ?? NSScreen.main else { return }
        let visible = screen.visibleFrame
        let chrome = panel.frame.height - panel.contentLayoutRect.height     // 제목 막대
        let h = min(max(contentHeight + chrome, folded ? 40 : 110), visible.height * 0.75)
        var f = panel.frame
        let top = f.maxY
        f.size.height = h
        f.origin.y = max(visible.minY + 10, top - h)
        panel.setFrame(f, display: true, animate: false)
    }

    func windowWillClose(_ notification: Notification) { onClose() }
    /// 사용자가 제목 막대를 끌기 시작할 때만 온다 (코드로 옮길 땐 오지 않는다)
    func windowWillMove(_ notification: Notification) { autoPlace = false }
    /// 카드를 옮기면 글 위치를 다시 알린다 (선 긋기 표시가 따라온다)
    func windowDidMove(_ notification: Notification) { web.evaluateJavaScript("postAnchors && postAnchors()") }
    func windowDidResize(_ notification: Notification) { web.evaluateJavaScript("postAnchors && postAnchors()") }

    /// 웹 화면 안 세로 위치(CSS 픽셀, 보이는 영역 위 기준) → 맥 화면 좌표. 보이는 영역 밖이면 버린다
    fileprivate func anchors(_ raw: [String: Any]) {
        let content = panel.contentLayoutRect
        var out: [String: CGPoint] = [:]
        for (k, v) in raw {
            guard let y = (v as? NSNumber).map({ CGFloat($0.doubleValue) }), y >= 0, y <= content.height else { continue }
            out[k] = CGPoint(x: panel.frame.minX, y: panel.frame.minY + content.maxY - y)
        }
        onAnchors?(out)
    }

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

/// 카드 항목에 올린 마우스 → 화면 표시
private final class HoverRelay: NSObject, WKScriptMessageHandler {
    weak var card: ExplainCard?
    init(card: ExplainCard) { self.card = card }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        let ref = message.body as? String
        card?.onHover?(ref?.isEmpty == false ? ref : nil)
    }
}

/// 카드 글의 위치 {"say": y, "m0": y, …} (CSS 픽셀)
private final class AnchorRelay: NSObject, WKScriptMessageHandler {
    weak var card: ExplainCard?
    init(card: ExplainCard) { self.card = card }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        if let d = message.body as? [String: Any] { card?.anchors(d) }
    }
}

/// 질문 칸에서 보낸 질문을 앱으로 전한다
/// 질문 칸을 누르면: 앱을 앞으로 가져와 키 입력이 카드에만 가게 한다
private final class TypingRelay: NSObject, WKScriptMessageHandler {
    weak var card: ExplainCard?
    init(card: ExplainCard) { self.card = card }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        card?.typing()
    }
}

private final class AskRelay: NSObject, WKScriptMessageHandler {
    weak var card: ExplainCard?
    init(card: ExplainCard) { self.card = card }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        if let q = message.body as? String { card?.asked(q) }
    }
}
