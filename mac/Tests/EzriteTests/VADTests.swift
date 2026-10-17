import Foundation
import Testing
@testable import Ezrite

/// 쉬지 않고 12초 넘게 말할 때의 강제 끊기. 단어 가운데가 아니라 마지막 1초 안의 가장 조용한 곳에서 끊고, 소리는 빠지지 않는다
struct VADTests {
    /// 블록마다 크기가 다른 소리. 샘플 값에 블록 번호를 섞어 이어 붙였을 때 순서까지 확인한다
    private func blocks(_ levels: [Float]) -> [[Float]] {
        levels.enumerated().map { i, a in
            (0..<VAD.blockSize).map { j in (j % 2 == 0 ? a : -a) + Float(i) * 1e-7 }
        }
    }

    private func run(_ input: [[Float]]) -> [[Float]] {
        var vad = VAD()
        var out: [[Float]] = []
        // 처음 1초는 조용하게 흘려 잡음 바닥을 잡는다
        for b in blocks(Array(repeating: 0.0002, count: 33)) { _ = vad.feed(b) }
        for b in input { if let u = vad.feed(b) { out.append(u) } }
        if let u = vad.flush() { out.append(u) }
        return out
    }

    @Test func 쉬지_않는_말을_끊어도_이어_붙이면_원래_소리와_같다() {
        let speech = blocks(Array(repeating: 0.1, count: 900))     // 27초
        let out = run(speech)
        #expect(out.count >= 2)
        // 시작 전 preroll 의 조용한 블록이 앞에 붙으므로 뒤쪽을 맞춰 본다
        let joined = out.flatMap { $0 }
        let original = speech.flatMap { $0 }
        #expect(Array(joined.suffix(original.count)) == original)
    }

    @Test func 마지막_1초_안의_조용한_블록_바로_뒤에서_끊는다() {
        var levels = Array(repeating: Float(0.1), count: 500)
        levels[380] = 0.03                                          // 11.4초 근처의 숨 고르는 틈 (발화 안에서는 마지막 1초 안)
        let out = run(blocks(levels))
        let first = out[0]
        // 첫 조각의 마지막 블록이 그 조용한 블록이어야 한다
        let last = Array(first.suffix(VAD.blockSize))
        #expect(abs(last[0] - (0.03 + 380 * 1e-7)) < 1e-6)
        #expect(Array(out.flatMap { $0 }.suffix(500 * VAD.blockSize)) == blocks(levels).flatMap { $0 })
    }

    @Test func 넘긴_소리로_시작한_다음_조각도_말하는_중으로_이어진다() {
        var levels = Array(repeating: Float(0.1), count: 420)
        levels[380] = 0.03
        let out = run(blocks(levels))
        // 넘긴 39블록 + 나머지가 한 조각으로 flush 된다 (짧다고 버려지지 않는다)
        #expect(out.count == 2)
        #expect(out[1].count == (420 - 381) * VAD.blockSize)
    }

    @Test func 넘긴_소리가_있어도_발화_시각은_실제_위치와_맞는다() {
        // 1초 조용 → 15초 말 (11.4초 지점 근처에 틈). 첫 구간은 그 틈에서 끝나야 한다
        var levels = Array(repeating: Float(0.0002), count: 33) + Array(repeating: Float(0.1), count: 500)
        levels[33 + 380] = 0.03
        let r = Retranscribe.utterances(blocks(levels).flatMap { $0 })
        #expect(abs(r[0].upperBound - Double(33 + 381) * VAD.blockSecs) < 1e-6)
        #expect(abs(r[1].lowerBound - Double(33 + 381) * VAD.blockSecs) < 1e-6)
    }

    @Test func 넘긴_끝쪽의_무음도_이어서_센다() {
        // 10.95초 지점의 아주 조용한 틈(365)에서 끊긴다. 넘긴 블록 끝쪽 3블록(390~392)은 이미 조용하다.
        // 그 무음부터 2초(67블록)가 되는 456번에서 두 번째 조각이 끊겨야 한다 (넘긴 무음을 안 세면 459번)
        var levels = Array(repeating: Float(0.1), count: 390) + Array(repeating: Float(0.0003), count: 100)
        levels[365] = 0.0001
        var vad = VAD()
        for b in blocks(Array(repeating: 0.0002, count: 33)) { _ = vad.feed(b) }
        var cuts: [Int] = []
        for (i, b) in blocks(levels).enumerated() where vad.feed(b) != nil { cuts.append(i) }
        #expect(cuts == [392, 390 + 66])
    }
}
