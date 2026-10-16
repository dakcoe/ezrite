import Foundation

/// 소리가 없거나 잡음뿐인 구간에서 Whisper 가 지어내는 문장을 거른다.
/// 같은 구절 반복은 Notes.sanitize 가 따로 자른다.
enum Hallucination {
    struct Segment {
        let text: String
        let noSpeechProb: Double
    }

    /// 무음에서 자주 나오는 문장 (글자·숫자만 남긴 소문자). 자막 데이터로 학습해서 생긴 버릇이다
    static let phrases = [
        "시청해주셔서감사합니다", "시청해주셔서고맙습니다", "시청해주셔서감사드립니다",
        "구독과좋아요부탁드립니다", "구독과좋아요", "좋아요와구독", "구독좋아요알림설정",
        "다음영상에서만나요", "자막제공", "한국어자막", "mbc뉴스", "kbs뉴스", "sbs뉴스", "감사합니다",
        "thankyouforwatching", "thanksforwatching", "pleasesubscribe", "subtitlesby", "thankyou",
        "ご視聴ありがとうございました", "チャンネル登録",
    ]
    /// 이보다 높으면 Whisper 스스로 "말소리 없음" 쪽으로 본 구간이다 (OpenAI whisper 기본값)
    static let noSpeechLimit = 0.6
    /// 단골 문장 앞뒤로 이만큼 글자가 더 붙어도 같은 문장으로 본다 ("MBC 뉴스 김성현입니다")
    static let slack = 8

    /// 남길 구간만 이어 붙인다
    static func keep(_ segments: [Segment]) -> String {
        segments
            .filter { $0.noSpeechProb < noSpeechLimit && !isKnown($0.text) }
            .map { $0.text.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    static func isKnown(_ text: String) -> Bool {
        let n = normalize(text)
        return phrases.contains { n == $0 || (n.contains($0) && n.count <= $0.count + slack) }
    }

    /// 바로 앞 줄을 그대로 다시 낸 줄. 짧은 대답("네")은 실제로 반복되니 빼 준다
    static func isRepeat(_ text: String, previous: String) -> Bool {
        let n = normalize(text)
        return n.count >= 6 && n == normalize(previous)
    }

    static func normalize(_ s: String) -> String {
        String(s.lowercased().filter { $0.isLetter || $0.isNumber })
    }
}
