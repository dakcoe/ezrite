import AVFoundation
import Foundation
import Testing
@testable import Ezrite

/// 녹음을 조각으로 나눠 쓰고, 정지하면 하나로 합친다. 앱이 죽으면 다음 실행 때 남은 조각을 합친다
@Suite(.serialized)
struct PartsTests {
    static func dir() throws -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("parts-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    static func seconds(_ url: URL) throws -> Double { try Double(Retranscribe.decode(url).count) / sampleRate }

    @Test func 조각으로_나눠_쓰고_정지하면_하나로_합친다() throws {
        let d = try Self.dir()
        let url = d.appendingPathComponent("2026-10-15_10-00-00.m4a")
        let rec = try #require(Notes.AudioRecorder(url: url, partSeconds: 1))
        rec.write(TimelineTests.tone(3.5))
        let parts = try FileManager.default.contentsOfDirectory(atPath: d.path).filter { $0.contains(".part-") }
        #expect(parts.count == 4)                                  // 1초씩 3개 + 쓰는 중 1개
        rec.close()
        Notes.AudioRecorder.waitForMerges()

        let names = try FileManager.default.contentsOfDirectory(atPath: d.path)
        #expect(names == ["2026-10-15_10-00-00.m4a"])                // 조각은 지워졌다
        // 이음매마다 빈 소리가 끼면 줄별 재생 위치가 밀린다. 합친 길이는 쓴 길이와 같아야 한다
        let merged = try Self.seconds(url)
        #expect(abs(merged - 3.5) < 0.06, "합친 길이 \(merged)")
    }

    @Test func 앱이_죽어_남은_조각은_다음_실행_때_합친다() throws {
        let d = try Self.dir()
        let url = d.appendingPathComponent("2026-10-15_11-00-00.m4a")
        let rec = try #require(Notes.AudioRecorder(url: url, partSeconds: 1))
        rec.write(TimelineTests.tone(2.5))                          // 다 찬 조각 2개 + 마무리 못 한 조각 1개
        // close() 없이 끝났다 (비정상 종료)
        Notes.recoverParts(in: d)
        #expect(FileManager.default.fileExists(atPath: url.path))
        let secs = try Self.seconds(url)
        #expect(secs > 1.9 && secs < 2.6, "살린 길이 \(secs)")      // 마무리 못 한 마지막 조각은 잃어도 된다
        withExtendedLifetime(rec) {}
    }
}
