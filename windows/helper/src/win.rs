//! Windows 오디오(WASAPI) 부분: 소리 세션 목록, 프로그램별 소리 받기, 마이크 받기

use std::collections::HashMap;
use std::io::Write;

use serde::Serialize;
use windows::core::{implement, Interface, Result, GUID, HRESULT, PCWSTR, PWSTR};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Foundation::{BOOL, CloseHandle, HANDLE, HWND, LPARAM, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::*;
use windows::Win32::Media::Multimedia::KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
use windows::Win32::System::Com::StructuredStorage::PropVariantToStringAlloc;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindow, GetWindowLongW, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    IsWindowVisible, GWL_EXSTYLE, GW_OWNER, WS_EX_TOOLWINDOW,
};

use crate::convert::{detect_format, Converter, SampleFormat, WAVE_FORMAT_EXTENSIBLE};
use crate::tree::{add_windowed, root_of, ProcInfo};

// ───────────────────────── list ─────────────────────────

#[derive(Serialize)]
struct AppOut {
    pid: u32,
    exe: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    /// 지금 실제로 소리를 내는 중인지 (세션 상태 Active)
    active: bool,
}

#[derive(Serialize)]
struct MicOut {
    id: String,
    name: String,
    default: bool,
}

#[derive(Serialize)]
struct ListOut {
    apps: Vec<AppOut>,
    mics: Vec<MicOut>,
}

fn com_init() -> Result<()> {
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok() }
}

fn enumerator() -> Result<IMMDeviceEnumerator> {
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
}

/// COM이 할당한 문자열을 String으로 옮기고 해제한다
unsafe fn take_pwstr(p: PWSTR) -> String {
    let s = p.to_string().unwrap_or_default();
    CoTaskMemFree(Some(p.0 as _));
    s
}

fn process_table() -> HashMap<u32, ProcInfo> {
    let mut map = HashMap::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return map;
        };
        let mut e = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                map.insert(
                    e.th32ProcessID,
                    ProcInfo {
                        parent: e.th32ParentProcessID,
                        exe: String::from_utf16_lossy(&e.szExeFile[..len]),
                    },
                );
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    map
}

/// pid → 보이는 최상위 창 제목 (pid마다 처음 찾은 것)
fn window_titles() -> HashMap<u32, String> {
    unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = &mut *(lparam.0 as *mut HashMap<u32, String>);
        if !IsWindowVisible(hwnd).as_bool() {
            return true.into();
        }
        if GetWindow(hwnd, GW_OWNER).map(|o| !o.is_invalid()).unwrap_or(false) {
            return true.into();
        }
        // 작업 표시줄에 안 뜨는 도구 창(겹쳐 그리는 오버레이 등)은 프로그램 창으로 보지 않는다
        if (GetWindowLongW(hwnd, GWL_EXSTYLE) as u32) & WS_EX_TOOLWINDOW.0 != 0 {
            return true.into();
        }
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return true.into();
        }
        let mut buf = vec![0u16; len as usize + 1];
        let n = GetWindowTextW(hwnd, &mut buf);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if n > 0 && pid != 0 {
            out.entry(pid).or_insert_with(|| String::from_utf16_lossy(&buf[..n as usize]));
        }
        true.into()
    }
    let mut map: HashMap<u32, String> = HashMap::new();
    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut map as *mut _ as isize));
    }
    map
}

pub fn list() -> Result<()> {
    com_init()?;
    let en = enumerator()?;
    let procs = process_table();

    // 루트 pid → 활성 여부
    let mut roots: Vec<(u32, bool)> = Vec::new();
    unsafe {
        let devices = en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
        for i in 0..devices.GetCount()? {
            let dev = devices.Item(i)?;
            let Ok(mgr) = dev.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
                continue;
            };
            let sessions = mgr.GetSessionEnumerator()?;
            for j in 0..sessions.GetCount()? {
                let ctl = sessions.GetSession(j)?;
                let Ok(ctl2) = ctl.cast::<IAudioSessionControl2>() else { continue };
                // S_OK면 시스템 소리 세션
                if ctl2.IsSystemSoundsSession() == HRESULT(0) {
                    continue;
                }
                let state = ctl.GetState()?;
                if state == AudioSessionStateExpired {
                    continue;
                }
                let Ok(pid) = ctl2.GetProcessId() else { continue };
                if pid == 0 || !procs.contains_key(&pid) {
                    continue;
                }
                let root = root_of(pid, &procs);
                let active = state == AudioSessionStateActive;
                match roots.iter_mut().find(|(p, _)| *p == root) {
                    Some(r) => r.1 |= active,
                    None => roots.push((root, active)),
                }
            }
        }
    }

    // 창 제목은 같은 트리의 아무 프로세스 창이나 쓴다 (보통 루트가 창을 가짐)
    let windows = window_titles();
    // 소리를 아직 안 내는 프로그램도 창이 있으면 고를 수 있다 (맥은 실행 중인 앱을 모두 보인다)
    let mut window_pids: Vec<u32> = windows.keys().copied().collect();
    window_pids.sort_unstable();
    add_windowed(&mut roots, window_pids, &procs);
    let mut titles: HashMap<u32, String> = HashMap::new();
    for (pid, title) in windows {
        let root = root_of(pid, &procs);
        if pid == root {
            titles.insert(root, title);
        } else {
            titles.entry(root).or_insert(title);
        }
    }

    let mut apps: Vec<AppOut> = roots
        .into_iter()
        .map(|(pid, active)| AppOut {
            pid,
            exe: procs.get(&pid).map(|p| p.exe.clone()).unwrap_or_default(),
            title: titles.get(&pid).cloned(),
            active,
        })
        .collect();
    apps.sort_by(|a, b| b.active.cmp(&a.active).then_with(|| a.exe.to_lowercase().cmp(&b.exe.to_lowercase())));

    let mics = list_mics(&en)?;
    let out = serde_json::to_string(&ListOut { apps, mics }).expect("직렬화 실패");
    println!("{out}");
    Ok(())
}

fn list_mics(en: &IMMDeviceEnumerator) -> Result<Vec<MicOut>> {
    let mut mics = Vec::new();
    unsafe {
        let default_id = en
            .GetDefaultAudioEndpoint(eCapture, eConsole)
            .and_then(|d| d.GetId())
            .map(|p| take_pwstr(p))
            .ok();
        let devices = en.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)?;
        for i in 0..devices.GetCount()? {
            let dev = devices.Item(i)?;
            let id = take_pwstr(dev.GetId()?);
            let name = dev
                .OpenPropertyStore(STGM_READ)
                .and_then(|store| store.GetValue(&PKEY_Device_FriendlyName))
                .and_then(|v| PropVariantToStringAlloc(&v))
                .map(|p| take_pwstr(p))
                .unwrap_or_else(|_| id.clone());
            let default = default_id.as_deref() == Some(id.as_str());
            mics.push(MicOut { id, name, default });
        }
    }
    Ok(mics)
}

// ───────────────────────── capture ─────────────────────────

/// 프로그램 소리를 받을 때 쓰는 형식. process loopback은 장치 mix format을 못 주므로 직접 정한다.
const LOOPBACK_RATE: u32 = 48_000;
const LOOPBACK_CHANNELS: u16 = 2;

/// ActivateAudioInterfaceAsync 완료를 이벤트로 알려 주는 핸들러
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct ActivateHandler {
    done: HANDLE,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for ActivateHandler_Impl {
    fn ActivateCompleted(&self, _op: Option<&IActivateAudioInterfaceAsyncOperation>) -> Result<()> {
        unsafe { SetEvent(self.done) }
    }
}

/// VT_BLOB PROPVARIANT와 같은 배치 (x64 기준 24바이트).
/// 버전마다 바뀌는 PROPVARIANT 래퍼를 피하려고 직접 만든다.
#[repr(C)]
struct BlobPropVariant {
    vt: u16,
    reserved: [u16; 3],
    cb_size: u32,
    p_blob: *const u8,
}
const VT_BLOB: u16 = 65;
const _: () = assert!(std::mem::size_of::<BlobPropVariant>() == 24);

fn activate_process_loopback(pid: u32) -> Result<IAudioClient> {
    unsafe {
        let params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: pid,
                    ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
                },
            },
        };
        let pv = BlobPropVariant {
            vt: VT_BLOB,
            reserved: [0; 3],
            cb_size: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
            p_blob: &params as *const _ as *const u8,
        };

        let done = CreateEventW(None, false, false, None)?;
        let handler: IActivateAudioInterfaceCompletionHandler = ActivateHandler { done }.into();
        let op = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&pv as *const _ as *const _),
            &handler,
        )?;
        let waited = WaitForSingleObject(done, 10_000);
        let _ = CloseHandle(done);
        if waited != WAIT_OBJECT_0 {
            return Err(windows::core::Error::new(
                HRESULT(0x8000_0004u32 as i32),
                "오디오 활성화 응답이 10초 안에 오지 않음",
            ));
        }

        let mut hr = HRESULT(0);
        let mut iface: Option<windows::core::IUnknown> = None;
        op.GetActivateResult(&mut hr, &mut iface)?;
        hr.ok()?;
        iface
            .ok_or_else(|| windows::core::Error::new(HRESULT(0x8000_4005u32 as i32), "오디오 인터페이스가 비어 있음"))?
            .cast::<IAudioClient>()
    }
}

pub fn capture_process(pid: u32) -> Result<()> {
    com_init()?;
    let client = activate_process_loopback(pid)?;
    let block_align = LOOPBACK_CHANNELS * 2;
    let wfx = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM as u16,
        nChannels: LOOPBACK_CHANNELS,
        nSamplesPerSec: LOOPBACK_RATE,
        nAvgBytesPerSec: LOOPBACK_RATE * block_align as u32,
        nBlockAlign: block_align,
        wBitsPerSample: 16,
        cbSize: 0,
    };
    unsafe {
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
            2_000_000, // 200ms (100ns 단위)
            0,
            &wfx,
            None,
        )?;
    }
    let conv = Converter::new(SampleFormat::I16, LOOPBACK_CHANNELS as usize, LOOPBACK_RATE);
    pump(&client, block_align as usize, conv)
}

pub fn capture_mic(id: &str) -> Result<()> {
    com_init()?;
    let en = enumerator()?;
    let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let dev = en.GetDevice(PCWSTR(wide.as_ptr()))?;
        let client = dev.Activate::<IAudioClient>(CLSCTX_ALL, None)?;
        let mix = client.GetMixFormat()?;
        let w = &*mix;
        let ext_is_float = (w.wFormatTag == WAVE_FORMAT_EXTENSIBLE && w.cbSize >= 22).then(|| {
            let ext = &*(mix as *const WAVEFORMATEXTENSIBLE);
            let sub: GUID = ext.SubFormat;
            sub == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
        });
        let (tag, bits, channels, rate, align) =
            (w.wFormatTag, w.wBitsPerSample, w.nChannels, w.nSamplesPerSec, w.nBlockAlign);
        let init = client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            2_000_000,
            0,
            mix,
            None,
        );
        CoTaskMemFree(Some(mix as _));
        init?;

        let format = detect_format(tag, bits, ext_is_float).ok_or_else(|| {
            windows::core::Error::new(
                HRESULT(0x8889_0008u32 as i32),
                format!("지원하지 않는 마이크 형식 (tag={tag:#x}, bits={bits})").as_str(),
            )
        })?;
        let conv = Converter::new(format, channels as usize, rate);
        pump(&client, align as usize, conv)
    }
}

/// 이벤트를 기다리며 버퍼를 꺼내 변환 후 stdout으로 쓴다.
/// stdout이 닫히면(앱이 끊으면) 정상 종료한다.
fn pump(client: &IAudioClient, block_align: usize, mut conv: Converter) -> Result<()> {
    unsafe {
        let event = CreateEventW(None, false, false, None)?;
        client.SetEventHandle(event)?;
        let cap: IAudioCaptureClient = client.GetService()?;
        client.Start()?;

        let stdout = std::io::stdout();
        let mut out = stdout.lock();
        let mut raw: Vec<u8> = Vec::new();

        loop {
            // 소리가 없어도 주기적으로 깨어나도록 시간 제한을 둔다
            let _ = WaitForSingleObject(event, 500);
            loop {
                let packet = cap.GetNextPacketSize()?;
                if packet == 0 {
                    break;
                }
                let mut data: *mut u8 = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                cap.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
                let len = frames as usize * block_align;
                raw.clear();
                if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                    raw.resize(len, 0);
                } else {
                    raw.extend_from_slice(std::slice::from_raw_parts(data, len));
                }
                cap.ReleaseBuffer(frames)?;

                let pcm = conv.push(&raw);
                if !pcm.is_empty() && (out.write_all(&pcm).is_err() || out.flush().is_err()) {
                    let _ = client.Stop();
                    let _ = CloseHandle(event);
                    return Ok(());
                }
            }
        }
    }
}
