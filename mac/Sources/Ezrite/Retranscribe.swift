import AppKit
import AVFoundation
import Foundation

/// 저장된 녹음(.m4a)으로 기록을 다시 받아 적는다. Groq 장애로 빠진 구간이나 엉망인 기록을 고칠 때 쓴다.
///
/// 소리를 VAD 로 발화 단위로 나누고, 이어지는 발화를 1분 안쪽으로 묶어 한 번에 보낸다(요청 수와 분당 한도를 줄인다).
/// 돌아온 구간(segment)은 가운데 시각이 속한 발화 줄로 다시 모아, 줄마다 녹음 위치를 그대로 갖게 한다
enum Retranscribe {
    struct Seg {
        let start: Double           // 묶음 안 시각(초)
        let end: Double
        let text: String
    }

    struct Line: Equatable {
        let text: String
        let time: ClosedRange<Double>
    }

    static let maxSpan = 60.0

    /// 발화 번호 묶음. 묶음 하나의 처음~끝이 maxSpan 을 넘지 않는다 (긴 발화 하나는 혼자)
    static func chunks(_ utterances: [ClosedRange<Double>], maxSpan: Double = maxSpan) -> [Range<Int>] {
        var out: [Range<Int>] = []
        var first = 0
        for i in utterances.indices where i > first {
            if utterances[i].upperBound - utterances[first].lowerBound > maxSpan {
                out.append(first..<i)
                first = i
            }
        }
        if !utterances.isEmpty { out.append(first..<utterances.count) }
        return out
    }

    /// 구간마다 가운데 시각이 속한 발화(없으면 가장 가까운 발화)에 붙여 줄을 만든다. 글이 없는 발화는 빠진다
    static func assign(_ segs: [Seg], chunkStart: Double, utterances: [ClosedRange<Double>]) -> [Line] {
        var texts = [[String]](repeating: [], count: utterances.count)
        for s in segs {
            let mid = chunkStart + (s.start + s.end) / 2
            let gap = { (r: ClosedRange<Double>) in r.contains(mid) ? 0 : min(abs(r.lowerBound - mid), abs(r.upperBound - mid)) }
            guard let i = utterances.indices.min(by: { gap(utterances[$0]) < gap(utterances[$1]) }) else { continue }
            let t = s.text.trimmingCharacters(in: .whitespaces)
            if !t.isEmpty { texts[i].append(t) }
        }
        return utterances.indices.compactMap { i in
            texts[i].isEmpty ? nil : Line(text: texts[i].joined(separator: " "), time: utterances[i])
        }
    }

    /// .m4a 를 16kHz 모노로 읽는다
    static func decode(_ url: URL) throws -> [Float] {
        let file = try AVAudioFile(forReading: url, commonFormat: .pcmFormatFloat32, interleaved: false)
        guard let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1,
                                         interleaved: false),
              let converter = AVAudioConverter(from: file.processingFormat, to: target) else { return [] }
        var out: [Float] = []
        let chunk: AVAudioFrameCount = 16384
        var done = false
        while !done {
            guard let dst = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: chunk) else { break }
            var err: NSError?
            let status = converter.convert(to: dst, error: &err) { _, outStatus in
                guard let src = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: chunk),
                      (try? file.read(into: src)) != nil, src.frameLength > 0 else {
                    outStatus.pointee = .endOfStream
                    return nil
                }
                outStatus.pointee = .haveData
                return src
            }
            if let ch = dst.floatChannelData, dst.frameLength > 0 {
                out += UnsafeBufferPointer(start: ch[0], count: Int(dst.frameLength))
            }
            done = status == .endOfStream || status == .error || dst.frameLength == 0
        }
        return out
    }

    /// 발화 구간들(초). 받아 적을 때와 같은 VAD 를 쓴다
    static func utterances(_ samples: [Float]) -> [ClosedRange<Double>] {
        var vad = VAD()
        var out: [ClosedRange<Double>] = []
        var consumed = 0
        var i = 0
        while i + VAD.blockSize <= samples.count {
            consumed += VAD.blockSize
            if let u = vad.feed(Array(samples[i..<i + VAD.blockSize])) {
                let end = Double(consumed - vad.carried) / sampleRate
                out.append(max(0, end - Double(u.count) / sampleRate)...end)
            }
            i += VAD.blockSize
        }
        if let u = vad.flush() {
            let end = Double(consumed) / sampleRate
            out.append(max(0, end - Double(u.count) / sampleRate)...end)
        }
        return out
    }
}

/// 다시 받아 적기 진행. 지난 기록 화면이 진행 상황을 보여주고 취소할 수 있다
@MainActor
final class Retranscriber: ObservableObject {
    @Published private(set) var running: URL?
    @Published private(set) var done = 0
    @Published private(set) var total = 0
    @Published var message: String?
    private var task: Task<Void, Never>?
    private let groq = GroqClient()

    /// Groq 분당 한도(20회) 안쪽으로 요청 간격을 둔다
    static let pace: UInt64 = 3_200_000_000

    /// 요청 수 어림 (확인 창에 보여준다): 1분 묶음 기준이라 실제로는 이보다 조금 많을 수 있다
    static func estimate(duration: Double) -> Int { max(1, Int((duration / 50).rounded(.up))) }

    func cancel() {
        task?.cancel()
        task = nil
        running = nil
        message = "다시 받아 적기를 취소했습니다. 원래 기록은 그대로입니다."
    }

    /// 끝나면 원래 글은 휴지통으로 옮기고 새 글로 바꾼다. 소리 파일은 그대로 둔다
    func start(_ txt: URL, state: AppState, onDone: @escaping (URL) -> Void) {
        guard running == nil, let audio = Notes.audioURL(txt) else { return }
        running = txt
        done = 0
        total = 0
        message = nil
        let language = state.languageCode
        let hadTranslations = Notes.load(txt).contains { $0.translation != nil }
        task = Task { [weak self] in
            guard let self else { return }
            do {
                let samples = try await Task.detached { try Retranscribe.decode(audio) }.value
                let utts = await Task.detached { Retranscribe.utterances(samples) }.value
                let chunks = Retranscribe.chunks(utts)
                self.total = chunks.count
                var entries: [Entry] = []
                var lastText = ""
                for (n, c) in chunks.enumerated() {
                    try Task.checkCancellation()
                    if n > 0 { try await Task.sleep(nanoseconds: Self.pace) }
                    let span = utts[c.lowerBound].lowerBound...utts[c.upperBound - 1].upperBound
                    let a = Int(span.lowerBound * sampleRate), b = min(samples.count, Int(span.upperBound * sampleRate))
                    do {
                        let segs = try await self.groq.segments(wav: WAV.encode(Array(samples[a..<b])), language: language,
                                                                prompt: lastText, onFallback: { _, _ in })
                            .filter { $0.noSpeech < Hallucination.noSpeechLimit && !Hallucination.isKnown($0.text) }
                            .map { Retranscribe.Seg(start: $0.start, end: $0.end, text: $0.text) }
                        for line in Retranscribe.assign(segs, chunkStart: span.lowerBound, utterances: Array(utts[c])) {
                            let text = Notes.sanitize(line.text)
                            guard !text.isEmpty, !Hallucination.isRepeat(text, previous: lastText) else { continue }
                            var e = Entry(original: text)
                            e.time = line.time
                            entries.append(e)
                            lastText = text
                        }
                    } catch is CancellationError {
                        throw CancellationError()
                    } catch {
                        // 이 묶음은 잃었다. 다른 묶음은 계속하고, 빠진 자리를 남긴다
                        entries.append(Entry(kind: .gap, original:
                            "── \(Self.clock(span.lowerBound)) 다시 받아 적기 실패: \(error.localizedDescription)"))
                    }
                    self.done = n + 1
                }
                if hadTranslations && language != "ko" {
                    self.message = "번역하는 중…"
                    try await self.translate(&entries, state: state)
                }
                try Task.checkCancellation()
                try await Self.replace(txt, with: entries)
                self.running = nil
                self.message = "다시 받아 적었습니다 (\(entries.filter { $0.kind == .text }.count)줄). 원래 기록은 휴지통에 있습니다."
                onDone(txt)
            } catch is CancellationError {
                return
            } catch {
                self.running = nil
                self.message = "다시 받아 적지 못했습니다: \(error.localizedDescription)"
            }
        }
    }

    private func translate(_ entries: inout [Entry], state: AppState) async throws {
        let idx = entries.indices.filter { entries[$0].kind == .text }
        var start = 0
        while start < idx.count {
            try Task.checkCancellation()
            let batch = Array(idx[start..<min(start + 10, idx.count)])
            let context = start > 0 ? [entries[idx[start - 1]].original] : []
            let out = (try? await Translation.run(batch.map { entries[$0].original }, context: context,
                                                  state: state, groq: groq)) ?? []
            for (i, t) in zip(batch, out) { entries[i].translation = t }
            start += batch.count
        }
    }

    /// 원래 글과 줄 위치 파일은 휴지통으로(되살릴 수 있게), 새 글과 위치를 같은 이름으로 쓴다
    /// 휴지통은 Finder 에게 맡긴다 (앱이 직접 옮기면 iCloud 폴더의 휴지통 권한이 없어 막힌다)
    static func replace(_ txt: URL, with entries: [Entry]) async throws {
        let times = Notes.timesURL(txt)
        let old = [txt] + (FileManager.default.fileExists(atPath: times.path) ? [times] : [])
        let failure: String? = await withCheckedContinuation { c in
            NSWorkspace.shared.recycle(old) { _, error in
                DispatchQueue.main.async {
                    c.resume(returning: error == nil ? nil
                             : Notes.finderTrash(old.filter { FileManager.default.fileExists(atPath: $0.path) }))
                }
            }
        }
        if let failure { throw NSError(domain: "Ezrite", code: 513, userInfo: [NSLocalizedDescriptionKey: failure]) }
        try Data((Notes.render(entries) + "\n").utf8).write(to: txt, options: .atomic)
        Notes.saveTimes(entries.compactMap { e in e.time.map { [$0.lowerBound, $0.upperBound] } }, for: txt)
    }

    static func clock(_ t: Double) -> String {
        let s = Int(t)
        return String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60)
    }
}
