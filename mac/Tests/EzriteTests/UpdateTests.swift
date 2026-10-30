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

    @Test func zip_이_있으면_자동_교체용으로_쓴다() throws {
        let json = #"{"tag_name":"v2.4","html_url":"https://github.com/o/r/releases/tag/v2.4","body":"","assets":[{"name":"Ezrite-2.4.zip","browser_download_url":"https://github.com/o/r/releases/download/v2.4/Ezrite-2.4.zip"},{"name":"b.zip","browser_download_url":"https://evil.example/b.zip"}]}"#
        #expect(try #require(Updater.release(from: Data(json.utf8))).zip?.absoluteString == "https://github.com/o/r/releases/download/v2.4/Ezrite-2.4.zip")
        let evil = #"{"tag_name":"v2.4","html_url":"https://github.com/o/r/releases/tag/v2.4","body":"","assets":[{"name":"b.zip","browser_download_url":"https://evil.example/b.zip"}]}"#
        #expect(try #require(Updater.release(from: Data(evil.utf8))).zip == nil)
    }

    @Test func 서명이_다른_앱은_교체하지_않는다() {
        // 테스트 실행 파일은 앱 인증서로 서명되지 않았으니 어떤 앱도 통과하면 안 된다
        #expect(!Updater.sameSigner(URL(fileURLWithPath: "/System/Applications/Calculator.app")))
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

    @Test func 릴리스_글에서_맨_위_핵심_줄만_뽑고_Windows_줄은_뺀다() {
        let body = "- 배터리를 덜 씁니다\r\n- Windows 는 바뀐 것이 없습니다\n- 카드가 따라옵니다\n\n## 받기\n- macOS 13 이상"
        #expect(Updater.highlights(body) == ["배터리를 덜 씁니다", "카드가 따라옵니다"])
    }
}
