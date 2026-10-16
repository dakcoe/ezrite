import Foundation

/// Groq 의 오늘 남은 요청 수. 모델마다 따로 잡히고, 응답 헤더로 매번 알려 준다
struct Usage: Equatable {
    let remaining: Int
    let limit: Int

    static func read(_ resp: HTTPURLResponse) -> Usage? {
        guard let r = resp.value(forHTTPHeaderField: "x-ratelimit-remaining-requests").flatMap(Int.init),
              let l = resp.value(forHTTPHeaderField: "x-ratelimit-limit-requests").flatMap(Int.init) else { return nil }
        return Usage(remaining: r, limit: l)
    }

    /// 번갈아 쓰는 모델들의 한도를 합친 남은 비율(0~1). 아직 모르는 모델은 빼고, 다 모르면 nil
    static func fraction(_ usages: [Usage?]) -> Double? {
        let known = usages.compactMap { $0 }
        let limit = known.reduce(0) { $0 + $1.limit }
        guard limit > 0 else { return nil }
        return Double(known.reduce(0) { $0 + $1.remaining }) / Double(limit)
    }

    enum Level { case plenty, half, low }

    /// 50% 아래 노랑, 10% 아래 빨강
    static func level(_ fraction: Double) -> Level {
        fraction < 0.1 ? .low : fraction < 0.5 ? .half : .plenty
    }

    /// 요청마다 불린다 (모델 이름, 남은 한도). AppDelegate 가 화면 상태로 옮긴다
    nonisolated(unsafe) static var report: ((String, Usage) -> Void)?
    /// 응답에 실린 쓴 양 (모델 이름, 종류, 양 — 토큰 수 또는 음성 초)
    nonisolated(unsafe) static var spent: ((String, Budget.Kind, Double) -> Void)?
}

extension Usage {
    /// 게이지 값: 호출 횟수와 토큰(음성 시간) 중 덜 남은 쪽. 아는 것만으로 낸다
    static func combined(requests: Double?, amount: Double?) -> Double? {
        switch (requests, amount) {
        case let (r?, a?): return min(r, a)
        case let (r?, nil): return r
        case let (nil, a?): return a
        default: return nil
        }
    }
}

/// 하루 토큰(TPD)·하루 음성 시간(ASD). Groq 는 이 둘을 응답 헤더로 알려주지 않아 앱이 직접 센다.
/// 쓴 양은 응답에 실린 값(채팅 usage.total_tokens, 받아쓰기 duration)이고 추정이 아니다.
/// 한도는 자정에 초기화되지 않고 24시간에 걸쳐 일정하게 회복되므로 "지금 찬 양 + 적은 시각"만 둔다
struct Budget: Codable {
    enum Kind: String, Codable { case tokens, audio }

    /// 무료 등급 하루 상한 (옛 앱과 같은 값): 토큰 20만, 음성 28,800초(8시간)
    static func cap(_ kind: Kind) -> Double { kind == .tokens ? 200_000 : 28_800 }
    static let window: TimeInterval = 24 * 3600

    private var rows: [String: [Double]] = [:]          // "모델|종류" → [찬 양, 그때 시각]

    mutating func note(_ model: String, _ kind: Kind, _ amount: Double, at now: Date = Date()) {
        guard amount > 0 else { return }
        rows[Self.key(model, kind)] = [used(model, kind, at: now) + amount, now.timeIntervalSince1970]
    }

    /// 지금 찬 양. 마지막 기록 뒤 흐른 시간만큼 빠지고, 0 아래로는 내려가지 않는다
    func used(_ model: String, _ kind: Kind, at now: Date = Date()) -> Double {
        guard let r = rows[Self.key(model, kind)], r.count == 2 else { return 0 }
        let rate = Self.cap(kind) / Self.window
        return max(0, r[0] - rate * (now.timeIntervalSince1970 - r[1]))
    }

    /// 번갈아 쓰는 모델들의 남은 비율(0~1)
    func fraction(_ models: [String], _ kind: Kind, at now: Date = Date()) -> Double {
        let cap = Self.cap(kind) * Double(models.count)
        let used = models.reduce(0) { $0 + min(Self.cap(kind), self.used($1, kind, at: now)) }
        return max(0, (cap - used) / cap)
    }

    /// 함께 써야 하는 모델들(하나라도 바닥나면 기능이 멈춘다)의 남은 비율: 가장 적게 남은 쪽
    func lowest(_ models: [String], _ kind: Kind, at now: Date = Date()) -> Double {
        models.map { fraction([$0], kind, at: now) }.min() ?? 1
    }

    private static func key(_ model: String, _ kind: Kind) -> String { "\(model)|\(kind.rawValue)" }

    // MARK: 저장 — 앱을 껐다 켜도 이어진다

    static let file = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Ezrite/usage.json")

    static func load() -> Budget {
        (try? JSONDecoder().decode(Budget.self, from: Data(contentsOf: file))) ?? Budget()
    }

    func save() {
        try? JSONEncoder().encode(self).write(to: Self.file, options: .atomic)
    }
}
