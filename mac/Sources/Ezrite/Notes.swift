import AppKit
import AVFoundation
import Foundation

/// 받아 적은 한 줄. 번역은 나중에 붙는다.
struct Entry: Identifiable, Hashable {
    enum Kind { case text, gap }
    let id = UUID()
    var kind: Kind = .text
    var original: String
    var translation: String?
    var time: ClosedRange<Double>?          // 녹음 파일 안의 위치(초). 옛 기록에는 없다
}

/// 자동 저장. 옛 앱과 같은 폴더·형식을 써서 기록 창에서 예전 노트도 같이 보인다.
///   원문 한 줄 / 번역은 네 칸 들여쓰기 / "── " 로 시작하면 끊김 표시
enum Notes {
    /// 옛 앱과 같은 기본 위치. 여기서만 30일 지난 기록을 지운다
    static let defaultDir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Ezrite/notes/autosave")
    /// 지금 저장 위치. 설정에서 바꾸면 AppState 가 고친다 (테스트는 임시 폴더로 바꾼다)
    static var dir = defaultDir
    static let keepDays = 30.0

    struct Session: Identifiable, Hashable {
        let url: URL
        let date: Date
        var id: URL { url }
        var title: String { Notes.title(of: url) }
        var audio: URL? { Notes.audioURL(url) }
    }

    /// 녹음 원본은 받아쓰기 파일과 같은 이름의 .m4a 다
    static func audioURL(_ txt: URL) -> URL? {
        let u = txt.deletingPathExtension().appendingPathExtension("m4a")
        return FileManager.default.fileExists(atPath: u.path) ? u : nil
    }

    /// 기록에 딸린 파일과 그 꼬리: 소리(.m4a), 설명(.explain.json), 설명 스크린샷(.explain-3.jpg).
    /// 이름이 "기록이름." 으로 시작하는 파일이다. 이름 바꾸기·지우기·내보내기·자동 삭제에 함께 따라간다
    static func companions(_ txt: URL) -> [(url: URL, suffix: String)] {
        let base = txt.deletingPathExtension().lastPathComponent + "."
        let dir = txt.deletingLastPathComponent()
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        return names.filter { $0.hasPrefix(base) && $0 != txt.lastPathComponent }
            .map { (dir.appendingPathComponent($0), String($0.dropFirst(base.count - 1))) }
    }

    /// 파일 이름 = "시작시각[_n][ 이름].txt". 이름이 따로 저장되지 않아 파일만 옮겨도 함께 간다
    static func title(of url: URL) -> String {
        var rest = url.deletingPathExtension().lastPathComponent.dropFirst(19)
        if rest.first == "_" { rest = rest.drop { $0 == "_" || $0.isNumber } }
        return rest.trimmingCharacters(in: .whitespaces)
    }

    /// 기록 하나가 자기 이름의 폴더에 들어 있나 (저장 폴더/기록이름/기록이름.txt). 예전 기록은 저장 폴더에 바로 있다
    static func isFoldered(_ txt: URL) -> Bool {
        txt.deletingLastPathComponent().lastPathComponent == txt.deletingPathExtension().lastPathComponent
    }

    /// 휴지통으로 보낼 것: 폴더 기록이면 폴더째, 예전 기록이면 글과 딸린 파일
    static func trashTargets(_ txt: URL) -> [URL] {
        isFoldered(txt) ? [txt.deletingLastPathComponent()] : companions(txt).map(\.url) + [txt]
    }

    /// 이름을 바꾸고(빈 문자열이면 이름 없앰) 새 경로를 돌려준다. 소리 파일도 같이 옮긴다.
    /// 폴더 기록이면 폴더 이름도 같이 바꾼다
    static func rename(_ url: URL, to title: String) throws -> URL {
        let name = url.deletingPathExtension().lastPathComponent
        var base = String(name.prefix(19))
        let tail = name.dropFirst(19)
        if tail.first == "_" { base += String(tail.prefix { $0 == "_" || $0.isNumber }) }
        let clean = title.components(separatedBy: CharacterSet(charactersIn: "/:\n")).joined(separator: " ")
            .trimmingCharacters(in: .whitespaces)
        let newName = clean.isEmpty ? base : "\(base) \(clean)"
        if isFoldered(url) {
            let folder = url.deletingLastPathComponent()
            let newFolder = folder.deletingLastPathComponent().appendingPathComponent(newName)
            guard newFolder != folder else { return url }
            try FileManager.default.moveItem(at: folder, to: newFolder)
            return try rename(inPlace: newFolder.appendingPathComponent(url.lastPathComponent), to: newName)
        }
        return try rename(inPlace: url, to: newName)
    }

    /// 같은 폴더 안에서 글과 딸린 파일의 이름만 바꾼다
    private static func rename(inPlace url: URL, to newName: String) throws -> URL {
        let dest = url.deletingLastPathComponent().appendingPathComponent(newName).appendingPathExtension("txt")
        guard dest != url else { return url }
        let others = companions(url)
        try FileManager.default.moveItem(at: url, to: dest)
        let newBase = dest.deletingPathExtension().lastPathComponent
        for c in others {
            try? FileManager.default.moveItem(at: c.url, to: dest.deletingLastPathComponent()
                .appendingPathComponent(newBase + c.suffix))
        }
        return dest
    }

    /// 받아쓰기와 딸린 파일(소리, 설명)을 함께 휴지통으로 보낸다 (실수로 지워도 되살릴 수 있게)
    /// 받아쓰기와 딸린 파일(소리, 설명)을 함께 휴지통으로 보낸다 (실수로 지워도 되살릴 수 있게).
    /// iCloud 폴더는 앱이 직접 휴지통으로 옮기는 것을 macOS 가 막는다(권한 오류 513). 그럴 땐 Finder 에게 맡긴다
    /// — 처음 한 번 "Finder 제어" 허락을 묻는다. 끝나면 실패 이유(없으면 nil)를 알린다
    static func delete(_ url: URL, done: @escaping (String?) -> Void) {
        let files = trashTargets(url)
        NSWorkspace.shared.recycle(files) { _, error in
            DispatchQueue.main.async {
                guard error != nil else { return done(nil) }
                let left = files.filter { FileManager.default.fileExists(atPath: $0.path) }
                done(finderTrash(left))
            }
        }
    }

    /// AppleScript 문자열 리터럴. 역슬래시를 먼저 바꿔야 따옴표 이스케이프가 깨지지 않는다
    static func appleScriptString(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    /// Finder 로 휴지통에 옮긴다. 실패하면 이유
    static func finderTrash(_ files: [URL]) -> String? {
        guard !files.isEmpty else { return nil }
        let list = files.map { "POSIX file \(appleScriptString($0.path))" }.joined(separator: ", ")
        var err: NSDictionary?
        NSAppleScript(source: "tell application \"Finder\" to delete {\(list)}")?.executeAndReturnError(&err)
        guard let err else { return nil }
        if (err[NSAppleScript.errorNumber] as? Int) == -1743 {
            return "Ezrite 가 Finder 를 제어하도록 허용해 주세요: 시스템 설정 → 개인정보 보호 및 보안 → 자동화 → Ezrite → Finder"
        }
        return err[NSAppleScript.errorMessage] as? String ?? "\(err)"
    }

    /// 녹음 원본을 AAC 로 남긴다. 16kHz 모노 32kbps — 한 시간에 약 14MB.
    /// m4a 는 닫을 때 마무리되므로, 녹음 중에는 partSeconds 마다 조각 파일(기록이름.part-001.m4a …)로 나눠 쓴다.
    /// 다 찬 조각은 바로 마무리돼서 앱이 죽어도 마지막 조각 안쪽만 잃는다. 정지하면 하나로 합친다
    final class AudioRecorder {
        private var file: AVAudioFile?
        private let lock = NSLock()
        private var written = 0
        private var partWritten = 0
        private var parts: [URL] = []
        private let url: URL
        private let partSamples: Int

        static let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 32000,
        ]

        /// 지금까지 쓴 길이(초). 다음 파이프라인이 시각을 이어 붙이는 기준
        var seconds: Double { lock.lock(); defer { lock.unlock() }; return Double(written) / sampleRate }

        /// url: 합쳐질 최종 파일 (기록이름.m4a)
        init?(url: URL, partSeconds: Double = 60) {
            self.url = url
            partSamples = Int(partSeconds * sampleRate)
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            guard openPart() else { return nil }
        }

        private func openPart() -> Bool {
            let part = Notes.partURL(url, parts.count + 1)
            guard let f = try? AVAudioFile(forWriting: part, settings: Self.settings,
                                           commonFormat: .pcmFormatFloat32, interleaved: false) else { return false }
            file = f
            parts.append(part)
            partWritten = 0
            return true
        }

        func write(_ samples: [Float]) {
            lock.lock(); defer { lock.unlock() }
            var rest = samples[...]
            while !rest.isEmpty, file != nil {
                if partWritten >= partSamples {
                    file = nil                                   // 다 찬 조각을 마무리한다
                    guard openPart() else { return }
                }
                let n = min(rest.count, partSamples - partWritten)
                guard let file, let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat,
                                                           frameCapacity: AVAudioFrameCount(n)) else { return }
                buf.frameLength = AVAudioFrameCount(n)
                rest.prefix(n).withUnsafeBufferPointer { buf.floatChannelData![0].update(from: $0.baseAddress!, count: n) }
                if (try? file.write(from: buf)) != nil { written += n; partWritten += n }
                rest = rest.dropFirst(n)
            }
        }

        /// 합치기는 다시 인코딩이라 2시간이면 10초쯤 걸린다. 정지할 때 화면이 멈추지 않게 뒤에서 한다
        static let mergeQueue = DispatchQueue(label: "audio.merge")

        /// 마지막 조각을 마무리하고, 뒤에서 조각들을 기록이름.m4a 하나로 합친다.
        /// 합치는 도중에 앱이 꺼져도 조각은 남아 있어 다음 실행 때 recoverParts 가 합친다
        func close() {
            lock.lock(); defer { lock.unlock() }
            guard file != nil || !parts.isEmpty else { return }
            file = nil
            let parts = self.parts, url = self.url
            self.parts = []
            Self.mergeQueue.async { Notes.mergeAndClean(parts, into: url) }
        }

        /// 뒤에서 하는 합치기가 끝날 때까지 기다린다 (테스트용)
        static func waitForMerges() { mergeQueue.sync {} }
    }

    /// 합친 뒤에만 조각을 지운다. 합친 파일은 임시 이름으로 만든 뒤 옮겨서, 도중에 꺼져도 반쯤 된 파일이 남지 않는다
    static func mergeAndClean(_ parts: [URL], into dest: URL) {
        let tmp = dest.deletingLastPathComponent().appendingPathComponent(".merging-" + dest.lastPathComponent)
        do {
            try merge(parts, into: tmp)
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.moveItem(at: tmp, to: dest)
            for p in parts { try? FileManager.default.removeItem(at: p) }
        } catch {
            try? FileManager.default.removeItem(at: tmp)
        }
    }

    static func partURL(_ audio: URL, _ n: Int) -> URL {
        audio.deletingPathExtension().appendingPathExtension(String(format: "part-%03d.m4a", n))
    }

    /// 조각들을 이어 붙여 하나로 다시 인코딩한다 (그대로 이어 붙이는 passthrough 는 macOS 가 거부한다).
    /// 읽을 수 없는 조각(마무리 못 한 것)은 건너뛴다. 이음매에 빈 소리가 끼지 않아 길이가 정확히 맞는다
    static func merge(_ parts: [URL], into dest: URL) throws {
        let comp = AVMutableComposition()
        guard let track = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
        else { throw CocoaError(.fileWriteUnknown) }
        var cursor = CMTime.zero
        for p in parts {
            let asset = AVURLAsset(url: p)
            guard let src = asset.tracks(withMediaType: .audio).first, asset.duration.seconds > 0 else { continue }
            try track.insertTimeRange(CMTimeRange(start: .zero, duration: asset.duration), of: src, at: cursor)
            cursor = cursor + asset.duration
        }
        guard cursor > .zero, let export = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetAppleM4A)
        else { throw CocoaError(.fileReadCorruptFile) }
        try? FileManager.default.removeItem(at: dest)
        export.outputURL = dest
        export.outputFileType = .m4a
        let done = DispatchSemaphore(value: 0)
        export.exportAsynchronously { done.signal() }
        done.wait()
        if export.status != .completed { throw export.error ?? CocoaError(.fileWriteUnknown) }
    }

    /// 앱이 죽어 남은 조각을 합친다 (실행할 때 prune 이 부른다)
    static func recoverParts(in dir: URL = dir) {
        for sub in subfolders(dir) { recoverParts(inFolder: sub) }
        recoverParts(inFolder: dir)
    }

    private static func recoverParts(inFolder dir: URL) {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        let groups = Dictionary(grouping: names.filter { $0.range(of: #"\.part-\d{3}\.m4a$"#, options: .regularExpression) != nil }) {
            String($0[..<$0.range(of: ".part-")!.lowerBound])
        }
        for (base, files) in groups {
            let parts = files.sorted().map { dir.appendingPathComponent($0) }
            let dest = dir.appendingPathComponent(base + ".m4a")
            guard !FileManager.default.fileExists(atPath: dest.path) else { continue }
            mergeAndClean(parts, into: dest)
        }
    }

    /// 받아 적은 줄을 그때그때 파일에 흘려 둔다. 앱이 죽어도 남도록 줄마다 디스크까지 내린다.
    final class Writer {
        /// 이름은 시작할 때 정해 둔다. 녹음 원본이 같은 이름(.m4a)을 쓴다
        let planned: URL = Notes.newURL()
        private(set) var url: URL?

        func append(_ line: String) {
            do {
                let u = try url ?? create()
                url = u
                let h = try FileHandle(forWritingTo: u)
                defer { try? h.close() }
                try h.seekToEnd()
                try h.write(contentsOf: Data((line + "\n").utf8))
                try h.synchronize()
            } catch {
                // 자동 저장이 실패해도 받아쓰기는 계속돼야 한다
            }
        }

        /// 번역이 붙으면 원문 바로 아래에 넣어야 해서 파일 전체를 다시 쓴다
        func rewrite(_ entries: [Entry]) {
            guard let url else { return }
            try? Data((Notes.render(entries) + "\n").utf8).write(to: url, options: .atomic)
        }

        private func create() throws -> URL {
            try FileManager.default.createDirectory(at: planned.deletingLastPathComponent(), withIntermediateDirectories: true)
            FileManager.default.createFile(atPath: planned.path, contents: nil)
            return planned
        }
    }

    static func newURL(in dir: URL = dir) -> URL {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd_HH-mm-ss"
        let base = f.string(from: Date())
        // 저장 폴더/기록이름/기록이름.txt. 폴더는 처음 쓸 때 만든다 (예전처럼 바로 놓인 같은 이름도 피한다)
        let taken = { (name: String) in
            [dir.appendingPathComponent(name), dir.appendingPathComponent(name + ".txt"), dir.appendingPathComponent(name + ".m4a")]
                .contains { FileManager.default.fileExists(atPath: $0.path) }
        }
        var name = base, n = 2
        while taken(name) { name = "\(base)_\(n)"; n += 1 }
        return dir.appendingPathComponent(name).appendingPathComponent(name + ".txt")
    }

    /// 파일 형식 그대로의 글: 원문 / 네 칸 들여쓴 번역 / 끊김 표시
    static func render(_ entries: [Entry]) -> String {
        entries.map { e in
            e.translation.map { "\(e.original)\n    \($0)" } ?? e.original
        }.joined(separator: "\n")
    }

    /// 이 앱이 만든 기록만 고른다 — 이름이 시작 시각으로 시작하는 .txt. 저장 위치가 수업 폴더여도 다른 노트는 섞이지 않는다
    static func sessions(in dir: URL = dir) -> [Session] {
        let urls = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        let foldered = subfolders(dir).map { $0.appendingPathComponent($0.lastPathComponent + ".txt") }
            .filter { FileManager.default.fileExists(atPath: $0.path) }
        return (urls.filter { $0.pathExtension == "txt" } + foldered)
            .compactMap { u in startedAt(u).map { Session(url: u, date: $0) } }
            .sorted { $0.date > $1.date }
    }

    /// 이 앱이 만든 기록 폴더 (이름이 시작 시각으로 시작하는 폴더)
    static func subfolders(_ dir: URL) -> [URL] {
        let urls = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.isDirectoryKey])) ?? []
        return urls.filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true && startedAt($0) != nil }
    }

    /// 이름 앞 19자가 "yyyy-MM-dd_HH-mm-ss" 면 그 시각, 아니면 이 앱 파일이 아니다
    static func startedAt(_ url: URL) -> Date? {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd_HH-mm-ss"
        return f.date(from: String(url.deletingPathExtension().lastPathComponent.prefix(19)))
    }

    /// 파일 이름이 시작 시각이다. 못 읽으면 수정 시각을 쓴다.
    static func startDate(of url: URL) -> Date {
        if let d = startedAt(url) { return d }
        let attrs = try? url.resourceValues(forKeys: [.contentModificationDateKey])
        return attrs?.contentModificationDate ?? .distantPast
    }

    /// 글 줄마다의 녹음 위치 [시작, 끝] (끊김 표시 줄은 빼고 글 줄 순서대로). 기록 옆 .times.json 에 둔다
    static func timesURL(_ txt: URL) -> URL {
        txt.deletingPathExtension().appendingPathExtension("times.json")
    }

    static func saveTimes(_ times: [[Double]], for txt: URL) {
        try? JSONSerialization.data(withJSONObject: times).write(to: timesURL(txt), options: .atomic)
    }

    static func loadTimes(_ txt: URL) -> [[Double]] {
        guard let data = try? Data(contentsOf: timesURL(txt)) else { return [] }
        return (try? JSONSerialization.jsonObject(with: data) as? [[Double]]) ?? []
    }

    static func load(_ url: URL) -> [Entry] {
        var entries = parse(url)
        var times = loadTimes(url).makeIterator()
        for i in entries.indices where entries[i].kind == .text {
            guard let t = times.next() else { break }
            if t.count == 2, t[0] <= t[1] { entries[i].time = t[0]...t[1] }
        }
        return entries
    }

    private static func parse(_ url: URL) -> [Entry] {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        var out: [Entry] = []
        for raw in text.split(separator: "\n", omittingEmptySubsequences: true) {
            let line = String(raw)
            if line.hasPrefix("    "), !out.isEmpty, out[out.count - 1].kind == .text {
                let t = line.trimmingCharacters(in: .whitespaces)
                let prev = out[out.count - 1].translation
                out[out.count - 1].translation = prev.map { $0 + " " + t } ?? t
            } else if line.hasPrefix("── ") {
                out.append(Entry(kind: .gap, original: line))
            } else {
                out.append(Entry(original: line.trimmingCharacters(in: .whitespaces)))
            }
        }
        return out
    }

    /// 받아 적은 글 없이 소리만 남은 파일을 지운다. autoDelete 면(기본 위치) 30일 지난 기록도 지운다.
    /// 사용자가 고른 폴더에서는 기록을 지우지 않는다. 어느 쪽이든 이 앱 이름 형식이 아닌 파일은 건드리지 않는다
    static func prune(in dir: URL = dir, autoDelete: Bool? = nil) {
        let autoDelete = autoDelete ?? (dir.standardizedFileURL.path == defaultDir.standardizedFileURL.path)
        recoverParts(in: dir)
        // 글 없이 소리만 남은 기록 폴더는 폴더째 지운다
        for sub in subfolders(dir) where !FileManager.default.fileExists(atPath: sub.appendingPathComponent(sub.lastPathComponent + ".txt").path) {
            let names = (try? FileManager.default.contentsOfDirectory(atPath: sub.path)) ?? []
            if names.allSatisfy({ $0.hasSuffix(".m4a") || $0 == ".DS_Store" }) { try? FileManager.default.removeItem(at: sub) }
        }
        let all = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        for a in all where a.pathExtension == "m4a" && startedAt(a) != nil && !a.lastPathComponent.contains(".part-") {
            let txt = a.deletingPathExtension().appendingPathExtension("txt")
            if !FileManager.default.fileExists(atPath: txt.path) { try? FileManager.default.removeItem(at: a) }
        }
        guard autoDelete else { return }
        let cutoff = Date().addingTimeInterval(-keepDays * 86400)
        for s in sessions(in: dir) where s.date < cutoff {
            for t in trashTargets(s.url) { try? FileManager.default.removeItem(at: t) }
        }
    }

    /// 글과 딸린 파일(소리, 설명)을 다른 폴더로 복사한다. 같은 이름이 있으면 덮어쓰지 않고 " 2", " 3"을 붙인다
    static func export(_ txt: URL, to folder: URL) throws -> [URL] {
        if isFoldered(txt) {
            // 폴더 기록은 폴더째 복사한다
            let src = txt.deletingLastPathComponent(), base = src.lastPathComponent
            var dest = folder.appendingPathComponent(base), n = 2
            while FileManager.default.fileExists(atPath: dest.path) { dest = folder.appendingPathComponent("\(base) \(n)"); n += 1 }
            try FileManager.default.copyItem(at: src, to: dest)
            return [dest]
        }
        let sources = [(url: txt, suffix: ".txt")] + companions(txt)
        let base = txt.deletingPathExtension().lastPathComponent
        var name = base
        var n = 2
        while sources.contains(where: { FileManager.default.fileExists(
            atPath: folder.appendingPathComponent(name + $0.suffix).path) }) {
            name = "\(base) \(n)"
            n += 1
        }
        return try sources.map { src in
            let dest = folder.appendingPathComponent(name + src.suffix)
            try FileManager.default.copyItem(at: src.url, to: dest)
            return dest
        }
    }

    /// Whisper 가 같은 구절을 반복 생성하는 환각을 잘라낸다 (KMP 로 주기 검출).
    static func sanitize(_ text: String) -> String {
        let words = text.split(separator: " ").map(String.init)
        let n = words.count
        guard n >= 4 else { return text.trimmingCharacters(in: .whitespaces) }
        let norm = words.map { $0.filter { $0.isLetter || $0.isNumber }.lowercased() }
        var f = [Int](repeating: 0, count: n)
        var k = 0
        for i in 1..<n {
            while k > 0 && norm[k] != norm[i] { k = f[k - 1] }
            if norm[k] == norm[i] { k += 1 }
            f[i] = k
        }
        let period = n - f[n - 1]
        if period < n && n % period == 0 && n / period >= 3 {
            var s = words[..<period].joined(separator: " ")
            while s.hasSuffix(",") { s.removeLast() }
            return s.trimmingCharacters(in: .whitespaces)
        }
        return text.trimmingCharacters(in: .whitespaces)
    }

    static func timestamp() -> String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f.string(from: Date())
    }
}
