//! Windows.Media.Ocr로 이미지 속 글자와 줄 위치를 읽는다 ("설명해줘"용)

use serde::Serialize;
use windows::core::{Result, HSTRING};
use windows::Graphics::Imaging::{
    BitmapAlphaMode, BitmapDecoder, BitmapInterpolationMode, BitmapPixelFormat, BitmapTransform,
    ColorManagementMode, ExifOrientationMode,
};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::{FileAccessMode, StorageFile};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

use crate::ocr_box::{ocr_order, scale, shrink_factor, union, BoxF, OcrChoice};

#[derive(Serialize)]
struct LineOut {
    text: String,
    #[serde(flatten)]
    rect: BoxF,
}

#[derive(Serialize)]
struct OcrOut {
    lang: String,
    /// 한국어 글자 인식 팩이 있는지. 없으면 앱이 "한국어를 추가하면 더 잘 읽는다"고 알린다
    #[serde(rename = "koAvailable")]
    ko_available: bool,
    width: u32,
    height: u32,
    lines: Vec<LineOut>,
}

/// `path`(png/jpg/bmp)의 글자를 읽어 JSON 한 줄로 출력한다. 좌표는 원래 이미지 픽셀 기준.
/// `lang`이 있으면 그 언어(예: "ko", "en-US")로, 없으면 사용자 언어 설정으로 인식한다.
pub fn ocr(path: &str, lang: Option<&str>) -> Result<()> {
    unsafe {
        // 이미 다른 방식으로 초기화돼 있어도 계속 진행한다
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }
    let full = std::fs::canonicalize(path)
        .map_err(|e| windows::core::Error::new(windows::core::HRESULT(0x8007_0002u32 as i32), e.to_string().as_str()))?;
    // canonicalize는 \\?\ 접두어를 붙이는데 StorageFile은 이를 받지 않는다
    let full = full.to_string_lossy().trim_start_matches(r"\\?\").to_string();

    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(full))?.get()?;
    let stream = file.OpenAsync(FileAccessMode::Read)?.get()?;
    let decoder = BitmapDecoder::CreateAsync(&stream)?.get()?;
    let (width, height) = (decoder.PixelWidth()?, decoder.PixelHeight()?);

    let max_dim = OcrEngine::MaxImageDimension()?;
    let factor = shrink_factor(width, height, max_dim);
    let transform = BitmapTransform::new()?;
    if factor > 1.0 {
        transform.SetScaledWidth((width as f32 / factor).floor() as u32)?;
        transform.SetScaledHeight((height as f32 / factor).floor() as u32)?;
        transform.SetInterpolationMode(BitmapInterpolationMode::Fant)?;
    }
    let bitmap = decoder
        .GetSoftwareBitmapTransformedAsync(
            BitmapPixelFormat::Bgra8,
            BitmapAlphaMode::Premultiplied,
            &transform,
            ExifOrientationMode::IgnoreExifOrientation,
            ColorManagementMode::DoNotColorManage,
        )?
        .get()?;

    let engine = pick_engine(lang)?;
    let result = engine.RecognizeAsync(&bitmap)?.get()?;

    let mut lines = Vec::new();
    for line in result.Lines()? {
        let words: Vec<BoxF> = line
            .Words()?
            .into_iter()
            .filter_map(|w| w.BoundingRect().ok())
            .map(|r| BoxF { x: r.X, y: r.Y, w: r.Width, h: r.Height })
            .collect();
        let Some(rect) = union(&words) else { continue };
        lines.push(LineOut { text: line.Text()?.to_string(), rect: scale(rect, factor) });
    }

    let out = OcrOut {
        lang: engine.RecognizerLanguage()?.LanguageTag()?.to_string(),
        ko_available: supported("ko"),
        width,
        height,
        lines,
    };
    println!("{}", serde_json::to_string(&out).expect("직렬화 실패"));
    Ok(())
}

fn supported(tag: &str) -> bool {
    windows::Globalization::Language::CreateLanguage(&HSTRING::from(tag))
        .and_then(|l| OcrEngine::IsLanguageSupported(&l))
        .unwrap_or(false)
}

/// ocr_order 순서대로 처음 만들어지는 인식기. 설치 안 된 언어는 건너뛴다 (예전엔 여기서 "작업을 완료했습니다" 오류로 멈췄다)
fn pick_engine(lang: Option<&str>) -> Result<OcrEngine> {
    for choice in ocr_order(lang) {
        let engine = match choice {
            OcrChoice::Lang(tag) => {
                if !supported(&tag) {
                    continue;
                }
                let language = windows::Globalization::Language::CreateLanguage(&HSTRING::from(tag.as_str()))?;
                OcrEngine::TryCreateFromLanguage(&language)
            }
            OcrChoice::UserProfile => OcrEngine::TryCreateFromUserProfileLanguages(),
        };
        if let Ok(e) = engine {
            return Ok(e);
        }
    }
    Err(windows::core::Error::new(
        windows::core::HRESULT(0x8007_0490u32 as i32),
        "이 PC 에 글자 읽기(OCR) 언어가 없습니다 (Windows 설정 → 언어에서 언어 팩 추가)",
    ))
}
