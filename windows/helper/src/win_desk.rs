//! 가상 데스크톱 지켜보기(1.2.2): `desktop-watch --hwnd a,b,c`.
//! 후보 창 가운데 데스크톱이 정해진 첫 창(작업 표시줄에 있는 보통 창)을 기준으로 삼고, 0.25초마다
//! IVirtualDesktopManager.IsWindowOnCurrentVirtualDesktop 으로 그 데스크톱이 지금 보이는지 본다 (공개 API 만 쓴다).
//! 바뀔 때만 JSON 한 줄을 쓴다. 앱이 끝나 stdout 이 닫히면(2초마다 빈 줄로 확인) 같이 끝난다.

use crate::desk::{parse_hwnds, Line, Watch};
use std::io::Write;
use std::time::{Duration, Instant};
use windows::core::GUID;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::{IVirtualDesktopManager, VirtualDesktopManager};
use windows::Win32::UI::WindowsAndMessaging::IsWindow;

const POLL: Duration = Duration::from_millis(250);
const HEARTBEAT: Duration = Duration::from_secs(2);

fn hwnd(h: u64) -> HWND {
    HWND(h as usize as *mut core::ffi::c_void)
}

/// 한 줄 쓰기. 앱 쪽이 닫혔으면 false
fn emit(out: &mut impl Write, line: &str) -> bool {
    writeln!(out, "{line}").and_then(|_| out.flush()).is_ok()
}

pub fn watch(list: &str) -> Result<(), String> {
    let candidates = parse_hwnds(list)?;
    // SAFETY: 이 스레드에서 COM 을 한 번 켜고 데스크톱 관리자 하나를 만든다. 창 핸들이 그 사이 닫혀도 아래 호출은 오류를 돌려줄 뿐이다
    let manager: IVirtualDesktopManager = unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        CoCreateInstance(&VirtualDesktopManager, None, CLSCTX_ALL).map_err(|e| e.to_string())?
    };
    let on_now = |h: u64| unsafe { manager.IsWindowOnCurrentVirtualDesktop(hwnd(h)) }.map(|b| b.as_bool()).ok();
    let mut out = std::io::stdout().lock();

    // 기준 창: 데스크톱 id 가 있는(GUID_NULL 이 아닌) 첫 후보. 작업 표시줄에 없는 창은 모든 데스크톱에 보여 기준이 못 된다
    // SAFETY: GetWindowDesktopId 는 핸들만 읽는다
    let anchor = candidates
        .iter()
        .copied()
        .find(|&h| unsafe { manager.GetWindowDesktopId(hwnd(h)) }.is_ok_and(|id| id != GUID::zeroed()));
    let Some(anchor) = anchor else {
        emit(&mut out, &serde_json::to_string(&Line::Start { anchor: None, on: None }).unwrap_or_default());
        return Ok(());
    };
    let mut w = Watch::default();
    let first = on_now(anchor).unwrap_or(true);
    w.step(first);
    if !emit(&mut out, &serde_json::to_string(&Line::Start { anchor: Some(anchor), on: Some(first) }).unwrap_or_default()) {
        return Ok(());
    }
    let mut beat = Instant::now();
    loop {
        std::thread::sleep(POLL);
        // SAFETY: IsWindow 는 핸들 값만 본다
        if !unsafe { IsWindow(hwnd(anchor)) }.as_bool() {
            emit(&mut out, &serde_json::to_string(&Line::Gone { gone: true }).unwrap_or_default());
            return Ok(());
        }
        if let Some(line) = on_now(anchor).and_then(|on| w.step(on)) {
            if !emit(&mut out, &serde_json::to_string(&line).unwrap_or_default()) {
                return Ok(());
            }
            beat = Instant::now();
        } else if beat.elapsed() >= HEARTBEAT {
            if !emit(&mut out, "") {
                return Ok(());
            }
            beat = Instant::now();
        }
    }
}
