import AppKit
import Foundation
import os

/// 앱 기록: ~/Library/Logs/Ezrite/ezrite-날짜.log (14일 보관) + 시스템 로그(subsystem com.dakcoe.ezrite).
/// 나중에 사용자가 겪은 문제를 되짚을 수 있게 동작·시간·오류를 남긴다. 받아 적은 글·API 키는 남기지 않는다 (길이만)
enum Log {
    static let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Ezrite")
    static let keepDays = 14.0
    private static let q = DispatchQueue(label: "log.file")
    private static let system = Logger(subsystem: "com.dakcoe.ezrite", category: "app")
    nonisolated(unsafe) private static var handle: FileHandle?
    nonisolated(unsafe) private static var day = ""
    /// 앱으로 돌 때만 파일에 쓴다 (테스트 실행기는 번들 ID 가 다르다)
    nonisolated(unsafe) static var enabled = Bundle.main.bundleIdentifier == "com.dakcoe.ezrite" && ProcessInfo.processInfo.environment["EZRITE_NO_LOG"] == nil

    static func info(_ area: String, _ message: String) { write("INFO", area, message) }
    static func warn(_ area: String, _ message: String) { write("WARN", area, message) }
    static func error(_ area: String, _ message: String) { write("ERR ", area, message) }

    /// 걸린 시간을 재서 남긴다. 오래 걸린 것(slow 초 넘게)은 WARN
    @discardableResult
    static func timed<T>(_ area: String, _ what: String, slow: Double = 2, _ body: () throws -> T) rethrows -> T {
        let t0 = Date()
        defer {
            let dt = Date().timeIntervalSince(t0)
            write(dt > slow ? "WARN" : "INFO", area, String(format: "%@ %.2f초", what, dt))
        }
        return try body()
    }

    /// 종료 직전: 줄 서 있는 기록을 파일에 다 쓴다
    static func flush() { q.sync { try? handle?.synchronize() } }

    private static func write(_ level: String, _ area: String, _ message: String) {
        let thread = Thread.isMainThread ? "main" : "bg"
        system.log("[\(area, privacy: .public)] \(message, privacy: .public)")
        guard enabled else { return }
        let now = Date()
        q.async {
            let line = "\(stamp.string(from: now)) \(level) [\(area)] \(message) (\(thread))\n"
            fileHandle(for: now)?.write(Data(line.utf8))
        }
    }

    private static let stamp: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"; return f
    }()
    private static let dayFormat: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd"; return f
    }()

    /// 날이 바뀌면 새 파일
    private static func fileHandle(for date: Date) -> FileHandle? {
        let d = dayFormat.string(from: date)
        if d == day, let handle { return handle }
        try? handle?.close()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("ezrite-\(d).log")
        if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
        handle = try? FileHandle(forWritingTo: url)
        _ = try? handle?.seekToEnd()
        day = d
        return handle
    }

    /// 14일 지난 기록과 멈춤 기록을 지운다
    static func prune(now: Date = Date()) {
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        for f in files {
            let m = (try? f.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? now
            if now.timeIntervalSince(m) > keepDays * 86400 { try? FileManager.default.removeItem(at: f) }
        }
    }

    /// 앱을 켤 때 한 번: 버전·OS·하드웨어, 잠자기·깨기·화면 잠금 같은 시스템 사건도 남기기 시작한다
    static func start() {
        prune()
        let info = ProcessInfo.processInfo
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        Log.info("앱", "시작 Ezrite \(version) (\(build)) · macOS \(info.operatingSystemVersionString) · 메모리 \(info.physicalMemory / 1_073_741_824)GB · pid \(info.processIdentifier)")
        let ws = NSWorkspace.shared.notificationCenter
        for (name, text) in [(NSWorkspace.willSleepNotification, "Mac 잠자기"), (NSWorkspace.didWakeNotification, "Mac 깨어남"),
                             (NSWorkspace.screensDidSleepNotification, "화면 꺼짐"), (NSWorkspace.screensDidWakeNotification, "화면 켜짐"),
                             (NSWorkspace.sessionDidResignActiveNotification, "사용자 전환·잠금"),
                             (NSWorkspace.sessionDidBecomeActiveNotification, "사용자 돌아옴"),
                             (NSWorkspace.willPowerOffNotification, "Mac 끄기·로그아웃")] {
            ws.addObserver(forName: name, object: nil, queue: nil) { _ in Log.info("시스템", text) }
        }
        let dist = DistributedNotificationCenter.default()
        dist.addObserver(forName: .init("com.apple.screenIsLocked"), object: nil, queue: nil) { _ in Log.info("시스템", "화면 잠금") }
        dist.addObserver(forName: .init("com.apple.screenIsUnlocked"), object: nil, queue: nil) { _ in Log.info("시스템", "화면 잠금 풀림") }
        NotificationCenter.default.addObserver(forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: nil) { _ in
            Log.warn("시스템", "발열 상태 \(ProcessInfo.processInfo.thermalState.rawValue) (0 보통 ~ 3 심각)")
        }
        HangWatch.start()
    }
}

/// 메인 스레드(화면)가 멈추면 남긴다. 1초마다 메인에 신호를 보내 3초 넘게 답이 없으면 "멈춤 시작" 과 함께
/// 그 순간 모든 스레드가 무엇을 하는지 /usr/bin/sample 로 떠서 hang-시각.txt 에 둔다 (멈춤 한 번에 한 장). 풀리면 얼마나 멈췄는지 남긴다
enum HangWatch {
    static let threshold: TimeInterval = 3
    private static let q = DispatchQueue(label: "log.hang", qos: .utility)
    nonisolated(unsafe) private static var lastPong = Date()
    nonisolated(unsafe) private static var hangStart: Date?

    static func start() {
        guard Log.enabled else { return }
        let timer = DispatchSource.makeTimerSource(queue: q)
        timer.schedule(deadline: .now() + 5, repeating: 1)
        timer.setEventHandler { tick() }
        timer.resume()
        keep = timer
    }
    nonisolated(unsafe) private static var keep: DispatchSourceTimer?

    private static func tick() {
        let now = Date()
        let waited = now.timeIntervalSince(lastPong)
        if waited > threshold, hangStart == nil {
            hangStart = lastPong
            Log.warn("멈춤", String(format: "화면이 %.0f초째 응답 없음 — 스레드 상태를 뜹니다", waited))
            snapshot()
        }
        DispatchQueue.main.async {
            let back = Date()
            q.async {
                if let s = hangStart {
                    Log.warn("멈춤", String(format: "풀림 — %.1f초 동안 멈춰 있었음", back.timeIntervalSince(s)))
                    hangStart = nil
                }
                lastPong = back
            }
        }
    }

    /// 멈춘 순간의 스레드 상태 (2초 동안 표본). 사용자 권한으로 자기 프로세스는 뜰 수 있다
    private static func snapshot() {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd_HH-mm-ss"
        let out = Log.dir.appendingPathComponent("hang-\(f.string(from: Date())).txt")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/sample")
        p.arguments = [String(ProcessInfo.processInfo.processIdentifier), "2", "-file", out.path]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run(); Log.info("멈춤", "스레드 상태 → \(out.lastPathComponent)") }
        catch { Log.error("멈춤", "스레드 상태를 뜨지 못함: \(error.localizedDescription)") }
    }
}
