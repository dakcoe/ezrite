import AppKit
import Foundation

/// 소리 → 30ms 블록 → VAD → 발화. 오디오 스레드에서만 만지므로 자기 큐 하나로 직렬화한다.
final class AudioPipeline {
    static let micLagMax = 4800                 // 300ms. 두 소스 시계가 어긋나 지연이 쌓이는 것을 끊는다

    private let q = DispatchQueue(label: "stt.pipeline")
    private var vad = VAD()
    private var pending: [Float] = []
    private var micBuf: [Float] = []
    private var blocksSinceLevel = 0
    private let mixing: Bool
    private let recorder: Notes.AudioRecorder?
    private let onUtterance: ([Float], Double, Double) -> Void
    private let onLevel: (Float) -> Void
    private let startOffset: Double
    private var consumed = 0                    // VAD 가 지금까지 읽은 샘플 수

    /// mixing: 앱 소리에 마이크를 섞는다. 그때 마이크는 pushMic, 앱 소리는 pushMain 으로 들어온다
    /// recorder: 섞은 소리를 그대로 원본 파일에 남긴다
    /// startOffset: 이 파이프라인이 시작할 때 녹음 파일에 이미 쌓인 초 (다시 연결·일시정지 뒤에도 시각이 이어지게)
    /// onUtterance(발화, 시작 초, 끝 초): 시각은 녹음 파일 안의 위치다
    init(mixing: Bool, recorder: Notes.AudioRecorder?, startOffset: Double = 0,
         onUtterance: @escaping ([Float], Double, Double) -> Void, onLevel: @escaping (Float) -> Void) {
        self.mixing = mixing
        self.recorder = recorder
        self.startOffset = startOffset
        self.onUtterance = onUtterance
        self.onLevel = onLevel
    }

    /// 방금 끝난 발화의 녹음 파일 안 위치
    private func emit(_ u: [Float]) {
        let end = startOffset + Double(consumed) / sampleRate
        onUtterance(u, end - Double(u.count) / sampleRate, end)
    }

    func pushMain(_ samples: [Float]) {
        q.async { self.ingest(samples) }
    }

    func pushMic(_ samples: [Float]) {
        q.async {
            guard self.mixing else { return self.ingest(samples) }
            self.micBuf += samples
            if self.micBuf.count > Self.micLagMax { self.micBuf.removeFirst(self.micBuf.count - Self.micLagMax) }
        }
    }

    /// 정지할 때 모으던 발화도 내보낸다
    func finish() {
        q.async {
            if let u = self.vad.flush() { self.emit(u) }
            self.pending = []
            self.micBuf = []
        }
    }

    private func ingest(_ input: [Float]) {
        var s = input
        if mixing && !micBuf.isEmpty {
            // 같은 큐에 번갈아 넣으면 시간축이 깨진다. 앱 소리 길이만큼 마이크를 더한다
            let n = min(s.count, micBuf.count)
            for i in 0..<n { s[i] += micBuf[i] }
            micBuf.removeFirst(n)
        }
        recorder?.write(s)
        pending += s
        var start = 0
        while pending.count - start >= VAD.blockSize {
            let block = Array(pending[start..<start + VAD.blockSize])
            start += VAD.blockSize
            blocksSinceLevel += 1
            if blocksSinceLevel >= 3 {                       // 90ms 마다 파형 갱신
                blocksSinceLevel = 0
                onLevel(VAD.rms(block))
            }
            consumed += VAD.blockSize
            if let u = vad.feed(block) { emit(u) }
        }
        pending.removeFirst(start)
    }
}

/// 받아쓰기 전체 흐름: 캡처 시작·정지, 끊기면 다시 붙이기, 발화를 순서대로 Groq 에 보내기, 자동 저장.
@MainActor
final class Transcriber {
    static let maxRestarts = 5
    static let restartWait: UInt64 = 2_000_000_000

    private let state: AppState
    private let groq = GroqClient()
    private var pipeline: AudioPipeline?
    private var recorder: Notes.AudioRecorder?
    private var screen: ScreenAudioCapture?
    private var mic: MicCapture?
    private var writer = Notes.Writer()
    private var lastText = ""
    private var sendChain: Task<Void, Never>?
    private var activity: NSObjectProtocol?
    private var restarts = 0
    private var pausedClock = ""
    private var untranslated: [UUID] = []       // 번역을 기다리는 줄
    private var times: [[Double]] = []          // 글 줄마다 녹음 위치 (.times.json)
    private var translating = false
    static let translateBatch = 10

    init(state: AppState) {
        self.state = state
    }

    func toggle() {
        if state.listening { stop() } else { Task { await start() } }
    }

    func togglePause() {
        if state.paused { Task { await resume() } } else { pause() }
    }

    func start() async {
        guard !state.listening else { return }
        state.error = nil
        guard APIKey.groq() != nil else {
            state.error = "Groq API 키가 없습니다. 설정에서 키를 입력하세요."
            return
        }
        let source = state.selectedSource
        guard await micAllowed() else { return }

        state.entries = []
        state.liveSession = nil
        Notes.prune()
        writer = Notes.Writer()
        // 다시 연결해도 같은 파일에 이어 쓴다
        recorder = Notes.AudioRecorder(url: writer.planned.deletingPathExtension().appendingPathExtension("m4a"))
        lastText = ""
        restarts = 0
        untranslated = []
        times = []
        state.listening = true
        state.paused = false
        state.recordedBefore = 0
        state.startedAt = Date()
        // 강의 중 잠자기로 캡처가 끊기지 않게 한다 (옛 앱의 caffeinate)
        activity = ProcessInfo.processInfo.beginActivity(
            options: [.idleSystemSleepDisabled, .idleDisplaySleepDisabled, .userInitiated],
            reason: "강의 받아쓰기")

        do {
            try await startCapture(source: source, mixMic: source != .mic && state.includeMic)
        } catch {
            state.error = error.localizedDescription
            stop()
        }
    }

    func stop() {
        guard state.listening else { return }
        state.listening = false
        state.paused = false
        state.startedAt = nil
        state.recordedBefore = 0
        stopCapture()
        recorder?.close()           // 여기서 m4a 가 마무리된다. 앱 종료 때도 이 길로 온다
        recorder = nil
        if let activity { ProcessInfo.processInfo.endActivity(activity) }
        activity = nil
    }

    private func micAllowed() async -> Bool {
        let wantsMic = (state.selectedSource == .mic || state.includeMic) && DevFeed.file == nil
        if wantsMic, !(await MicCapture.requestPermission()) {
            state.error = "마이크 권한이 필요합니다. 시스템 설정 → 개인정보 보호 및 보안 → 마이크에서 Ezrite 를 허용하세요."
            return false
        }
        return true
    }

    /// 녹음 중에 소리 출처(또는 마이크 섞기)를 바꾸면 캡처만 새로 붙인다. 기록과 소리 파일은 그대로 이어 쓴다.
    /// 일시정지 중이면 이어 할 때 새 출처로 붙으니 자리만 남긴다
    func switchSource() async {
        guard state.listening else { return }
        let source = state.selectedSource
        addGap("── \(Notes.timestamp()) 소리 출처 → \(source.label)" + (state.includeMic && source != .mic ? " + 마이크" : ""))
        guard !state.paused else { return }
        stopCapture()
        guard await micAllowed() else { return stop() }
        do {
            try await startCapture(source: source, mixMic: source != .mic && state.includeMic)
        } catch {
            state.error = error.localizedDescription
            stop()
        }
    }

    /// 인식 언어는 발화를 보낼 때마다 읽으니 바로 다음 문장부터 바뀐다. 바꾼 자리만 남긴다
    func languageChanged() {
        guard state.listening else { return }
        addGap("── \(Notes.timestamp()) 인식 언어 → \(state.language)")
    }

    /// 듣기만 멈춘다. 받아쓰기 파일과 소리 파일은 열어 둔 채라 이어 하면 같은 세션에 이어 쓴다
    func pause() {
        guard state.listening, !state.paused else { return }
        state.paused = true
        state.recordedBefore += state.startedAt.map { Date().timeIntervalSince($0) } ?? 0
        state.startedAt = nil
        pausedClock = Notes.timestamp()
        stopCapture()
    }

    func resume() async {
        guard state.listening, state.paused else { return }
        state.paused = false
        state.startedAt = Date()
        restarts = 0
        addGap("── \(pausedClock)–\(Notes.timestamp()) 일시정지 후 이어서 녹음")
        do {
            let source = state.selectedSource
            try await startCapture(source: source, mixMic: source != .mic && state.includeMic)
        } catch {
            state.error = error.localizedDescription
            stop()
        }
    }

    private func stopCapture() {
        state.level = 0
        screen?.stop()
        mic?.stop()
        screen = nil
        mic = nil
        pipeline?.finish()          // 남은 발화는 그대로 보내진다
        pipeline = nil
    }

    private func startCapture(source: AudioSource, mixMic: Bool) async throws {
        let p = AudioPipeline(
            mixing: mixMic, recorder: recorder, startOffset: recorder?.seconds ?? 0,
            // main 큐는 넣은 순서대로 돈다. Task 로 넘기면 발화 순서가 뒤바뀔 수 있다
            onUtterance: { [weak self] u, start, end in
                DispatchQueue.main.async { MainActor.assumeIsolated { self?.enqueue(u, time: start...end) } }
            },
            onLevel: { [weak self] l in Task { @MainActor in self?.state.level = l } })
        pipeline = p

        if DevFeed.file != nil {
            DevFeed.run { [weak p] s in p?.pushMain(s) }
            return
        }
        if source == .mic || mixMic {
            let m = MicCapture { [weak p] s in p?.pushMic(s) }
            try m.start()
            mic = m
        }
        switch source {
        case .mic:
            break
        case .system, .app:
            let bundleID: String?
            if case .app(let b, _) = source { bundleID = b } else { bundleID = nil }
            let s = ScreenAudioCapture(
                bundleID: bundleID,
                onSamples: { [weak p] samples in p?.pushMain(samples) },
                onStop: { [weak self] err in Task { @MainActor in await self?.reconnect(after: err) } })
            try await s.start()
            screen = s
        }
    }

    /// 화면이 잠들거나 대상 앱이 소리를 멈추면 ScreenCaptureKit 이 스트림을 끊는다.
    /// 조용히 멈추지 않게 다시 붙이고, 끊긴 자리를 기록에 남긴다.
    private func reconnect(after error: Error) async {
        guard state.listening, !state.paused else { return }   // 일시정지로 멈춘 스트림은 다시 붙이지 않는다
        addGap("── \(Notes.timestamp()) 소리가 끊겼습니다 (\(error.localizedDescription))")
        let source = state.selectedSource
        while state.listening && restarts < Self.maxRestarts {
            restarts += 1
            try? await Task.sleep(nanoseconds: Self.restartWait)
            guard state.listening, !state.paused else { return }
            screen?.stop()
            mic?.stop()
            do {
                try await startCapture(source: source, mixMic: source != .mic && state.includeMic)
                addGap("── \(Notes.timestamp()) 다시 연결됨")
                return
            } catch {
                continue
            }
        }
        state.error = "소리 캡처를 다시 붙이지 못했습니다. 받아쓰기를 다시 시작하세요."
        stop()
    }

    /// 발화를 순서대로 하나씩 보낸다. 앞 문장이 끝나야 다음 문장의 prompt(직전 문맥)가 정해진다.
    private func enqueue(_ samples: [Float], time: ClosedRange<Double>) {
        let prev = sendChain
        let language = state.languageCode
        sendChain = Task { [weak self] in
            await prev?.value
            await self?.send(samples, time: time, language: language)
        }
    }

    private func send(_ samples: [Float], time: ClosedRange<Double>, language: String) async {
        state.inflight += 1
        defer { state.inflight -= 1 }
        do {
            let raw = try await groq.transcribe(
                wav: WAV.encode(samples), language: language, prompt: lastText,
                onFallback: { [weak self] old, new in
                    Task { @MainActor in self?.state.notice = "\(old) 한도 초과 → \(new)로 전환" }
                })
            let text = Notes.sanitize(raw)
            guard !text.isEmpty, !Hallucination.isRepeat(text, previous: lastText) else { return }
            lastText = text
            state.error = nil
            var entry = Entry(original: text)
            entry.time = time
            state.entries.append(entry)
            writer.append(text)
            state.liveSession = writer.url
            times.append([time.lowerBound, time.upperBound])
            if let u = writer.url { Notes.saveTimes(times, for: u) }
            // 한국어 강의는 옮기지 않는다
            if state.autoTranslate && language != "ko" {
                untranslated.append(entry.id)
                pumpTranslation()
            }
        } catch {
            // 이 구간은 잃었다. 어디부터 다시 들어야 하는지 알 수 있게 자리를 남긴다
            state.error = error.localizedDescription
            addGap("── \(Notes.timestamp()) 인식 실패: \(error.localizedDescription)")
        }
    }

    /// 설정에서 고른 서비스로 옮긴다. 실패하면(키 오류 제외) Groq 로 대신한다
    private func translate(_ lines: [String], context: [String]) async throws -> [String?] {
        try await Translation.run(lines, context: context, state: state, groq: groq)
    }

    /// 밀린 줄을 묶어서 한 번에 옮긴다. 한 묶음이 끝나면 그동안 쌓인 줄로 다음 묶음을 보낸다.
    private func pumpTranslation() {
        guard !translating, !untranslated.isEmpty else { return }
        let ids = Array(untranslated.prefix(Self.translateBatch))
        untranslated.removeFirst(ids.count)
        let lines = ids.compactMap { id in state.entries.first { $0.id == id }?.original }
        guard lines.count == ids.count else { return pumpTranslation() }   // 새 세션이 시작돼 사라진 줄
        // 첫 줄 바로 앞의 받아 적은 한 줄 (끊긴 문장 잇기용)
        let first = state.entries.firstIndex { $0.id == ids[0] } ?? 0
        let context = state.entries[..<first].last { $0.kind == .text }.map { [$0.original] } ?? []
        translating = true
        let session = writer
        Task { [weak self] in
            let result: [String?]
            do {
                result = try await self?.translate(lines, context: context) ?? []
            } catch {
                result = []
                self?.state.notice = error.localizedDescription
            }
            guard let self else { return }
            self.translating = false
            if session === self.writer {
                for (id, t) in zip(ids, result) {
                    if let t, let i = self.state.entries.firstIndex(where: { $0.id == id }) {
                        self.state.entries[i].translation = t
                    }
                }
                if result.contains(where: { $0 != nil }) { self.writer.rewrite(self.state.entries) }
            }
            self.pumpTranslation()
        }
    }

    private func addGap(_ line: String) {
        state.entries.append(Entry(kind: .gap, original: line))
        writer.append(line)
        state.liveSession = writer.url
    }
}

/// 설정에서 고른 서비스로 옮긴다. 실패하면(키 오류 제외) Groq 로 대신한다.
/// 실시간 받아쓰기와 다시 받아 적기가 함께 쓴다
@MainActor
enum Translation {
    /// context: 바로 앞 한 줄. 문장이 줄을 넘어 이어질 때 자연스럽게 옮기도록 참고로만 준다
    static func run(_ lines: [String], context: [String], state: AppState, groq: GroqClient) async throws -> [String?] {
        let p = state.translateProvider, model = state.translateModel
        guard p != .groq, !model.isEmpty else { return try await groq.translate(lines, context: context) }
        let input = GroqClient.translationInput(lines, context: context)
        do {
            let out = try await AI.complete(p, model: model, prompt: GroqClient.translatePrompt + "\n\n" + input,
                                            json: false, maxTokens: 2000, think: false)
            return GroqClient.parse(out, count: lines.count)
        } catch let e as AI.Failure where AI.shouldFallback(status: e.status) {
            state.notice = "\(p.label) 번역 실패 → Groq 로 대신했습니다"
            return try await groq.translate(lines, context: context)
        }
    }
}
