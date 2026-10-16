import Foundation
import Testing
@testable import Ezrite

/// 저장 폴더를 사용자가 고른 곳(수업 폴더 등)으로 바꿨을 때 그 폴더의 다른 파일을 건드리지 않는지, 내보내기가 되는지
struct StorageTests {
    static func tempDir() throws -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("storage-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    @discardableResult
    static func file(_ dir: URL, _ name: String, daysOld: Double = 0) -> URL {
        let u = dir.appendingPathComponent(name)
        FileManager.default.createFile(atPath: u.path, contents: Data("내용\n".utf8))
        let date = Date().addingTimeInterval(-daysOld * 86400)
        try? FileManager.default.setAttributes([.modificationDate: date], ofItemAtPath: u.path)
        return u
    }

    @Test func 기록_목록에는_이_앱이_만든_파일만_나온다() throws {
        let d = try Self.tempDir()
        Self.file(d, "2026-10-14_21-13-43.txt")
        Self.file(d, "2026-10-14_21-23-07 1주차 수업.txt")
        Self.file(d, "6주차 정리.txt")                       // 사용자가 직접 만든 노트
        let names = Notes.sessions(in: d).map(\.url.lastPathComponent).sorted()
        #expect(names == ["2026-10-14_21-13-43.txt", "2026-10-14_21-23-07 1주차 수업.txt"])
    }

    @Test func 사용자가_고른_폴더에서는_오래된_기록도_지우지_않는다() throws {
        let d = try Self.tempDir()
        let old = Self.file(d, "2025-01-01_10-00-00.txt", daysOld: 400)
        let mine = Self.file(d, "6주차 정리.txt", daysOld: 400)
        Notes.prune(in: d, autoDelete: false)
        #expect(FileManager.default.fileExists(atPath: old.path))
        #expect(FileManager.default.fileExists(atPath: mine.path))
    }

    @Test func 기본_폴더에서는_30일_지난_기록만_지우고_다른_파일은_남긴다() throws {
        let d = try Self.tempDir()
        let old = Self.file(d, "2025-01-01_10-00-00.txt", daysOld: 400)
        let oldAudio = Self.file(d, "2025-01-01_10-00-00.m4a", daysOld: 400)
        let recent = Self.file(d, Notes.newURL(in: d).lastPathComponent)
        let mine = Self.file(d, "메모.txt", daysOld: 400)
        Notes.prune(in: d, autoDelete: true)
        #expect(!FileManager.default.fileExists(atPath: old.path))
        #expect(!FileManager.default.fileExists(atPath: oldAudio.path))
        #expect(FileManager.default.fileExists(atPath: recent.path))
        #expect(FileManager.default.fileExists(atPath: mine.path))
    }

    @Test func 내보내면_글과_소리를_고른_폴더로_복사하고_원본은_남는다() throws {
        let src = try Self.tempDir(), dest = try Self.tempDir()
        let txt = Self.file(src, "2026-10-14_21-23-07 테스트.txt")
        Self.file(src, "2026-10-14_21-23-07 테스트.m4a")
        let out = try Notes.export(txt, to: dest)
        #expect(out.map(\.lastPathComponent).sorted() == ["2026-10-14_21-23-07 테스트.m4a", "2026-10-14_21-23-07 테스트.txt"])
        #expect(FileManager.default.fileExists(atPath: txt.path))

        // 같은 이름이 이미 있으면 덮어쓰지 않고 번호를 붙인다
        let again = try Notes.export(txt, to: dest)
        #expect(again.map(\.lastPathComponent).sorted() == ["2026-10-14_21-23-07 테스트 2.m4a", "2026-10-14_21-23-07 테스트 2.txt"])
    }

    @Test func 휴지통_명령의_파일_경로는_따옴표와_역슬래시가_있어도_그대로_전달된다() throws {
        let path = #"/tmp/a\b "c" \" & quit.txt"#
        var err: NSDictionary?
        let back = NSAppleScript(source: "return \(Notes.appleScriptString(path))")?.executeAndReturnError(&err)
        #expect(err == nil)
        #expect(back?.stringValue == path)
    }
}
