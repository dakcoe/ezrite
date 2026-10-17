import AppKit
import SwiftUI

/// 팝오버 화면 상태. @State 대신 ObservableObject (DEVELOPMENT.md 참고)
final class PopoverModel: ObservableObject {
    enum Page: String { case live, history, settings }
    @Published var page: Page = .live
    @Published var sessions: [Notes.Session] = []
    @Published var opened: URL?                 // 지난 기록에서 연 세션
    @Published var loaded: [Entry] = []
    @Published var keyDrafts: [String: String] = [:]     // 서비스별로 입력 중인 키
    @Published var titleDraft = ""
    @Published var confirmDelete = false
    /// 다시 받아 적는 기록 (그동안 이름 바꾸기·지우기를 막는다)
    @Published var retxRunning: URL?
    /// 기록을 휴지통으로 옮기지 못했을 때 그 이유
    @Published var deleteError: String?
    @Published var confirmRetx = false
    let player = Player()

    func reloadSessions() { sessions = Notes.sessions() }

    func open(_ url: URL?) {
        opened = url
        loaded = url.map(Notes.load) ?? []
        titleDraft = url.map(Notes.title) ?? ""
        if let audio = url.flatMap(Notes.audioURL) { player.open(audio) } else { player.close() }
    }
}

/// 메뉴바 아이콘을 누르면 아이콘 아래에 뜨는 작은 팝업: 지금 받아 적는 내용만 본다.
/// ⚙ 버튼을 누르면 전체 창(MainView)이 설정 화면으로 뜬다. 지난 기록은 그 창의 탭에서 본다.
struct MenuPopover: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        if state.compact { CompactPopover() } else { full }
    }

    private var full: some View {
        VStack(spacing: 0) {
            UpdateBanner()
            SavedBanner()
            StatusHeader {
                Button {
                    AppDelegate.shared?.popover.page = .settings
                    AppDelegate.shared?.showMainWindow()
                } label: {
                    Image(systemName: "gearshape")
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                        .frame(width: 26, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("설정")
            }
            .background(WindowDragArea())               // 위쪽 줄 빈 곳을 잡고 끌어 옮긴다
            Divider().opacity(0.4)
            LivePage().frame(height: 260)
            Divider().opacity(0.4)
            UsageFooter()
        }
        .frame(width: 340)
        .onAppear { state.refreshSources() }
    }
}

/// 새 버전이 나오면 맨 위에 뜨는 띠: 버전, 바뀐 점(앞 세 줄), [받기] [나중에]
struct UpdateBanner: View {
    @EnvironmentObject var updater: Updater

    var body: some View {
        if let r = updater.available {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.down.circle.fill").foregroundStyle(.blue)
                    Text("새 버전 \(r.version)").font(.system(size: 12.5, weight: .semibold))
                    Text("지금 \(Updater.current)").font(.system(size: 11)).foregroundStyle(.secondary)
                    Spacer()
                    Button("나중에") { updater.skip() }.controlSize(.small)
                    Button("받기") { updater.download() }.controlSize(.small).buttonStyle(.borderedProminent)
                }
                if !r.notes.isEmpty {
                    Text(r.notes.split(separator: "\n").prefix(3).joined(separator: "\n"))
                        .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(Color.blue.opacity(0.08))
        }
    }
}

/// 녹음을 끝내면 맨 위에 뜨는 띠: 어디에 저장됐는지와 [기록 보기]. 다음 녹음을 시작하거나 ✕ 를 누르면 사라진다
struct SavedBanner: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        if let url = state.savedSession {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                    Text("녹음 기록 저장됨").font(.system(size: 12.5, weight: .semibold))
                    Spacer()
                    Button("기록 보기") {
                        AppDelegate.shared?.popover.page = .history
                        AppDelegate.shared?.popover.open(url)
                        AppDelegate.shared?.showMainWindow()
                    }
                    .controlSize(.small).buttonStyle(.borderedProminent)
                    Button { state.savedSession = nil } label: {
                        Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
                            .frame(width: 18, height: 18).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).help("닫기")
                }
                // 저장 위치. 누르면 Finder 에서 그 기록 폴더를 보여 준다
                Button { NSWorkspace.shared.activateFileViewerSelecting([url]) } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "folder").font(.system(size: 10))
                        Text(Self.place(url)).lineLimit(1).truncationMode(.middle)
                    }
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                }
                .buttonStyle(.plain).help("Finder 에서 보기 — " + (url.deletingLastPathComponent().path as NSString).abbreviatingWithTildeInPath)
            }
            .padding(.horizontal, 14).padding(.vertical, 9)
            .background(Color.green.opacity(0.08))
        }
    }

    /// "수업녹음 › 2026-10-18_09-00-00 1주차" 처럼 저장 폴더 이름과 기록 폴더(예전 기록이면 파일) 이름. 전체 경로는 도움말에
    static func place(_ txt: URL) -> String {
        let target = Notes.isFoldered(txt) ? txt.deletingLastPathComponent() : txt
        return target.deletingLastPathComponent().lastPathComponent + " › " + target.lastPathComponent
    }
}

/// 팝업 맨 아래: 오늘 남은 Groq 한도 게이지 3개와 종료. 자리를 적게 차지하게 아이콘과 가는 막대만 두고,
/// 마우스를 올리면 그 자리에 무슨 한도인지 글로 보여준다. 한 기능이 번갈아 쓰는 모델들은 한도를 합친다
struct UsageFooter: View {
    @EnvironmentObject var state: AppState
    @StateObject private var hover = HoverText()
    typealias Gauge = (icon: String, label: String, models: [String], kind: Budget.Kind, feature: Feature?)
    static let gauges: [Gauge] = [
        ("waveform", "받아쓰기", GroqClient.models, .audio, nil),
        ("character.bubble", "번역", GroqClient.chatModels, .tokens, .translate),
        // Groq 설명·질문은 qwen 한 모델로 한다 (120b 는 qwen 이 막혔을 때만)
        ("sparkles", "화면 설명", [GroqClient.visionModel], .tokens, .explain),
    ]

    /// 그 기능을 Groq 가 아닌 서비스로 돌리면 그 서비스. 유료 크레딧이라 하루 한도 막대 대신 이름만 보인다
    private func paid(_ g: Gauge) -> Provider? {
        let p: Provider
        switch g.feature {
        case .translate?: p = state.translateProvider
        case .explain?: p = state.explainProvider
        case nil: return nil
        }
        return p == .groq ? nil : p
    }

    /// 호출 횟수와 토큰(음성 시간) 중 덜 남은 쪽
    private func parts(_ g: Gauge) -> (requests: Double?, amount: Double, total: Double?) {
        // 번갈아 쓰는 모델(받아쓰기·번역)은 합치고, 함께 써야 하는 모델(화면 설명)은 가장 적게 남은 쪽
        let together = g.feature == .explain
        let r = together ? g.models.compactMap { Usage.fraction([state.usage[$0]]) }.min()
                         : Usage.fraction(g.models.map { state.usage[$0] })
        let a = together ? state.budget.lowest(g.models, g.kind) : state.budget.fraction(g.models, g.kind)
        return (r, a, Usage.combined(requests: r, amount: a))
    }

    /// 마우스가 올라간 곳(게이지 이름 또는 "quit"). 글은 그릴 때마다 만들어서 한도가 바뀌면 바로 반영된다
    final class HoverText: ObservableObject {
        @Published var target: String?
    }
    static let gaugeWidth: CGFloat = 46          // 남은 횟수 글까지 팝업 폭(340)에 들어가게
    static let gaugeSpacing: CGFloat = 10

    private var caption: String? {
        guard let t = hover.target else { return nil }
        if t == "quit" { return "Ezrite 종료" }
        if t == "compact" { return "작은 창으로" }
        guard let g = Self.gauges.first(where: { $0.label == t }) else { return nil }
        let p = parts(g)
        let uses = g.feature == .explain ? (left(.explain), left(.ask)) : nil
        return Self.captionText(g.label, left: p.total ?? p.amount, paid: paid(g)?.label, uses: uses)
    }

    /// 한도 줄에 겹쳐 보이는 글. 게이지 자리(약 240pt)에 "…" 없이 들어가게 짧게 쓴다 (호출·토큰 세부는 뺐다)
    static func captionText(_ label: String, left: Double, paid: String?, uses: (explain: Int, ask: Int)? = nil) -> String {
        if let paid { return "\(label): \(paid) 사용 (유료, 한도 표시 없음)" }
        let pct = Int((left * 100).rounded())
        if let uses { return "\(label) \(pct)% 남음 · 설명 약 \(uses.explain)번, 질문 약 \(uses.ask)번" }
        return "\(label) 한도 \(pct)% 남음"
    }

    /// 남은 한도로 설명·질문을 몇 번 더 할 수 있나 (qwen 한도 ÷ 한 번 평균)
    private func left(_ use: Budget.Use) -> Int { state.budget.usesLeft(use, model: GroqClient.visionModel) }

    var body: some View {
        // 한도는 24시간에 걸쳐 차오른다. 1분마다 다시 그려 막대와 횟수가 따라 오르게 한다
        TimelineView(.periodic(from: .now, by: 60)) { _ in row }
    }

    private var row: some View {
        HStack(spacing: 10) {
            // 게이지는 그대로 두고 위에 글만 겹친다. 게이지를 빼면 마우스 추적 영역도 사라져 글이 안 지워진다
            HStack(spacing: Self.gaugeSpacing) {
                ForEach(Self.gauges, id: \.label) { g in gauge(g) }
                if state.explainProvider == .groq {
                    Text("설명 \(left(.explain)) · 질문 \(left(.ask))")
                        .font(.system(size: 9).monospacedDigit()).foregroundStyle(.secondary).lineLimit(1)
                        .fixedSize()
                }
                Spacer(minLength: 0)
            }
            .opacity(caption == nil ? 1 : 0)
            .overlay(alignment: .leading) {
                if let text = caption {
                    Text(text).font(.system(size: 10.5)).foregroundStyle(.secondary).lineLimit(1)
                        .minimumScaleFactor(0.85).allowsHitTesting(false)
                }
            }
            // 게이지마다 따로 감지하면 옆으로 옮길 때 신호가 꼬인다. 줄 전체에서 마우스 가로 위치로 어느 게이지인지 고른다
            .overlay(HoverArea { x in
                guard let x else { return hover.target = nil }
                let i = Int(x / (Self.gaugeWidth + Self.gaugeSpacing))
                hover.target = Self.gauges.indices.contains(i) ? Self.gauges[i].label : nil
            })
            Button { state.compact = true } label: {
                Image(systemName: "pip.enter").font(.system(size: 11, weight: .semibold))
                    .frame(width: 20, height: 20).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .overlay(HoverArea { hover.target = $0 == nil ? nil : "compact" })
            Button { NSApp.terminate(nil) } label: {
                Image(systemName: "power").font(.system(size: 11, weight: .semibold))
                    .frame(width: 20, height: 20).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .overlay(HoverArea { hover.target = $0 == nil ? nil : "quit" })
        }
        .padding(.horizontal, 12)
        .frame(height: 24)
    }

    private func gauge(_ g: Gauge) -> some View {
        let fraction = parts(g).total
        return HStack(spacing: 4) {
            Image(systemName: g.icon).font(.system(size: 9)).foregroundStyle(.secondary)
            if let other = paid(g) {
                Text(other.label).font(.system(size: 9.5, weight: .medium)).foregroundStyle(.secondary)
                    .lineLimit(1).fixedSize().frame(width: 30, alignment: .leading)
            } else {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.1))
                    Capsule().fill(Self.color(fraction)).frame(width: geo.size.width * CGFloat(fraction ?? 0))
                }
            }
            .frame(width: 30, height: 4)
            }
        }
        .frame(width: Self.gaugeWidth, alignment: .leading)
    }

    static func color(_ fraction: Double?) -> Color {
        guard let fraction else { return .clear }
        switch Usage.level(fraction) {
        case .plenty: return .green
        case .half: return .yellow
        case .low: return .red
        }
    }
}

/// 작은 창: 녹음 표시, 가장 최근 전사된 한 줄과 번역. 오른쪽 버튼으로 원래 크기로
struct CompactPopover: View {
    @EnvironmentObject var state: AppState

    private var last: Entry? { state.entries.last { $0.kind == .text } }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle().fill(state.listening ? (state.paused ? Color.orange : Color.red) : Color.primary.opacity(0.3))
                .frame(width: 8, height: 8).padding(.top, 6)
            VStack(alignment: .leading, spacing: 3) {
                // 최근 발화 한 묶음의 원문과 번역을 자르지 않고 다 보인다. 창 높이가 글에 맞춰 바뀐다 (StatusBar)
                Text(last?.original ?? (state.listening ? "듣고 있어요…" : "녹음하고 있지 않아요"))
                    .font(.system(size: 13, weight: .medium)).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(last?.translation ?? " ")
                    .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(minHeight: 74, alignment: .top)             // 짧은 줄에서 창이 너무 작아지지 않게
            // 설명해줘 (전체 팝업의 ✨ 와 같다)
            Button { AppDelegate.shared?.explain() } label: {
                Group {
                    if state.explaining { ProgressView().controlSize(.mini) }
                    else { Image(systemName: "sparkles").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary) }
                }
                .frame(width: 22, height: 22).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(state.explaining)
            .help("AI 질문하기")
            Button { state.compact = false } label: {
                Image(systemName: "rectangle.expand.vertical").font(.system(size: 12)).foregroundStyle(.secondary)
                    .frame(width: 22, height: 22).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("원래 크기로")
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .frame(width: 340)
        .background(WindowDragArea())
    }
}

/// 전체 창: 실시간 받아쓰기 / 지난 기록 / 설정
struct MainView: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var model: PopoverModel

    var body: some View {
        VStack(spacing: 0) {
            UpdateBanner()
            SavedBanner()
            StatusHeader(place: "window") {
                Button { model.page = model.page == .settings ? .live : .settings } label: {
                    Image(systemName: "gearshape")
                        .font(.system(size: 14))
                        .foregroundStyle(model.page == .settings ? Color.blue : Color.secondary)
                        .frame(width: 30, height: 34)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("설정")
            }
            Divider().opacity(0.4)
            content.frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider().opacity(0.4)
            tabs
        }
        .frame(minWidth: 380, minHeight: 460)
        .onDisappear { model.player.close() }           // 창을 닫으면 듣던 소리도 멈춘다
        .onAppear {
            state.refreshSources()
            model.reloadSessions()
        }
    }

    // MARK: 가운데

    @ViewBuilder private var content: some View {
        switch model.page {
        case .live: LivePage()
        case .history: HistoryPage()
        case .settings: SettingsPage()
        }
    }

    // MARK: 탭

    private var tabs: some View {
        HStack(spacing: 6) {
            TabButton(icon: "text.bubble", title: "실시간", selected: model.page == .live) { model.page = .live }
            TabButton(icon: "clock.arrow.circlepath", title: "지난 기록", selected: model.page == .history) {
                model.reloadSessions()
                model.page = .history
            }
        }
        .padding(8)
    }
}

/// 상태·녹음 시간·파형·녹음 버튼. 오른쪽 끝 버튼은 쓰는 곳마다 다르다
struct StatusHeader<Extra: View>: View {
    @EnvironmentObject var state: AppState
    /// 이 머리가 놓인 곳 ("popup" 메뉴바 팝업 / "window" 전체 창). 고르는 말풍선은 누른 쪽에만 뜬다
    var place = "popup"
    @ViewBuilder var extra: Extra

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 7) {
                    Circle().fill(dotColor).frame(width: 8, height: 8)
                    if let start = state.startedAt {
                        TimelineView(.periodic(from: start, by: 1)) { tl in
                            Text("녹음 중 " + Self.clock(state.recordedBefore + tl.date.timeIntervalSince(start)))
                                .font(.system(size: 13.5, weight: .semibold)).monospacedDigit()
                                .fixedSize()
                        }
                    } else if state.paused {
                        Text("일시정지 " + Self.clock(state.recordedBefore))
                            .font(.system(size: 13.5, weight: .semibold)).monospacedDigit()
                    } else {
                        Text("대기 중").font(.system(size: 13.5, weight: .semibold))
                    }
                }
                Text(state.notice ?? "\(state.selectedSource.label) · \(state.language)")
                    .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            if state.listening && !state.paused { Waveform(level: state.level) }
            // 설명해줘: 화면 캡처가 고른 AI 회사로 전송된다
            Button { AppDelegate.shared?.explain() } label: {
                Group {
                    if state.explaining {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "sparkles").font(.system(size: 12, weight: .semibold))
                    }
                }
                .frame(width: 28, height: 28)
                .background(Circle().fill(Color.primary.opacity(0.08)))
            }
            .buttonStyle(.plain)
            .disabled(state.explaining)
            .help("AI 질문하기")
            if state.listening {
                // 일시정지: 세션은 그대로 두고 듣기만 멈춘다. 다시 누르면 같은 기록에 이어 쓴다
                Button { AppDelegate.shared?.togglePause() } label: {
                    Image(systemName: state.paused ? "play.fill" : "pause.fill")
                        .font(.system(size: 12, weight: .semibold))
                        .frame(width: 28, height: 28)
                        .background(Circle().fill(Color.primary.opacity(0.08)))
                }
                .buttonStyle(.plain)
                .help(state.paused ? "이어서 녹음" : "일시정지")
            }
            Button { AppDelegate.shared?.toggleListening(from: place) } label: {
                Image(systemName: state.listening ? "stop.fill" : "record.circle")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(state.listening ? Color.red.opacity(0.85) : Color.blue))
            }
            .buttonStyle(.plain)
            // 녹음 전에 소리 출처·인식 언어를 고르는 말풍선 (버튼 아래로 꼬리)
            .popover(isPresented: Binding(get: { state.choosing && state.choosingPlace == place },
                                          set: { if !$0 { state.choosing = false } }),
                     arrowEdge: .bottom) {
                RecordChooser().environmentObject(state)
            }
            .help(state.listening ? "녹음 종료" : "녹음 시작")
            extra
        }
        .padding(.horizontal, 14)
        .frame(height: 58)
    }

    private var dotColor: Color {
        state.paused ? .orange : state.listening ? .red : Color.primary.opacity(0.3)
    }

    static func clock(_ t: TimeInterval) -> String {
        let s = max(0, Int(t))
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60)
                         : String(format: "%02d:%02d", s / 60, s % 60)
    }
}

// MARK: - 실시간

private struct LivePage: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        VStack(spacing: 0) {
            if let error = state.error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 11.5))
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 10).fill(.orange.opacity(0.12)))
                    .padding([.horizontal, .top], 12)
            }
            if state.entries.isEmpty {
                Spacer()
                Text(state.listening ? "듣고 있어요. 말소리가 들리면 여기에 적힙니다."
                                     : "위의 녹음 버튼을 누르면 받아 적기 시작합니다.")
                    .font(.system(size: 12.5)).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center).padding(30)
                Spacer()
            } else {
                TranscriptList(entries: state.entries, follow: true, pending: state.inflight > 0)
            }
        }
    }
}

/// 녹음 시작 전: 소리 출처와 인식 언어를 고른다. 지난번 값이 골라져 있어 [시작] 만 눌러도 된다
private struct RecordChooser: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("녹음 시작").font(.system(size: 13, weight: .semibold))
            Card {
                PickerRow(icon: "speaker.wave.2", title: "소리 출처", selection: $state.sourceID,
                          options: state.sources.map { ($0.id, $0.label) })
                Divider().opacity(0.4)
                PickerRow(icon: "character.bubble", title: "인식 언어", selection: $state.language,
                          options: AppState.languages.map { ($0.label, $0.label) })
                // 컴퓨터 소리를 받을 때만 의미가 있다 (마이크를 고르면 이미 내 목소리가 들어간다)
                if state.sourceID != "mic" {
                    Divider().opacity(0.4)
                    HStack(spacing: 10) {
                        Image(systemName: "mic").font(.system(size: 13)).foregroundStyle(.blue).frame(width: 18)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("내 목소리도 함께").font(.system(size: 13, weight: .medium))
                            Text("발표·질문하는 내 말도 같이 받아 적어요").font(.system(size: 11)).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Toggle("", isOn: $state.includeMic).toggleStyle(.switch).labelsHidden().controlSize(.small)
                    }
                }
            }
            HStack(spacing: 8) {
                Toggle("다음부터 묻지 않기", isOn: Binding(get: { !state.askBeforeRecord },
                                                     set: { state.askBeforeRecord = !$0 }))
                    .toggleStyle(.checkbox).font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer()
                Button("취소") { state.choosing = false }.keyboardShortcut(.cancelAction)
                // 팝업은 포커스를 받지 않아 기본 강조 버튼이 회색으로 보인다. 색을 직접 칠한다
                Button { AppDelegate.shared?.toggleListening() } label: {
                    Text("시작").font(.system(size: 12.5, weight: .semibold)).foregroundStyle(.white)
                        .padding(.horizontal, 14).frame(height: 24)
                        .background(Capsule().fill(Color.blue))
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(14)
        .frame(width: 300)
    }
}

// MARK: - 설정

private struct SettingsPage: View {
    /// 설치 디스크(DMG)에서 바로 켠 앱을 등록하면 디스크를 빼는 순간 깨진다
    private static let fromInstaller = Installer.runsFromInstaller(
        Bundle.main.bundlePath, readOnly: Installer.isReadOnly(Bundle.main.bundleURL))

    private var loginDetail: String {
        if Self.fromInstaller { return "응용 프로그램 폴더로 옮겨 설치한 뒤에 켤 수 있습니다." }
        return state.loginItem.note ?? "맥에 로그인하면 메뉴바에 Ezrite 가 바로 뜹니다."
    }

    @EnvironmentObject var state: AppState
    @EnvironmentObject var model: PopoverModel
    @EnvironmentObject var updater: Updater

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                SectionLabel("입력")
                Card {
                    PickerRow(icon: "speaker.wave.2", title: "소리 출처", selection: $state.sourceID,
                              options: state.sources.map { ($0.id, $0.label) })
                    Divider().opacity(0.4)
                    PickerRow(icon: "character.bubble", title: "인식 언어", selection: $state.language,
                              options: AppState.languages.map { ($0.label, $0.label) })
                }
                if state.listening {
                    Text("녹음 중에 바꾸면 같은 기록에 이어서 받아 적고, 바꾼 자리를 표시합니다.")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                        .padding(.top, -8).padding(.leading, 2)
                }

                SectionLabel("옵션")
                ToggleCard(icon: "globe", title: "자동 번역",
                           detail: "영어·일본어 강의를 한국어로 옮겨 아래 줄에 붙입니다. 쓰는 AI 는 아래 기능별 AI 에서 고릅니다.",
                           isOn: $state.autoTranslate)
                ToggleCard(icon: "slider.horizontal.3", title: "녹음할 때마다 묻기",
                           detail: "녹음 버튼을 누르면 소리 출처와 인식 언어를 먼저 고릅니다.",
                           isOn: $state.askBeforeRecord)
                ToggleCard(icon: "mic", title: "내 목소리도 함께",
                           detail: "앱 소리를 받을 때 마이크도 섞어서 받아 적습니다.",
                           isOn: $state.includeMic)
                    .disabled(state.sourceID == "mic")
                Card { PickerRow(icon: "circle.lefthalf.filled", title: "화면 테마", selection: $state.theme, options: Theme.options) }
                ToggleCard(icon: "power", title: "로그인할 때 자동 실행", detail: loginDetail,
                           isOn: Binding(get: { state.loginItem.isOn }, set: { state.loginItem = LoginItem.set($0) }))
                    .disabled(Self.fromInstaller)
                    .onAppear { state.loginItem = LoginItem.current }

                SectionLabel("저장 위치")
                Card {
                    HStack(spacing: 8) {
                        Image(systemName: "folder").font(.system(size: 13)).foregroundStyle(.blue).frame(width: 18)
                        Text((state.notesDir.path as NSString).abbreviatingWithTildeInPath)
                            .font(.system(size: 12)).lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 4)
                        Button("변경…") {
                            if let u = chooseFolder(prompt: "여기에 저장") { state.notesFolder = u.path }
                            model.reloadSessions()
                        }
                        if !state.notesFolder.isEmpty {
                            Button("기본값") { state.notesFolder = ""; model.reloadSessions() }
                        }
                    }
                    Text(state.notesFolder.isEmpty
                         ? "30일 지난 기록은 자동으로 지웁니다."
                         : "이 폴더의 기록은 자동으로 지우지 않습니다. 이전 위치의 기록은 옮겨지지 않습니다.")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .disabled(state.listening)          // 녹음 중인 파일 위치가 바뀌지 않게

                SectionLabel("AI 서비스 키")
                Card {
                    ForEach(Array(Provider.allCases.enumerated()), id: \.offset) { i, p in
                        if i > 0 { Divider().opacity(0.4) }
                        KeyRow(provider: p)
                    }
                }
                Text("받아쓰기는 Groq 를 씁니다. 다른 서비스 키를 넣으면 번역·화면 설명에 고를 수 있습니다. 키는 이 맥에만 저장됩니다.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, -6).padding(.leading, 2)

                SectionLabel("AI 지침")
                Card {
                    VStack(alignment: .leading, spacing: 6) {
                        ZStack(alignment: .topLeading) {
                            if state.userGuide.isEmpty {
                                Text("예: 통계학 전공 2학년 수준으로 설명해 줘. 수식은 꼭 한 단계씩 풀어 줘. 용어는 영어도 같이.")
                                    .font(.system(size: 12)).foregroundStyle(.tertiary).padding(.top, 1).padding(.leading, 5)
                            }
                            TextEditor(text: $state.userGuide)
                                .font(.system(size: 12)).scrollContentBackground(.hidden).frame(height: 70)
                        }
                        Text("✨ 설명과 질문 답을 만들 때마다 화면, 전사된 음성과 함께 AI 에게 전합니다.")
                            .font(.system(size: 10.5)).foregroundStyle(.secondary)
                    }
                }

                SectionLabel("기능별 AI")
                Card {
                    FeatureRow(icon: "character.bubble", title: "번역", feature: .translate,
                               provider: $state.translateProvider, model: $state.translateModel)
                    Divider().opacity(0.4)
                    FeatureRow(icon: "sparkles", title: "화면 설명", feature: .explain,
                               provider: $state.explainProvider, model: $state.explainModel)
                }

                SectionLabel("버전")
                Card {
                    HStack(spacing: 10) {
                        Image(systemName: "info.circle").font(.system(size: 14)).foregroundStyle(.blue).frame(width: 20)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Ezrite \(Updater.current)").font(.system(size: 13, weight: .semibold))
                            Text(versionStatus).font(.system(size: 11)).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if updater.checking { ProgressView().controlSize(.small) }
                        Button("업데이트 확인") { updater.checkNow() }
                            .disabled(updater.checking)
                    }
                }

                // 세 버튼을 한 줄에 나란히 (한 줄씩 쓰면 자리를 많이 차지한다)
                HStack(spacing: 8) {
                    FooterButton(icon: "questionmark.circle", title: "설정 안내") {
                        AppDelegate.shared?.showOnboarding()
                    }
                    .help("설정 안내")
                    FooterButton(icon: "book", title: "사용 가이드") {
                        AppDelegate.shared?.showGuide()
                    }
                    FooterButton(icon: "exclamationmark.bubble", title: "문의·신고") {
                        if let url = Updater.issueURL { NSWorkspace.shared.open(url) }
                    }
                    .help("문의·신고")
                }
                FooterButton(icon: "power", title: "Ezrite 종료") { NSApp.terminate(nil) }
                    .padding(.top, 4)
            }
            .padding(14)
        }
    }
}

private extension SettingsPage {
    /// 버전 줄 아래 한 줄: 새 버전 있음 / 최신 / 아직 확인 전
    var versionStatus: String {
        if let r = updater.available { return "새 버전 \(r.version) 이 있습니다 — 팝업 위 알림에서 받기" }
        if updater.checking { return "확인하는 중…" }
        if updater.checkedAt != nil { return "최신 버전입니다" }
        return "빌드 \(Updater.build)"
    }
}

// MARK: - 부품

/// 서비스 키 한 줄: 이름 · 입력칸 · 저장 · 확인 결과
private struct KeyRow: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var model: PopoverModel
    let provider: Provider

    private var draft: Binding<String> {
        Binding(get: { model.keyDrafts[provider.rawValue] ?? "" },
                set: { model.keyDrafts[provider.rawValue] = $0 })
    }
    private var trimmed: String { draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var saved: Bool { APIKey.read(provider) != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(provider.label).font(.system(size: 12.5, weight: .semibold)).frame(width: 52, alignment: .leading)
                // 창 폭이 좁아도 잘리지 않게 짧게. 발급 주소는 아래 "키 발급받기" 링크에 있다
                SecureField(saved ? "저장됨 · 새 키로 바꾸기" : "키 붙여넣기", text: draft)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12))
                // 버튼 두 칸은 늘 같은 폭으로 잡아 둔다. 지우기가 없는 줄(Groq·키 없음)도 칸을 비워 두어 네 줄이 나란히 선다
                Button("저장") {
                    state.saveKey(provider, trimmed)
                    draft.wrappedValue = ""
                    state.error = nil
                }
                .disabled(trimmed.isEmpty)
                Group {
                    if saved && provider != .groq {
                        Button { state.saveKey(provider, "") } label: {
                            Image(systemName: "trash").font(.system(size: 11)).foregroundStyle(.secondary)
                                .frame(width: 22, height: 20).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help("키 삭제")
                    } else {
                        Color.clear
                    }
                }
                .frame(width: 22, height: 20)
            }
            if let status = state.providerStatus[provider.rawValue] {
                CheckLine(text: status, started: state.checking[provider.rawValue]).padding(.leading, 60)
            } else if !saved {
                // 키가 없으면 발급 페이지로 바로 간다. Groq 는 무료라 받아쓰기를 쓰려면 이것부터 해야 한다
                Button { NSWorkspace.shared.open(provider.keyPage) } label: {
                    Text(provider == .groq ? "무료 키 발급받기 ↗ (받아쓰기에 필요)" : "키 발급받기 ↗")
                        .font(.system(size: 10.5)).foregroundStyle(.blue).underline()
                }
                .buttonStyle(.plain)
                .padding(.leading, 60)
                .help(provider.keyPage.absoluteString)
            }
        }
    }
}

/// 확인 결과 한 줄. 확인 중이면 글 옆에 돌아가는 표시와 경과 초
private struct CheckLine: View {
    let text: String
    let started: Date?

    var body: some View {
        HStack(spacing: 6) {
            if let started {
                ProgressView().controlSize(.mini)
                TimelineView(.periodic(from: started, by: 1)) { tl in
                    Text("\(text)… \(Int(tl.date.timeIntervalSince(started)))초")
                        .font(.system(size: 10.5)).foregroundStyle(.secondary).monospacedDigit()
                }
            } else {
                Text(text).font(.system(size: 10.5))
                    .foregroundStyle(text.hasPrefix("✕") ? Color.orange : text.hasPrefix("✓") ? Color.green : Color.secondary)
                    .lineLimit(2)
            }
        }
    }
}

/// 기능 하나에 쓸 서비스와 모델. 키를 넣은 서비스만 고를 수 있다
private struct FeatureRow: View {
    @EnvironmentObject var state: AppState
    let icon: String
    let title: String
    let feature: Feature
    @Binding var provider: Provider
    @Binding var model: String

    private var usable: [Provider] { Provider.allCases.filter { $0 == .groq || APIKey.read($0) != nil } }
    private var models: [String] {
        let list = AI.ranked(state.providerModels[provider.rawValue] ?? [], for: feature)
        return list.contains(model) || model.isEmpty ? list : [model] + list
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: icon).font(.system(size: 13)).foregroundStyle(.blue).frame(width: 18)
                Text(title).font(.system(size: 13, weight: .medium))
                Spacer()
                Picker("", selection: Binding(get: { provider }, set: { p in
                    provider = p
                    model = p == .groq ? "" : state.defaultModel(p, for: feature)
                    state.checkModel(p, model, for: feature)
                })) {
                    ForEach(usable) { Text($0.label).tag($0) }
                }
                .labelsHidden().fixedSize()
                if provider == .groq {
                    Text("기본 모델").font(.system(size: 11.5)).foregroundStyle(.secondary)
                } else {
                    // 무료 등급 등 계정마다 쓸 수 있는 모델이 달라서 직접 고르고, 고르면 바로 불러 본다
                    Picker("", selection: Binding(get: { model }, set: { m in
                        model = m
                        state.checkModel(provider, m, for: feature)
                    })) {
                        ForEach(models, id: \.self) { Text($0).tag($0) }
                    }
                    .labelsHidden().frame(maxWidth: 150)
                }
            }
            if provider != .groq, let check = state.modelCheck[provider.rawValue + "." + feature.key] {
                CheckLine(text: check, started: state.checking[provider.rawValue + "." + feature.key])
                    .padding(.leading, 26)
            }
        }
    }
}

/// 폴더 고르기 창. 고르지 않으면 nil
func chooseFolder(prompt: String) -> URL? {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.canCreateDirectories = true
    panel.prompt = prompt
    NSApp.activate(ignoringOtherApps: true)
    return panel.runModal() == .OK ? panel.url : nil
}

private struct TabButton: View {
    let icon: String
    let title: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: icon).font(.system(size: 12))
                Text(title).font(.system(size: 12, weight: .medium))
            }
            .foregroundStyle(selected ? Color.primary : Color.secondary)
            .frame(maxWidth: .infinity)
            .frame(height: 30)
            .background(RoundedRectangle(cornerRadius: 8).fill(selected ? Color.primary.opacity(0.08) : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// 소리 크기만큼 출렁이는 막대
struct Waveform: View {
    var level: Float
    private let count = 5

    var body: some View {
        TimelineView(.animation) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            HStack(spacing: 2.5) {
                ForEach(0..<count, id: \.self) { i in
                    Capsule().fill(Color.red).frame(width: 2.5, height: barHeight(t: t, index: i))
                }
            }
        }
        .frame(height: 16)
    }

    // 식을 따로 빼고 타입을 박아 둔다. 뷰 안에 인라인으로 두면 타입 추론이 수 분씩 걸린다
    private func barHeight(t: Double, index: Int) -> CGFloat {
        // 강의 음성 RMS 는 대략 0.01~0.2. 제곱근으로 펴서 작은 소리도 보이게 한다
        let amp: Double = min(1.0, (Double(level) * 8.0).squareRoot())
        let phase: Double = t * 5.0 + Double(index) * 0.9
        return CGFloat(3.0 + 11.0 * amp * (0.5 + 0.5 * abs(sin(phase))))
    }
}

struct SectionLabel: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 11, weight: .semibold))
            .tracking(0.6)
            .foregroundStyle(.secondary)
            .padding(.leading, 2)
            .padding(.bottom, -6)
    }
}

struct Card<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(spacing: 10) { content }
            .padding(12)
            .background(CardBackground())
    }
}

struct CardBackground: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 10)
            .fill(Color.primary.opacity(0.05))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.primary.opacity(0.08)))
    }
}

struct PickerRow: View {
    let icon: String
    let title: String
    @Binding var selection: String
    let options: [(tag: String, label: String)]

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon).font(.system(size: 13)).foregroundStyle(.blue).frame(width: 18)
            Text(title).font(.system(size: 13, weight: .medium))
            Spacer()
            Picker("", selection: $selection) {
                ForEach(options, id: \.tag) { Text($0.label).tag($0.tag) }
            }
            .labelsHidden()
            .fixedSize()
        }
    }
}

struct ToggleCard: View {
    let icon: String
    let title: String
    let detail: String
    @Binding var isOn: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon).font(.system(size: 14)).foregroundStyle(.blue)
                .frame(width: 18).padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 13, weight: .semibold))
                Text(detail).font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Toggle("", isOn: $isOn).toggleStyle(.switch).labelsHidden().controlSize(.small).tint(.blue)
        }
        .padding(12)
        .background(CardBackground())
    }
}

struct FooterButton: View {
    let icon: String
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: icon).font(.system(size: 12))
                Text(title).font(.system(size: 12, weight: .medium))
            }
            .frame(maxWidth: .infinity)
            .frame(height: 32)
            .background(CardBackground())
        }
        .buttonStyle(.plain)
    }
}
