import Foundation

/// 번역·화면 설명에 쓸 수 있는 AI 서비스. 기본은 무료인 Groq, 나머지는 사용자가 키를 넣으면 쓴다.
/// 받아쓰기는 Groq 만 쓴다 (Claude 는 음성 인식이 없고, 다른 곳은 음성 API 방식이 다르다)
enum Provider: String, CaseIterable, Identifiable {
    case groq, claude, gemini, openai
    var id: String { rawValue }

    var label: String {
        switch self {
        case .groq: return "Groq"
        case .claude: return "Claude"
        case .gemini: return "Gemini"
        case .openai: return "GPT"
        }
    }

    /// 키 발급 페이지 (설정의 "키 발급받기" 링크)
    var keyPage: URL {
        switch self {
        case .groq: return URL(string: "https://console.groq.com/keys")!
        case .claude: return URL(string: "https://console.anthropic.com/settings/keys")!
        case .gemini: return URL(string: "https://aistudio.google.com/app/apikey")!
        case .openai: return URL(string: "https://platform.openai.com/api-keys")!
        }
    }

    /// 키 발급 안내에 쓰는 주소
    var console: String {
        switch self {
        case .groq: return "console.groq.com"
        case .claude: return "console.anthropic.com"
        case .gemini: return "aistudio.google.com"
        case .openai: return "platform.openai.com"
        }
    }
}

enum Feature {
    case translate, explain
    var key: String { self == .translate ? "translate" : "explain" }
}

enum AI {
    struct Failure: LocalizedError {
        let status: Int?
        let errorDescription: String?
    }

    struct Reply: Equatable {
        let text: String
        let tokens: Int
    }

    static let anthropicVersion = "2023-06-01"

    // MARK: 요청 만들기

    /// 한 번의 요청. image 가 있으면 JPEG 로 붙이고, json 이면 JSON 으로만 답하게 한다
    /// think: false 면 Claude 의 생각 단계를 끈다. 번역처럼 단순한 일에 출력 토큰(비용)이 몇 배로 늘지 않게
    static func request(_ p: Provider, model: String, key: String, prompt: String, image: Data?,
                        json: Bool, maxTokens: Int, think: Bool = true) throws -> URLRequest {
        var req: URLRequest
        var body: [String: Any]
        switch p {
        case .claude:
            req = URLRequest(url: URL(string: "https://api.anthropic.com/v1/messages")!, timeoutInterval: 90)
            req.setValue(key, forHTTPHeaderField: "x-api-key")
            req.setValue(anthropicVersion, forHTTPHeaderField: "anthropic-version")
            var content: [[String: Any]] = []
            if let image {
                content.append(["type": "image", "source": ["type": "base64", "media_type": "image/jpeg",
                                                            "data": image.base64EncodedString()]])
            }
            // Claude 에는 JSON 전용 모드가 없다. 지시로 요구하고, 받을 때 코드블록을 벗긴다(stripFences)
            content.append(["type": "text", "text": json ? prompt + "\nRespond with the JSON object only." : prompt])
            body = ["model": model, "max_tokens": maxTokens, "messages": [["role": "user", "content": content]]]
            if !think { body["thinking"] = ["type": "disabled"] }
        case .groq, .openai, .gemini:
            let base: String
            switch p {
            case .groq: base = "https://api.groq.com/openai/v1"
            case .openai: base = "https://api.openai.com/v1"
            default: base = "https://generativelanguage.googleapis.com/v1beta/openai"
            }
            req = URLRequest(url: URL(string: base + "/chat/completions")!, timeoutInterval: 90)
            req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
            var content: [[String: Any]] = [["type": "text", "text": prompt]]
            if let image {
                content.append(["type": "image_url",
                                "image_url": ["url": "data:image/jpeg;base64," + image.base64EncodedString()]])
            }
            body = ["model": model, "messages": [["role": "user", "content": content]]]
            // GPT 의 추론 모델은 max_tokens 대신 max_completion_tokens 만 받는다
            body[p == .openai ? "max_completion_tokens" : "max_tokens"] = maxTokens
            if json { body["response_format"] = ["type": "json_object"] }
        }
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        return req
    }

    // MARK: 응답 읽기

    static func reply(_ p: Provider, _ data: Data) -> Reply? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let usage = obj["usage"] as? [String: Any]
        let n = { (k: String) in (usage?[k] as? NSNumber)?.intValue ?? 0 }
        switch p {
        case .claude:
            let text = ((obj["content"] as? [[String: Any]]) ?? [])
                .compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined()
            return Reply(text: text, tokens: n("input_tokens") + n("output_tokens"))
        default:
            let msg = ((obj["choices"] as? [[String: Any]])?.first?["message"] as? [String: Any])?["content"] as? String
            return Reply(text: msg ?? "", tokens: n("total_tokens"))
        }
    }

    /// ```json … ``` 처럼 감싸 오거나 앞뒤에 말을 붙여 온 답에서 JSON 객체만 꺼낸다
    static func stripFences(_ text: String) -> String {
        var inner = Substring(text)
        if let open = text.range(of: "```") {
            inner = text[open.upperBound...]
            if let nl = inner.firstIndex(of: "\n") { inner = inner[inner.index(after: nl)...] }   // ```json 줄
            if let close = inner.range(of: "```") { inner = inner[..<close.lowerBound] }
        }
        if let a = inner.firstIndex(of: "{"), let b = inner.lastIndex(of: "}"), a < b { inner = inner[a...b] }
        return inner.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// 오류 응답의 설명. Gemini 는 [{"error":{…}}] 처럼 배열로 감싸 보내기도 한다
    static func errorMessage(_ data: Data) -> String {
        var obj = try? JSONSerialization.jsonObject(with: data)
        if let arr = obj as? [Any] { obj = arr.first }
        let err = (obj as? [String: Any])?["error"]
        return ((err as? [String: Any])?["message"] as? String) ?? (err as? String) ?? ""
    }

    /// 키가 틀렸다는 응답인가. Gemini 는 틀린 키에 401 이 아니라 400 "Please pass a valid API key" 를 준다
    static func keyRejected(status: Int, body: Data) -> Bool {
        if status == 401 || status == 403 { return true }
        guard status == 400 else { return false }
        return String(decoding: body, as: UTF8.self).range(of: "API key", options: .caseInsensitive) != nil
    }

    /// 키가 틀렸거나 권한이 없는 오류만 빼고는 Groq 로 대신 처리한다 (강의 중에 멈추지 않게)
    static func shouldFallback(status: Int?) -> Bool {
        status != 401 && status != 403
    }

    // MARK: 모델 고르기

    /// 서비스별 기본 이름 꼴. 이 꼴(버전 + 등급)에 맞는 모델만 기본으로 고른다.
    /// 그림 생성(nano-banana), 음성(tts·live), 코딩용(codex), 검색용, 날짜 붙은 사본, 실험판(omni·luna)은 빠진다
    private static let shapes: [String] = [
        #"^claude-(opus|sonnet|haiku)-\d+(-\d+)?$"#,
        #"^gemini-\d+(\.\d+)?-(pro|flash)(-preview)?$"#,
        #"^gpt-\d+(\.\d+)?(-mini|-nano|-[a-z]+)?$"#,     // 새 별칭: sol(최상위)·luna(가벼움)·terra·astra
    ]

    /// 용도별 등급. 앞쪽 등급을 먼저 고른다
    private static func tiers(_ feature: Feature) -> [(String) -> Bool] {
        switch feature {
        // GPT 의 pro·codex·search 는 이름 꼴에서 먼저 빠진다(gptExcluded)
        case .explain:
            return [{ $0.contains("-sonnet-") }, { $0.contains("-pro") }, { $0.hasPrefix("gpt-") && $0.hasSuffix("-sol") },
                    { $0.hasPrefix("gpt-") && !gptSmall($0) && !$0.hasSuffix("-sol") }]
        case .translate:
            return [{ $0.contains("-haiku-") }, { $0.contains("-flash") }, { $0.hasPrefix("gpt-") && $0.hasSuffix("-luna") },
                    { $0.hasPrefix("gpt-") && $0.hasSuffix("-mini") }]
        }
    }

    private static func gptSmall(_ m: String) -> Bool { m.hasSuffix("-mini") || m.hasSuffix("-nano") || m.hasSuffix("-luna") }
    /// 이름 꼴(-[a-z]+)에 걸리지만 기본으로 고르면 안 되는 GPT 모델: 아주 비싼 pro, 코딩용, 검색용, 대화판 사본
    private static func gptExcluded(_ m: String) -> Bool {
        m.hasPrefix("gpt-") && ["-pro", "-codex", "-search", "-chat", "-audio", "-realtime", "-image", "-transcribe", "-tts"]
            .contains { m.hasSuffix($0) || m.contains($0 + "-") }
    }

    /// 버전 숫자 (claude-sonnet-5-5 → 5.5, gemini-3.1-pro → 3.1, gpt-5.4-mini → 5.4)
    private static func version(_ m: String) -> Double {
        guard let r = m.range(of: #"\d+([.-]\d+)?"#, options: .regularExpression) else { return 0 }
        return Double(m[r].replacingOccurrences(of: "-", with: ".")) ?? 0
    }

    /// 용도에 맞는 후보를 좋은 순서로: 등급 → 높은 버전 → 정식판(preview 아님). 키를 저장할 때 앞에서부터 실제로 불러 본다
    static func ranked(_ models: [String], for feature: Feature) -> [String] {
        let ok = models.filter { m in
            !gptExcluded(m) && shapes.contains { m.range(of: $0, options: .regularExpression) != nil }
        }
        var out: [String] = []
        for tier in tiers(feature) {
            out += ok.filter(tier).filter { !out.contains($0) }.sorted {
                let (a, b) = (version($0), version($1))
                if a != b { return a > b }
                return !$0.contains("preview") && $1.contains("preview")
            }
        }
        return out
    }

    static func pick(_ models: [String], for feature: Feature) -> String? { ranked(models, for: feature).first }

    /// 실제로 답하는지 짧게 불러 본다 (무료 등급은 목록에 있어도 쓸 수 없는 모델이 많다). 안 되면 그 이유
    static func check(_ p: Provider, model: String) async -> String? {
        guard let key = APIKey.read(p),
              var req = try? request(p, model: model, key: key, prompt: "Say OK", image: nil, json: false,
                                     maxTokens: 16, think: false) else { return "키가 없습니다" }
        // timeoutInterval 은 "응답이 멈춘 시간" 기준이라, 연결만 붙들고 답을 안 주는 모델(Gemini 3.7·3.8 무료 등급)은
        // 끝나지 않는다. 전체 시간으로 끊는다
        guard let (data, resp) = await fetch(req, within: checkTimeout) else { return "\(Int(checkTimeout / 1_000_000_000))초 동안 응답 없음" }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        return code == 200 ? nil : "\(code) \(errorMessage(data).prefix(80))"
    }

    static let checkTimeout: UInt64 = 15_000_000_000
    static let requestTimeout: UInt64 = 60_000_000_000

    /// 전체 시간 안에 끝나지 않으면 nil. URLRequest.timeoutInterval 은 "응답이 멈춘 시간" 기준이라
    /// 연결만 붙들고 답을 안 주는 서버에서는 끝나지 않는다
    static func fetch(_ req: URLRequest, within limit: UInt64) async -> (Data, URLResponse)? {
        await withTaskGroup(of: (Data, URLResponse)?.self) { group in
            group.addTask { try? await URLSession.shared.data(for: req) }
            group.addTask { try? await Task.sleep(nanoseconds: limit); return nil }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    /// 앞 순위부터 불러 봐서 처음 답하는 모델 (최대 4개). 다 안 되면 마지막 이유와 함께 nil
    static func firstWorking(_ p: Provider, _ models: [String], for feature: Feature) async -> (model: String?, reason: String?) {
        var reason: String?
        for m in ranked(models, for: feature).prefix(4) {
            reason = await check(p, model: m)
            if reason == nil { return (m, nil) }
        }
        return (nil, reason ?? "맞는 모델이 없습니다")
    }

    // MARK: 보내기

    /// 한 번 보내고 본문을 받는다. 쓴 토큰은 Usage.spent 로 알린다
    static func complete(_ p: Provider, model: String, prompt: String, image: Data? = nil,
                         json: Bool, maxTokens: Int, think: Bool = true) async throws -> String {
        guard let key = APIKey.read(p) else {
            throw Failure(status: 401, errorDescription: "\(p.label) API 키가 없습니다. 설정에서 키를 입력하세요.")
        }
        let req = try request(p, model: model, key: key, prompt: prompt, image: image, json: json,
                              maxTokens: maxTokens, think: think)
        guard let (data, resp) = await fetch(req, within: requestTimeout) else {
            // 응답이 없으면 Groq 로 대신하도록 상태 코드 없이 던진다
            throw Failure(status: nil, errorDescription: "\(p.label) 가 \(Int(requestTimeout / 1_000_000_000))초 동안 응답하지 않았습니다")
        }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if keyRejected(status: code, body: data) {
            throw Failure(status: 401, errorDescription: "\(p.label) API 키가 맞지 않습니다. 설정에서 다시 확인하세요.")
        }
        guard code == 200, let r = reply(p, data) else {
            let msg = errorMessage(data)
            throw Failure(status: code, errorDescription: "\(p.label) 오류 \(code): \(msg)")
        }
        Usage.spent?(model, .tokens, Double(r.tokens))
        return json ? stripFences(r.text) : r.text
    }

    /// 키 확인 겸 고를 수 있는 모델 목록
    static func models(_ p: Provider) async throws -> [String] {
        guard let key = APIKey.read(p) else { throw Failure(status: 401, errorDescription: "키가 없습니다") }
        var req: URLRequest
        switch p {
        case .claude:
            req = URLRequest(url: URL(string: "https://api.anthropic.com/v1/models?limit=100")!)
            req.setValue(key, forHTTPHeaderField: "x-api-key")
            req.setValue(anthropicVersion, forHTTPHeaderField: "anthropic-version")
        case .groq: req = URLRequest(url: URL(string: "https://api.groq.com/openai/v1/models")!)
        case .openai: req = URLRequest(url: URL(string: "https://api.openai.com/v1/models")!)
        case .gemini: req = URLRequest(url: URL(string: "https://generativelanguage.googleapis.com/v1beta/openai/models")!)
        }
        if p != .claude { req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization") }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = obj["data"] as? [[String: Any]] else {
            let bad = keyRejected(status: code, body: data)
            throw Failure(status: bad ? 401 : code, errorDescription: bad ? "키가 맞지 않습니다" : "확인 실패 (\(code))")
        }
        // Gemini 는 "models/gemini-…" 처럼 앞에 붙여 온다
        return list.compactMap { ($0["id"] as? String)?.replacingOccurrences(of: "models/", with: "") }.sorted()
    }
}
