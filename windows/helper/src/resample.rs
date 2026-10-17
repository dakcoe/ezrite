//! 16kHz → 48kHz (정확히 3배) 선형 보간. 받아쓰기용 말소리라 이 정도로 충분하다.
//! Windows 와 상관없는 계산이라 따로 두고 시험한다.

/// 샘플마다 [그 샘플, 다음 쪽으로 1/3, 2/3] 을 낸다. 마지막 샘플은 그대로 세 번
pub fn upsample3(input: &[i16]) -> Vec<i16> {
    let mut out = Vec::with_capacity(input.len() * 3);
    for (i, &a) in input.iter().enumerate() {
        let b = *input.get(i + 1).unwrap_or(&a);
        let (a, b) = (a as i32, b as i32);
        out.push(a as i16);
        out.push((a + (b - a) / 3) as i16);
        out.push((a + (b - a) * 2 / 3) as i16);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 세_배_길이로_늘리고_사이를_잇는다() {
        assert_eq!(upsample3(&[0, 300, -300]), vec![0, 100, 200, 300, 100, -100, -300, -300, -300]);
    }

    #[test]
    fn 빈_입력은_빈_출력() {
        assert!(upsample3(&[]).is_empty());
    }

    #[test]
    fn 끝값에서_넘치지_않는다() {
        let out = upsample3(&[i16::MAX, i16::MIN]);
        assert_eq!(out[0], i16::MAX);
        assert_eq!(out[3], i16::MIN);
        assert!(out.iter().all(|&v| v >= i16::MIN && v <= i16::MAX));
    }
}
