import Foundation
import Testing
@testable import Ezrite

/// 설치 DMG 정리: 설치한 앱이 켜지면 열려 있던 Ezrite 설치 DMG 를 꺼낸다 (목록에 Ezrite 가 둘로 보이지 않게)
struct InstallerTests {
    @Test func Ezrite_설치_DMG_만_꺼낸다() {
        #expect(Installer.isInstallerVolume(name: "Ezrite 0.9.1", hasApp: true, readOnly: true))
        #expect(!Installer.isInstallerVolume(name: "Ezrite 0.9.1", hasApp: false, readOnly: true))
        #expect(!Installer.isInstallerVolume(name: "Cursor Installer", hasApp: true, readOnly: true))
        #expect(!Installer.isInstallerVolume(name: "Macintosh HD", hasApp: false, readOnly: false))
        // 이름이 같아도 쓰기 되는 디스크(외장 드라이브 등)는 꺼내지 않는다
        #expect(!Installer.isInstallerVolume(name: "Ezrite 백업", hasApp: true, readOnly: false))
    }

    @Test func DMG_안에서_켜졌는지_안다() {
        #expect(Installer.runsFromInstaller("/Volumes/Ezrite 0.9.1/Ezrite.app", readOnly: true))
        // macOS 가 격리 실행으로 옮긴 경우 (DMG·내려받기 폴더에서 바로 켰을 때)
        #expect(Installer.runsFromInstaller("/private/var/folders/x/T/AppTranslocation/1234/d/Ezrite.app", readOnly: true))
        #expect(!Installer.runsFromInstaller("/Applications/Ezrite.app", readOnly: false))
        // 외장 디스크에 설치해 쓰는 것은 괜찮다
        #expect(!Installer.runsFromInstaller("/Volumes/SSD/Applications/Ezrite.app", readOnly: false))
    }
}
