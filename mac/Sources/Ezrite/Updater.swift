import AppKit
import Foundation

/// 새 버전 알림. 켤 때와 6시간마다 GitHub 의 최신 릴리스를 물어보고, 앱보다 높으면 팝업 위에 띠를 띄운다.
/// 설치는 사용자가 [받기]로 DMG 를 받아 직접 한다 (자동 설치는 Apple 개발자 서명이 있어야 매끄럽다).
/// 보내는 것은 릴리스 조회 요청 하나뿐이다. 개인 정보는 보내지 않는다
final class Updater: ObservableObject {
    struct Release: Equatable {
        let version: String
        let notes: String
        let download: URL
    }

    @Published private(set) var available: Release?
    /// 설정의 [업데이트 확인] 을 누른 뒤 결과를 기다리는 중
    @Published private(set) var checking = false
    /// 마지막 확인이 끝난 시각 (설정에 "최신 버전입니다" 를 띄울 때 쓴다)
    @Published private(set) var checkedAt: Date?

    /// 릴리스를 올리는 GitHub 저장소 ("owner/name"). Info.plist 의 EzriteUpdateRepo
    static var repo: String? { Bundle.main.object(forInfoDictionaryKey: "EzriteUpdateRepo") as? String }
    static var current: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0" }
    static let interval: TimeInterval = 6 * 3600
    private var timer: Timer?
    /// [나중에] 로 닫은 버전. 이번 확인 동안만 숨기고, 앱을 다시 켜거나 다음 확인(6시간) 때 다시 알린다
    private var snoozed: String?
    private var snoozeChecks = 0                   // 닫은 뒤 지난 확인 횟수

    func start() {
        check()
        timer = Timer.scheduledTimer(withTimeInterval: Self.interval, repeats: true) { [weak self] _ in self?.check() }
    }

    func check() {
        newCheck()
        // 개발용: 릴리스 JSON 파일로 띠 모양을 확인한다
        if let path = ProcessInfo.processInfo.environment["EZRITE_UPDATE_JSON"],
           let data = FileManager.default.contents(atPath: path) {
            available = Self.release(from: data)
            return
        }
        guard let repo = Self.repo, let url = URL(string: "https://api.github.com/repos/\(repo)/releases/latest") else { return }
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        checking = true
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            let r = (resp as? HTTPURLResponse)?.statusCode == 200 ? data.flatMap(Self.release(from:)) : nil
            DispatchQueue.main.async {
                guard let self else { return }
                self.checking = false
                guard let r else { return }
                self.checkedAt = Date()
                self.available = self.shouldShow(r.version, current: Self.current) ? r : nil
            }
        }.resume()
    }

    /// [받기]: DMG(없으면 릴리스 페이지)를 브라우저로 연다
    func download() {
        guard let r = available else { return }
        NSWorkspace.shared.open(r.download)
    }

    /// [나중에]: 지금만 닫는다
    func skip() {
        guard let r = available else { return }
        snooze(r.version)
        available = nil
    }

    func snooze(_ version: String) { snoozed = version; snoozeChecks = 0 }

    /// 설정의 [업데이트 확인]: 직접 눌렀으니 [나중에] 로 닫은 것도 다시 보여준다
    func checkNow() {
        snoozed = nil
        check()
    }

    /// 문제 신고 양식 (버전·macOS·칩을 미리 채운다)
    static var issueURL: URL? {
        guard let repo else { return nil }
        let os = ProcessInfo.processInfo.operatingSystemVersion
        var size = 0; sysctlbyname("hw.machine", nil, &size, nil, 0)
        var machine = [CChar](repeating: 0, count: size); sysctlbyname("hw.machine", &machine, &size, nil, 0)
        let chip = String(cString: machine) == "arm64" ? "Apple 칩" : "Intel"
        var c = URLComponents(string: "https://github.com/\(repo)/issues/new")
        c?.queryItems = [URLQueryItem(name: "template", value: "bug.yml"),
                         URLQueryItem(name: "version", value: current),
                         URLQueryItem(name: "mac", value: "macOS \(os.majorVersion).\(os.minorVersion).\(os.patchVersion), \(chip)")]
        return c?.url
    }

    static var build: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "" }

    /// 새로 확인할 때마다 부른다. 닫은 뒤 한 번 더 확인하면 다시 알린다
    func newCheck() {
        if snoozed != nil { snoozeChecks += 1 }
        if snoozeChecks >= 1 { snoozed = nil; snoozeChecks = 0 }
    }

    func shouldShow(_ version: String, current: String) -> Bool {
        Self.isNewer(version, than: current) && snoozed != version
    }

    // MARK: 계산

    /// "v2.0.10" 처럼 앞의 v 를 떼고 점으로 나눈 숫자끼리 비교한다
    static func isNewer(_ a: String, than b: String) -> Bool {
        let parts = { (s: String) in
            s.trimmingCharacters(in: CharacterSet(charactersIn: "vV ")).split(separator: ".").map { Int($0) ?? 0 }
        }
        let x = parts(a), y = parts(b)
        for i in 0..<max(x.count, y.count) {
            let p = i < x.count ? x[i] : 0, q = i < y.count ? y[i] : 0
            if p != q { return p > q }
        }
        return false
    }

    static func release(from data: Data) -> Release? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tag = obj["tag_name"] as? String,
              let page = (obj["html_url"] as? String).flatMap(trusted) else { return nil }
        let assets = (obj["assets"] as? [[String: Any]]) ?? []
        let dmg = assets.first { ($0["name"] as? String)?.lowercased().hasSuffix(".dmg") == true }?["browser_download_url"] as? String
        return Release(version: tag.trimmingCharacters(in: CharacterSet(charactersIn: "vV ")),
                       notes: ((obj["body"] as? String) ?? "").replacingOccurrences(of: "\r\n", with: "\n")
                           .trimmingCharacters(in: .whitespacesAndNewlines),
                       download: dmg.flatMap(trusted) ?? page)
    }

    /// [받기] 로 여는 주소는 https 의 GitHub 것만 믿는다 (응답이 바뀌어도 다른 곳을 열지 않게)
    static func trusted(_ s: String) -> URL? {
        guard let u = URL(string: s), u.scheme == "https", let host = u.host?.lowercased() else { return nil }
        return host == "github.com" || host.hasSuffix(".githubusercontent.com") ? u : nil
    }
}
