import Foundation
import Testing
@testable import Ezrite

/// Groq 응답 헤더에서 오늘 남은 요청 수 읽기
struct UsageTests {
    @Test func 응답_헤더에서_오늘_남은_요청_수를_읽는다() throws {
        let resp = try #require(HTTPURLResponse(
            url: URL(string: "https://api.groq.com")!, statusCode: 200, httpVersion: nil,
            headerFields: ["x-ratelimit-limit-requests": "2000", "x-ratelimit-remaining-requests": "1974"]))
        let u = try #require(Usage.read(resp))
        #expect(u.remaining == 1974 && u.limit == 2000)
    }

    @Test func 한도_헤더가_없으면_모른다() throws {
        let resp = try #require(HTTPURLResponse(url: URL(string: "https://api.groq.com")!, statusCode: 200,
                                                httpVersion: nil, headerFields: [:]))
        #expect(Usage.read(resp) == nil)
    }

    @Test func 번갈아_쓰는_모델들은_한도를_합쳐서_남은_비율을_낸다() {
        let g = Usage.fraction([Usage(remaining: 1500, limit: 2000), Usage(remaining: 500, limit: 2000)])
        #expect(g == 0.5)
        #expect(Usage.fraction([nil, Usage(remaining: 900, limit: 1000)]) == 0.9)   // 아직 모르는 모델은 빼고
        #expect(Usage.fraction([nil, nil]) == nil)
    }

    @Test func 절반_아래는_노랑_십분의_일_아래는_빨강() {
        #expect(Usage.level(0.8) == .plenty)
        #expect(Usage.level(0.5) == .plenty)
        #expect(Usage.level(0.49) == .half)
        #expect(Usage.level(0.1) == .half)
        #expect(Usage.level(0.09) == .low)
    }
}
