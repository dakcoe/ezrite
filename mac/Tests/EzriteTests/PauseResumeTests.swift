import AVFoundation
import Foundation
import Testing
@testable import Ezrite

/// 받아쓰기 도중 일시정지했다 이어 하기. 소리 없는 파일을 흘려 넣어서 Groq 로는 아무것도 보내지 않는다.
/// (시작할 때 Groq 키가 있는지만 본다 — 이 맥에 저장된 키를 쓴다)
// 테스트마다 Notes.dir·환경변수를 바꾸므로 한 번에 하나씩 돌린다
@MainActor @Suite(.serialized)
struct PauseResumeTests {
    /// 기록은 임시 폴더에 쓴다. 실제 자동 저장 폴더를 건드리지 않는다
    static func setUp() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pause-test-\(UUID().uuidString)")
        let notes = root.appendingPathComponent("notes")
        try FileManager.default.createDirectory(at: notes, withIntermediateDirectories: true)
        Notes.dir = notes

        let wav = root.appendingPathComponent("silence.wav")
        let file = try AVAudioFile(forWriting: wav, settings: [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false,
        ])
        let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 16000 * 10)!
        buf.frameLength = 16000 * 10
        try file.write(from: buf)
        setenv("EZRITE_TESTFILE", wav.path, 1)
        return notes
    }

    static func audioSeconds(in dir: URL) throws -> [Double] {
        Notes.AudioRecorder.waitForMerges()
        return try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "m4a" && !$0.lastPathComponent.contains(".part-") }
            .map { url in
                let f = try AVAudioFile(forReading: url)
                return Double(f.length) / f.fileFormat.sampleRate
            }
    }

    @Test func 일시정지했다_이어_하면_같은_세션의_소리_파일에_이어_쓴다() async throws {
        let dir = try Self.setUp()
        let state = AppState()
        let t = Transcriber(state: state)

        await t.start()
        try await Task.sleep(nanoseconds: 1_000_000_000)
        t.pause()
        #expect(state.listening && state.paused)

        try await Task.sleep(nanoseconds: 800_000_000)     // 이 동안은 녹음되지 않아야 한다
        await t.resume()
        #expect(state.listening && !state.paused)
        #expect(state.entries.contains { $0.kind == .gap && $0.original.contains("이어서 녹음") })

        try await Task.sleep(nanoseconds: 1_000_000_000)
        t.stop()
        try await Task.sleep(nanoseconds: 300_000_000)

        let audio = try Self.audioSeconds(in: dir)
        #expect(audio.count == 1)                           // 새 세션이 생기지 않았다
        let secs = audio.first ?? 0
        #expect(secs > 1.6 && secs < 2.5, "녹음 \(secs)초: 앞 1초 + 뒤 1초, 쉰 0.8초는 빠져야 한다")
    }

    @Test func 녹음_중에_소리_출처를_바꿔도_같은_기록에_이어_쓴다() async throws {
        let dir = try Self.setUp()
        let state = AppState()
        let t = Transcriber(state: state)
        let before = state.sourceID
        defer { state.sourceID = before }               // 사용자 설정을 되돌린다

        await t.start()
        try await Task.sleep(nanoseconds: 800_000_000)
        state.sourceID = "mic"
        await t.switchSource()
        #expect(state.listening && !state.paused)
        #expect(state.entries.contains { $0.kind == .gap && $0.original.contains("소리 출처 → 기본 마이크") })

        try await Task.sleep(nanoseconds: 800_000_000)
        t.stop()
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(try Self.audioSeconds(in: dir).count == 1)
    }

    @Test func 녹음_중에_인식_언어를_바꾸면_바꾼_자리를_남긴다() async throws {
        _ = try Self.setUp()
        let state = AppState()
        let t = Transcriber(state: state)
        let before = state.language
        defer { state.language = before }

        await t.start()
        state.language = "English"
        t.languageChanged()
        #expect(state.listening)
        #expect(state.entries.contains { $0.kind == .gap && $0.original.contains("인식 언어 → English") })
        t.stop()
    }
}
