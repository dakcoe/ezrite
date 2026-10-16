import Foundation

/// 한국어로 시켰는데 다른 문자가 섞여 나오는 일 (qwen 이 "本课程" 같은 중국어 낱말을 끼우거나, 가끔 러시아어가 튀어나온다).
/// 섞인 조각만 찾아 싼 모델에게 그 조각만 옮기게 하고 제자리에 끼워 넣는다. 깨끗하면 추가 비용이 없다.
/// 로마자·숫자·기호는 어느 언어에서나 정상이다 (TCP, LMS 같은 약어). 그리스 문자는 수식에 쓰여서 정상으로 본다
enum Script {
    private static let foreign: [ClosedRange<UInt32>] = [
        0x3040...0x30FF, 0x31F0...0x31FF,                   // 가나
        0x4E00...0x9FFF, 0x3400...0x4DBF, 0xF900...0xFAFF,  // 한자
        0x0400...0x04FF,                                    // 키릴
        0x0600...0x06FF, 0x0590...0x05FF,                   // 아랍, 히브리
        0x0E00...0x0E7F, 0x0900...0x097F,                   // 태국, 데바나가리
    ]

    private static func isForeign(_ c: Character) -> Bool {
        c.unicodeScalars.contains { s in foreign.contains { $0.contains(s.value) } }
    }

    /// 섞여 나온 조각들 (이어 붙은 글자끼리, 중복 없이). source(화면 글자·강의 말)에 있던 글자는 빼고 본다
    static func foreignRuns(_ text: String, source: String) -> [String] {
        let seen = Set(source)
        var runs: [String] = [], cur = ""
        for c in text {
            if isForeign(c) && !seen.contains(c) { cur.append(c) } else if !cur.isEmpty { runs.append(cur); cur = "" }
        }
        if !cur.isEmpty { runs.append(cur) }
        var unique = Set<String>()
        return runs.filter { unique.insert($0).inserted }
    }

    /// 조각만 옮겨 달라는 요청. 한자는 한국 한자음으로 (超越=초월)
    static func fixPrompt(_ text: String, runs: [String]) -> String {
        """
        다음 한국어 글에 다른 언어 문자가 잘못 섞였다. 나열된 조각만 한국어로 옮겨라.
        한자는 한국 한자음 독음으로 옮겨라 (超越=초월, 金融=금융). 독음이 어색하면 뜻으로 옮겨라.
        형식은 한 줄에 하나, `원문=번역`. 다른 말은 쓰지 마라.

        글: \(text.prefix(400))

        조각:
        \(runs.joined(separator: "\n"))
        """
    }

    /// 교정표(`원문=번역` 줄)대로 끼워 넣는다. 조각을 다 고치지 못했거나 고친 말에 또 섞였으면 nil
    static func apply(_ text: String, reply: String, runs: [String]) -> String? {
        var table: [String: String] = [:]
        for line in reply.split(separator: "\n") {
            let parts = line.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            guard parts.count == 2, runs.contains(parts[0]), !parts[1].isEmpty,
                  foreignRuns(parts[1], source: "").isEmpty else { continue }
            table[parts[0]] = parts[1]
        }
        guard table.count == runs.count else { return nil }
        // 긴 조각부터 바꿔야 짧은 조각이 긴 조각 일부를 먼저 먹지 않는다
        return table.keys.sorted { $0.count > $1.count }.reduce(text) { $0.replacingOccurrences(of: $1, with: table[$1]!) }
    }
}
