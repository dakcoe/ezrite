import AppKit

/// 설치 DMG 정리. 열린 DMG 안의 앱도 Launchpad·Spotlight 에 보여서 Ezrite 가 둘로 보인다
enum Installer {
    /// DMG 는 읽기 전용으로 붙는다. 같은 이름의 외장 디스크는 건드리지 않는다
    static func isInstallerVolume(name: String, hasApp: Bool, readOnly: Bool) -> Bool {
        name.hasPrefix("Ezrite ") && hasApp && readOnly
    }

    /// DMG 안에서 켰거나, macOS 가 격리 실행(AppTranslocation)으로 옮겨 켠 경우
    static func runsFromInstaller(_ bundlePath: String, readOnly: Bool) -> Bool {
        bundlePath.contains("/AppTranslocation/") || (bundlePath.hasPrefix("/Volumes/") && readOnly)
    }

    static func isReadOnly(_ url: URL) -> Bool {
        (try? url.resourceValues(forKeys: [.volumeIsReadOnlyKey]))?.volumeIsReadOnly ?? false
    }

    /// 켤 때 한 번: DMG 안에서 켰으면 옮기라고 알리고, 설치된 앱이면 남아 있는 설치 DMG 를 꺼낸다
    static func tidy() {
        if runsFromInstaller(Bundle.main.bundlePath, readOnly: isReadOnly(Bundle.main.bundleURL)) {
            let alert = NSAlert()
            alert.messageText = "Applications 폴더로 옮겨서 쓰세요"
            alert.informativeText = "지금은 설치 DMG 나 내려받은 폴더에서 바로 켜졌습니다. 창에서 Ezrite 를 Applications 로 끌어다 놓은 뒤, 그쪽에서 다시 열어 주세요. 여기서 쓰면 설정과 권한이 남지 않습니다."
            alert.addButton(withTitle: "확인")
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
            return
        }
        let fm = FileManager.default
        for url in fm.mountedVolumeURLs(includingResourceValuesForKeys: nil, options: [.skipHiddenVolumes]) ?? [] {
            let hasApp = fm.fileExists(atPath: url.appendingPathComponent("Ezrite.app").path)
            guard isInstallerVolume(name: url.lastPathComponent, hasApp: hasApp, readOnly: isReadOnly(url)) else { continue }
            DispatchQueue.global().async { try? NSWorkspace.shared.unmountAndEjectDevice(at: url) }
        }
    }
}
