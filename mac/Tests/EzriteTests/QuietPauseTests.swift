import Foundation
import Testing
@testable import Ezrite

/// 말소리가 30초 동안 없으면 자동 일시정지: 그동안은 녹음 파일에 쓰지 않고, 말이 다시 들리면 같은 기록에 이어 쓴다
struct QuietPauseTests {
    final class Log: @unchecked Sendable {
        var idle: [Bool] = []
        var utterances: [(start: Double, end: Double)] = []
    }

    static func run(_ audio: [Float], idleAfter: Double?, recorder: Notes.AudioRecorder? = nil) async -> Log {
        let log = Log()
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            let p = AudioPipeline(mixing: false, recorder: recorder, idleAfter: idleAfter,
                                  onUtterance: { _, s, e in log.utterances.append((s, e)) },
                                  onLevel: { _ in }, onIdle: { log.idle.append($0) })
            p.pushMain(audio)
            p.finish()
            p.sync { cont.resume() }
        }
        return log
    }

    @Test func 말이_30초_없으면_일시정지하고_다시_들리면_이어_한다() async {
        let audio = TimelineTests.silence(1) + TimelineTests.tone(1.5) + TimelineTests.silence(40) + TimelineTests.tone(1.5) + TimelineTests.silence(3)
        let log = await Self.run(audio, idleAfter: 30)
        #expect(log.idle == [true, false])
        #expect(log.utterances.count == 2, "\(log.utterances)")
    }

    @Test func 쉬는_동안은_녹음_파일에_쓰지_않고_줄_시각도_파일_기준으로_이어진다() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("quiet-\(UUID().uuidString)")
        let rec = try #require(Notes.AudioRecorder(url: dir.appendingPathComponent("rec.m4a")))
        let audio = TimelineTests.silence(1) + TimelineTests.tone(1.5) + TimelineTests.silence(40) + TimelineTests.tone(1.5) + TimelineTests.silence(3)
        let log = await Self.run(audio, idleAfter: 30, recorder: rec)
        // 첫 말은 1~2.5초, 그 발화가 끝난 뒤(약 4.5초) 30초가 지나면 쉰다 → 약 34.5초에서 파일이 멈추고
        // 42.5초에 다시 말할 때까지(약 8초)는 파일에 들어가지 않는다. 전체 47초 중 약 39초만 남는다
        #expect(rec.seconds > 38 && rec.seconds < 41, "recorded \(rec.seconds)")
        let second = try #require(log.utterances.last)
        #expect(second.start > 33.5 && second.start < 35, "start \(second.start)")   // 파일 기준: 쉬기 시작한 자리 바로 뒤
        #expect(second.end <= rec.seconds + 0.01)
    }

    @Test func 끄면_길게_조용해도_멈추지_않는다() async {
        let log = await Self.run(TimelineTests.tone(1.5) + TimelineTests.silence(40), idleAfter: nil)
        #expect(log.idle.isEmpty)
    }
}
