import Foundation
import Testing
@testable import Ezrite

/// 하루 토큰·하루 음성 시간: Groq 가 헤더로 알려주지 않아서 앱이 직접 센다.
/// 한도는 자정에 초기화되지 않고 24시간에 걸쳐 일정하게 회복된다
struct BudgetTests {
    static let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func 쓴_만큼_차고_시간이_지나면_일정하게_빠진다() {
        var b = Budget()
        b.note("m", .tokens, 100_000, at: Self.t0)
        #expect(b.used("m", .tokens, at: Self.t0) == 100_000)
        // 하루 20만 → 12시간이면 10만 회복
        #expect(abs(b.used("m", .tokens, at: Self.t0.addingTimeInterval(12 * 3600))) < 1)
        // 안 쓰고 둔다고 0 아래로 내려가지 않는다
        #expect(b.used("m", .tokens, at: Self.t0.addingTimeInterval(48 * 3600)) == 0)
    }

    @Test func 남은_비율은_모델들의_한도를_합쳐서_낸다() {
        var b = Budget()
        b.note("a", .audio, 28_800, at: Self.t0)            // 하나는 하루치를 다 씀
        let f = b.fraction(["a", "b"], .audio, at: Self.t0)  // 다른 하나는 안 씀
        #expect(f == 0.5)
    }

    @Test func 게이지는_호출_횟수와_양_중_덜_남은_쪽을_따른다() {
        #expect(Usage.combined(requests: 0.9, amount: 0.3) == 0.3)
        #expect(Usage.combined(requests: nil, amount: 0.7) == 0.7)
        #expect(Usage.combined(requests: 0.4, amount: nil) == 0.4)
        #expect(Usage.combined(requests: nil, amount: nil) == nil)
    }

    @Test func 저장했다_읽어도_같다() throws {
        var b = Budget()
        b.note("m", .tokens, 1234, at: Self.t0)
        let back = try JSONDecoder().decode(Budget.self, from: JSONEncoder().encode(b))
        #expect(back.used("m", .tokens, at: Self.t0) == 1234)
    }
}

/// 화면 설명은 두 모델(화면 읽기·설명 쓰기)을 함께 써서, 더 적게 남은 쪽이 남은 한도다
struct ExplainBudgetTests {
    @Test func 함께_쓰는_모델은_가장_적게_남은_쪽을_보인다() {
        var b = Budget()
        let now = Date()
        b.note("vision", .tokens, 2_000, at: now)          // 1% 씀
        b.note("reason", .tokens, 150_000, at: now)        // 75% 씀
        #expect(abs(b.lowest(["vision", "reason"], .tokens, at: now) - 0.25) < 0.001)
        #expect(b.fraction(["vision", "reason"], .tokens, at: now) > 0.5)   // 합치면 실제보다 넉넉해 보인다
    }
}
