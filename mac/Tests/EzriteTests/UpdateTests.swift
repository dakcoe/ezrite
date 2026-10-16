import Foundation
import Testing
@testable import Ezrite

/// 새 버전 알림: GitHub 최신 릴리스 번호를 앱 버전과 비교한다
struct UpdateTests {
    @Test func 버전_번호를_숫자로_비교한다() {
        #expect(Updater.isNewer("v2.1.0", than: "2.0.0"))
        #expect(Updater.isNewer("2.0.10", than: "2.0.9"))           // 문자 순서가 아니라 숫자 순서
        #expect(Updater.isNewer("v3", than: "2.9.9"))
        #expect(!Updater.isNewer("v2.0.0", than: "2.0.0"))
        #expect(!Updater.isNewer("1.9.0", than: "2.0.0"))
    }

    @Test func GitHub_최신_릴리스에서_번호·바뀐_점·DMG_주소를_읽는다() throws {
        let json = #"""
        {"tag_name":"v2.1.0","name":"Ezrite 2.1.0","html_url":"https://github.com/o/r/releases/tag/v2.1.0",
         "body":"- 설명 영상\r\n- 버그 수정","draft":false,"prerelease":false,
         "assets":[{"name":"notes.txt","browser_download_url":"https://github.com/o/r/releases/download/v2.1.0/notes.txt"},
                   {"name":"Ezrite-2.1.0.dmg","browser_download_url":"https://github.com/o/r/releases/download/v2.1.0/Ezrite-2.1.0.dmg"}]}
        """#
        let r = try #require(Updater.release(from: Data(json.utf8)))
        #expect(r.version == "2.1.0")
        #expect(r.notes == "- 설명 영상\n- 버그 수정")
        #expect(r.download.absoluteString == "https://github.com/o/r/releases/download/v2.1.0/Ezrite-2.1.0.dmg")   // DMG 가 있으면 바로 받기
    }

    @Test func DMG가_없으면_릴리스_페이지로() throws {
        let json = #"{"tag_name":"v2.2","html_url":"https://github.com/o/r/releases/tag/v2.2","body":"","assets":[]}"#
        #expect(try #require(Updater.release(from: Data(json.utf8))).download.absoluteString == "https://github.com/o/r/releases/tag/v2.2")
    }

    @Test func GitHub_밖의_주소는_열지_않는다() throws {
        // DMG 주소가 GitHub 밖이면 릴리스 페이지로 대신한다
        let other = #"{"tag_name":"v2.3","html_url":"https://github.com/o/r/releases/tag/v2.3","body":"","assets":[{"name":"a.dmg","browser_download_url":"https://evil.example/a.dmg"}]}"#
        #expect(try #require(Updater.release(from: Data(other.utf8))).download.absoluteString == "https://github.com/o/r/releases/tag/v2.3")
        // 페이지 주소까지 믿을 수 없으면 알리지 않는다
        for page in ["http://github.com/o/r", "file:///Applications/Calculator.app", "https://github.com.evil.example/x"] {
            let json = #"{"tag_name":"v2.3","html_url":"\#(page)","body":"","assets":[]}"#
            #expect(Updater.release(from: Data(json.utf8)) == nil, "\(page)")
        }
    }

    @Test func 나중에는_이번에만_닫고_다음_확인_때_다시_알린다() {
        let u = Updater()
        #expect(u.shouldShow("0.9.1", current: "0.9.0"))
        u.snooze("0.9.1")
        #expect(!u.shouldShow("0.9.1", current: "0.9.0"))       // 지금은 닫는다
        u.newCheck()                                             // 앱을 다시 켜거나 6시간 뒤 다시 확인
        #expect(u.shouldShow("0.9.1", current: "0.9.0"))
        #expect(!u.shouldShow("0.9.0", current: "0.9.0"))       // 같은 버전은 알리지 않는다
    }
}
