//! 캡처한 소리를 16kHz mono s16le로 바꾸는 부분.
//! OS와 무관한 순수 코드라서 여기서만 단위 테스트한다.

/// 장치에서 들어오는 샘플 형식
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleFormat {
    I16,
    I32,
    F32,
}

impl SampleFormat {
    pub fn bytes_per_sample(self) -> usize {
        match self {
            SampleFormat::I16 => 2,
            SampleFormat::I32 | SampleFormat::F32 => 4,
        }
    }
}

pub const WAVE_FORMAT_PCM: u16 = 1;
pub const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
pub const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;

/// WAVEFORMATEX의 태그·비트 수로 샘플 형식을 고른다.
/// EXTENSIBLE이면 `ext_is_float`에 SubFormat이 float인지 넘긴다.
/// 24비트 묶음(3바이트)처럼 다루지 않는 형식은 None.
pub fn detect_format(tag: u16, bits: u16, ext_is_float: Option<bool>) -> Option<SampleFormat> {
    let is_float = match tag {
        WAVE_FORMAT_IEEE_FLOAT => true,
        WAVE_FORMAT_PCM => false,
        WAVE_FORMAT_EXTENSIBLE => ext_is_float?,
        _ => return None,
    };
    match (is_float, bits) {
        (true, 32) => Some(SampleFormat::F32),
        (false, 16) => Some(SampleFormat::I16),
        (false, 32) => Some(SampleFormat::I32),
        _ => None,
    }
}

/// 인터리브된 원본 바이트를 채널 평균으로 mono f32(-1.0~1.0)로 내린다.
/// 마지막에 프레임 하나를 다 채우지 못한 바이트는 버린다.
pub fn to_mono_f32(bytes: &[u8], format: SampleFormat, channels: usize) -> Vec<f32> {
    if channels == 0 {
        return Vec::new();
    }
    let bps = format.bytes_per_sample();
    let frame_bytes = bps * channels;
    bytes
        .chunks_exact(frame_bytes)
        .map(|frame| {
            let sum: f32 = frame.chunks_exact(bps).map(|s| read_sample(s, format)).sum();
            sum / channels as f32
        })
        .collect()
}

fn read_sample(s: &[u8], format: SampleFormat) -> f32 {
    match format {
        SampleFormat::I16 => i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.0,
        SampleFormat::I32 => i32::from_le_bytes([s[0], s[1], s[2], s[3]]) as f32 / 2_147_483_648.0,
        SampleFormat::F32 => f32::from_le_bytes([s[0], s[1], s[2], s[3]]),
    }
}

/// 구간 평균 방식의 스트리밍 리샘플러.
/// 출력 샘플 하나는 입력 축에서 `in_rate / out_rate` 길이 구간의 평균이다.
/// 내려 받을 때는 간단한 저역 통과 역할도 해서 선형 보간보다 접힘 잡음이 적다.
/// 상태를 들고 있으므로 조각을 나눠 넣어도 한 번에 넣은 것과 결과가 같다.
pub struct Resampler {
    step: f64,
    acc: f64,
    acc_w: f64,
}

impl Resampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Self {
        assert!(in_rate > 0 && out_rate > 0, "샘플레이트는 0보다 커야 함");
        Self {
            step: in_rate as f64 / out_rate as f64,
            acc: 0.0,
            acc_w: 0.0,
        }
    }

    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        // 부동소수 오차로 구간이 영영 안 닫히는 일을 막는 여유값
        const EPS: f64 = 1e-9;
        for &x in input {
            let mut w = 1.0f64;
            while w > EPS {
                let t = w.min(self.step - self.acc_w);
                self.acc += x as f64 * t;
                self.acc_w += t;
                w -= t;
                if self.acc_w >= self.step - EPS {
                    out.push((self.acc / self.acc_w) as f32);
                    self.acc = 0.0;
                    self.acc_w = 0.0;
                }
            }
        }
    }
}

/// f32 샘플을 잘라 붙여(clamp) s16le 바이트로 만든다.
pub fn f32_to_s16le(samples: &[f32], out: &mut Vec<u8>) {
    out.reserve(samples.len() * 2);
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
}

/// 원본 형식 → 16kHz mono s16le 변환을 한 번에 묶은 것
pub struct Converter {
    format: SampleFormat,
    channels: usize,
    resampler: Resampler,
}

pub const OUT_RATE: u32 = 16_000;

impl Converter {
    pub fn new(format: SampleFormat, channels: usize, in_rate: u32) -> Self {
        Self {
            format,
            channels,
            resampler: Resampler::new(in_rate, OUT_RATE),
        }
    }

    /// 입력은 프레임 단위로 잘린 바이트여야 한다 (WASAPI 버퍼는 항상 그렇다).
    pub fn push(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mono = to_mono_f32(bytes, self.format, self.channels);
        let mut resampled = Vec::with_capacity(mono.len());
        self.resampler.process(&mono, &mut resampled);
        let mut out = Vec::new();
        f32_to_s16le(&resampled, &mut out);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn i16_bytes(v: &[i16]) -> Vec<u8> {
        v.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    fn f32_bytes(v: &[f32]) -> Vec<u8> {
        v.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    #[test]
    fn 스테레오_i16은_채널_평균으로_내려간다() {
        let bytes = i16_bytes(&[16384, 0, -16384, -16384]);
        let mono = to_mono_f32(&bytes, SampleFormat::I16, 2);
        assert_eq!(mono, vec![0.25, -0.5]);
    }

    #[test]
    fn f32와_i32도_읽는다() {
        let mono = to_mono_f32(&f32_bytes(&[0.5, -0.5, 1.0, 1.0]), SampleFormat::F32, 2);
        assert_eq!(mono, vec![0.0, 1.0]);

        let bytes: Vec<u8> = [i32::MIN, 0].iter().flat_map(|s| s.to_le_bytes()).collect();
        let mono = to_mono_f32(&bytes, SampleFormat::I32, 1);
        assert_eq!(mono, vec![-1.0, 0.0]);
    }

    #[test]
    fn 덜_찬_프레임과_채널_0은_버린다() {
        let mut bytes = i16_bytes(&[100, 200]);
        bytes.push(7);
        assert_eq!(to_mono_f32(&bytes, SampleFormat::I16, 2).len(), 1);
        assert!(to_mono_f32(&bytes, SampleFormat::I16, 0).is_empty());
    }

    #[test]
    fn 초당_48k는_초당_16k가_된다() {
        let mut r = Resampler::new(48_000, 16_000);
        let mut out = Vec::new();
        r.process(&vec![0.3; 48_000], &mut out);
        assert_eq!(out.len(), 16_000);
        assert!(out.iter().all(|&s| (s - 0.3).abs() < 1e-6));
    }

    #[test]
    fn 비율_44_1k처럼_나눠떨어지지_않는_비율도_길이가_맞다() {
        let mut r = Resampler::new(44_100, 16_000);
        let mut out = Vec::new();
        r.process(&vec![0.0; 44_100], &mut out);
        assert!((out.len() as i64 - 16_000).abs() <= 1, "len={}", out.len());
    }

    #[test]
    fn 조각으로_나눠_넣어도_결과가_같다() {
        let input: Vec<f32> = (0..4_410).map(|i| ((i as f32) * 0.01).sin()).collect();

        let mut whole = Vec::new();
        Resampler::new(44_100, 16_000).process(&input, &mut whole);

        let mut parts = Vec::new();
        let mut r = Resampler::new(44_100, 16_000);
        for chunk in input.chunks(37) {
            r.process(chunk, &mut parts);
        }

        assert_eq!(whole.len(), parts.len());
        for (a, b) in whole.iter().zip(&parts) {
            assert!((a - b).abs() < 1e-5);
        }
    }

    #[test]
    fn 내려_받을_때_구간_평균을_낸다() {
        let mut r = Resampler::new(3, 1);
        let mut out = Vec::new();
        r.process(&[0.0, 0.3, 0.6, 1.0, 1.0, 1.0], &mut out);
        assert_eq!(out.len(), 2);
        assert!((out[0] - 0.3).abs() < 1e-6);
        assert!((out[1] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn 올려_받을_때는_샘플을_유지한다() {
        let mut r = Resampler::new(8_000, 16_000);
        let mut out = Vec::new();
        r.process(&[0.5, -0.5], &mut out);
        assert_eq!(out, vec![0.5, 0.5, -0.5, -0.5]);
    }

    #[test]
    fn s16le_변환은_범위를_넘으면_잘라낸다() {
        let mut out = Vec::new();
        f32_to_s16le(&[0.0, 1.5, -2.0, 0.5], &mut out);
        let v: Vec<i16> = out.as_chunks::<2>().0.iter().map(|b| i16::from_le_bytes(*b)).collect();
        assert_eq!(v, vec![0, 32767, -32767, 16384]);
    }

    #[test]
    fn 컨버터는_48k_스테레오를_16k_모노_바이트로_만든다() {
        let mut c = Converter::new(SampleFormat::I16, 2, 48_000);
        let frames: Vec<i16> = (0..480).flat_map(|_| [8192i16, 8192]).collect();
        let out = c.push(&i16_bytes(&frames));
        assert_eq!(out.len(), 160 * 2);
        let first = i16::from_le_bytes([out[0], out[1]]);
        assert!((first - 8192).abs() <= 1);
    }

    #[test]
    fn 장치_형식을_알아본다() {
        assert_eq!(detect_format(WAVE_FORMAT_PCM, 16, None), Some(SampleFormat::I16));
        assert_eq!(detect_format(WAVE_FORMAT_IEEE_FLOAT, 32, None), Some(SampleFormat::F32));
        assert_eq!(detect_format(WAVE_FORMAT_EXTENSIBLE, 32, Some(true)), Some(SampleFormat::F32));
        assert_eq!(detect_format(WAVE_FORMAT_EXTENSIBLE, 32, Some(false)), Some(SampleFormat::I32));
        assert_eq!(detect_format(WAVE_FORMAT_EXTENSIBLE, 32, None), None);
        assert_eq!(detect_format(WAVE_FORMAT_PCM, 24, None), None);
        assert_eq!(detect_format(0x55, 16, None), None);
    }

    #[test]
    #[should_panic]
    fn 샘플레이트_0은_거부한다() {
        Resampler::new(0, 16_000);
    }
}
