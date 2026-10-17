//! ezrite-audio: Ezrite Windows판 소리 받기 보조 프로그램
//!
//! 사용법:
//!   ezrite-audio list
//!   ezrite-audio capture --pid <N>
//!   ezrite-audio capture --mic <장치 id>
//!   ezrite-audio ocr <이미지 경로> [--lang <언어 태그>]
//!   ezrite-audio corner --hwnd <창 핸들>
//!   ezrite-audio encode --in <16kHz mono s16le .pcm> --out <.m4a>
//!
//! ocr은 글자와 줄 상자(원래 이미지 픽셀 좌표)를 JSON 한 줄로 출력한다.
//! capture는 16kHz mono s16le PCM을 stdout으로 계속 흘린다. 멈추려면 프로세스를 끝낸다.
//! encode는 녹음 원본을 AAC(.m4a)로 바꾸고 {"seconds": 길이} 를 JSON 한 줄로 출력한다.
//! corner는 테두리 없는 창(팝업·작은 창)에 Windows 11 둥근 모서리(DWMWCP_ROUND)를 켠다.
//! 오류는 stderr에 한 줄로 쓰고 종료 코드 1로 끝난다.

mod convert;
mod resample;
mod ocr_box;
mod tree;

#[cfg(windows)]
mod win;
#[cfg(windows)]
mod win_ocr;
#[cfg(windows)]
mod win_dwm;
#[cfg(windows)]
mod win_encode;

use std::process::ExitCode;

#[derive(Debug, PartialEq, Eq)]
enum Command {
    List,
    CapturePid(u32),
    CaptureMic(String),
    Ocr { path: String, lang: Option<String> },
    Corner(u64),
    Encode { input: String, output: String },
}

fn parse_args(args: &[String]) -> Result<Command, String> {
    match args {
        [cmd] if cmd == "list" => Ok(Command::List),
        [cmd, flag, value] if cmd == "capture" && flag == "--pid" => value
            .parse::<u32>()
            .ok()
            .filter(|&p| p > 0)
            .map(Command::CapturePid)
            .ok_or_else(|| format!("pid가 올바르지 않음: {value}")),
        [cmd, flag, value] if cmd == "capture" && flag == "--mic" && !value.is_empty() => {
            Ok(Command::CaptureMic(value.clone()))
        }
        [cmd, path] if cmd == "ocr" && !path.is_empty() => Ok(Command::Ocr { path: path.clone(), lang: None }),
        [cmd, path, flag, lang] if cmd == "ocr" && flag == "--lang" && !path.is_empty() && !lang.is_empty() => {
            Ok(Command::Ocr { path: path.clone(), lang: Some(lang.clone()) })
        }
        [cmd, flag, value] if cmd == "corner" && flag == "--hwnd" => value
            .parse::<u64>()
            .ok()
            .filter(|&h| h > 0)
            .map(Command::Corner)
            .ok_or_else(|| format!("창 핸들이 올바르지 않음: {value}")),
        [cmd, f1, input, f2, output] if cmd == "encode" && f1 == "--in" && f2 == "--out" && !input.is_empty() && !output.is_empty() => {
            Ok(Command::Encode { input: input.clone(), output: output.clone() })
        }
        _ => Err(
            "사용법: ezrite-audio list | capture --pid <N> | capture --mic <id> | ocr <이미지> [--lang <태그>] | corner --hwnd <N> | encode --in <pcm> --out <m4a>"
                .into(),
        ),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = match parse_args(&args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    match run(cmd) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(windows)]
fn run(cmd: Command) -> Result<(), String> {
    match cmd {
        Command::List => win::list().map_err(|e| format!("list 실패: {e}")),
        Command::CapturePid(pid) => win::capture_process(pid).map_err(|e| format!("capture 실패: {e}")),
        Command::CaptureMic(id) => win::capture_mic(&id).map_err(|e| format!("capture 실패: {e}")),
        Command::Ocr { path, lang } => {
            win_ocr::ocr(&path, lang.as_deref()).map_err(|e| format!("ocr 실패: {e}"))
        }
        Command::Corner(hwnd) => win_dwm::round_corners(hwnd).map_err(|e| format!("corner 실패: {e}")),
        Command::Encode { input, output } => {
            let secs = win_encode::encode(&input, &output).map_err(|e| format!("encode 실패: {e}"))?;
            println!("{}", serde_json::json!({ "seconds": secs }));
            Ok(())
        }
    }
}

#[cfg(not(windows))]
fn run(_cmd: Command) -> Result<(), String> {
    Err("Windows에서만 동작합니다".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn 인자를_읽는다() {
        assert_eq!(parse_args(&a(&["list"])), Ok(Command::List));
        assert_eq!(parse_args(&a(&["capture", "--pid", "42"])), Ok(Command::CapturePid(42)));
        assert_eq!(
            parse_args(&a(&["capture", "--mic", "{0.0.1}.{abc}"])),
            Ok(Command::CaptureMic("{0.0.1}.{abc}".into()))
        );
    }

    #[test]
    fn 잘못된_인자는_거부한다() {
        assert!(parse_args(&a(&[])).is_err());
        assert!(parse_args(&a(&["capture", "--pid", "0"])).is_err());
        assert!(parse_args(&a(&["capture", "--pid", "abc"])).is_err());
        assert!(parse_args(&a(&["capture", "--mic", ""])).is_err());
        assert!(parse_args(&a(&["capture"])).is_err());
        assert!(parse_args(&a(&["list", "x"])).is_err());
        assert!(parse_args(&a(&["ocr"])).is_err());
        assert!(parse_args(&a(&["ocr", "a.png", "--lang"])).is_err());
        assert!(parse_args(&a(&["ocr", "a.png", "--lang", ""])).is_err());
    }

    #[test]
    fn corner_인자를_읽는다() {
        assert_eq!(parse_args(&a(&["corner", "--hwnd", "132456"])), Ok(Command::Corner(132456)));
        assert!(parse_args(&a(&["corner", "--hwnd", "0"])).is_err());
        assert!(parse_args(&a(&["corner", "--hwnd", "x"])).is_err());
        assert!(parse_args(&a(&["corner"])).is_err());
    }

    #[test]
    fn encode_인자를_읽는다() {
        assert_eq!(
            parse_args(&a(&["encode", "--in", "a.pcm", "--out", "b.m4a"])),
            Ok(Command::Encode { input: "a.pcm".into(), output: "b.m4a".into() })
        );
        assert!(parse_args(&a(&["encode", "--in", "a.pcm"])).is_err());
        assert!(parse_args(&a(&["encode", "--out", "b.m4a", "--in", "a.pcm"])).is_err());
        assert!(parse_args(&a(&["encode", "--in", "", "--out", "b.m4a"])).is_err());
    }

    #[test]
    fn ocr_인자를_읽는다() {
        assert_eq!(
            parse_args(&a(&["ocr", "a.png"])),
            Ok(Command::Ocr { path: "a.png".into(), lang: None })
        );
        assert_eq!(
            parse_args(&a(&["ocr", "a.png", "--lang", "ko"])),
            Ok(Command::Ocr { path: "a.png".into(), lang: Some("ko".into()) })
        );
    }
}
