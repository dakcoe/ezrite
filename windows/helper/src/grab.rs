//! 화면 번역(실험 기능)의 창 그림에서 Windows API 없이 정할 수 있는 것: 잘라내기, 바뀜 감지용 6×6 칸 평균, BMP 쓰기.
//! 그림은 모두 위에서 아래로 BGRA (GDI GetDIBits 를 높이 음수로 받은 것).

/// (x0, y0) 부터 cw×ch 를 잘라낸다. 그림 밖은 0
pub fn crop(bgra: &[u8], w: usize, h: usize, x0: i64, y0: i64, cw: usize, ch: usize) -> Vec<u8> {
    let mut out = vec![0u8; cw * ch * 4];
    for y in 0..ch {
        let sy = y0 + y as i64;
        if sy < 0 || sy >= h as i64 {
            continue;
        }
        for x in 0..cw {
            let sx = x0 + x as i64;
            if sx < 0 || sx >= w as i64 {
                continue;
            }
            let s = (sy as usize * w + sx as usize) * 4;
            let d = (y * cw + x) * 4;
            out[d..d + 4].copy_from_slice(&bgra[s..s + 4]);
        }
    }
    out
}

/// n×n 칸마다 RGB 평균 (칸 순서는 위 줄부터, 값은 r,g,b). 맥 6×6 썸네일 비교와 같은 쓰임 (평균 차 2.5 넘으면 바뀜)
pub fn signature(bgra: &[u8], w: usize, h: usize, n: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(n * n * 3);
    if w == 0 || h == 0 {
        return vec![0; n * n * 3];
    }
    for cy in 0..n {
        let (ya, yb) = (cy * h / n, ((cy + 1) * h / n).max(cy * h / n + 1).min(h));
        for cx in 0..n {
            let (xa, xb) = (cx * w / n, ((cx + 1) * w / n).max(cx * w / n + 1).min(w));
            let (mut r, mut g, mut b, mut c) = (0u64, 0u64, 0u64, 0u64);
            // 칸이 크면 2점마다 (6×6 평균에는 충분하다)
            for y in (ya..yb).step_by(2) {
                for x in (xa..xb).step_by(2) {
                    let i = (y * w + x) * 4;
                    b += bgra[i] as u64;
                    g += bgra[i + 1] as u64;
                    r += bgra[i + 2] as u64;
                    c += 1;
                }
            }
            let c = c.max(1);
            out.extend_from_slice(&[(r / c) as u8, (g / c) as u8, (b / c) as u8]);
        }
    }
    out
}

/// 32비트 위→아래 BMP (BITMAPINFOHEADER, 높이 음수). 글자 인식(BitmapDecoder)이 읽고, 앱은 압축 풀기 없이 읽는다. 알파는 255
pub fn bmp(bgra: &[u8], w: u32, h: u32) -> Vec<u8> {
    let size = (w * h * 4) as usize;
    let mut out = Vec::with_capacity(54 + size);
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&((54 + size) as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&54u32.to_le_bytes());
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&(w as i32).to_le_bytes());
    out.extend_from_slice(&(-(h as i32)).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&32u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // BI_RGB
    out.extend_from_slice(&(size as u32).to_le_bytes());
    out.extend_from_slice(&2835u32.to_le_bytes());
    out.extend_from_slice(&2835u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    for px in bgra.as_chunks::<4>().0 {
        out.extend_from_slice(&[px[0], px[1], px[2], 255]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn img(w: usize, h: usize, f: impl Fn(usize, usize) -> [u8; 3]) -> Vec<u8> {
        let mut v = Vec::new();
        for y in 0..h {
            for x in 0..w {
                let [r, g, b] = f(x, y);
                v.extend_from_slice(&[b, g, r, 255]);
            }
        }
        v
    }

    #[test]
    fn 잘라내기는_그림_밖을_0으로() {
        let src = img(4, 4, |x, y| [(x * 10) as u8, (y * 10) as u8, 0]);
        let c = crop(&src, 4, 4, 2, 3, 3, 2);
        assert_eq!(&c[0..4], &[0, 30, 20, 255]); // (2,3) → r=20 g=30
        assert_eq!(&c[8..12], &[0, 0, 0, 0]); // (4,3) 은 밖
        assert_eq!(&c[12..16], &[0, 0, 0, 0]); // (2,4) 는 밖
    }

    #[test]
    fn 칸_평균은_위_줄부터_rgb() {
        let src = img(12, 12, |x, y| if x < 6 && y < 6 { [255, 0, 0] } else { [0, 0, 255] });
        let s = signature(&src, 12, 12, 2);
        assert_eq!(s, vec![255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 255]);
        assert_eq!(signature(&src, 12, 12, 6).len(), 108);
    }

    #[test]
    fn bmp_머리와_크기() {
        let b = bmp(&img(3, 2, |_, _| [1, 2, 3]), 3, 2);
        assert_eq!(&b[0..2], b"BM");
        assert_eq!(b.len(), 54 + 24);
        assert_eq!(i32::from_le_bytes([b[22], b[23], b[24], b[25]]), -2);
        assert_eq!(&b[54..58], &[3, 2, 1, 255]);
    }
}
