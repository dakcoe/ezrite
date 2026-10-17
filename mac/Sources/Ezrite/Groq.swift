import Foundation

/// Groq Whisper 받아쓰기 (번역은 아래 extension).
///
/// 모델 순서는 large-v3 → turbo. 한도(429)는 모델마다 따로 잡히므로 막히면 다음 모델로 넘긴다.
/// 5xx(520·525 등 Groq 앞단 Cloudflare 장애)와 네트워크 오류는 같은 음성으로 다시 보낸다 —
/// 옛 앱은 여기서 그 구간을 버렸다.
actor GroqClient {
    static let models = ["whisper-large-v3", "whisper-large-v3-turbo"]
    private static let url = URL(string: "https://api.groq.com/openai/v1/audio/transcriptions")!
    static let retries = 3

    private var cooldown: [String: Date] = [:]
    /// 마지막으로 성공한 채팅 요청의 토큰 (chat 바로 뒤에 읽는다 — 그 사이에 await 가 없어 다른 요청이 끼지 않는다)
    private var lastTokens = 0.0

    struct Failure: LocalizedError {
        let errorDescription: String?
        init(_ msg: String) { errorDescription = msg }
    }

    /// 받아 적은 구간 하나 (시각은 보낸 소리 안의 초)
    struct RawSeg {
        let text: String
        let start: Double
        let end: Double
        let noSpeech: Double
        var asSegment: Hallucination.Segment { Hallucination.Segment(text: text, noSpeechProb: noSpeech) }
    }

    /// onFallback(막힌 모델, 다음 모델). 지어낸 문장을 거른 글을 돌려준다
    func transcribe(wav: Data, language: String, prompt: String,
                    onFallback: @Sendable (String, String) -> Void) async throws -> String {
        Hallucination.keep(try await segments(wav: wav, language: language, prompt: prompt, onFallback: onFallback)
            .map(\.asSegment))
    }

    /// 구간별 글과 시각. 다시 받아 적기는 이 시각으로 줄을 나눈다
    func segments(wav: Data, language: String, prompt: String,
                  onFallback: @Sendable (String, String) -> Void) async throws -> [RawSeg] {
        guard let key = APIKey.groq() else {
            throw Failure("Groq API 키가 없습니다. 설정에서 키를 입력하세요.")
        }
        let now = Date()
        let usable = Self.models.filter { (cooldown[$0] ?? .distantPast) <= now }
        let chain = usable.isEmpty ? [Self.models[0]] : usable

        var lastError = Failure("음성 인식에 실패했습니다")
        for (i, model) in chain.enumerated() {
            do {
                return try await sendWithRetry(wav: wav, model: model, key: key,
                                               language: language, prompt: prompt)
            } catch let limited as RateLimited {
                cooldown[model] = Date().addingTimeInterval(min(max(limited.retryAfter ?? 30, 30), 600))
                lastError = Failure("'\(model)' 한도를 초과했고 대체할 모델도 없습니다. 잠시 후 다시 시도하세요.")
                if i + 1 < chain.count { onFallback(model, chain[i + 1]) }
            }
        }
        throw lastError
    }

    struct RateLimited: LocalizedError {
        let retryAfter: Double?             // 응답 헤더 retry-after (초)
        var errorDescription: String? {
            let wait = retryAfter.map { s in s >= 60 ? "\(Int((s / 60).rounded(.up)))분 뒤" : "\(Int(s.rounded(.up)))초 뒤" } ?? "잠시 뒤"
            return "Groq 무료 한도에 걸렸습니다. \(wait) 다시 눌러 주세요."
        }
    }

    private func sendWithRetry(wav: Data, model: String, key: String,
                               language: String, prompt: String) async throws -> [RawSeg] {
        var lastError: Error = Failure("음성 인식에 실패했습니다")
        for attempt in 1...Self.retries {
            do {
                return try await sendOnce(wav: wav, model: model, key: key, language: language, prompt: prompt)
            } catch let e as RateLimited {
                throw e
            } catch let e as Transient {
                lastError = Failure(e.message)
                if attempt < Self.retries {
                    try await Task.sleep(nanoseconds: UInt64(1_500_000_000 * Double(attempt)))
                }
            }
        }
        throw Failure("\((lastError as? Failure)?.errorDescription ?? "") — \(Self.retries)번 다시 보냈지만 실패")
    }

    /// 다시 보내면 풀릴 수 있는 오류
    struct Transient: Error { let message: String }

    private func sendOnce(wav: Data, model: String, key: String,
                          language: String, prompt: String) async throws -> [RawSeg] {
        // verbose_json: 구간마다 "말소리 없음 확률"이 와서 지어낸 문장을 구간 단위로 거를 수 있다
        var fields = ["model": model, "response_format": "verbose_json", "temperature": "0", "language": language]
        if !prompt.isEmpty {
            fields["prompt"] = String(prompt.suffix(400))   // 직전 문맥: 고유명사·용어 인식률이 오른다
        }
        let boundary = "ezrite-\(UUID().uuidString)"
        var req = URLRequest(url: Self.url, timeoutInterval: 60)
        req.httpMethod = "POST"
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.httpBody = Self.multipart(fields: fields, file: wav, boundary: boundary)

        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await URLSession.shared.data(for: req)
        } catch {
            throw Transient(message: "네트워크 오류: \(error.localizedDescription)")
        }
        let http = resp as? HTTPURLResponse
        if let http, let u = Usage.read(http) { Usage.report?(model, u) }
        let code = http?.statusCode ?? 0
        switch code {
        case 200:
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            if let secs = (obj?["duration"] as? NSNumber)?.doubleValue { Usage.spent?(model, .audio, secs) }
            guard let segs = obj?["segments"] as? [[String: Any]] else {
                let text = ((obj?["text"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                return text.isEmpty ? [] : [RawSeg(text: text, start: 0, end: 0, noSpeech: 0)]
            }
            let num = { (v: Any?) in (v as? NSNumber)?.doubleValue ?? 0 }
            return segs.map { RawSeg(text: $0["text"] as? String ?? "", start: num($0["start"]), end: num($0["end"]),
                                     noSpeech: num($0["no_speech_prob"])) }
        case 401:
            throw Failure("API 키가 올바르지 않습니다. 설정에서 다시 확인하세요.")
        case 429:
            throw RateLimited(retryAfter: (http?.value(forHTTPHeaderField: "retry-after")).flatMap(Double.init))
        case 500...599:
            // 52x 는 Cloudflare 가 HTML 페이지를 돌려준다. 본문 대신 코드만 보여준다
            throw Transient(message: "Groq 서버 일시 장애 (\(code))")
        default:
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let msg = (obj?["error"] as? [String: Any])?["message"] as? String
            throw Failure("Groq 오류 \(code): \(msg ?? String(decoding: data.prefix(200), as: UTF8.self))")
        }
    }

    private static func multipart(fields: [String: String], file: Data, boundary: String) -> Data {
        var body = Data()
        func add(_ s: String) { body.append(contentsOf: Array(s.utf8)) }
        for (k, v) in fields {
            add("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(k)\"\r\n\r\n\(v)\r\n")
        }
        add("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\n")
        add("Content-Type: audio/wav\r\n\r\n")
        body.append(file)
        add("\r\n--\(boundary)--\r\n")
        return body
    }
}

/// API 키는 나만 읽을 수 있는 파일(0600)에 둔다.
/// 키체인은 자체 서명 앱을 빌드마다 다른 앱으로 보고 로그인 암호를 다시 물어서 쓰지 않는다.
/// 서비스별 API 키. 키체인 대신 나만 읽을 수 있는 파일(0600)에 둔다 (DEVELOPMENT.md 참고)
enum APIKey {
    private static let dir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Ezrite")

    private static func file(_ p: Provider) -> URL { dir.appendingPathComponent("\(p.rawValue)_key") }

    static func read(_ p: Provider) -> String? {
        if let k = try? String(contentsOf: file(p), encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines), !k.isEmpty { return k }
        return p == .groq ? migrateOldGroq() : nil
    }

    /// 빈 문자열이면 키를 지운다
    static func save(_ p: Provider, _ key: String) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if key.isEmpty { try? FileManager.default.removeItem(at: file(p)); return }
        FileManager.default.createFile(atPath: file(p).path, contents: Data(key.utf8),
                                       attributes: [.posixPermissions: 0o600])
    }

    static func groq() -> String? { read(.groq) }
    static func save(_ key: String) { save(.groq, key) }

    /// 옛 앱 설정(settings.json)에 있던 Groq 키를 한 번 옮겨 온다
    private static func migrateOldGroq() -> String? {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("settings.json")),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let k = (obj["groq_api_key"] as? String)?.trimmingCharacters(in: .whitespaces),
              !k.isEmpty else { return nil }
        save(.groq, k)
        return k
    }
}

/// Groq 채팅 모델로 받아 적은 문장을 한국어로 옮긴다. 받아쓰기와 같은 키를 쓴다.
/// 120b 가 막히면(429) 20b 로 넘긴다. qwen 은 번역 중간에 중국어가 섞여서 뺐다.
extension GroqClient {
    static let chatModels = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]
    private static let chatURL = URL(string: "https://api.groq.com/openai/v1/chat/completions")!
    // 매 요청마다 입력 토큰으로 세지므로 짧게 둔다
    static let translatePrompt = """
        Translate numbered lecture transcript lines into natural Korean. Output only "N. translation", one per line. \
        Lines are speech-recognition chunks: a sentence may continue across lines; fix clearly misheard words; \
        drop fillers (um, uh). Keep technical terms accurate. No notes. \
        Never output the Previous line; "1." is the first numbered line.
        """

    /// 앞줄(문장이 이어질 때 참고, 옮기지 않음) + 번호 붙인 옮길 줄
    static func translationInput(_ lines: [String], context: [String]) -> String {
        let numbered = lines.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n")
        return context.isEmpty ? numbered : "Previous (do not translate): \(context.joined(separator: " "))\n\(numbered)"
    }

    /// 여러 줄을 한 번에 옮긴다. 돌려받은 배열은 입력과 같은 길이이고, 응답에서 못 찾은 줄은 nil.
    func translate(_ lines: [String], context: [String] = []) async throws -> [String?] {
        guard let key = APIKey.groq() else { throw Failure("Groq API 키가 없습니다. 설정에서 키를 입력하세요.") }
        let input = Self.translationInput(lines, context: context)
        var lastError = Failure("번역에 실패했습니다")
        for model in Self.chatModels {
            for attempt in 1...Self.retries {
                do {
                    return Self.parse(try await chatOnce(model: model, key: key, input: input), count: lines.count)
                } catch is RateLimited {
                    lastError = Failure("번역 한도 초과")
                    break                                   // 다음 모델로
                } catch let e as Transient {
                    lastError = Failure("번역: \(e.message)")
                    if attempt < Self.retries {
                        try await Task.sleep(nanoseconds: UInt64(1_500_000_000 * Double(attempt)))
                    }
                }
            }
        }
        throw lastError
    }

    static func parse(_ out: String, count: Int) -> [String?] {
        var found: [Int: String] = [:]
        for raw in out.split(separator: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard let dot = line.firstIndex(of: "."), let n = Int(line[..<dot]) else { continue }
            let text = line[line.index(after: dot)...].trimmingCharacters(in: .whitespaces)
            if !text.isEmpty { found[n] = text }
        }
        // 모델이 참고로 준 앞줄까지 "1." 로 옮겨 번호가 하나씩 밀려 오면 첫 줄을 버린다 (안 그러면 한 줄씩 어긋난다)
        let shift = found[count + 1] != nil ? 1 : 0
        return (1...max(count, 1)).prefix(count).map { found[$0 + shift] }
    }

    private func chatOnce(model: String, key: String, input: String) async throws -> String {
        try await chat([
            "model": model,
            "messages": [["role": "system", "content": Self.translatePrompt], ["role": "user", "content": input]],
            "temperature": 0.2,
            "reasoning_effort": "low",                  // gpt-oss 는 추론 모델이다. 번역엔 길게 생각할 필요가 없다
        ], key: key)
    }

    /// 채팅 요청 한 번. 응답 본문(content)을 돌려준다
    func chat(_ body: [String: Any], key: String) async throws -> String {
        var req = URLRequest(url: Self.chatURL, timeoutInterval: 60)
        req.httpMethod = "POST"
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await URLSession.shared.data(for: req)
        } catch {
            throw Transient(message: "네트워크 오류: \(error.localizedDescription)")
        }
        if let http = resp as? HTTPURLResponse, let u = Usage.read(http), let model = body["model"] as? String {
            Usage.report?(model, u)
        }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        switch code {
        case 200:
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            if let model = body["model"] as? String,
               let tokens = ((obj?["usage"] as? [String: Any])?["total_tokens"] as? NSNumber)?.doubleValue {
                Usage.spent?(model, .tokens, tokens)
                lastTokens = tokens
            }
            let msg = ((obj?["choices"] as? [[String: Any]])?.first?["message"] as? [String: Any])?["content"] as? String
            return msg ?? ""
        case 401: throw Failure("API 키가 올바르지 않습니다. 설정에서 다시 확인하세요.")
        case 429: throw RateLimited(retryAfter: (resp as? HTTPURLResponse)?.value(forHTTPHeaderField: "retry-after").flatMap(Double.init))
        case 500...599: throw Transient(message: "Groq 서버 일시 장애 (\(code))")
        default:
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let err = obj?["error"] as? [String: Any]
            // JSON 을 시켰는데 모델이 수식 역슬래시를 그대로 써서 Groq 이 거절한 경우: 거절된 원문을 고쳐 쓴다 (다시 묻지 않는다)
            if body["response_format"] != nil, let raw = err?["failed_generation"] as? String,
               let fixed = Explain.lenientJSON(raw) {
                return String(decoding: fixed, as: UTF8.self)
            }
            throw Failure("Groq 오류 \(code): \(err?["message"] as? String ?? "")")
        }
    }
}

/// "설명해줘" 요청 두 개. 표시(줄 고르기)는 화면을 보는 빠른 모델, 그림·요약은 계산이 정확한 모델이 맡는다
extension GroqClient {
    static let visionModel = "qwen/qwen3.8-27b"
    static let reasoningModel = "openai/gpt-oss-120b"

    /// 사용자가 설정에 적어 둔 AI 지침 (수준, 말투, 강조할 것 등). AppState 가 바뀔 때마다 넣어 준다
    nonisolated(unsafe) static var guide = ""

    static func context(lines: [Explain.Line], transcript: [String]) -> String {
        let speech = transcript.isEmpty ? "(none — explain what is on screen)" : transcript.joined(separator: "\n")
        let screen = lines.map { "\($0.id): \($0.text)" }.joined(separator: "\n")
        let g = guide.trimmingCharacters(in: .whitespacesAndNewlines)
        // 지침은 말투·깊이·형식을 바꾸지만 사실을 바꾸지는 않는다
        let rules = g.isEmpty ? "" : "\n\nStudent's instructions (follow them for depth, style and format; never invent facts):\n\(g)"
        return "Recent lecture speech (oldest first):\n\(speech)\n\nText lines on screen (id: text):\n\(screen)\(rules)"
    }

    /// 설명 카드에서 이어 묻는 질문. 답은 글(answer) + 화면 짚기(marks, path) + 그림(visuals)
    static func questionPrompt(_ question: String, history: [(q: String, a: String)], explanation: String,
                               lines: [Explain.Line], transcript: [String]) -> String {
        let past = history.map { "Q: \($0.q)\nA: \($0.a)" }.joined(separator: "\n\n")
        return """
            \(audience)
            \(context(lines: lines, transcript: transcript))

            Explanation already shown to the student:
            \(explanation.isEmpty ? "(none)" : explanation)
            \(past.isEmpty ? "" : "\nEarlier questions and answers:\n\(past)\n")
            The student now asks: \(question)

            Answer in Korean, clearly and thoroughly enough to actually resolve the question — explain the why, \
            and work through any formula or calculation step by step. Point at the screen lines your answer refers to.
            Return JSON only: {"answer":"Korean answer, paragraphs separated by \\n", \(marksShape),
            "visuals":[0 to 2 items]}
            \(visualsGuide)
            """
    }

    // 프롬프트 조각. Groq 는 두 모델에 나눠 묻고, 다른 서비스는 한 번에 묻는다(unifiedPrompt)
    static let marksTask = """
        Choose up to 3 text lines from the MAIN lecture material on screen (slides, document, board) that the \
        lecturer is talking about right now. Ignore menus, tabs, address bars, thumbnails, captions and other \
        app UI. If there is no speech, choose the most important lines.
        If the lecturer is walking through an ORDER inside a figure — e.g. a path through a circuit, the flow of \
        a diagram, a route on a map, a cycle — also give that order as the text labels inside the figure, in \
        sequence. Use only labels that sit inside the figure. Omit "path" when there is no such order.
        """
    static let marksShape = """
        "marks":[{"id":<line id>,"note":"1-2 Korean sentences explaining what this line MEANS (the idea itself, \
        with the why) — not that the lecturer is explaining it"}],
        "path":{"ids":[<label line ids in order>],"note":"one short Korean sentence about the route"}
        """
    static let visualsTask = "Explain what is being taught right now, in Korean, for a student seeing it for the first time."
    static let visualsShape = #""summary":"3-5 Korean sentences: what it is, why it matters, and a simple example or intuition","visuals":[0 to 2 items],"scenes":[2 to 6 scenes]"#
    /// 장면 대본: 설명을 짧은 영상처럼 순서대로 보여준다
    static let scenesGuide = """
        Scenes play like a short explainer video, in the order the lecturer explained it (follow the speech; with no \
        speech, follow the screen's logical order). Each scene: {"say":"1-2 Korean sentences that teach this step (meaning and reason, not just what is on screen)", \
        "focus":[screen line ids to highlight, 0-2], "arrow":{"from":line id,"to":line id} or null (connect two \
        related lines on screen), "visual":index into visuals or null (show that visual beside the screen), \
        "reveal":how many items/rows of that steps/table visual to show so far, or null}. Build visuals up gradually \
        across scenes. Every scene says something new — never repeat an earlier scene. Use only line ids from the list.
        """
    static let visualsGuide = """
        Visual item types — pick only what genuinely helps, or none:
        - {"type":"steps","title":"...","items":["...", "..."]}  ordered process, procedure, argument, derivation, \
        calculation, sequence of events
        - {"type":"table","title":"...","headers":["..."],"rows":[["..."]]}  comparison, classification, attributes
        - {"type":"card","title":"...","formula":"KaTeX, optional","body":"optional","terms":[["term","meaning"]]}  \
        definition, key formula, glossary
        - {"type":"mermaid","title":"...","code":"..."}  relationships, cause and effect, hierarchy, cycle, \
        interaction between actors. Use flowchart TD/LR or sequenceDiagram. Put every node label in double quotes.
        Rules: stay faithful to the screen and the speech, do not invent facts; check any calculation step by step; \
        keep text short; formulas only in the card "formula" field.
        """
    static let audience = "You help a university student follow a lecture. The subject can be anything " +
        "(humanities, social science, science, engineering, arts)."
    /// Groq 모델에만 붙인다: qwen 은 줄 번호("5번 줄")를 그대로 말하고, 답 글에 LaTeX 를 써서 카드에 기호가 그대로 보인다
    static let groqRules = "\nLine ids are only for you to point at lines — never write ids or \"line N\" in any text the student reads. " +
        "In text the student reads, write math in plain Unicode (δ, Σ, ², ᵀ, √, →); never LaTeX or $ (KaTeX only in a card \"formula\"). " +
        "Break long text into short paragraphs of 2-3 sentences separated by \\n\\n; put derivation steps on their own lines. " +
        // qwen 이 가끔 한국어 답에 한자(核 등)를 섞는다. 32번 시험에서는 재현되지 않았지만 예방으로 둔다
        "Write every student-facing text in Korean (Hangul) only. Never use Chinese characters or Japanese, not even for technical terms. " +
        "Keep technical terms in their original English as written on the screen or in the speech (e.g. kernel, eigenvector, PCA), optionally with Hangul (커널). " +
        "If a screen line looks garbled by text recognition (random symbols or Chinese characters inside a formula), do not copy it: " +
        "write the formula correctly from the image, or describe it in words."

    static func marksPrompt(lines: [Explain.Line], transcript: [String]) -> String {
        "\(audience)\n\(context(lines: lines, transcript: transcript))\n\n\(marksTask)\nReturn JSON only: {\(marksShape)}"
    }

    static func visualsPrompt(lines: [Explain.Line], transcript: [String]) -> String {
        "\(audience)\n\(context(lines: lines, transcript: transcript))\n\n\(visualsTask)\n" +
            "Return JSON only: {\(visualsShape)}\n\(visualsGuide)\n\(scenesGuide)"
    }

    /// Claude·Gemini·GPT: 화면 이미지와 글자를 보고 표시·요약·그림을 한 번에
    static func unifiedPrompt(lines: [Explain.Line], transcript: [String]) -> String {
        "\(audience)\n\(context(lines: lines, transcript: transcript))\n\nDo two things.\n1. \(marksTask)\n" +
            "2. \(visualsTask)\nReturn ONE JSON object only: {\(marksShape),\n\(visualsShape)}\n\(visualsGuide)\n" +
            scenesGuide
    }

    /// 설명: qwen 이 화면 사진과 글자를 보고 표시·요약·그림을 한 번에 만든다 (다른 서비스의 unifiedPrompt 와 같다).
    /// 한도에 걸리면 RateLimited 를 그대로 던진다 — 부르는 쪽이 예전 두 요청 방식으로 넘어간다
    func explainUnified(jpeg: Data, lines: [Explain.Line], transcript: [String]) async throws -> Data {
        guard let key = APIKey.groq() else { throw Failure("Groq API 키가 없습니다. 설정에서 키를 입력하세요.") }
        let text = try await chat(Self.visionBody(Self.unifiedPrompt(lines: lines, transcript: transcript), jpeg: jpeg), key: key)
        Usage.used?(.explain, lastTokens)
        return Data(Explain.dropLineRefs(await fixScript(text, source: Self.source(lines, transcript)), lines: lines).utf8)
    }

    /// 질문의 답: qwen 이 지금 화면 사진까지 보고 답한다. qwen 이 한도에 걸리면 120b 가 글자만 보고 답한다
    func answer(_ prompt: String, jpeg: Data, lines: [Explain.Line], transcript: [String]) async throws -> Data {
        guard let key = APIKey.groq() else { throw Failure("Groq API 키가 없습니다. 설정에서 키를 입력하세요.") }
        do {
            let text = try await chat(Self.visionBody(prompt, jpeg: jpeg), key: key)
            Usage.used?(.ask, lastTokens)
            return Data(Explain.dropLineRefs(await fixScript(text, source: Self.source(lines, transcript)), lines: lines).utf8)
        } catch let first as RateLimited {
            do { return Data(Explain.dropLineRefs(String(decoding: try await answer(prompt), as: UTF8.self), lines: lines).utf8) }
            catch let second as RateLimited {
                throw RateLimited(retryAfter: [first.retryAfter, second.retryAfter].compactMap { $0 }.min())
            }
        }
    }

    static func visionBody(_ prompt: String, jpeg: Data) -> [String: Any] {
        ["model": visionModel,
         "messages": [["role": "user", "content": [
             ["type": "text", "text": prompt + groqRules],
             ["type": "image_url", "image_url": ["url": "data:image/jpeg;base64," + jpeg.base64EncodedString()]],
         ]]],
         "temperature": 0.3, "response_format": ["type": "json_object"], "reasoning_effort": "none"]
    }

    /// 섞임 검사에서 빼 줄 글자: 화면 글자와 강의 말에 원래 있던 글자
    static func source(_ lines: [Explain.Line], _ transcript: [String]) -> String {
        (lines.map(\.text) + transcript).joined(separator: " ")
    }

    /// 섞여 나온 다른 언어 조각만 20b 에게 옮기게 해서 끼워 넣는다. 못 고치면 받은 그대로 둔다
    func fixScript(_ text: String, source: String) async -> String {
        let runs = Script.foreignRuns(text, source: source)
        guard !runs.isEmpty, let key = APIKey.groq() else { return text }
        let reply = try? await chat(["model": Self.chatModels[1], "temperature": 0, "reasoning_effort": "low",
                                     "messages": [["role": "user", "content": Script.fixPrompt(text, runs: runs, source: source)]]], key: key)
        return reply.flatMap { Script.apply(text, reply: $0, runs: runs) } ?? text
    }

    /// 질문의 답 (글만 보고 답한다 — 화면 줄 번호로 짚는다). qwen 이 막혔을 때 쓴다
    func answer(_ prompt: String) async throws -> Data {
        guard let key = APIKey.groq() else { throw Failure("Groq API 키가 없습니다. 설정에서 키를 입력하세요.") }
        return Data(try await chat([
            "model": Self.reasoningModel, "messages": [["role": "user", "content": prompt + Self.groqRules]],
            "temperature": 0.3, "response_format": ["type": "json_object"], "reasoning_effort": "medium",
        ], key: key).utf8)
    }

    /// 그림·요약 요청. gpt-oss 는 엄격한 스키마(structured outputs)를 지원해서 칸 이름·구조가 반드시 맞게 온다
    static func visualsBody(prompt: String) -> [String: Any] {
        [
            "model": reasoningModel, "messages": [["role": "user", "content": prompt]], "temperature": 0.2,
            "reasoning_effort": "medium",
            "response_format": ["type": "json_schema",
                                "json_schema": ["name": "explanation", "strict": true, "schema": visualsSchema]],
        ]
    }

    /// 네 가지 그림 틀. strict 모드는 모든 칸이 required 여야 해서, 빠질 수 있는 칸은 null 을 허용한다
    static let visualsSchema: [String: Any] = {
        func obj(_ props: [String: Any]) -> [String: Any] {
            ["type": "object", "additionalProperties": false, "required": Array(props.keys).sorted(), "properties": props]
        }
        let str: [String: Any] = ["type": "string"]
        let strs: [String: Any] = ["type": "array", "items": str]
        let kind = { (k: String) -> [String: Any] in ["type": "string", "enum": [k]] }
        let items: [[String: Any]] = [
            obj(["type": kind("steps"), "title": str, "items": strs]),
            obj(["type": kind("table"), "title": str, "headers": strs, "rows": ["type": "array", "items": strs]]),
            obj(["type": kind("card"), "title": str, "formula": ["type": ["string", "null"]],
                 "body": ["type": ["string", "null"]], "terms": ["type": "array", "items": strs]]),
            obj(["type": kind("mermaid"), "title": str, "code": str]),
        ]
        let int: [String: Any] = ["type": "integer"]
        let nullInt: [String: Any] = ["type": ["integer", "null"]]
        let scene = obj(["say": str, "focus": ["type": "array", "items": int],
                         "arrow": ["anyOf": [obj(["from": int, "to": int]), ["type": "null"]]],
                         "visual": nullInt, "reveal": nullInt])
        return obj(["summary": str, "visuals": ["type": "array", "items": ["anyOf": items]],
                    "scenes": ["type": "array", "items": scene]])
    }()

    /// 화면 위 표시: 강사가 지금 말하는 줄 번호를 고른다. 이미지가 막히면(한도) 글자만으로 고른다
    func explainMarks(jpeg: Data, lines: [Explain.Line], transcript: [String]) async throws -> Data {
        guard let key = APIKey.groq() else { throw Failure("Groq API 키가 없습니다. 설정에서 키를 입력하세요.") }
        let prompt = Self.marksPrompt(lines: lines, transcript: transcript)
        let image = "data:image/jpeg;base64," + jpeg.base64EncodedString()
        do {
            return Data(try await chat([
                "model": Self.visionModel,
                "messages": [["role": "user", "content": [
                    ["type": "text", "text": prompt], ["type": "image_url", "image_url": ["url": image]],
                ]]],
                "temperature": 0.2, "response_format": ["type": "json_object"], "reasoning_effort": "none",
            ], key: key).utf8)
        } catch is RateLimited {
            return Data(try await chat([
                "model": Self.reasoningModel, "messages": [["role": "user", "content": prompt]],
                "temperature": 0.2, "response_format": ["type": "json_object"], "reasoning_effort": "low",
            ], key: key).utf8)
        }
    }

    /// 설명 카드: 요약과 그림 0~2개. 그림 형식은 어느 과목에나 맞는 일반 형식만 쓴다
    func explainVisuals(lines: [Explain.Line], transcript: [String]) async throws -> Data {
        guard let key = APIKey.groq() else { throw Failure("Groq API 키가 없습니다. 설정에서 키를 입력하세요.") }
        let prompt = Self.visualsPrompt(lines: lines, transcript: transcript) + Self.groqRules
        let clean = { (d: Data) in Data(Explain.dropLineRefs(String(decoding: d, as: UTF8.self), lines: lines).utf8) }
        do {
            return clean(try await visuals(prompt: prompt, model: Self.reasoningModel, key: key))
        } catch let first as RateLimited {
            // 120b 가 막히면 한도가 따로인 qwen 으로 (20b 는 형식을 자주 틀려서 쓰지 않는다)
            do { return clean(try await visuals(prompt: prompt, model: Self.visionModel, key: key)) }
            catch let second as RateLimited {
                throw RateLimited(retryAfter: [first.retryAfter, second.retryAfter].compactMap { $0 }.min())
            }
        }
    }

    /// 엄격한 형식으로 한 번 더 묻고, 그래도 형식이 어긋나면 느슨한 JSON 으로 받아 고쳐 쓴다
    /// (gpt-oss 가 가끔 객체 대신 목록을 내서 Groq 이 400 "does not match the expected schema" 로 거절한다)
    private func visuals(prompt: String, model: String, key: String) async throws -> Data {
        func body(_ p: String) -> [String: Any] {
            var b = Self.visualsBody(prompt: p)
            b["model"] = model
            if model == Self.visionModel { b["reasoning_effort"] = "none" }   // qwen 은 low·medium 을 받지 않는다
            return b
        }
        for attempt in 0..<2 {
            do { return Data(try await chat(body(prompt), key: key).utf8) }
            catch let e as Failure where (e.errorDescription ?? "").contains("expected schema") && attempt == 0 { continue }
            catch let e as Failure where (e.errorDescription ?? "").contains("expected schema") { break }
        }
        var loose = body(prompt + "\nReturn ONE JSON object (not an array) with the keys described above.")
        loose["response_format"] = ["type": "json_object"]
        return Self.asVisualsObject(Data(try await chat(loose, key: key).utf8))
    }

    /// 맨 바깥이 목록이면 그림 목록으로 보고 {"summary": "", "visuals": [...]} 로 감싼다
    static func asVisualsObject(_ data: Data) -> Data {
        guard let arr = try? JSONSerialization.jsonObject(with: data) as? [Any],
              let wrapped = try? JSONSerialization.data(withJSONObject: ["summary": "", "visuals": arr]) else { return data }
        return wrapped
    }
}

extension GroqClient {
    /// 앱을 켤 때 모델마다 남은 한도를 알아 둔다. 모델마다 하루 한도에서 1회씩 쓴다
    /// (채팅은 1토큰짜리 요청, 받아쓰기는 0.3초 무음)
    func probeLimits() async {
        guard let key = APIKey.groq() else { return }
        for model in Self.chatModels + [Self.visionModel] {
            _ = try? await chat(["model": model, "messages": [["role": "user", "content": "hi"]], "max_tokens": 1], key: key)
        }
        let silence = WAV.encode([Float](repeating: 0, count: 4800))
        for model in Self.models {
            _ = try? await sendOnce(wav: silence, model: model, key: key, language: "ko", prompt: "")
        }
    }
}
