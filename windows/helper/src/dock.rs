//! 화면 나누기(1.2.1)의 창 목록·옮기기에서 Windows API 없이 정할 수 있는 것: 출력 모양, 건너뛸 창 종류, 옮길 목록 읽기.
//! 실제 창을 다루는 곳은 win_windows.rs. 좌표는 모두 물리 픽셀(Per-Monitor V2)이다.

use serde::{Deserialize, Serialize};

/// 보이는 최상위 창 하나 (GetWindowRect 바깥 사각형 — 보이지 않는 크기 조절 테두리 포함).
/// max: 최대화 — 화면을 다 덮어도(작업 표시줄 자동 숨김) 전체 화면으로 치지 않는다.
/// normal: 최대화한 창의 보통 크기 자리 (WINDOWPLACEMENT.rcNormalPosition, 작업 영역 좌표 l·t·r·b). 되돌릴 때 그대로 받는다
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Win {
    pub hwnd: u64,
    pub pid: u32,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub max: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub normal: Option<[i32; 4]>,
}

/// `windows` 출력: 맨 앞 창과 창 목록(겹침 순서대로, 맨 앞부터)
#[derive(Debug, Serialize)]
pub struct Listing {
    pub foreground: u64,
    pub windows: Vec<Win>,
}

/// `place` 입력 하나: 이 창을 이 자리·크기로.
/// unmax: 먼저 최대화를 푼다 (Chromium 창은 최대화 상태에서 크기를 바꾸면 최대화 크기로 되돌아간다).
/// restoreMax: 자리·크기 대신 이 보통 크기 자리(`windows` 의 normal)로 두고 다시 최대화한다
#[derive(Debug, Deserialize, PartialEq, Eq)]
pub struct Place {
    pub hwnd: u64,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    #[serde(default)]
    pub unmax: bool,
    #[serde(default, rename = "restoreMax")]
    pub restore_max: Option<[i32; 4]>,
}

/// 바탕화면·작업 표시줄·시작 메뉴 같은 셸 창은 옮기지 않는다
pub fn shell_class(name: &str) -> bool {
    matches!(
        name,
        "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "Windows.UI.Core.CoreWindow"
    )
}

/// `place --json` 의 목록을 읽는다. 창 핸들이 0 이거나 크기가 0 이하면 받지 않는다
pub fn parse_places(json: &str) -> Result<Vec<Place>, String> {
    let list: Vec<Place> = serde_json::from_str(json).map_err(|e| format!("옮길 목록을 읽지 못함: {e}"))?;
    if let Some(p) = list.iter().find(|p| p.hwnd == 0 || p.w <= 0 || p.h <= 0) {
        return Err(format!("옮길 자리가 올바르지 않음: 창 {} ({}×{})", p.hwnd, p.w, p.h));
    }
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 옮길_목록을_읽는다() {
        let v = parse_places(r#"[{"hwnd":66052,"x":-7,"y":0,"w":1505,"h":1047},{"hwnd":2,"x":10,"y":20,"w":30,"h":40}]"#).unwrap();
        assert_eq!(v, vec![
            Place { hwnd: 66052, x: -7, y: 0, w: 1505, h: 1047, unmax: false, restore_max: None },
            Place { hwnd: 2, x: 10, y: 20, w: 30, h: 40, unmax: false, restore_max: None },
        ]);
        assert_eq!(parse_places("[]").unwrap(), vec![]);
        let m = parse_places(r#"[{"hwnd":3,"x":-8,"y":-8,"w":1936,"h":1056,"unmax":true},{"hwnd":3,"x":-8,"y":-8,"w":1936,"h":1056,"restoreMax":[200,100,1400,900]}]"#).unwrap();
        assert!(m[0].unmax && m[0].restore_max.is_none());
        assert_eq!(m[1].restore_max, Some([200, 100, 1400, 900]));
    }

    #[test]
    fn 잘못된_목록은_받지_않는다() {
        assert!(parse_places("").is_err());
        assert!(parse_places("{}").is_err());
        assert!(parse_places(r#"[{"hwnd":1,"x":0,"y":0,"w":10}]"#).is_err());
        assert!(parse_places(r#"[{"hwnd":0,"x":0,"y":0,"w":10,"h":10}]"#).is_err());
        assert!(parse_places(r#"[{"hwnd":1,"x":0,"y":0,"w":0,"h":10}]"#).is_err());
        assert!(parse_places(r#"[{"hwnd":1,"x":0,"y":0,"w":10,"h":-5}]"#).is_err());
    }

    #[test]
    fn 셸_창은_건너뛴다() {
        for c in ["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Windows.UI.Core.CoreWindow"] {
            assert!(shell_class(c), "{c}");
        }
        for c in ["Chrome_WidgetWin_1", "PPTFrameClass", "Notepad", "ApplicationFrameWindow"] {
            assert!(!shell_class(c), "{c}");
        }
    }

    #[test]
    fn 목록은_앱이_읽는_모양으로_나온다() {
        let l = Listing {
            foreground: 5,
            windows: vec![
                Win { hwnd: 5, pid: 9, x: -7, y: 0, w: 100, h: 50, max: true, normal: Some([1, 2, 3, 4]) },
                Win { hwnd: 6, pid: 9, x: 0, y: 0, w: 10, h: 10, max: false, normal: None },
            ],
        };
        assert_eq!(
            serde_json::to_string(&l).unwrap(),
            r#"{"foreground":5,"windows":[{"hwnd":5,"pid":9,"x":-7,"y":0,"w":100,"h":50,"max":true,"normal":[1,2,3,4]},{"hwnd":6,"pid":9,"x":0,"y":0,"w":10,"h":10,"max":false}]}"#
        );
    }
}
