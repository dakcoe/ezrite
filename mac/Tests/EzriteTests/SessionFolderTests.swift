import Foundation
import Testing
@testable import Ezrite

/// 기록 하나 = 폴더 하나. 저장 폴더/기록이름/ 안에 글(.txt)·소리(.m4a)·시각(.times.json) 등이 함께 들어간다.
/// 예전처럼 저장 폴더에 바로 놓인 기록도 그대로 읽고 다룬다
struct SessionFolderTests {
    private func dir() throws -> URL { try StorageTests.tempDir() }
    private func make(_ folder: URL, _ base: String, files: [String] = [".txt", ".m4a", ".times.json"]) throws -> URL {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for f in files { FileManager.default.createFile(atPath: folder.appendingPathComponent(base + f).path, contents: Data("x\n".utf8)) }
        return folder.appendingPathComponent(base + ".txt")
    }

    @Test func 새_기록은_자기_이름의_폴더_안에_만든다() throws {
        let d = try dir()
        let u = Notes.newURL(in: d)
        let base = u.deletingPathExtension().lastPathComponent
        #expect(u.deletingLastPathComponent().lastPathComponent == base)
        #expect(u.deletingLastPathComponent().deletingLastPathComponent().standardizedFileURL == d.standardizedFileURL)
    }

    @Test func 같은_시각이면_폴더_이름에_번호를_붙인다() throws {
        let d = try dir()
        let first = Notes.newURL(in: d)
        _ = try make(first.deletingLastPathComponent(), first.deletingPathExtension().lastPathComponent)
        let second = Notes.newURL(in: d)
        #expect(second.deletingLastPathComponent() != first.deletingLastPathComponent())
        #expect(second.deletingPathExtension().lastPathComponent.hasSuffix("_2"))
    }

    @Test func 기록_목록에_폴더_기록과_예전_기록이_함께_나온다() throws {
        let d = try dir()
        _ = try make(d.appendingPathComponent("2026-10-18_09-00-00 1주차"), "2026-10-18_09-00-00 1주차")
        StorageTests.file(d, "2026-10-17_09-00-00.txt")
        try FileManager.default.createDirectory(at: d.appendingPathComponent("다른 폴더"), withIntermediateDirectories: true)
        let names = Notes.sessions(in: d).map(\.url.lastPathComponent)
        #expect(names == ["2026-10-18_09-00-00 1주차.txt", "2026-10-17_09-00-00.txt"])
    }

    @Test func 이름을_바꾸면_폴더와_안의_파일이_함께_바뀐다() throws {
        let d = try dir()
        let txt = try make(d.appendingPathComponent("2026-10-18_09-00-00"), "2026-10-18_09-00-00")
        let new = try Notes.rename(txt, to: "2주차 수업")
        #expect(new.path == d.appendingPathComponent("2026-10-18_09-00-00 2주차 수업/2026-10-18_09-00-00 2주차 수업.txt").path)
        for f in [".txt", ".m4a", ".times.json"] {
            #expect(FileManager.default.fileExists(atPath: new.deletingLastPathComponent().appendingPathComponent("2026-10-18_09-00-00 2주차 수업" + f).path))
        }
        #expect(!FileManager.default.fileExists(atPath: d.appendingPathComponent("2026-10-18_09-00-00").path))
    }

    @Test func 지울_때는_폴더째_보낸다() throws {
        let d = try dir()
        let txt = try make(d.appendingPathComponent("2026-10-18_09-00-00"), "2026-10-18_09-00-00")
        #expect(Notes.trashTargets(txt) == [txt.deletingLastPathComponent()])
        let flat = StorageTests.file(d, "2026-10-17_09-00-00.txt")
        #expect(Notes.trashTargets(flat) == [flat])
    }

    @Test func 오래된_폴더_기록은_폴더째_정리한다() throws {
        let d = try dir()
        let txt = try make(d.appendingPathComponent("2020-01-01_09-00-00"), "2020-01-01_09-00-00")
        Notes.prune(in: d, autoDelete: true)
        #expect(!FileManager.default.fileExists(atPath: txt.deletingLastPathComponent().path))
    }

    @Test func 글_없이_소리만_남은_폴더는_지운다() throws {
        let d = try dir()
        let folder = d.appendingPathComponent("2026-10-18_09-00-00")
        _ = try make(folder, "2026-10-18_09-00-00", files: [".m4a"])
        Notes.prune(in: d, autoDelete: false)
        #expect(!FileManager.default.fileExists(atPath: folder.path))
    }

    @Test func 내보내면_폴더째_복사한다() throws {
        let d = try dir(), dest = try dir()
        let txt = try make(d.appendingPathComponent("2026-10-18_09-00-00"), "2026-10-18_09-00-00")
        let out = try Notes.export(txt, to: dest)
        #expect(out.map(\.path) == [dest.appendingPathComponent("2026-10-18_09-00-00").path])
        #expect(FileManager.default.fileExists(atPath: dest.appendingPathComponent("2026-10-18_09-00-00/2026-10-18_09-00-00.m4a").path))
        let again = try Notes.export(txt, to: dest)
        #expect(again.map(\.path) == [dest.appendingPathComponent("2026-10-18_09-00-00 2").path])
    }
}
