//! 테두리 없는 창의 모서리를 Windows 11 방식으로 둥글게 한다 (DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND).
//! Electron의 roundedCorners 옵션은 macOS 전용이라 Windows에서는 여기서 직접 켠다.
//! Windows 10에는 이 속성이 없어 오류가 나지만, 모서리가 각질 뿐이니 앱 쪽에서는 무시한다.

use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND};

pub fn round_corners(hwnd: u64) -> windows::core::Result<()> {
    let pref = DWMWCP_ROUND;
    // SAFETY: hwnd는 Electron getNativeWindowHandle()이 준 같은 사용자 세션의 최상위 창이다.
    // 잘못된 핸들이면 DWM이 오류를 돌려줄 뿐 메모리를 건드리지 않는다. pref는 이 호출 동안 살아 있다.
    unsafe {
        DwmSetWindowAttribute(
            HWND(hwnd as usize as *mut core::ffi::c_void),
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &pref as *const _ as *const core::ffi::c_void,
            std::mem::size_of_val(&pref) as u32,
        )
    }
}
