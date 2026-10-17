//! 글자 인식 결과의 상자 계산 (순수 코드)

/// 화면 픽셀 좌표의 사각형
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct BoxF {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// 단어 상자들을 모두 덮는 줄 상자. 단어가 없으면 None.
pub fn union(boxes: &[BoxF]) -> Option<BoxF> {
    let first = boxes.first()?;
    let (mut x0, mut y0) = (first.x, first.y);
    let (mut x1, mut y1) = (first.x + first.w, first.y + first.h);
    for b in &boxes[1..] {
        x0 = x0.min(b.x);
        y0 = y0.min(b.y);
        x1 = x1.max(b.x + b.w);
        y1 = y1.max(b.y + b.h);
    }
    Some(BoxF { x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
}

/// 인식기에 넣으려고 줄인 이미지의 좌표를 원래 크기로 되돌린다
pub fn scale(b: BoxF, factor: f32) -> BoxF {
    BoxF { x: b.x * factor, y: b.y * factor, w: b.w * factor, h: b.h * factor }
}

/// 인식기 최대 크기에 맞추려면 몇 배로 줄여야 하는지 (1.0이면 그대로)
pub fn shrink_factor(width: u32, height: u32, max_dim: u32) -> f32 {
    let longest = width.max(height);
    if max_dim == 0 || longest <= max_dim {
        1.0
    } else {
        longest as f32 / max_dim as f32
    }
}

/// 글자 인식 언어를 고르는 순서
#[derive(Debug, Clone, PartialEq)]
pub enum OcrChoice {
    /// 이 언어 태그 (설치돼 있을 때만)
    Lang(String),
    /// Windows 사용자 언어 설정에서 처음으로 설치된 것
    UserProfile,
}

/// 요청한 언어가 있으면 그것만. 없으면 한국어 → 사용자 언어 → 영어 순서로 처음 되는 것을 쓴다
/// (한국어 화면을 가장 잘 읽고, 한국어 OCR 팩이 없는 PC 에서도 멈추지 않게)
pub fn ocr_order(requested: Option<&str>) -> Vec<OcrChoice> {
    match requested {
        Some(tag) => vec![OcrChoice::Lang(tag.to_string())],
        None => vec![
            OcrChoice::Lang("ko".into()),
            OcrChoice::UserProfile,
            OcrChoice::Lang("en-US".into()),
            OcrChoice::Lang("en".into()),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 언어를_안_정하면_한국어_사용자언어_영어_순서() {
        assert_eq!(
            ocr_order(None),
            vec![
                OcrChoice::Lang("ko".into()),
                OcrChoice::UserProfile,
                OcrChoice::Lang("en-US".into()),
                OcrChoice::Lang("en".into())
            ]
        );
    }

    #[test]
    fn 언어를_정하면_그_언어만() {
        assert_eq!(ocr_order(Some("ja")), vec![OcrChoice::Lang("ja".into())]);
    }

    fn b(x: f32, y: f32, w: f32, h: f32) -> BoxF {
        BoxF { x, y, w, h }
    }

    #[test]
    fn 단어_상자를_모두_덮는다() {
        let u = union(&[b(10.0, 20.0, 5.0, 5.0), b(30.0, 18.0, 10.0, 10.0)]).unwrap();
        assert_eq!(u, b(10.0, 18.0, 30.0, 10.0));
    }

    #[test]
    fn 빈_목록은_none() {
        assert_eq!(union(&[]), None);
    }

    #[test]
    fn 줄인_비율과_되돌리기() {
        assert_eq!(shrink_factor(5120, 1440, 2560), 2.0);
        assert_eq!(shrink_factor(1920, 1080, 2560), 1.0);
        assert_eq!(shrink_factor(100, 100, 0), 1.0);
        assert_eq!(scale(b(1.0, 2.0, 3.0, 4.0), 2.0), b(2.0, 4.0, 6.0, 8.0));
    }
}
