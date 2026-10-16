import Foundation
import Testing
@testable import Ezrite

/// 여러 AI 서비스(Claude, Gemini, GPT, Groq): 요청 본문 만들기와 응답 읽기
struct ProviderTests {
    static let jpeg = Data([0xFF, 0xD8, 0xFF])

    @Test func Claude_요청은_이미지를_base64_블록으로_붙이고_키는_헤더로_보낸다() throws {
        let req = try AI.request(.claude, model: "claude-sonnet-5-5", key: "k", prompt: "설명해", image: Self.jpeg,
                                 json: true, maxTokens: 900)
        #expect(req.url?.absoluteString == "https://api.anthropic.com/v1/messages")
        #expect(req.value(forHTTPHeaderField: "x-api-key") == "k")
        #expect(req.value(forHTTPHeaderField: "anthropic-version") != nil)
        let body = try #require(JSONSerialization.jsonObject(with: req.httpBody!) as? [String: Any])
        #expect(body["max_tokens"] as? Int == 900)
        let content = try #require(((body["messages"] as? [[String: Any]])?.first?["content"]) as? [[String: Any]])
        let image = try #require(content.first { $0["type"] as? String == "image" })
        let source = try #require(image["source"] as? [String: Any])
        #expect(source["media_type"] as? String == "image/jpeg")
        #expect(source["data"] as? String == Self.jpeg.base64EncodedString())
    }

    @Test func 번역처럼_단순한_요청은_Claude_생각_단계를_끈다() throws {
        let off = try AI.request(.claude, model: "m", key: "k", prompt: "p", image: nil, json: false, maxTokens: 9, think: false)
        let on = try AI.request(.claude, model: "m", key: "k", prompt: "p", image: nil, json: false, maxTokens: 9)
        let a = try #require(JSONSerialization.jsonObject(with: off.httpBody!) as? [String: Any])
        let b = try #require(JSONSerialization.jsonObject(with: on.httpBody!) as? [String: Any])
        #expect((a["thinking"] as? [String: Any])?["type"] as? String == "disabled")
        #expect(b["thinking"] == nil)
    }

    @Test func GPT와_Gemini는_같은_채팅_형식에_주소만_다르다() throws {
        let gpt = try AI.request(.openai, model: "m", key: "k", prompt: "p", image: Self.jpeg, json: true, maxTokens: 500)
        let gem = try AI.request(.gemini, model: "m", key: "k", prompt: "p", image: nil, json: false, maxTokens: 500)
        #expect(gpt.url?.absoluteString == "https://api.openai.com/v1/chat/completions")
        #expect(gem.url?.absoluteString == "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions")
        #expect(gpt.value(forHTTPHeaderField: "Authorization") == "Bearer k")
        let body = try #require(JSONSerialization.jsonObject(with: gpt.httpBody!) as? [String: Any])
        #expect((body["response_format"] as? [String: Any])?["type"] as? String == "json_object")
        let content = try #require(((body["messages"] as? [[String: Any]])?.first?["content"]) as? [[String: Any]])
        let url = (content.first { $0["type"] as? String == "image_url" }?["image_url"] as? [String: Any])?["url"] as? String
        #expect(url == "data:image/jpeg;base64," + Self.jpeg.base64EncodedString())
    }

    @Test func 서비스마다_다른_응답에서_본문과_쓴_토큰을_읽는다() throws {
        let claude = Data(#"{"content":[{"type":"text","text":"안녕"}],"usage":{"input_tokens":10,"output_tokens":5}}"#.utf8)
        let chat = Data(#"{"choices":[{"message":{"content":"hi"}}],"usage":{"total_tokens":42}}"#.utf8)
        #expect(AI.reply(.claude, claude) == AI.Reply(text: "안녕", tokens: 15))
        #expect(AI.reply(.openai, chat) == AI.Reply(text: "hi", tokens: 42))
        #expect(AI.reply(.gemini, chat) == AI.Reply(text: "hi", tokens: 42))
    }

    @Test func 코드블록으로_감싼_JSON도_벗겨서_읽는다() {
        #expect(AI.stripFences("```json\n{\"a\":1}\n```") == "{\"a\":1}")
        #expect(AI.stripFences("설명입니다\n```\n{\"a\":1}\n```") == "{\"a\":1}")
        #expect(AI.stripFences("{\"a\":1}") == "{\"a\":1}")
    }

    @Test func 모델_목록에서_용도에_맞는_기본_모델을_고른다() {
        let claude = ["claude-opus-5-5", "claude-sonnet-4-6", "claude-sonnet-5-5", "claude-haiku-4-5-20251001", "claude-haiku-5-5"]
        #expect(AI.pick(claude, for: .explain) == "claude-sonnet-5-5")
        #expect(AI.pick(claude, for: .translate) == "claude-haiku-5-5")
        #expect(AI.pick([], for: .explain) == nil)
    }

    @Test func Gemini는_그림_생성·음성_모델을_빼고_버전_숫자로_고른다() {
        // 실제 무료 키가 받아 온 목록 일부 — 문자 순서로 고르면 nano-banana, omni 가 잡혔다
        let gemini = ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3-flash-preview", "gemini-3.1-pro-preview",
                      "gemini-3.1-flash-lite", "gemini-3.8-flash", "gemini-3.8-flash-tts", "gemini-3.8-live",
                      "gemini-omni-flash-preview", "gemini-nano-banana-2.1", "nano-banana-pro-preview", "gemma-4-31b-it"]
        #expect(AI.ranked(gemini, for: .explain).prefix(2) == ["gemini-3.1-pro-preview", "gemini-2.5-pro"])
        #expect(AI.ranked(gemini, for: .translate).prefix(3) == ["gemini-3.8-flash", "gemini-3-flash-preview", "gemini-2.5-flash"])
    }

    @Test func GPT는_비싼_pro·코딩용·검색용·날짜붙은_사본을_피한다() {
        let gpt = ["gpt-5.5", "gpt-5.5-2026-04-23", "gpt-5.5-pro", "gpt-5.4-mini", "gpt-5.4-mini-2026-03-17",
                   "gpt-5.3-codex", "gpt-5-search-api", "gpt-5.6-luna", "gpt-5.2-chat-latest", "gpt-4o-mini-tts"]
        #expect(AI.pick(gpt, for: .explain) == "gpt-5.5")                  // luna 는 가벼운 등급이라 설명에 안 고른다
        #expect(AI.pick(gpt, for: .translate) == "gpt-5.6-luna")
    }

    @Test func GPT_새_별칭은_sol을_화면_설명에_luna를_번역에() {
        // 실제 계정 목록: 별칭 sol(최상위)·luna(가벼움)·terra·astra
        let gpt = ["gpt-5.5", "gpt-5.4-mini", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
                   "gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol", "gpt-5.5-pro"]
        #expect(AI.pick(gpt, for: .explain) == "gpt-6.1-sol")
        #expect(AI.pick(gpt, for: .translate) == "gpt-6-luna")
        #expect(AI.ranked(gpt, for: .explain).contains("gpt-6-astra"))   // 별칭 모델은 목록에서 직접 고를 수 있다
    }

    @Test func Gemini는_틀린_키에_400을_줘도_키_오류로_본다() {
        let gemini = Data(#"{"error":{"code":400,"message":"Please pass a valid API key","status":"INVALID_ARGUMENT"}}"#.utf8)
        #expect(AI.keyRejected(status: 400, body: gemini))
        #expect(!AI.keyRejected(status: 400, body: Data(#"{"error":{"message":"image too large"}}"#.utf8)))
        #expect(AI.keyRejected(status: 401, body: Data()))
    }

    @Test func 키가_틀린_오류만_빼고는_Groq로_대신_처리한다() {
        #expect(!AI.shouldFallback(status: 401))
        #expect(!AI.shouldFallback(status: 403))
        #expect(AI.shouldFallback(status: 429))
        #expect(AI.shouldFallback(status: 500))
        #expect(AI.shouldFallback(status: nil))       // 네트워크 오류
    }
}

/// 번역 요청 본문: 앞줄은 참고로만 주고, 옮길 줄만 번호를 붙인다
struct TranslationInputTests {
    @Test func 앞줄은_번호_없이_참고로_주고_옮길_줄만_번호를_붙인다() {
        let text = GroqClient.translationInput(["one at a time.", "First, we look at all the tumors."],
                                               context: ["the algorithm is going to look at the classes"])
        #expect(text.contains("the algorithm is going to look at the classes"))
        #expect(!text.contains("1. the algorithm"))
        #expect(text.contains("1. one at a time."))
        #expect(text.contains("2. First, we look at all the tumors."))
    }

    @Test func 앞줄이_없으면_옮길_줄만_보낸다() {
        #expect(GroqClient.translationInput(["Hello."], context: []) == "1. Hello.")
    }
}
