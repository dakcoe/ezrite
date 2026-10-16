import AVFoundation
import Foundation

/// 개발용: 권한 없이 받아쓰기 흐름을 확인한다.
///   EZRITE_TESTFILE=<16kHz mono wav> EZRITE_SPEED=2  → 실행하자마자 그 파일을 소리처럼 흘려 넣는다
enum DevFeed {
    static var file: String? { ProcessInfo.processInfo.environment["EZRITE_TESTFILE"] }

    static func run(into push: @escaping ([Float]) -> Void) {
        guard let path = file,
              let f = try? AVAudioFile(forReading: URL(fileURLWithPath: path), commonFormat: .pcmFormatFloat32,
                                       interleaved: false),
              let buf = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: AVAudioFrameCount(f.length)),
              (try? f.read(into: buf)) != nil,
              let ch = buf.floatChannelData else { return }
        let all = Array(UnsafeBufferPointer(start: ch[0], count: Int(buf.frameLength)))
        let speed = Double(ProcessInfo.processInfo.environment["EZRITE_SPEED"] ?? "1") ?? 1
        let chunk = Int(sampleRate / 10)            // 100ms
        DispatchQueue.global().async {
            var i = 0
            while i < all.count {
                push(Array(all[i..<min(i + chunk, all.count)]))
                i += chunk
                Thread.sleep(forTimeInterval: 0.1 / speed)
            }
        }
    }
}
