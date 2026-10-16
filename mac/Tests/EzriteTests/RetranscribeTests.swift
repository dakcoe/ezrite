import Foundation
import Testing
@testable import Ezrite

/// 저장된 소리로 다시 받아 적기: 발화를 묶어 보내고, 돌아온 구간을 다시 줄로 나눈다
struct RetranscribeTests {
    typealias R = ClosedRange<Double>

    @Test func 이어지는_발화를_1분이_넘지_않게_묶는다() {
        let utterances: [R] = [0...10, 11...25, 26...50, 52...70, 71...80, 200...205]
        let chunks = Retranscribe.chunks(utterances, maxSpan: 60)
        #expect(chunks.map { $0.map { $0 } } == [[0, 1, 2], [3, 4], [5]])   // 묶음마다 발화 번호
    }

    @Test func 너무_긴_발화_하나는_혼자_한_묶음() {
        #expect(Retranscribe.chunks([0...90, 91...100], maxSpan: 60).map { $0.map { $0 } } == [[0], [1]])
    }

    @Test func 돌아온_구간을_가운데_시각이_속한_발화_줄로_모은다() {
        let utterances: [R] = [100...110, 112...125]
        // 묶음은 100초에서 시작했다. 구간 시각은 묶음 안 시각이다
        let segs = [Retranscribe.Seg(start: 0, end: 4, text: " Hello there."),
                    Retranscribe.Seg(start: 4, end: 9.5, text: " This is line one."),
                    Retranscribe.Seg(start: 12.5, end: 24, text: " Second line here.")]
        let lines = Retranscribe.assign(segs, chunkStart: 100, utterances: utterances)
        #expect(lines.map(\.text) == ["Hello there. This is line one.", "Second line here."])
        #expect(lines.map(\.time) == [100...110, 112...125])
    }

    @Test func 발화_사이_빈틈에_떨어진_구간은_가까운_줄로() {
        let lines = Retranscribe.assign([Retranscribe.Seg(start: 10.6, end: 11.4, text: "uh")],
                                        chunkStart: 0, utterances: [0...10, 12...20])
        #expect(lines.map(\.text) == ["uh"])
        #expect(lines.first?.time == 0...10)
    }

    @Test func 녹음_파일을_다시_읽어_발화_구간을_찾는다() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("rtx-\(UUID().uuidString).m4a")
        let rec = try #require(Notes.AudioRecorder(url: url))
        rec.write(TimelineTests.silence(1) + TimelineTests.tone(1.5) + TimelineTests.silence(3))
        rec.close()
        Notes.AudioRecorder.waitForMerges()
        let samples = try Retranscribe.decode(url)
        #expect(abs(Double(samples.count) / sampleRate - 5.5) < 0.15, "길이 \(Double(samples.count) / sampleRate)")
        let u = Retranscribe.utterances(samples)
        #expect(u.count == 1)
        #expect(abs((u.first?.lowerBound ?? 0) - 0.7) < 0.15, "시작 \(u.first?.lowerBound ?? -1)")
    }
}
