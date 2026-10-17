//! 녹음 원본(16kHz mono s16le .pcm)을 .m4a(AAC)로 바꾼다. Windows 에 들어 있는 Media Foundation AAC 인코더를 쓴다.
//!
//! Media Foundation AAC 인코더는 44.1kHz·48kHz 입력만 받아서 16kHz 를 48kHz 로 늘려(선형 보간) 넣는다.
//! 비트레이트는 인코더가 받는 가장 낮은 96kbps (맥은 16kHz 32kbps — 한 시간에 맥 약 14MB, 여기 약 43MB).

use windows::core::HSTRING;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use crate::resample::upsample3;

const IN_RATE: u32 = 16_000;
const OUT_RATE: u32 = 48_000;
const AAC_BYTES_PER_SEC: u32 = 12_000; // 96kbps. 인코더가 받는 값: 12000·16000·20000·24000
const CHUNK: usize = 4_800; // 48kHz 기준 100ms 씩 넣는다

/// 바꾼 소리 길이(초)를 돌려준다
pub fn encode(input: &str, output: &str) -> Result<f64, String> {
    let bytes = std::fs::read(input).map_err(|e| format!("{input} 읽기 실패: {e}"))?;
    let samples: Vec<i16> = bytes.as_chunks::<2>().0.iter().map(|b| i16::from_le_bytes(*b)).collect();
    if samples.is_empty() {
        return Err("소리가 없습니다 (빈 pcm)".into());
    }
    let wide = upsample3(&samples);
    write_m4a(&wide, output).map_err(|e| format!("m4a 쓰기 실패: {e}"))?;
    Ok(samples.len() as f64 / IN_RATE as f64)
}

fn audio_type(subtype: &windows::core::GUID, bytes_per_sec: u32) -> windows::core::Result<IMFMediaType> {
    // SAFETY: MFCreateMediaType 이 만든 COM 객체에 값을 넣기만 한다
    unsafe {
        let t = MFCreateMediaType()?;
        t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
        t.SetGUID(&MF_MT_SUBTYPE, subtype)?;
        t.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
        t.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, OUT_RATE)?;
        t.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 1)?;
        t.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, bytes_per_sec)?;
        if *subtype == MFAudioFormat_PCM {
            t.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 2)?;
        }
        Ok(t)
    }
}

fn write_m4a(samples: &[i16], output: &str) -> windows::core::Result<()> {
    // SAFETY: Media Foundation 을 이 함수 안에서만 켜고 끈다. 버퍼 포인터는 Lock~Unlock 사이에서
    // 그 버퍼 크기(len)만큼만 쓴다. 넘기는 COM 객체는 모두 이 함수가 만든 것이다
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET)?;
        let result = (|| {
            let writer = MFCreateSinkWriterFromURL(&HSTRING::from(output), None, None)?;
            let out_type = audio_type(&MFAudioFormat_AAC, AAC_BYTES_PER_SEC)?;
            let stream = writer.AddStream(&out_type)?;
            let in_type = audio_type(&MFAudioFormat_PCM, OUT_RATE * 2)?;
            writer.SetInputMediaType(stream, &in_type, None)?;
            writer.BeginWriting()?;

            let mut written: u64 = 0;
            for chunk in samples.chunks(CHUNK) {
                let len = (chunk.len() * 2) as u32;
                let buf = MFCreateMemoryBuffer(len)?;
                let mut ptr: *mut u8 = std::ptr::null_mut();
                buf.Lock(&mut ptr, None, None)?;
                std::ptr::copy_nonoverlapping(chunk.as_ptr() as *const u8, ptr, len as usize);
                buf.Unlock()?;
                buf.SetCurrentLength(len)?;
                let sample = MFCreateSample()?;
                sample.AddBuffer(&buf)?;
                // 시각은 100ns 단위
                sample.SetSampleTime((written * 10_000_000 / OUT_RATE as u64) as i64)?;
                sample.SetSampleDuration((chunk.len() as u64 * 10_000_000 / OUT_RATE as u64) as i64)?;
                writer.WriteSample(stream, &sample)?;
                written += chunk.len() as u64;
            }
            writer.Finalize()
        })();
        let _ = MFShutdown();
        result
    }
}
