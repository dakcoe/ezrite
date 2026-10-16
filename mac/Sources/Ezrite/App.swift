import AppKit
import Combine
import SwiftUI
import WebKit

final class AppState: ObservableObject {
    static let languages: [(label: String, code: String)] = [("한국어", "ko"), ("English", "en"), ("日本語", "ja")]
    private static let defaults = UserDefaults.standard

    // 받아쓰기
    @Published var listening = false
    @Published var usage: [String: Usage] = [:]     // 모델 이름 → 오늘 남은 요청 수
    @Published var budget = Budget.load()           // 하루 토큰·음성 시간 (앱이 직접 센다)
    @Published var explaining = false          // "설명해줘" 진행 중
    @Published var paused = false              // 세션은 열려 있고 듣기만 멈춘 상태
    @Published var startedAt: Date?            // 지금 듣기를 시작한 때. 일시정지 중엔 nil
    @Published var recordedBefore: TimeInterval = 0   // 일시정지 전까지 들은 시간
    @Published var entries: [Entry] = []
    @Published var liveSession: URL?           // 지금 쓰고 있는 자동 저장 파일
    @Published var inflight = 0                // Groq 에 보내 놓고 기다리는 발화 수
    @Published var level: Float = 0            // 최근 소리 크기 (파형)
    @Published var error: String?
    /// 위쪽 줄에 잠깐 띄우는 알림. 6초 뒤 저절로 사라진다 (그 사이 새 알림이 오면 그것 기준으로 다시 센다)
    @Published var notice: String? {
        didSet {
            guard let shown = notice else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
                if self?.notice == shown { self?.notice = nil }
            }
        }
    }

    // 설정 — 다음 실행 때도 그대로
    @Published var sources: [AudioSource] = AudioSource.available()
    @Published var sourceID: String = defaults.string(forKey: "sourceID") ?? "system" {
        didSet { Self.defaults.set(sourceID, forKey: "sourceID") }
    }
    @Published var language: String = defaults.string(forKey: "language") ?? "한국어" {
        didSet { Self.defaults.set(language, forKey: "language") }
    }
    @Published var autoTranslate: Bool = defaults.object(forKey: "autoTranslate") as? Bool ?? true {
        didSet { Self.defaults.set(autoTranslate, forKey: "autoTranslate") }
    }
    // AI 서비스: 번역·화면 설명마다 서비스와 모델을 고른다. 받아쓰기는 Groq 고정
    @Published var translateProvider: Provider = Provider(rawValue: defaults.string(forKey: "translateProvider") ?? "") ?? .groq {
        didSet { Self.defaults.set(translateProvider.rawValue, forKey: "translateProvider") }
    }
    @Published var translateModel: String = defaults.string(forKey: "translateModel") ?? "" {
        didSet { Self.defaults.set(translateModel, forKey: "translateModel") }
    }
    @Published var explainProvider: Provider = Provider(rawValue: defaults.string(forKey: "explainProvider") ?? "") ?? .groq {
        didSet { Self.defaults.set(explainProvider.rawValue, forKey: "explainProvider") }
    }
    @Published var explainModel: String = defaults.string(forKey: "explainModel") ?? "" {
        didSet { Self.defaults.set(explainModel, forKey: "explainModel") }
    }
    /// 키를 저장할 때 받아 온 서비스별 모델 목록
    @Published var providerModels: [String: [String]] = defaults.dictionary(forKey: "providerModels") as? [String: [String]] ?? [:] {
        didSet { Self.defaults.set(providerModels, forKey: "providerModels") }
    }
    @Published var providerStatus: [String: String] = [:]      // 키 확인 결과 ("연결됨 · 모델 12개" 등)

    /// 키를 저장하고 모델 목록을 받아 와 확인한다. 아직 고른 모델이 없으면 용도에 맞는 기본 모델을 정한다
    func saveKey(_ p: Provider, _ key: String) {
        APIKey.save(p, key)
        guard !key.isEmpty else {
            providerModels[p.rawValue] = nil
            providerStatus[p.rawValue] = nil
            if translateProvider == p { translateProvider = .groq }
            if explainProvider == p { explainProvider = .groq }
            return
        }
        providerStatus[p.rawValue] = "키 확인 중"
        checking[p.rawValue] = Date()
        Task { @MainActor in
            defer { checking[p.rawValue] = nil }
            do {
                let list = try await AI.models(p)
                providerModels[p.rawValue] = list
                providerStatus[p.rawValue] = "연결됨 · 쓸 수 있는 모델 확인 중"
                // 무료 등급은 목록에 있어도 막힌 모델이 많다. 실제로 답하는 모델을 용도별 기본으로 정해 둔다
                guard p != .groq else { providerStatus[p.rawValue] = "연결됨"; return }
                var parts: [String] = [], why: String?
                for f in [Feature.explain, .translate] {
                    let (m, reason) = await AI.firstWorking(p, list, for: f)
                    providerDefaults[p.rawValue + "." + f.key] = m
                    if let m {
                        if f == .explain && explainProvider == p { explainModel = m }
                        if f == .translate && translateProvider == p { translateModel = m }
                    } else { why = reason }
                    parts.append("\(f == .explain ? "화면 설명" : "번역") \(m ?? "쓸 수 없음")")
                }
                providerStatus[p.rawValue] = "연결됨 · " + parts.joined(separator: " · ") + (why.map { " (\($0))" } ?? "")
            } catch {
                providerStatus[p.rawValue] = error.localizedDescription
            }
        }
    }

    /// 설정에서 고른 모델을 바로 불러 봐서 쓸 수 있는지 알려 준다 ("서비스.용도" → 결과 글)
    @Published var modelCheck: [String: String] = [:]
    /// 확인을 시작한 때 (진행 표시의 경과 초). 확인 중일 때만 있다
    @Published var checking: [String: Date] = [:]

    func checkModel(_ p: Provider, _ model: String, for feature: Feature) {
        let k = p.rawValue + "." + feature.key
        guard p != .groq, !model.isEmpty else { modelCheck[k] = nil; return }
        modelCheck[k] = "확인 중"
        let started = Date()
        checking[k] = started
        Task { @MainActor in
            let reason = await AI.check(p, model: model)
            // 그 사이 다른 모델로 바꿨으면 버린다
            let now = feature == .explain ? explainModel : translateModel
            guard now == model, checking[k] == started else { return }
            checking[k] = nil
            modelCheck[k] = reason.map { "✕ 쓸 수 없음 — \($0)" } ?? "✓ 쓸 수 있음"
        }
    }

    /// 키를 저장할 때 실제로 불러 보고 정한 용도별 기본 모델 ("서비스.용도" → 모델)
    @Published var providerDefaults: [String: String] = defaults.dictionary(forKey: "providerDefaults") as? [String: String] ?? [:] {
        didSet { Self.defaults.set(providerDefaults, forKey: "providerDefaults") }
    }

    /// 서비스를 바꾸면 그 서비스에서 용도에 맞는 모델을 기본으로 고른다
    func defaultModel(_ p: Provider, for feature: Feature) -> String {
        providerDefaults[p.rawValue + "." + feature.key] ?? AI.pick(providerModels[p.rawValue] ?? [], for: feature) ?? ""
    }

    /// 녹음 버튼을 누를 때마다 소리 출처·인식 언어를 먼저 고른다
    @Published var askBeforeRecord: Bool = defaults.object(forKey: "askBeforeRecord") as? Bool ?? true {
        didSet { Self.defaults.set(askBeforeRecord, forKey: "askBeforeRecord") }
    }
    /// 고르는 말풍선이 떠 있는 중 (녹음 전), 그리고 어느 쪽 ● 에서 눌렀는지
    @Published var choosing = false
    var choosingPlace = "popup"

    /// 팝업을 최근 한 줄과 번역만 보이는 작은 띠로
    @Published var compact: Bool = defaults.bool(forKey: "compact") {
        didSet { Self.defaults.set(compact, forKey: "compact") }
    }

    /// AI 지침: ✨ 설명과 질문 답에 함께 들어간다 (수준, 말투, 강조할 것)
    @Published var userGuide: String = defaults.string(forKey: "userGuide") ?? "" {
        didSet {
            Self.defaults.set(userGuide, forKey: "userGuide")
            GroqClient.guide = userGuide
        }
    }

    /// 비어 있으면 기본 위치(Notes.defaultDir)
    @Published var notesFolder: String = defaults.string(forKey: "notesFolder") ?? "" {
        didSet {
            Self.defaults.set(notesFolder, forKey: "notesFolder")
            Notes.dir = notesDir
        }
    }
    var notesDir: URL { notesFolder.isEmpty ? Notes.defaultDir : URL(fileURLWithPath: notesFolder) }
    @Published var includeMic: Bool = defaults.bool(forKey: "includeMic") {
        didSet { Self.defaults.set(includeMic, forKey: "includeMic") }
    }

    var selectedSource: AudioSource {
        sources.first { $0.id == sourceID } ?? .system
    }

    var languageCode: String {
        Self.languages.first { $0.label == language }?.code ?? "ko"
    }

    /// 팝오버를 열 때마다 실행 중인 앱 목록을 새로 본다. 저장해 둔 앱이 꺼져 있어도 목록에서 사라지지 않게 한다.
    func refreshSources() {
        var list = AudioSource.available()
        if !list.contains(where: { $0.id == sourceID }), let kept = sources.first(where: { $0.id == sourceID }) {
            list.append(kept)
        }
        sources = list
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    static weak var shared: AppDelegate?
    let state = AppState()
    let popover = PopoverModel()
    let updater = Updater()               // 창을 닫았다 열어도 보던 화면이 남는다
    private var transcriber: Transcriber!
    private var explainer: Explainer!
    private var statusBar: StatusBar!
    private(set) var retx: Retranscriber!
    private var main: NSWindow?
    private var onboarding: NSWindow?
    private var guide: NSWindow?
    private let guideNav = GuideNav()
    private var bag: Set<AnyCancellable> = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        AppDelegate.shared = self
        Notes.dir = state.notesDir
        GroqClient.guide = state.userGuide
        Notes.prune()
        transcriber = Transcriber(state: state)
        explainer = MainActor.assumeIsolated { Explainer() }
        MainActor.assumeIsolated {
            explainer.context = { [weak self] in
                guard let s = self?.state else { return ([], .groq, "") }
                // 질문은 설명보다 길게: 최근 30문장 (대략 5분)
                return (s.entries.filter { $0.kind == .text }.suffix(30).map(\.original), s.explainProvider, s.explainModel)
            }
        }
        retx = MainActor.assumeIsolated { Retranscriber() }
        statusBar = StatusBar(state: state, updater: updater)
        updater.start()
        Usage.report = { [weak self] model, u in DispatchQueue.main.async { self?.state.usage[model] = u } }
        Usage.spent = { [weak self] model, kind, amount in
            DispatchQueue.main.async {
                guard let self else { return }
                self.state.budget.note(model, kind, amount)
                self.state.budget.save()
            }
        }
        Task { await GroqClient().probeLimits() }
        // 녹음 중에 설정을 바꾸면 같은 기록 안에서 바로 반영한다.
        // @Published 는 값이 바뀌기 직전에 알리므로 main 큐로 한 번 미뤄서 바뀐 값을 읽는다
        Publishers.Merge(state.$sourceID.map { _ in () }, state.$includeMic.map { _ in () })
            .dropFirst(2)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] in
                guard let self, self.state.listening else { return }
                MainActor.assumeIsolated { Task { await self.transcriber.switchSource() } }
            }
            .store(in: &bag)
        state.$language.dropFirst().removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in MainActor.assumeIsolated { self?.transcriber.languageChanged() } }
            .store(in: &bag)
        // 처음 켰을 때: 키가 없으면 키·권한 안내, 있으면 팝업과 사용 가이드를 바로 띄운다 (메뉴바 아이콘만 생겨서 설치됐는지 모르기 쉽다)
        if DevFeed.file == nil && ProcessInfo.processInfo.environment["EZRITE_PREVIEW"] == nil {
            if APIKey.groq() == nil { showOnboarding() }
            else if !Self.defaults.bool(forKey: Self.welcomedKey) { welcome() }
        }
        if ProcessInfo.processInfo.environment["EZRITE_PREVIEW"] == nil { Installer.tidy() }   // 설치 DMG 정리
        let script = ProcessInfo.processInfo.environment["EZRITE_SCRIPT"]                              // 개발용
        if DevFeed.file != nil && script == nil { state.choosing = true; toggleListening() }   // 개발용 흘려 넣기는 바로 시작
        if let script { runScript(script) }
        if ProcessInfo.processInfo.environment["EZRITE_CHOOSE"] != nil {                                // 개발용
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.state.choosing = true }        // 팝업이 뜬 뒤에
        }
        if let page = ProcessInfo.processInfo.environment["EZRITE_PREVIEW"] { showPreview(page) }   // 개발용
        if let path = ProcessInfo.processInfo.environment["EZRITE_CARD"],                                // 개발용
           let data = FileManager.default.contents(atPath: path),
           let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            MainActor.assumeIsolated { explainer.demo(payload) }
        }
        if let path = ProcessInfo.processInfo.environment["EZRITE_RETX"] {                                 // 개발용
            MainActor.assumeIsolated { retx.start(URL(fileURLWithPath: path), state: state) { _ in } }
        }
        if let q = ProcessInfo.processInfo.environment["EZRITE_ASK"] {                                    // 개발용
            MainActor.assumeIsolated { explainer.devQuestion = q }
        }
        if let delay = ProcessInfo.processInfo.environment["EZRITE_EXPLAIN"].flatMap(Double.init) {     // 개발용
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.explain() }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated { transcriber.stop() }
        // 녹음 조각을 하나로 합치는 중이면 끝날 때까지 기다린다 (2시간 녹음도 10초 안쪽). 못 기다려도 다음 실행 때 합친다
        Notes.AudioRecorder.waitForMerges()
    }

    /// ● 버튼: 녹음 중이면 끝내고, 아니면 (묻기가 켜져 있으면) 소리 출처·언어 고르는 칸을 먼저 띄운다
    func toggleListening(from place: String = "popup") {
        if !state.listening && state.askBeforeRecord && !state.choosing {
            state.refreshSources()
            state.choosingPlace = place
            state.choosing = true
            return
        }
        state.choosing = false
        MainActor.assumeIsolated { transcriber.toggle() }
    }

    /// 지금 화면과 최근 강의 말을 Groq 에 보내 화면 위 표시와 설명 카드를 띄운다
    func explain() {
        let recent = state.entries.filter { $0.kind == .text }.suffix(12).map(\.original)
        state.explaining = true
        Task { @MainActor in
            await explainer.run(transcript: Array(recent), provider: state.explainProvider, model: state.explainModel,
                                onNotice: { [weak self] in self?.state.notice = $0 })
            state.explaining = false
        }
    }

    /// 개발용(홍보 영상 녹화): "pop@1;choose@3;source@5=Google Chrome;start@7;explain@40" 처럼
    /// 시각(초)마다 정해 둔 조작을 한다. 녹음은 EZRITE_TESTFILE 소리로 흘려 넣는다
    private func runScript(_ script: String) {
        for step in script.split(separator: ";") {
            let parts = step.split(separator: "@", maxSplits: 1)
            guard parts.count == 2 else { continue }
            let arg = parts[1].split(separator: "=", maxSplits: 1)
            guard let at = Double(arg[0]) else { continue }
            let value = arg.count > 1 ? String(arg[1]) : ""
            DispatchQueue.main.asyncAfter(deadline: .now() + at) { [self] in
                switch parts[0] {
                case "pop": statusBar.show()
                case "choose": toggleListening(from: "popup")
                case "source":
                    state.refreshSources()
                    if let s = state.sources.first(where: { $0.label == value }) { state.sourceID = s.id }
                case "start": if state.choosing { toggleListening(from: state.choosingPlace) }
                case "explain": explain()
                case "stop": if state.listening { toggleListening() }
                default: break
                }
            }
        }
    }

    func togglePause() {
        MainActor.assumeIsolated { transcriber.togglePause() }
    }

    var popupFrame: NSRect? { statusBar.frame }

    /// 팝업의 ⚙ 버튼: 팝업을 닫고 전체 창을 띄운다
    func showMainWindow() {
        statusBar.hide()
        if main == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 600),
                             styleMask: [.titled, .closable, .miniaturizable, .resizable],
                             backing: .buffered, defer: false)
            w.title = "Ezrite"
            w.isReleasedWhenClosed = false
            w.contentViewController = NSHostingController(rootView: MainView()
                .environmentObject(state).environmentObject(popover).environmentObject(updater))
            w.setFrameAutosaveName("MainWindow")
            if !w.setFrameUsingName("MainWindow") { w.center() }
            main = w
        }
        NSApp.activate(ignoringOtherApps: true)
        main?.makeKeyAndOrderFront(nil)
    }

    /// 사용 가이드 (Resources/web/guide.html)
    func showGuide() {
        if guide == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 720),
                             styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
            w.title = "Ezrite 사용 가이드"
            w.isReleasedWhenClosed = false
            let web = WKWebView()
            web.navigationDelegate = guideNav
            if let page = Bundle.main.url(forResource: "guide", withExtension: "html", subdirectory: "web") {
                web.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
            }
            w.contentView = web
            w.setFrameAutosaveName("GuideWindow")
            if !w.setFrameUsingName("GuideWindow") { w.center() }
            guide = w
        }
        NSApp.activate(ignoringOtherApps: true)
        guide?.makeKeyAndOrderFront(nil)
    }

    private static let welcomedKey = "welcomed"
    private static var defaults: UserDefaults { .standard }

    /// 처음 한 번: 메뉴바 팝업을 열고 사용 가이드를 띄운다
    func welcome() {
        Self.defaults.set(true, forKey: Self.welcomedKey)
        statusBar.show()
        showGuide()
    }

    func showOnboarding() {
        if onboarding == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 820),
                             styleMask: [.titled, .closable], backing: .buffered, defer: false)
            w.title = "Ezrite"
            w.isReleasedWhenClosed = false
            w.contentViewController = NSHostingController(rootView: OnboardingView { [weak self] in
                self?.onboarding?.close()
                self?.welcome()                         // 메뉴바 팝업과 사용 가이드로 어디서 시작하는지 보여준다
            }.environmentObject(state))
            w.center()
            onboarding = w
        }
        NSApp.activate(ignoringOtherApps: true)
        onboarding?.makeKeyAndOrderFront(nil)
    }

    /// 개발용: 화면을 코드로 열어 스크린샷으로 확인한다. mini 는 메뉴바 팝업
    private func showPreview(_ page: String) {
        if page == "onboarding" { return showOnboarding() }
        if page == "guide" { return showGuide() }
        guard page == "mini" else {
            if page == "record" {                       // 가장 최근 기록을 연 화면
                popover.page = .history
                popover.open(Notes.sessions().first?.url)
            } else {
                popover.page = PopoverModel.Page(rawValue: page) ?? .live
            }
            return showMainWindow()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.statusBar.show() }   // 흘려 넣기 시작이 팝업을 닫지 않게 뒤에 연다
    }
}

/// 가이드가 다 그려지면 맨 위(제목)부터 보이게 한다
final class GuideNav: NSObject, WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript("window.scrollTo(0, 0)")
    }
}
