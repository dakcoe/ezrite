//! 프로세스 트리 계산 (순수 코드).
//! Chrome처럼 소리를 하위 프로세스가 내는 프로그램을 맨 위 프로세스 하나로 묶을 때 쓴다.

use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct ProcInfo {
    pub parent: u32,
    pub exe: String,
}

/// 같은 exe 이름을 가진 부모를 따라 올라가 가장 위 pid를 돌려준다.
/// 부모가 이미 끝났거나 pid가 재사용돼 고리가 생겨도 멈추도록 횟수를 제한한다.
pub fn root_of(pid: u32, procs: &HashMap<u32, ProcInfo>) -> u32 {
    let Some(me) = procs.get(&pid) else {
        return pid;
    };
    let mut cur = pid;
    for _ in 0..64 {
        let Some(info) = procs.get(&cur) else { break };
        let parent = info.parent;
        if parent == 0 || parent == cur {
            break;
        }
        match procs.get(&parent) {
            Some(p) if p.exe.eq_ignore_ascii_case(&me.exe) => cur = parent,
            _ => break,
        }
    }
    cur
}

/// 목록에 넣지 않는 창: Windows 셸·입력기 같은 시스템 창과 Ezrite 자신
const NOT_SOURCES: &[&str] = &[
    "explorer.exe",
    "applicationframehost.exe",
    "textinputhost.exe",
    "shellexperiencehost.exe",
    "startmenuexperiencehost.exe",
    "searchhost.exe",
    "lockapp.exe",
    "systemsettings.exe",
    "ezrite.exe",
    "ezrite-audio.exe",
];

/// 창이 있는 프로그램(맨 위 pid)을 소리 없음(false)으로 더한다. 맥처럼 소리를 내기 전에도 고를 수 있게.
/// 이미 있는 pid 는 그대로 두고, 처음 본 순서대로 붙인다
pub fn add_windowed(roots: &mut Vec<(u32, bool)>, window_pids: impl IntoIterator<Item = u32>, procs: &HashMap<u32, ProcInfo>) {
    for pid in window_pids {
        let root = root_of(pid, procs);
        let Some(info) = procs.get(&root) else { continue };
        let exe = info.exe.to_ascii_lowercase();
        if NOT_SOURCES.contains(&exe.as_str()) || roots.iter().any(|(p, _)| *p == root) {
            continue;
        }
        roots.push((root, false));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn procs(list: &[(u32, u32, &str)]) -> HashMap<u32, ProcInfo> {
        list.iter()
            .map(|&(pid, parent, exe)| (pid, ProcInfo { parent, exe: exe.to_string() }))
            .collect()
    }

    #[test]
    fn 크롬_하위_프로세스는_맨_위_크롬으로_묶인다() {
        let p = procs(&[
            (10, 1, "explorer.exe"),
            (100, 10, "chrome.exe"),
            (200, 100, "chrome.exe"),
            (300, 200, "CHROME.EXE"),
        ]);
        assert_eq!(root_of(300, &p), 100);
        assert_eq!(root_of(100, &p), 100);
    }

    #[test]
    fn 다른_이름의_부모에서는_멈춘다() {
        let p = procs(&[(10, 1, "explorer.exe"), (20, 10, "spotify.exe")]);
        assert_eq!(root_of(20, &p), 20);
    }

    #[test]
    fn 창이_있는_프로그램은_소리가_없어도_목록에_더한다() {
        let p = procs(&[
            (10, 1, "explorer.exe"),
            (100, 10, "chrome.exe"),
            (200, 100, "chrome.exe"),
            (300, 10, "Code.exe"),
            (400, 10, "spotify.exe"),
            (500, 10, "TextInputHost.exe"),
            (600, 10, "Ezrite.exe"),
        ]);
        // spotify 는 소리 세션이 있다 (active)
        let mut roots = vec![(400, true)];
        add_windowed(&mut roots, [200, 300, 400, 10, 500, 600, 999], &p);
        assert_eq!(roots, vec![(400, true), (100, false), (300, false)]);
    }

    #[test]
    fn 모르는_pid와_고리는_안전하게_처리한다() {
        let p = procs(&[(5, 6, "a.exe"), (6, 5, "a.exe")]);
        assert_eq!(root_of(999, &p), 999);
        let r = root_of(5, &p);
        assert!(r == 5 || r == 6);
    }
}
