//! 화면 나누기(1.2.1, 맥 Dock.swift WindowDock): 보이는 최상위 창 목록(`windows`)과 창 자리·크기 바꾸기(`place`).
//! 프로세스를 Per-Monitor V2 DPI 인식으로 켜서 좌표를 물리 픽셀로 주고받는다 (앱은 screen.dipToScreenRect 로 맞춘다).
//! 옮길 때 포커스·겹침 순서는 건드리지 않고 자리·크기만 바꾼다 — 되돌릴 때 원래 사각형을 그대로 주면 원래대로 온다.
//! 최대화한 창은 먼저 최대화를 풀고(활성화 없이) 줄이며, 되돌릴 때 원래 배치(보통 크기 자리 + 최대화)로 돌린다.
//! 활성화 없이 최대화하는 방법은 없어서, 되돌릴 때 그 창이 앞으로 온다 (앱이 뒤 창부터 보낸다).

use crate::dock::{parse_places, shell_class, Listing, Win};
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT, TRUE};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetForegroundWindow, GetWindow, GetWindowLongW, GetWindowPlacement, GetWindowRect,
    GetWindowTextLengthW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, IsZoomed, SetWindowPlacement, SetWindowPos,
    ShowWindowAsync, GWL_EXSTYLE, GW_OWNER, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER,
    SW_SHOWMAXIMIZED, SW_SHOWNOACTIVATE, WINDOWPLACEMENT, WPF_ASYNCWINDOWPLACEMENT, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
};

fn dpi_aware() {
    // SAFETY: 프로세스 전역 설정을 한 번 바꿀 뿐이다. 이미 정해져 있으면 오류를 돌려주고 그대로 둔다
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

fn hwnd(h: u64) -> HWND {
    HWND(h as usize as *mut core::ffi::c_void)
}

fn handle(h: HWND) -> u64 {
    h.0 as usize as u64
}

/// 작업 전환(Alt+Tab)에 나오는 창과 거의 같은 기준: 보이고, 최소화·숨김(cloaked) 아님, 도구 창 아님,
/// 주인 창이 있으면 APPWINDOW 일 때만, 제목 있음, 셸 창 아님, 크기 있음
fn describe(h: HWND) -> Option<Win> {
    // SAFETY: EnumWindows 가 준 최상위 창 핸들. 그 사이 창이 닫혀도 아래 함수들은 실패를 돌려줄 뿐이다.
    // 버퍼(class·cloaked·rect·pid)는 이 함수 안에서 살아 있고 크기를 함께 넘긴다
    unsafe {
        if !IsWindowVisible(h).as_bool() || IsIconic(h).as_bool() {
            return None;
        }
        let ex = GetWindowLongW(h, GWL_EXSTYLE) as u32;
        if ex & WS_EX_TOOLWINDOW.0 != 0 {
            return None;
        }
        if GetWindow(h, GW_OWNER).is_ok_and(|o| !o.is_invalid()) && ex & WS_EX_APPWINDOW.0 == 0 {
            return None;
        }
        let mut cloaked = 0u32;
        if DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut _, 4).is_ok() && cloaked != 0 {
            return None;
        }
        if GetWindowTextLengthW(h) == 0 {
            return None;
        }
        let mut buf = [0u16; 128];
        let n = GetClassNameW(h, &mut buf).max(0) as usize;
        if shell_class(&String::from_utf16_lossy(&buf[..n])) {
            return None;
        }
        let mut r = RECT::default();
        GetWindowRect(h, &mut r).ok()?;
        let (w, ht) = (r.right - r.left, r.bottom - r.top);
        if w <= 0 || ht <= 0 {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, Some(&mut pid));
        let max = IsZoomed(h).as_bool();
        let normal = if max { placement(h).map(|p| rect4(p.rcNormalPosition)) } else { None };
        Some(Win { hwnd: handle(h), pid, x: r.left, y: r.top, w, h: ht, max, normal })
    }
}

fn rect4(r: RECT) -> [i32; 4] {
    [r.left, r.top, r.right, r.bottom]
}

fn placement(h: HWND) -> Option<WINDOWPLACEMENT> {
    let mut p = WINDOWPLACEMENT { length: std::mem::size_of::<WINDOWPLACEMENT>() as u32, ..Default::default() };
    // SAFETY: p 는 length 를 채운 이 함수의 지역 변수. 닫힌 창이면 실패를 돌려줄 뿐이다
    unsafe { GetWindowPlacement(h, &mut p) }.ok()?;
    Some(p)
}

unsafe extern "system" fn collect(h: HWND, lparam: LPARAM) -> BOOL {
    // SAFETY: lparam 은 list_windows 의 Vec 을 가리키고, EnumWindows 가 끝날 때까지 살아 있다 (같은 스레드에서 차례로 부른다)
    let out = unsafe { &mut *(lparam.0 as *mut Vec<Win>) };
    if let Some(w) = describe(h) {
        out.push(w);
    }
    TRUE
}

/// 보이는 최상위 창을 맨 앞부터 JSON 한 줄로
pub fn list_windows() -> windows::core::Result<()> {
    dpi_aware();
    let mut out: Vec<Win> = Vec::new();
    // SAFETY: collect 는 위 규칙대로 out 만 건드린다. GetForegroundWindow 는 인자가 없다
    let foreground = unsafe {
        EnumWindows(Some(collect), LPARAM(&mut out as *mut Vec<Win> as isize))?;
        handle(GetForegroundWindow())
    };
    println!("{}", serde_json::to_string(&Listing { foreground, windows: out }).unwrap_or_default());
    Ok(())
}

/// 창들을 주어진 자리·크기로. 관리자 권한 창처럼 못 옮긴 창은 건너뛰고 {"moved":n,"failed":[hwnd…]} 를 쓴다.
/// SWP_ASYNCWINDOWPOS: 그 창의 프로그램이 멈춰 있어도 여기서 기다리지 않는다
pub fn place(json: &str) -> Result<(), String> {
    let list = parse_places(json)?;
    dpi_aware();
    let mut failed = Vec::new();
    for p in &list {
        let h = hwnd(p.hwnd);
        // SAFETY: 핸들은 직전에 `windows` 로 받은 최상위 창이다. 이미 닫혔으면 아래 함수들이 실패할 뿐이다.
        // 모두 비동기(…Async·ASYNC 깃발)로 보내 그 창의 프로그램이 멈춰 있어도 여기서 기다리지 않는다 (같은 창 메시지 차례대로 처리됨)
        let ok = unsafe {
            if let Some(n) = p.restore_max {
                match placement(h) {
                    Some(mut wp) => {
                        wp.rcNormalPosition = RECT { left: n[0], top: n[1], right: n[2], bottom: n[3] };
                        wp.showCmd = SW_SHOWMAXIMIZED.0 as u32;
                        wp.flags = WPF_ASYNCWINDOWPLACEMENT;
                        SetWindowPlacement(h, &wp).is_ok()
                    }
                    None => false,
                }
            } else {
                if p.unmax {
                    let _ = ShowWindowAsync(h, SW_SHOWNOACTIVATE);
                }
                SetWindowPos(h, None, p.x, p.y, p.w, p.h, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_ASYNCWINDOWPOS)
                    .is_ok()
            }
        };
        if !ok {
            failed.push(p.hwnd);
        }
    }
    println!("{}", serde_json::json!({ "moved": list.len() - failed.len(), "failed": failed }));
    Ok(())
}
