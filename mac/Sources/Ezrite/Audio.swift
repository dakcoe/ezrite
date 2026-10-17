import AppKit
import AVFoundation
import ScreenCaptureKit

let sampleRate: Double = 16000

/// 받아 적을 소리의 출처.
enum AudioSource: Hashable, Identifiable {
    case system
    case mic
    case app(bundleID: String, name: String)

    var id: String {
        switch self {
        case .system: return "system"
        case .mic: return "mic"
        case .app(let b, _): return "app:" + b
        }
    }

    var label: String {
        switch self {
        case .system: return "시스템 전체 소리"
        case .mic: return "기본 마이크"
        case .app(_, let n): return n
        }
    }

    /// 실행 중인 일반 앱 목록. 화면 녹화 권한 없이 볼 수 있는 NSWorkspace 를 쓴다.
    static func available() -> [AudioSource] {
        var out: [AudioSource] = [.system, .mic]
        var seen = Set<String>()
        for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
            guard let b = app.bundleIdentifier, let n = app.localizedName,
                  b != Bundle.main.bundleIdentifier, seen.insert(b).inserted else { continue }
            out.append(.app(bundleID: b, name: n))
        }
        return out
    }
}

struct CaptureError: LocalizedError {
    let errorDescription: String?
    init(_ msg: String) { errorDescription = msg }
}

// MARK: - 앱·시스템 소리 (ScreenCaptureKit)

/// BlackHole 같은 가상 장치 없이, 출력 장치를 건드리지 않고 소리를 가져온다.
final class ScreenAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private let bundleID: String?          // nil 이면 시스템 전체
    private let onSamples: ([Float]) -> Void
    private let onStop: (Error) -> Void
    private let queue = DispatchQueue(label: "capture.screen")
    private var stream: SCStream?

    init(bundleID: String?, onSamples: @escaping ([Float]) -> Void, onStop: @escaping (Error) -> Void) {
        self.bundleID = bundleID
        self.onSamples = onSamples
        self.onStop = onStop
    }

    func start() async throws {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        } catch {
            throw CaptureError("화면 녹화 권한이 필요합니다. 시스템 설정 → 개인정보 보호 및 보안 → 화면 및 시스템 오디오 녹음에서 Ezrite 를 허용하세요.")
        }
        guard let display = content.displays.first else { throw CaptureError("디스플레이를 찾을 수 없습니다") }

        let filter: SCContentFilter
        if let bundleID {
            // 같은 앱이 여러 개 떠 있을 수 있다 (예: 보이지 않는 Chrome 이 하나 더). 첫 번째만 잡으면 소리 없는 쪽을 받는다
            let apps = content.applications.filter { $0.bundleIdentifier == bundleID }
            guard !apps.isEmpty else {
                throw CaptureError("선택한 앱이 실행 중이 아닙니다. 앱을 켠 뒤 다시 시작하세요.")
            }
            filter = SCContentFilter(display: display, including: apps, exceptingWindows: [])
        } else {
            let me = content.applications.filter { $0.bundleIdentifier == Bundle.main.bundleIdentifier }
            filter = SCContentFilter(display: display, excludingApplications: me, exceptingWindows: [])
        }

        let cfg = SCStreamConfiguration()
        cfg.capturesAudio = true
        cfg.sampleRate = Int(sampleRate)
        cfg.channelCount = 1
        cfg.excludesCurrentProcessAudio = true
        // 화면은 안 쓰지만 SCStream 이 비디오를 요구하므로 최소로 낮춘다
        cfg.width = 2
        cfg.height = 2
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        try await s.startCapture()
        stream = s
    }

    func stop() {
        let s = stream
        stream = nil
        Task { try? await s?.stopCapture() }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, let samples = sb.monoFloats() else { return }
        onSamples(samples)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        guard self.stream != nil else { return }     // 우리가 멈춘 것이면 무시
        self.stream = nil
        onStop(error)
    }
}

private extension CMSampleBuffer {
    /// Float32 오디오를 모노 배열로. 여러 채널이 인터리브돼 오면 평균낸다.
    func monoFloats() -> [Float]? {
        guard CMSampleBufferDataIsReady(self),
              let desc = CMSampleBufferGetFormatDescription(self),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc)?.pointee else { return nil }
        var block: CMBlockBuffer?
        var abl = AudioBufferList()
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            self, bufferListSizeNeededOut: nil, bufferListOut: &abl,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &block)
        guard status == noErr, let data = abl.mBuffers.mData else { return nil }

        let count = Int(abl.mBuffers.mDataByteSize) / MemoryLayout<Float>.size
        let src = UnsafeBufferPointer(start: data.bindMemory(to: Float.self, capacity: count), count: count)
        let ch = max(1, Int(asbd.mChannelsPerFrame))
        let interleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) == 0
        guard interleaved && ch > 1 else { return Array(src) }
        let frames = count / ch
        var out = [Float](repeating: 0, count: frames)
        for i in 0..<frames {
            var v: Float = 0
            for c in 0..<ch { v += src[i * ch + c] }
            out[i] = v / Float(ch)
        }
        return out
    }
}

// MARK: - 마이크 (AVAudioEngine)

final class MicCapture {
    private let engine = AVAudioEngine()
    private let onSamples: ([Float]) -> Void

    init(onSamples: @escaping ([Float]) -> Void) {
        self.onSamples = onSamples
    }

    static func requestPermission() async -> Bool {
        await AVCaptureDevice.requestAccess(for: .audio)
    }

    func start() throws {
        let input = engine.inputNode
        let inFmt = input.outputFormat(forBus: 0)
        guard inFmt.sampleRate > 0,
              let outFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate,
                                         channels: 1, interleaved: false),
              let conv = AVAudioConverter(from: inFmt, to: outFmt) else {
            throw CaptureError("마이크를 열 수 없습니다")
        }
        let ratio = sampleRate / inFmt.sampleRate
        input.installTap(onBus: 0, bufferSize: 4096, format: inFmt) { [weak self] buf, _ in
            let cap = AVAudioFrameCount(Double(buf.frameLength) * ratio) + 32
            guard let out = AVAudioPCMBuffer(pcmFormat: outFmt, frameCapacity: cap) else { return }
            var fed = false
            var err: NSError?
            conv.convert(to: out, error: &err) { _, status in
                if fed {
                    status.pointee = .noDataNow
                    return nil
                }
                fed = true
                status.pointee = .haveData
                return buf
            }
            guard err == nil, let chans = out.floatChannelData else { return }
            self?.onSamples(Array(UnsafeBufferPointer(start: chans[0], count: Int(out.frameLength))))
        }
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }
}

// MARK: - WAV

enum WAV {
    /// Float 샘플 → 16-bit mono WAV
    static func encode(_ samples: [Float]) -> Data {
        var pcm = Data(capacity: samples.count * 2)
        for s in samples {
            var v = Int16(max(-1, min(1, s)) * 32767).littleEndian
            withUnsafeBytes(of: &v) { pcm.append(contentsOf: $0) }
        }
        var d = Data()
        func u32(_ v: UInt32) { var x = v.littleEndian; withUnsafeBytes(of: &x) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { var x = v.littleEndian; withUnsafeBytes(of: &x) { d.append(contentsOf: $0) } }
        let rate = UInt32(sampleRate)
        d.append(contentsOf: Array("RIFF".utf8)); u32(36 + UInt32(pcm.count))
        d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
        d.append(contentsOf: Array("data".utf8)); u32(UInt32(pcm.count))
        d.append(pcm)
        return d
    }
}
