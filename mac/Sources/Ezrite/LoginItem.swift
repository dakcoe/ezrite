import Foundation
import ServiceManagement

/// 로그인할 때 자동 실행 (macOS 13 SMAppService). 기본은 꺼짐, 설정에서 켠다.
/// 켜짐 여부는 따로 저장하지 않는다. 사용자가 시스템 설정에서 끌 수도 있어서 늘 시스템 상태를 읽는다
enum LoginItem {
    struct View: Equatable {
        var isOn: Bool
        var note: String?
    }

    static func view(_ status: SMAppService.Status) -> View {
        switch status {
        case .enabled: return View(isOn: true, note: nil)
        case .requiresApproval: return View(isOn: true, note: "시스템 설정 → 일반 → 로그인 항목에서 Ezrite 를 허용해야 켜집니다.")
        default: return View(isOn: false, note: nil)
        }
    }

    static var current: View { view(SMAppService.mainApp.status) }

    /// 바꾼 뒤의 상태. 허용이 필요하면 시스템 설정의 로그인 항목을 연다
    static func set(_ on: Bool) -> View {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            NSLog("Ezrite login item: \(error)")
        }
        let v = current
        if on && SMAppService.mainApp.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
        return v
    }
}
