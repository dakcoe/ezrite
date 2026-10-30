import AppKit
import Foundation
import Security

/// 새 버전 알림. 켤 때와 6시간마다 GitHub 의 최신 릴리스를 물어보고, 앱보다 높으면 팝업 위에 띠를 띄운다.
/// [업데이트] 는 릴리스의 zip 을 앱이 직접 받아 풀고, 지금 앱과 같은 인증서로 서명됐는지 확인한 뒤 바꿔 끼우고 다시 켠다.
/// 앱이 받은 파일에는 격리 표시가 붙지 않아 "그래도 열기" 가 다시 뜨지 않는다. zip 이 없거나 바꿀 수 없으면 예전처럼 DMG 를 연다.
/// 보내는 것은 릴리스 조회 요청 하나뿐이다. 개인 정보는 보내지 않는다
final class Updater: ObservableObject {
    struct Release: Equatable {
        let version: String
        let notes: String
        let download: URL
        /// 앱 자동 교체용 zip (없으면 nil — 옛 릴리스)
        var zip: URL?
    }

    @Published private(set) var available: Release?
    /// 설정의 [업데이트 확인] 을 누른 뒤 결과를 기다리는 중
    @Published private(set) var checking = false
    /// 마지막 확인이 끝난 시각 (설정에 "최신 버전입니다" 를 띄울 때 쓴다)
    @Published private(set) var checkedAt: Date?
    /// 설정에 보이는 최근 버전들의 핵심 변경 (릴리스 글 맨 위 줄들)
    @Published private(set) var history: [Highlights] = []
    /// [업데이트] 로 받고 확인하는 중
    @Published private(set) var installing = false
    @Published private(set) var installError: String?
    /// 지금 바꿔 끼우면 안 되는 때 (녹음·다시 받아쓰기 중). AppDelegate 가 채운다
    var busy: () -> Bool = { false }

    struct Highlights: Equatable, Identifiable {
        let version: String
        let points: [String]
        var id: String { version }
    }

    /// 릴리스를 올리는 GitHub 저장소 ("owner/name"). Info.plist 의 EzriteUpdateRepo
    static var repo: String? { Bundle.main.object(forInfoDictionaryKey: "EzriteUpdateRepo") as? String }
    static var current: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0" }
    static let interval: TimeInterval = 6 * 3600
    private var timer: Timer?
    /// [나중에] 로 닫은 버전. 이번 확인 동안만 숨기고, 앱을 다시 켜거나 다음 확인(6시간) 때 다시 알린다
    private var snoozed: String?
    private var snoozeChecks = 0                   // 닫은 뒤 지난 확인 횟수

    func start() {
        // 지난 업데이트 때 받아 둔 파일. 바꿔 끼운 뒤 다시 켜진 이때 지운다
        try? FileManager.default.removeItem(at: Self.work)
        check()
        timer = Timer.scheduledTimer(withTimeInterval: Self.interval, repeats: true) { [weak self] _ in self?.check() }
    }

    func check() {
        newCheck()
        // 개발용: 릴리스 JSON 파일로 띠 모양을 확인한다
        if let path = ProcessInfo.processInfo.environment["EZRITE_UPDATE_JSON"],
           let data = FileManager.default.contents(atPath: path) {
            available = Self.release(from: data)
            // 개발용: 이 zip 으로 자동 교체를 시험한다
            if let zip = ProcessInfo.processInfo.environment["EZRITE_UPDATE_ZIP"] { available?.zip = URL(fileURLWithPath: zip) }
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

    /// 앱이 직접 바꿔 끼울 수 있나: zip 이 있고, 앱이 사용자가 쓸 수 있는 폴더에 있다
    var canInstall: Bool {
        available?.zip != nil && FileManager.default.isWritableFile(atPath: Bundle.main.bundleURL.deletingLastPathComponent().path)
    }

    /// [업데이트]: zip 받기 → 풀기 → 서명·버전 확인 → 앱이 끝난 뒤 바꿔 끼우고 다시 켠다. 안 되면 DMG 를 연다
    func install() {
        guard let r = available, let zip = r.zip, canInstall else { return download() }
        guard !busy() else { installError = "녹음이 끝나면 업데이트할 수 있어요"; return }
        installing = true; installError = nil
        let fail: (String) -> Void = { msg in DispatchQueue.main.async { self.installing = false; self.installError = msg } }
        let work = Self.work
        let unpack: (URL) -> Void = { file in
            try? FileManager.default.removeItem(at: work.appendingPathComponent("app"))
            let app = work.appendingPathComponent("app/Ezrite.app")
            guard Self.run("/usr/bin/ditto", ["-x", "-k", file.path, work.appendingPathComponent("app").path]),
                  FileManager.default.fileExists(atPath: app.path) else { return fail("받은 파일을 풀지 못했어요") }
            guard Self.sameSigner(app) else { return fail("받은 앱의 서명이 달라 설치하지 않았어요") }
            let v = Bundle(url: app)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
            guard Self.isNewer(v, than: Self.current) else { return fail("받은 앱이 지금보다 새 버전이 아니에요") }
            DispatchQueue.main.async {
                guard !self.busy() else { self.installing = false; self.installError = "녹음이 끝나면 업데이트할 수 있어요"; return }
                self.relaunch(into: app)
            }
        }
        try? FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        if zip.isFileURL { DispatchQueue.global().async { unpack(zip) }; return }
        URLSession.shared.downloadTask(with: URLRequest(url: zip, timeoutInterval: 120)) { tmp, resp, _ in
            guard let tmp, (resp as? HTTPURLResponse)?.statusCode == 200 else { return fail("새 버전을 받지 못했어요") }
            let file = work.appendingPathComponent("Ezrite.zip")
            try? FileManager.default.removeItem(at: file)
            guard (try? FileManager.default.moveItem(at: tmp, to: file)) != nil else { return fail("새 버전을 받지 못했어요") }
            unpack(file)
        }.resume()
    }

    static let work = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Ezrite-update", isDirectory: true)

    /// 이 앱이 끝나기를 기다렸다가 바꿔 끼우고 연다. 실패하면 옛 앱을 되돌려 연다
    private func relaunch(into app: URL) {
        let dest = Bundle.main.bundleURL.path, old = dest + ".old"
        let script = """
        while kill -0 \(ProcessInfo.processInfo.processIdentifier) 2>/dev/null; do sleep 0.2; done
        rm -rf "$3"
        if mv "$1" "$3" && mv "$2" "$1"; then rm -rf "$3"; xattr -dr com.apple.quarantine "$1"
        else [ -e "$1" ] || mv "$3" "$1"; fi
        open "$1"
        """
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", script, "sh", dest, app.path, old]
        do { try p.run() } catch { installing = false; installError = "업데이트를 시작하지 못했어요"; return }
        NSApp.terminate(nil)
    }

    /// 받은 앱이 지금 앱의 지정 요구사항(번들 ID + 인증서)을 채우는지. 자체 서명이라 이것이 바꿔치기를 막는 유일한 확인이다
    static func sameSigner(_ app: URL) -> Bool {
        var me: SecCode?, mine: SecStaticCode?, req: SecRequirement?, other: SecStaticCode?
        guard SecCodeCopySelf([], &me) == errSecSuccess, let me,
              SecCodeCopyStaticCode(me, [], &mine) == errSecSuccess, let mine,
              SecCodeCopyDesignatedRequirement(mine, [], &req) == errSecSuccess, let req,
              SecStaticCodeCreateWithPath(app as CFURL, [], &other) == errSecSuccess, let other else { return false }
        return SecStaticCodeCheckValidity(other, SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate | kSecCSCheckNestedCode), req) == errSecSuccess
    }

    private static func run(_ tool: String, _ args: [String]) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        guard (try? p.run()) != nil else { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0
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

    /// 설정을 열 때 최근 릴리스 몇 개의 핵심 변경을 받아 온다 (한 번 받으면 다시 묻지 않는다)
    func loadHistory(count: Int = 4) {
        guard history.isEmpty, let repo = Self.repo,
              let url = URL(string: "https://api.github.com/repos/\(repo)/releases?per_page=\(count)") else { return }
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            guard (resp as? HTTPURLResponse)?.statusCode == 200, let data,
                  let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
            let items = list.compactMap { r -> Highlights? in
                guard let tag = r["tag_name"] as? String else { return nil }
                return Highlights(version: tag.trimmingCharacters(in: CharacterSet(charactersIn: "vV ")),
                                  points: Self.highlights((r["body"] as? String) ?? ""))
            }
            DispatchQueue.main.async { self?.history = items }
        }.resume()
    }

    /// 릴리스 글에서 첫 "##" 앞의 "- " 줄만 (맨 위 요약). Windows 만의 줄은 맥 앱이라 뺀다
    static func highlights(_ body: String) -> [String] {
        var out: [String] = []
        for raw in body.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("##") { break }
            guard line.hasPrefix("- ") else { continue }
            let text = String(line.dropFirst(2))
            if !text.hasPrefix("Windows") { out.append(text) }
        }
        return out
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
        let asset = { (ext: String) in assets.first { ($0["name"] as? String)?.lowercased().hasSuffix(ext) == true }?["browser_download_url"] as? String }
        let dmg = asset(".dmg")
        return Release(version: tag.trimmingCharacters(in: CharacterSet(charactersIn: "vV ")),
                       notes: ((obj["body"] as? String) ?? "").replacingOccurrences(of: "\r\n", with: "\n")
                           .trimmingCharacters(in: .whitespacesAndNewlines),
                       download: dmg.flatMap(trusted) ?? page,
                       zip: asset(".zip").flatMap(trusted))
    }

    /// [받기] 로 여는 주소는 https 의 GitHub 것만 믿는다 (응답이 바뀌어도 다른 곳을 열지 않게)
    static func trusted(_ s: String) -> URL? {
        guard let u = URL(string: s), u.scheme == "https", let host = u.host?.lowercased() else { return nil }
        return host == "github.com" || host.hasSuffix(".githubusercontent.com") ? u : nil
    }
}
