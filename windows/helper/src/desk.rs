//! 가상 데스크톱 지켜보기(1.2.2)에서 Windows API 없이 정할 수 있는 것: 후보 창 목록 읽기, 바뀔 때만 내보낼 줄.
//! 실제 IVirtualDesktopManager 호출은 win_desk.rs.
//!
//! Ezrite 의 설명 카드·표시·팝업은 작업 표시줄에 없는 창이라 데스크톱 관리자가 맡지 않아 모든 데스크톱에 보인다.
//! 그래서 "설명한 화면이 지금 보이나"는 우리 창이 아니라 설명할 때 앞에 있던 다른 프로그램 창(기준 창)으로 본다.

use serde::Serialize;

/// `desktop-watch --hwnd a,b,c` 의 후보 창 (앞에서부터). 비었거나 0·숫자 아닌 값이 있으면 받지 않는다
pub fn parse_hwnds(s: &str) -> Result<Vec<u64>, String> {
    let list: Vec<u64> = s
        .split(',')
        .map(|v| v.trim().parse::<u64>().ok().filter(|&h| h > 0))
        .collect::<Option<_>>()
        .ok_or_else(|| format!("창 핸들 목록이 올바르지 않음: {s}"))?;
    if list.is_empty() {
        return Err("창 핸들 목록이 비었음".into());
    }
    Ok(list)
}

/// 내보내는 줄: 처음 한 번 {"anchor":h,"on":b}, 그 뒤로는 바뀔 때만 {"on":b}.
/// 기준 창이 없으면 {"anchor":null} 하나, 기준 창이 닫히면 {"gone":true} 하나를 쓰고 끝난다
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum Line {
    Start { anchor: Option<u64>, #[serde(skip_serializing_if = "Option::is_none")] on: Option<bool> },
    On { on: bool },
    Gone { gone: bool },
}

/// 지난번 값과 같으면 아무것도 내보내지 않는다 (0.25초마다 보지만 바뀔 때만 앱을 깨운다)
#[derive(Default)]
pub struct Watch {
    last: Option<bool>,
}

impl Watch {
    pub fn step(&mut self, on: bool) -> Option<Line> {
        if self.last == Some(on) {
            return None;
        }
        self.last = Some(on);
        Some(Line::On { on })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 후보_창_목록을_읽는다() {
        assert_eq!(parse_hwnds("66052"), Ok(vec![66052]));
        assert_eq!(parse_hwnds("5, 6,7"), Ok(vec![5, 6, 7]));
        assert!(parse_hwnds("").is_err());
        assert!(parse_hwnds("0").is_err());
        assert!(parse_hwnds("5,x").is_err());
        assert!(parse_hwnds("5,,6").is_err());
    }

    #[test]
    fn 바뀔_때만_내보낸다() {
        let mut w = Watch::default();
        assert_eq!(w.step(true), Some(Line::On { on: true }));
        assert_eq!(w.step(true), None);
        assert_eq!(w.step(false), Some(Line::On { on: false }));
        assert_eq!(w.step(false), None);
        assert_eq!(w.step(true), Some(Line::On { on: true }));
    }

    #[test]
    fn 줄은_앱이_읽는_모양으로_나온다() {
        let j = |l: &Line| serde_json::to_string(l).unwrap();
        assert_eq!(j(&Line::Start { anchor: Some(5), on: Some(true) }), r#"{"anchor":5,"on":true}"#);
        assert_eq!(j(&Line::Start { anchor: None, on: None }), r#"{"anchor":null}"#);
        assert_eq!(j(&Line::On { on: false }), r#"{"on":false}"#);
        assert_eq!(j(&Line::Gone { gone: true }), r#"{"gone":true}"#);
    }
}
