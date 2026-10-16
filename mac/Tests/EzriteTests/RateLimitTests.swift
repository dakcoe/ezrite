import Foundation
import Testing
@testable import Ezrite

/// Groq 한도에 걸렸을 때 언제 다시 누르면 되는지 알려 준다 (응답 헤더 retry-after, 초)
struct RateLimitTests {
    @Test func 기다릴_시간을_초나_분으로_알린다() {
        #expect(GroqClient.RateLimited(retryAfter: 23).localizedDescription == "Groq 무료 한도에 걸렸습니다. 23초 뒤 다시 눌러 주세요.")
        #expect(GroqClient.RateLimited(retryAfter: 7.2).localizedDescription == "Groq 무료 한도에 걸렸습니다. 8초 뒤 다시 눌러 주세요.")
        #expect(GroqClient.RateLimited(retryAfter: 125).localizedDescription == "Groq 무료 한도에 걸렸습니다. 3분 뒤 다시 눌러 주세요.")
        #expect(GroqClient.RateLimited(retryAfter: nil).localizedDescription == "Groq 무료 한도에 걸렸습니다. 잠시 뒤 다시 눌러 주세요.")
    }
}
