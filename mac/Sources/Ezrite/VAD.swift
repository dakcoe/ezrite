import Foundation

/// 에너지 VAD — 30ms 블록의 RMS 로 발화 구간을 끊는다. 옛 앱 stt_engine.py 를 그대로 옮겼다.
///
/// 상태: 대기 ─[음성 감지]→ 발화 모음 ─[침묵·길이 조건]→ 발화 하나를 돌려줌 → 대기
struct VAD {
    static let blockSize = 480                  // 16kHz × 30ms
    static let blockSecs = 0.03

    static let onsetBlocks = 3                  // 연속 3블록(90ms) 음성이면 발화 시작
    static let prerollBlocks = 10               // 시작 300ms 앞부터 포함 (첫 음절 잘림 방지)
    static let noiseFactor: Float = 3.0         // 잡음 바닥의 3배를 넘으면 음성
    static let noiseFloorMin: Float = 1e-4      // 완전 무음에서 문턱이 0 으로 붙는 것 방지

    // 잡음 바닥은 빠르게 내려가고 아주 천천히 올라간다.
    // 음성 아닌 블록으로만 갱신하면 시작이 완전 무음일 때 바닥이 0 에 붙어 발화가 안 끊기고,
    // 최근 구간 백분위로 잡으면 말이 이어질 때 바닥이 음성 레벨까지 올라간다.
    static let noiseDown: Float = 0.30
    static let noiseUp: Float = 0.0003          // 시상수 약 100초

    // Groq 무료 한도(분당 20회)를 넘지 않도록 짧은 말은 뭉친다
    static let shortSilence = 0.8               // 이만큼 조용하면 끊는다 (minChunk 이상 모였을 때)
    static let longSilence = 2.0                // 이만큼 조용하면 짧아도 끊는다
    static let minChunk = 6.0
    static let maxChunk = 12.0                  // 계속 말하면 이 길이에서 강제로 끊는다
    static let minUtterance = 0.4               // 이보다 짧으면 잡음으로 보고 버린다

    private var noiseFloor: Float?
    private var preroll: [[Float]] = []
    private var speechRun = 0
    private var utterance: [[Float]] = []
    private var speechSecs = 0.0
    private var silenceSecs = 0.0

    var inSpeech: Bool { !utterance.isEmpty }

    static func rms(_ b: [Float]) -> Float {
        var sum: Float = 0
        for s in b { sum += s * s }
        return (sum / Float(max(1, b.count))).squareRoot()
    }

    /// 블록 하나를 넣는다. 발화가 끊기면 그 샘플을 돌려준다.
    mutating func feed(_ block: [Float]) -> [Float]? {
        let rms = Self.rms(block)
        var floor = noiseFloor ?? max(rms, Self.noiseFloorMin)
        if noiseFloor != nil {
            let k = rms < floor ? Self.noiseDown : Self.noiseUp
            floor = (1 - k) * floor + k * rms
        }
        floor = max(floor, Self.noiseFloorMin)
        noiseFloor = floor
        let isSpeech = rms > floor * Self.noiseFactor

        if !utterance.isEmpty {
            utterance.append(block)
            if isSpeech {
                speechSecs += Self.blockSecs
                silenceSecs = 0
            } else {
                silenceSecs += Self.blockSecs
            }
            let total = Double(utterance.count) * Self.blockSecs
            let cut = (silenceSecs >= Self.shortSilence && speechSecs >= Self.minChunk)
                || silenceSecs >= Self.longSilence
                || total >= Self.maxChunk
            return cut ? flush() : nil
        }

        preroll.append(block)
        if preroll.count > Self.prerollBlocks { preroll.removeFirst() }
        speechRun = isSpeech ? speechRun + 1 : 0
        if speechRun >= Self.onsetBlocks {
            utterance = preroll
            speechSecs = Double(speechRun) * Self.blockSecs
            silenceSecs = 0
            preroll = []
        }
        return nil
    }

    /// 모으던 발화를 내보낸다. 너무 짧으면 버린다.
    mutating func flush() -> [Float]? {
        defer {
            utterance = []
            speechSecs = 0
            silenceSecs = 0
            speechRun = 0
        }
        guard !utterance.isEmpty, speechSecs >= Self.minUtterance else { return nil }
        return utterance.flatMap { $0 }
    }
}
