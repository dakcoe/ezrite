import Foundation
import Testing
@testable import Ezrite

/// 받아 적은 줄마다 녹음 파일 안의 위치(초) — 그 줄만 다시 들을 때 쓴다
struct TimelineTests {
    static func tone(_ secs: Double) -> [Float] {
        (0..<Int(secs * sampleRate)).map { Float(0.3 * sin(Double($0) * 2 * .pi * 220 / sampleRate)) }
    }
    static func silence(_ secs: Double) -> [Float] { [Float](repeating: 0, count: Int(secs * sampleRate)) }

    @Test func 발화마다_녹음_시작부터의_시각을_함께_낸다() async {
        let got: (samples: Int, start: Double, end: Double) = await withCheckedContinuation { cont in
            var done = false
            let p = AudioPipeline(mixing: false, recorder: nil, startOffset: 10,   // 앞서 10초가 이미 녹음됐다
                                  onUtterance: { u, start, end in
                                      guard !done else { return }
                                      done = true
                                      cont.resume(returning: (u.count, start, end))
                                  }, onLevel: { _ in })
            p.pushMain(Self.silence(1) + Self.tone(1.5) + Self.silence(3))
            p.finish()
        }
        // 말은 10+1=11초에 시작한다. 첫 음절 보호로 0.3초 앞부터 담는다
        #expect(abs(got.start - 10.7) < 0.1, "start \(got.start)")
        #expect(abs((got.end - got.start) - Double(got.samples) / sampleRate) < 0.01)
        #expect(got.end > 12.4 && got.end < 15, "end \(got.end)")
    }

    @Test func 줄마다의_시각을_따로_저장하고_다시_읽을_때_글_줄에만_붙인다() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("times-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let txt = dir.appendingPathComponent("2026-10-15_09-00-00.txt")
        try "첫 줄\n── 09:01:00 소리가 끊겼습니다\n둘째 줄\n    번역\n".write(to: txt, atomically: true, encoding: .utf8)
        Notes.saveTimes([[1.0, 3.0], [5.5, 8.0]], for: txt)

        let entries = Notes.load(txt)
        #expect(entries.map(\.kind) == [.text, .gap, .text])
        #expect(entries[0].time == 1.0...3.0)
        #expect(entries[1].time == nil)
        #expect(entries[2].time == 5.5...8.0)
        #expect(entries[2].translation == "번역")
    }
}
