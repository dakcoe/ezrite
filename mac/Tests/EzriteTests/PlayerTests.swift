import AVFoundation
import Foundation
import Testing
@testable import Ezrite

/// 녹음 플레이어: 지난 기록 화면의 ▶/⏸ 버튼 뒤에 있는 동작
@MainActor
struct PlayerTests {
    /// 소리 없는 m4a (재생 테스트가 스피커로 소리를 내지 않게)
    static func silentFile(seconds: Double) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("player-test-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16000,
                                       AVNumberOfChannelsKey: 1]
        let file = try AVAudioFile(forWriting: url, settings: settings,
                                   commonFormat: .pcmFormatFloat32, interleaved: false)
        let frames = AVAudioFrameCount(16000 * seconds)
        let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames)!
        buf.frameLength = frames            // 새 버퍼는 0 으로 채워져 있다
        try file.write(from: buf)
        return url
    }

    @Test func 열면_멈춰_있고_누르면_재생된다() throws {
        let player = Player()
        player.open(try Self.silentFile(seconds: 2))
        #expect(!player.isPlaying)
        #expect(abs(player.duration - 2) < 0.2)

        player.toggle()
        #expect(player.isPlaying)
    }

    @Test func 멈추면_그_자리에_서고_다시_누르면_이어서_재생된다() async throws {
        let player = Player()
        player.open(try Self.silentFile(seconds: 3))
        player.toggle()
        try await Task.sleep(nanoseconds: 600_000_000)
        player.toggle()
        #expect(!player.isPlaying)
        let paused = player.position
        #expect(paused > 0.3 && paused < 1.2)

        try await Task.sleep(nanoseconds: 400_000_000)
        #expect(abs(player.position - paused) < 0.05)       // 멈춘 동안 위치가 그대로

        player.toggle()
        #expect(player.isPlaying)
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(player.position > paused + 0.1)              // 처음부터가 아니라 이어서
    }

    @Test func 끝까지_들으면_멈춤_상태로_돌아오고_처음부터_다시_들을_수_있다() async throws {
        let player = Player()
        player.open(try Self.silentFile(seconds: 1))
        player.toggle()
        try await Task.sleep(nanoseconds: 1_600_000_000)
        #expect(!player.isPlaying)
        #expect(player.position < 0.05)

        player.toggle()
        #expect(player.isPlaying)
    }

    @Test func 진행_막대로_원하는_위치로_옮긴다() throws {
        let player = Player()
        player.open(try Self.silentFile(seconds: 3))
        player.seek(to: 2)
        #expect(abs(player.position - 2) < 0.05)
        #expect(!player.isPlaying)                       // 옮기기만 해서는 재생되지 않는다

        player.seek(to: 99)                              // 범위를 넘으면 끝에 붙는다
        #expect(player.position <= player.duration)
        player.seek(to: -5)
        #expect(player.position == 0)
    }

    @Test func 다른_기록을_열면_재생이_멈추고_새_기록은_처음부터다() throws {
        let player = Player()
        player.open(try Self.silentFile(seconds: 3))
        player.toggle()
        player.open(try Self.silentFile(seconds: 2))
        #expect(!player.isPlaying)
        #expect(player.position == 0)
        #expect(abs(player.duration - 2) < 0.2)
    }

    @Test func 목록으로_돌아가면_재생이_멈춘다() throws {
        let player = Player()
        player.open(try Self.silentFile(seconds: 3))
        player.toggle()
        player.close()
        #expect(!player.isPlaying)
        #expect(player.duration == 0)
    }

    @Test func 줄을_누르면_그_구간만_재생하고_멈춘다() async throws {
        let player = Player()
        player.open(try Self.silentFile(seconds: 3))
        player.play(from: 1.0, to: 1.5)
        #expect(player.isPlaying)
        #expect(abs(player.position - 1.0) < 0.1)
        try await Task.sleep(nanoseconds: 900_000_000)
        #expect(!player.isPlaying)
        #expect(abs(player.position - 1.5) < 0.15, "멈춘 자리 \(player.position)")
    }

    @Test func 구간_재생_중에_다른_조작을_하면_구간_끝에서_멈추지_않는다() async throws {
        let player = Player()
        player.open(try Self.silentFile(seconds: 3))
        player.play(from: 0.2, to: 0.5)
        player.seek(to: 1.0)                             // 사용자가 막대를 옮겼다
        try await Task.sleep(nanoseconds: 600_000_000)
        #expect(player.isPlaying)                         // 0.5초 예약 정지가 취소됐다
    }
}
