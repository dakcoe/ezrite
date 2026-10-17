import Foundation
import ServiceManagement
import Testing
@testable import Ezrite

/// 로그인할 때 자동 실행. 켜짐 여부는 우리가 따로 저장하지 않고 시스템 상태를 그대로 보인다
struct LoginItemTests {
    @Test func 등록됐으면_켜짐으로_보인다() {
        #expect(LoginItem.view(.enabled) == .init(isOn: true, note: nil))
    }

    @Test func 허용을_기다리면_켜짐으로_두고_시스템_설정에서_허용하라고_알린다() {
        let v = LoginItem.view(.requiresApproval)
        #expect(v.isOn)
        #expect(v.note?.contains("로그인 항목") == true)
    }

    @Test func 등록_안_됐으면_꺼짐() {
        #expect(LoginItem.view(.notRegistered) == .init(isOn: false, note: nil))
        #expect(LoginItem.view(.notFound) == .init(isOn: false, note: nil))
    }
}
