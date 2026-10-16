import AppKit
import ScreenCaptureKit
import Vision

/// "설명해줘": 지금 화면 + 최근 강의 말 → 화면 위 표시(①②)와 설명 카드.
/// 화면 캡처는 받아쓰기와 같은 화면 녹화 권한을 쓴다.

/// 마우스가 있는 화면을 찍는다. 우리 앱 창(표시·설명 카드)은 빼고 찍어서 두 번째 눌러도 겹치지 않는다
enum ScreenGrab {
    struct Shot {
        let image: CGImage
        let screen: NSScreen         // 표시를 그릴 화면
    }

    /// on: 찍을 화면 (없으면 마우스가 있는 화면). full: 원래 해상도, 아니면 절반 크기로 가볍게
    static func capture(on target: NSScreen? = nil, full: Bool = true) async throws -> Shot {
        let mouse = NSEvent.mouseLocation
        guard let screen = target ?? NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) ?? NSScreen.main,
              let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        else { throw Explain.Failure("화면을 찾지 못했습니다") }

        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == number.uint32Value }) else {
            throw Explain.Failure("화면을 찾지 못했습니다")
        }
        let mine = content.applications.filter { $0.processID == ProcessInfo.processInfo.processIdentifier }
        let filter = SCContentFilter(display: display, excludingApplications: mine, exceptingWindows: [])
        let config = SCStreamConfiguration()
        let scale = full ? screen.backingScaleFactor : 1
        config.width = Int(screen.frame.width * scale)
        config.height = Int(screen.frame.height * scale)
        config.showsCursor = false
        let image: CGImage
        if #available(macOS 14, *) {
            image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        } else {
            image = try await OneFrame.capture(filter: filter, config: config)
        }
        return Shot(image: image, screen: screen)
    }
}

/// macOS 13: 한 장 찍기(SCScreenshotManager)가 없어서 화면 스트림을 잠깐 열고 첫 화면 한 장만 받는다
private final class OneFrame: NSObject, SCStreamOutput {
    private var done: CheckedContinuation<CGImage, Error>?
    private var stream: SCStream?

    static func capture(filter: SCContentFilter, config: SCStreamConfiguration) async throws -> CGImage {
        let me = OneFrame()
        return try await withCheckedThrowingContinuation { c in
            me.done = c
            let stream = SCStream(filter: filter, configuration: config, delegate: nil)
            me.stream = stream
            do {
                try stream.addStreamOutput(me, type: .screen, sampleHandlerQueue: .global())
                stream.startCapture { error in if let error { me.finish(.failure(error)) } }
            } catch { me.finish(.failure(error)) }
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        // 화면이 바뀌지 않은 틀(idle)에는 그림이 없다. 그림이 있는 첫 틀을 쓴다
        guard type == .screen, let pixels = CMSampleBufferGetImageBuffer(buffer) else { return }
        let ci = CIImage(cvPixelBuffer: pixels)
        guard let image = CIContext().createCGImage(ci, from: ci.extent) else { return }
        finish(.success(image))
    }

    private func finish(_ result: Result<CGImage, Error>) {
        objc_sync_enter(self); defer { objc_sync_exit(self) }
        guard let c = done else { return }
        done = nil
        stream?.stopCapture { _ in }
        withExtendedLifetime(self) { c.resume(with: result) }
    }
}

enum Explain {
    struct Failure: LocalizedError {
        let errorDescription: String?
        init(_ msg: String) { errorDescription = msg }
    }

    /// 화면에서 읽은 글자 한 줄. box 는 화면 크기에 대한 비율(0~1), 왼쪽 위가 원점
    struct Line: Equatable {
        let id: Int
        let text: String
        let box: CGRect
    }

    /// 화면 위에 그릴 표시 하나. 번호(①②③)는 배열 순서다
    struct Mark: Equatable {
        let line: Line
        let note: String
    }

    /// 그림 속 라벨을 차례로 잇는 경로 (회로의 전류 길, 도식의 진행 순서, 지도의 이동 경로 등)
    struct Path: Equatable {
        let steps: [Line]
        let note: String
    }

    /// 설명 영상의 장면 하나: 자막, 짚을 줄, 이전 자리→새 자리 화살표, 옆 그림(몇 단계까지 보일지)
    struct Scene: Equatable {
        let say: String
        var focus: [Line]
        var arrow: (from: Line, to: Line)?
        let visual: Int?
        let reveal: Int?

        static func == (a: Scene, b: Scene) -> Bool {
            a.say == b.say && a.focus == b.focus && a.visual == b.visual && a.reveal == b.reveal
                && a.arrow?.from == b.arrow?.from && a.arrow?.to == b.arrow?.to
        }
    }

    static let maxScenes = 6
    static let maxMarks = 3
    static let maxPathSteps = 10
    static let maxVisuals = 4               // 프롬프트는 2개까지 요청한다. 넘쳐도 카드가 터지지 않게 막는 상한

    // MARK: 글자 읽기

    /// Vision 은 왼쪽 아래가 원점이다. 화면 그리기(SwiftUI)는 왼쪽 위가 원점이라 여기서 한 번만 뒤집는다
    static func topLeft(_ visionBox: CGRect) -> CGRect {
        CGRect(x: visionBox.minX, y: 1 - visionBox.maxY, width: visionBox.width, height: visionBox.height)
    }

    /// 화면 글자와 위치. AI 는 좌표를 직접 못 짚어서, 여기서 찾은 줄 번호만 고르게 한다
    /// correct: 맞춤법 보정. 표시 자리만 다시 찾을 때는 꺼서 빠르게 한다 (복잡한 화면에서 약 40% 빠름)
    static func readText(_ image: CGImage, correct: Bool = true) throws -> [Line] {
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.automaticallyDetectsLanguage = true
        req.usesLanguageCorrection = correct
        try VNImageRequestHandler(cgImage: image).perform([req])
        return (req.results ?? []).enumerated().compactMap { i, o in
            guard let t = o.topCandidates(1).first?.string, !t.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
            return Line(id: i, text: t, box: topLeft(o.boundingBox))
        }
    }

    // MARK: 표시 자리가 바뀌었나

    static let thumbSize = (w: 24, h: 12)
    /// 흑백 0~255 평균 차이가 이보다 크면 바뀐 것. 해상도·압축 차이는 보통 5 아래다
    static let changeLimit = 20.0

    /// 표시 자리(box: 화면 비율, 왼쪽 위 원점)를 작은 흑백 그림으로 줄인다
    static func thumbnail(_ image: CGImage, box: CGRect) -> [UInt8] {
        let w = CGFloat(image.width), h = CGFloat(image.height)
        let rect = CGRect(x: box.minX * w, y: box.minY * h, width: box.width * w, height: box.height * h).integral
        guard let crop = image.cropping(to: rect) else { return [] }
        var px = [UInt8](repeating: 0, count: thumbSize.w * thumbSize.h)
        px.withUnsafeMutableBytes { buf in
            guard let ctx = CGContext(data: buf.baseAddress, width: thumbSize.w, height: thumbSize.h, bitsPerComponent: 8,
                                      bytesPerRow: thumbSize.w, space: CGColorSpaceCreateDeviceGray(),
                                      bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return }
            ctx.interpolationQuality = .medium
            ctx.draw(crop, in: CGRect(x: 0, y: 0, width: thumbSize.w, height: thumbSize.h))
        }
        return px
    }

    static func changed(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        guard a.count == b.count, !a.isEmpty else { return true }
        let diff = zip(a, b).reduce(0) { $0 + abs(Int($1.0) - Int($1.1)) }
        return Double(diff) / Double(a.count) > changeLimit
    }

    // MARK: 표시 상자 여백

    /// 글자 상자(화면 좌표)를 조금 넓혀 그릴 상자로. 이웃 상자와 겹치면 그쪽 여백을 사이 간격의 절반까지 줄인다.
    /// 글자 인식이 이웃 줄을 원래부터 조금 겹치게 잡았으면 겹친 부분 한가운데를 경계로 나눈다(여백이 음수가 된다).
    /// 거의 같은 자리(같은 줄을 두 번 짚음)끼리는 따지지 않는다
    static func padded(_ raw: [CGRect], dx: CGFloat = 8, dy: CGFloat = 6) -> [CGRect] {
        raw.indices.map { i in
            let a = raw[i]
            var left = dx, right = dx, top = dy, bottom = dy
            for (j, b) in raw.enumerated() where j != i && !sameSpot(a, b) {
                let gapX = max(b.minX - a.maxX, a.minX - b.maxX)       // 양수면 떨어져 있고, 음수면 겹친 폭
                let gapY = max(b.minY - a.maxY, a.minY - b.maxY)
                if gapY >= gapX {                                       // 위아래로 나누는 쪽이 덜 깎인다 (겹쳤으면 덜 겹친 축)
                    if b.midY >= a.midY { bottom = min(bottom, gapY / 2 - 0.5) } else { top = min(top, gapY / 2 - 0.5) }
                } else {
                    if b.midX >= a.midX { right = min(right, gapX / 2 - 0.5) } else { left = min(left, gapX / 2 - 0.5) }
                }
            }
            // 너무 깎여 뒤집히지 않게 글자 상자의 절반까지만
            top = max(top, -a.height / 2); bottom = max(bottom, -a.height / 2)
            left = max(left, -a.width / 2); right = max(right, -a.width / 2)
            return CGRect(x: a.minX - left, y: a.minY - top, width: a.width + left + right, height: a.height + top + bottom)
        }
    }

    /// 겹친 넓이가 작은 상자의 80% 이상이면 같은 자리로 본다
    private static func sameSpot(_ a: CGRect, _ b: CGRect) -> Bool {
        let i = a.intersection(b)
        guard !i.isNull else { return false }
        return i.width * i.height >= 0.8 * min(a.width * a.height, b.width * b.height)
    }

    // MARK: 움직인 표시 따라가기

    /// 글자 인식이 조금 달라도(띄어쓰기, 한두 글자) 같은 줄로 보는 기준
    static let sameText = 0.8

    /// 짚었던 줄들을 새 화면 글자에서 다시 찾는다. 글자가 더 같은 쪽, 똑같으면 원래 자리에 가까운 쪽.
    /// 화면 밖으로 나간 줄은 빼고 찾은 줄만 돌려준다. 하나도 못 찾으면 nil (슬라이드가 넘어간 것으로 본다)
    static func relocate(_ targets: [Line], in lines: [Line]) -> [Line]? {
        let out = targets.compactMap { t -> Line? in
            let key = Hallucination.normalize(t.text)
            let candidates = lines.filter { sameLine(key, Hallucination.normalize($0.text)) }
            let score = { (l: Line) in (similarity(key, Hallucination.normalize(l.text)), -distance(l.box, t.box)) }
            guard let best = candidates.max(by: { score($0) < score($1) }) else { return nil }
            return Line(id: t.id, text: t.text, box: best.box)
        }
        return out.isEmpty ? nil : out
    }

    /// 같은 줄인가 (a, b 는 normalize 한 글자). 확대·창 폭이 바뀌면 줄이 다른 곳에서 끊기고 수식 인식이 흔들린다
    static func sameLine(_ a: String, _ b: String) -> Bool {
        if similarity(a, b) >= sameText { return true }
        // 줄이 다른 곳에서 끊김: 짧은 쪽 길이만큼 앞부분이 같다
        let n = min(a.count, b.count)
        if n >= 8, similarity(String(a.prefix(n)), String(b.prefix(n))) >= sameText { return true }
        // 수식 인식이 흔들림: 앞의 한글 낱말(4글자 이상, 예: "출력층오차")이 똑같다
        let label = { (s: String) in String(s.prefix { ("가"..."힣").contains($0) }) }
        let la = label(a)
        return la.count >= 4 && la == label(b)
    }

    private static func distance(_ a: CGRect, _ b: CGRect) -> CGFloat {
        hypot(a.midX - b.midX, a.midY - b.midY)
    }

    /// 1 - 편집 거리 / 긴 쪽 길이
    static func similarity(_ a: String, _ b: String) -> Double {
        let x = Array(a), y = Array(b)
        guard !x.isEmpty, !y.isEmpty else { return x.isEmpty && y.isEmpty ? 1 : 0 }
        var prev = Array(0...y.count)
        for i in 1...x.count {
            var cur = [i] + Array(repeating: 0, count: y.count)
            for j in 1...y.count {
                cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] == y[j - 1] ? 0 : 1))
            }
            prev = cur
        }
        return 1 - Double(prev[y.count]) / Double(max(x.count, y.count))
    }

    // MARK: 응답 검사

    /// Groq 모델이 내부 줄 번호를 쓰면 ("25번 줄에", "(28번)") 그 줄의 글자로 바꾸거나 지운다. 없는 번호는 둔다.
    /// JSON 글 그대로에 써도 깨지지 않게 넣는 글자에서 역슬래시는 빼고 따옴표는 ” 로 바꾼다
    static func dropLineRefs(_ s: String, lines: [Line]) -> String {
        let text = Dictionary(lines.map { ($0.id, $0.text) }, uniquingKeysWith: { a, _ in a })
        let safe = { (t: String) in t.replacingOccurrences(of: "\\", with: "").replacingOccurrences(of: "\"", with: "”") }
        func sub(_ pattern: String, _ s: String, _ make: (String) -> String) -> String {
            let re = try! NSRegularExpression(pattern: pattern)
            var out = s
            for m in re.matches(in: s, range: NSRange(s.startIndex..., in: s)).reversed() {
                guard let whole = Range(m.range, in: out), let num = Range(m.range(at: 1), in: out),
                      let id = Int(out[num]), let line = text[id] else { continue }
                out.replaceSubrange(whole, with: make(line))
            }
            return out
        }
        let quote = { (t: String) in "‘\(safe(t))’" }
        var named = s
        for pattern in [#"(?:화면|스크린)\s*(\d+)번(?:\s*(?:줄|라인))?"#, #"(\d+)번\s*(?:줄|라인)"#, #"(?i)\bline\s+(\d+)"#] {
            named = sub(pattern, named, quote)
        }
        return sub(#"\s*\((\d+)번\)"#, named) { _ in "" }
    }

    /// 모델이 JSON 글 안에 수식 역슬래시를 그대로 써서(\delta, \frac) 깨진 JSON 을 고쳐 읽는다.
    /// 올바른 이스케이프(\" \\ \/ \uXXXX, 뒤에 글자가 이어지지 않는 \n \t 등)는 두고, 나머지 역슬래시는 글자로 만든다
    static func lenientJSON(_ text: String) -> Data? {
        guard let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}"), start < end else { return nil }
        let s = Array(text[start...end])
        var out = "", i = 0
        let isHex = { (c: Character) in c.isHexDigit }
        while i < s.count {
            let c = s[i]
            guard c == "\\", i + 1 < s.count else { out.append(c); i += 1; continue }
            let n = s[i + 1]
            let after = i + 2 < s.count ? s[i + 2] : " "
            let valid = n == "\\" || n == "\"" || n == "/"
                || (n == "u" && i + 5 < s.count && s[(i + 2)...(i + 5)].allSatisfy(isHex))
                || ("bfnrt".contains(n) && !(after.isASCII && after.isLetter))
            if valid { out.append(c); out.append(n); i += 2 } else { out.append("\\\\"); i += 1 }
        }
        let data = Data(out.utf8)
        return (try? JSONSerialization.jsonObject(with: data)) is [String: Any] ? data : nil
    }


    /// AI 가 고른 줄 번호 → 표시. 화면에 없는 번호와 중복은 버리고 3개까지만
    static func marks(from data: Data, lines: [Line]) -> [Mark] {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = obj["marks"] as? [[String: Any]] else { return [] }
        let byID = Dictionary(lines.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var out: [Mark] = []
        for m in raw {
            guard let id = (m["id"] as? NSNumber)?.intValue, let line = byID[id],
                  !out.contains(where: { $0.line.id == id }) else { continue }
            out.append(Mark(line: line, note: (m["note"] as? String) ?? ""))
            if out.count == maxMarks { break }
        }
        return out
    }

    /// AI 가 고른 라벨 순서 → 경로. 화면에 없는 번호와 바로 앞과 같은 번호는 뺀다(한 바퀴 돌아오는 건 둔다)
    static func path(from data: Data, lines: [Line]) -> Path? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = obj["path"] as? [String: Any],
              let ids = raw["ids"] as? [NSNumber] else { return nil }
        let byID = Dictionary(lines.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var steps: [Line] = []
        for id in ids.map(\.intValue) {
            guard let line = byID[id], steps.last?.id != id else { continue }
            steps.append(line)
            if steps.count == maxPathSteps { break }
        }
        return steps.count >= 2 ? Path(steps: steps, note: (raw["note"] as? String) ?? "") : nil
    }

    /// 장면 대본. 화면에 없는 줄·빈 자막은 버리고, 그림 번호와 단계 수는 범위 안으로. 6개까지.
    /// 비어 있으면 예전처럼 표시·그림을 한 번에 보여준다
    static func scenes(from data: Data, lines: [Line], visualCount: Int) -> [Scene] {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = obj["scenes"] as? [[String: Any]] else { return [] }
        let byID = Dictionary(lines.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let num = { (v: Any?) in (v as? NSNumber)?.intValue }
        var out: [Scene] = []
        for r in raw {
            let say = ((r["say"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !say.isEmpty else { continue }
            let focus = ((r["focus"] as? [NSNumber]) ?? []).compactMap { byID[$0.intValue] }
            var arrow: (Line, Line)?
            if let a = r["arrow"] as? [String: Any], let f = num(a["from"]).flatMap({ byID[$0] }),
               let t = num(a["to"]).flatMap({ byID[$0] }), f.id != t.id { arrow = (f, t) }
            let visual = num(r["visual"]).flatMap { (0..<visualCount).contains($0) ? $0 : nil }
            let reveal = visual == nil ? nil : num(r["reveal"]).flatMap { $0 > 0 ? $0 : nil }
            out.append(Scene(say: say, focus: Array(focus.prefix(maxMarks)), arrow: arrow, visual: visual, reveal: reveal))
            if out.count == maxScenes { break }
        }
        return out
    }

    /// 질문에 대한 답 본문
    static func answer(from data: Data) -> String? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let a = (obj["answer"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !a.isEmpty else { return nil }
        return a.replacingOccurrences(of: "\\n", with: "\n")
    }

    /// 설명 카드에 넣을 요약과 그림. 그림은 웹 화면(explain.html)이 그리므로 사전 형태 그대로 넘긴다.
    /// 모르는 형식, 필수 칸이 빈 그림은 버린다
    static func visuals(from data: Data) -> (summary: String, visuals: [[String: Any]]) {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return ("", []) }
        let summary = (obj["summary"] as? String) ?? ""
        let raw = (obj["visuals"] as? [[String: Any]]) ?? []
        let ok = raw.filter { v in
            switch v["type"] as? String {
            case "steps": return !((v["items"] as? [String]) ?? []).isEmpty
            case "table": return !((v["rows"] as? [[Any]]) ?? []).isEmpty && !((v["headers"] as? [String]) ?? []).isEmpty
            case "card": return v["formula"] is String || v["body"] is String || !((v["terms"] as? [[String]]) ?? []).isEmpty
            case "mermaid": return !((v["code"] as? String) ?? "").isEmpty
            default: return false
            }
        }
        return (summary, Array(ok.prefix(maxVisuals)))
    }
}
