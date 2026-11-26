//! 화면 번역(실험 기능, 1.3.2 예정): 고른 창 하나만 찍기와 그 창 지켜보기.
//! PrintWindow(PW_RENDERFULLCONTENT)로 그 창만 그린다 — 다른 창에 가려져 있어도 그 창 내용이 찍히고, 앱의 덮개 창은 안 찍힌다.
//! 좌표는 물리 픽셀(Per-Monitor V2). 보이지 않는 크기 조절 테두리는 DWM 의 보이는 사각형(EXTENDED_FRAME_BOUNDS)으로 잘라낸다.
//!   grab --hwnd H --out <.bmp>   → 그 창 그림을 BMP 로, {"x","y","w","h"} (보이는 사각형) 한 줄
//!   screen-watch --hwnd H --ms N → N ms 마다 {"x","y","w","h","sig":[6×6×rgb],"front":[[l,t,r,b]…]} 한 줄.
//!                                  front 는 겹침 순서로 그 창보다 앞에 있는 창들 [l,t,r,b,pid]. 창이 닫히면 {"gone":true} 를 쓰고 끝,
//!                                  최소화되면 {"min":true}

use crate::grab::{bmp, crop, signature};
use crate::win_windows::{describe_window, dpi_aware};
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT, TRUE};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowRect, IsIconic, IsWindow};

const PW_RENDERFULLCONTENT: u32 = 2;

fn hwnd(h: u64) -> HWND {
    HWND(h as usize as *mut core::ffi::c_void)
}

fn err(msg: &str) -> windows::core::Error {
    windows::core::Error::new(windows::core::HRESULT(0x8000_4005u32 as i32), msg)
}

pub struct Shot {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub data: Vec<u8>,
}

/// 보이는 사각형 (DWM). 못 얻으면 창 사각형
fn visible_rect(h: HWND, wr: RECT) -> RECT {
    let mut r = RECT::default();
    // SAFETY: r 은 이 함수의 지역 변수이고 크기를 함께 넘긴다
    let ok = unsafe { DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut RECT as *mut _, std::mem::size_of::<RECT>() as u32) };
    if ok.is_ok() && r.right > r.left && r.bottom > r.top {
        r
    } else {
        wr
    }
}

/// 그 창 하나를 그려 받는다 (보이는 사각형으로 잘라서)
pub fn capture(h: HWND) -> windows::core::Result<Shot> {
    let mut wr = RECT::default();
    // SAFETY: 닫힌 창이면 오류를 돌려줄 뿐이다
    unsafe { GetWindowRect(h, &mut wr)? };
    let (w, ht) = (wr.right - wr.left, wr.bottom - wr.top);
    if w <= 0 || ht <= 0 || w > 16384 || ht > 16384 {
        return Err(err("창 크기가 없습니다"));
    }
    let mut buf = vec![0u8; (w * ht * 4) as usize];
    // SAFETY: DC·비트맵은 이 블록에서 만들고 지운다. GetDIBits 의 버퍼는 w×h×4 바이트(위→아래 32비트)로 맞췄다
    unsafe {
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(screen);
        let bitmap = CreateCompatibleBitmap(screen, w, ht);
        let old = SelectObject(mem, bitmap);
        let printed = PrintWindow(h, mem, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool();
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -ht,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let lines = GetDIBits(mem, bitmap, 0, ht as u32, Some(buf.as_mut_ptr() as *mut _), &mut info, DIB_RGB_COLORS);
        SelectObject(mem, old);
        let _ = DeleteObject(bitmap);
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        if !printed || lines == 0 {
            return Err(err("창을 그리지 못했습니다 (PrintWindow)"));
        }
    }
    let v = visible_rect(h, wr);
    let (cw, ch) = ((v.right - v.left) as usize, (v.bottom - v.top) as usize);
    let data = crop(&buf, w as usize, ht as usize, (v.left - wr.left) as i64, (v.top - wr.top) as i64, cw, ch);
    Ok(Shot { x: v.left, y: v.top, w: cw as i32, h: ch as i32, data })
}

pub fn grab(handle: u64, out: &str) -> windows::core::Result<()> {
    dpi_aware();
    let s = capture(hwnd(handle))?;
    std::fs::write(out, bmp(&s.data, s.w as u32, s.h as u32)).map_err(|e| err(&e.to_string()))?;
    println!("{}", serde_json::json!({ "x": s.x, "y": s.y, "w": s.w, "h": s.h }));
    Ok(())
}

struct Front {
    target: u64,
    reached: bool,
    rects: Vec<[i64; 5]>,
}

unsafe extern "system" fn front_of(h: HWND, lparam: LPARAM) -> BOOL {
    // SAFETY: lparam 은 front() 의 Front 를 가리키고 EnumWindows 가 끝날 때까지 살아 있다
    let f = unsafe { &mut *(lparam.0 as *mut Front) };
    if h.0 as usize as u64 == f.target {
        f.reached = true;
        return BOOL(0); // 여기서 멈춘다 (뒤 창은 상관없다)
    }
    if let Some(w) = describe_window(h) {
        f.rects.push([w.x as i64, w.y as i64, (w.x + w.w) as i64, (w.y + w.h) as i64, w.pid as i64]);
    }
    TRUE
}

/// 겹침 순서로 그 창보다 앞에 있는 보이는 창들의 사각형 [l, t, r, b, pid] (앱은 자기 창을 뺀다)
fn front(target: u64) -> Vec<[i64; 5]> {
    let mut f = Front { target, reached: false, rects: Vec::new() };
    // SAFETY: front_of 는 f 만 건드린다. 멈추려고 FALSE 를 돌려주면 EnumWindows 가 오류를 돌려주는데 무시한다
    unsafe {
        let _ = EnumWindows(Some(front_of), LPARAM(&mut f as *mut Front as isize));
    }
    if f.reached {
        f.rects
    } else {
        Vec::new()
    }
}

pub fn watch(handle: u64, ms: u64) -> windows::core::Result<()> {
    dpi_aware();
    let h = hwnd(handle);
    loop {
        // SAFETY: 핸들 확인만 한다
        let (alive, min) = unsafe { (IsWindow(h).as_bool(), IsIconic(h).as_bool()) };
        let line = if !alive {
            serde_json::json!({ "gone": true })
        } else if min {
            serde_json::json!({ "min": true })
        } else {
            match capture(h) {
                Ok(s) => serde_json::json!({
                    "x": s.x, "y": s.y, "w": s.w, "h": s.h,
                    "sig": signature(&s.data, s.w as usize, s.h as usize, 6),
                    "front": front(handle),
                }),
                Err(e) => serde_json::json!({ "error": e.message() }),
            }
        };
        println!("{line}");
        if !alive {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
}
