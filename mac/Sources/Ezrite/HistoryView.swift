import AppKit
import SwiftUI

/// 지난 기록 탭: 세션 목록 → 누르면 그 세션의 전체 원문·번역.
/// 진행 중인 세션은 받아 적는 대로 계속 늘어난다.
struct HistoryPage: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var model: PopoverModel

    var body: some View {
        Group {
            if let url = model.opened {
                detail(url)
            } else {
                list
            }
        }
        // 진행 중일 때 읽어 둔 내용은 그 시점까지뿐이다. 끝나거나 새 세션이 시작되면 파일에서 다시 읽는다
        .onChange(of: state.listening) { _ in
            model.reloadSessions()
            if let u = model.opened { model.open(u) }
        }
        .onChange(of: state.liveSession) { _ in model.reloadSessions() }
        // 기록 화면이 닫힌 뒤에도 보이게 목록 쪽에 단다
        .alert("기록을 지우지 못했습니다", isPresented: Binding(get: { model.deleteError != nil },
                                                          set: { if !$0 { model.deleteError = nil } })) {
            Button("확인") { model.deleteError = nil }
        } message: {
            Text(model.deleteError ?? "")
        }
    }

    private var list: some View {
        ScrollView {
            LazyVStack(spacing: 2) {
                ForEach(model.sessions) { s in
                    Button { model.open(s.url) } label: {
                        SessionRow(session: s, live: s.url == state.liveSession && state.listening)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(8)
        }
        .overlay {
            if model.sessions.isEmpty {
                Text("아직 받아 적은 기록이 없습니다").font(.callout).foregroundStyle(.secondary)
            }
        }
    }

    private func detail(_ url: URL) -> some View {
        // 녹음이 끝나면 방금 기록도 일반 기록이다 (liveSession 은 다음 녹음을 시작할 때까지 남아 있다)
        let live = state.listening && url == state.liveSession
        let entries = live ? state.entries : model.loaded
        // 다시 받아 적는 중엔 끝날 때 파일을 덮어쓰므로 이름 바꾸기·지우기를 막는다
        let busy = live || model.retxRunning == url
        return VStack(spacing: 0) {
            HStack(spacing: 6) {
                Button { model.open(nil) } label: {
                    Image(systemName: "chevron.left").font(.system(size: 13, weight: .semibold))
                        .frame(width: 26, height: 26).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                VStack(alignment: .leading, spacing: 1) {
                    // 진행 중인 기록은 파일을 쓰는 중이라 이름을 못 바꾼다
                    TextField(live ? "녹음이 끝나면 이름을 붙일 수 있어요" : "이름 붙이기 (Enter 로 저장)",
                              text: $model.titleDraft)
                        .textFieldStyle(.plain)
                        .font(.system(size: 13, weight: .semibold))
                        .disabled(busy)
                        .onSubmit { rename(url) }
                    Text(SessionRow.fmt.string(from: Notes.startDate(of: url)))
                        .font(.system(size: 10.5)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                SmallButton(icon: "square.and.arrow.up", help: "다른 폴더로 내보내기 (글·소리 복사)") {
                    guard let folder = chooseFolder(prompt: "여기로 내보내기") else { return }
                    do {
                        _ = try Notes.export(url, to: folder)
                        // Finder 에 보이는 이름으로 (iCloud Drive 는 실제 폴더 이름이 com~apple~CloudDocs 다)
                        state.notice = "내보냄 → \(FileManager.default.displayName(atPath: folder.path))"
                    } catch {
                        state.notice = "내보내지 못했습니다: \(error.localizedDescription)"
                    }
                }
                .disabled(live)                         // 녹음 중엔 소리 파일이 아직 완성되지 않았다
                SmallButton(icon: "doc.on.doc", help: "전체 복사") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(Notes.render(entries), forType: .string)
                }
                SmallButton(icon: "folder", help: "Finder 에서 보기") {
                    NSWorkspace.shared.activateFileViewerSelecting([url])
                }
                SmallButton(icon: "arrow.clockwise", help: "저장된 소리로 다시 받아 적기") { model.confirmRetx = true }
                    .disabled(live || Notes.audioURL(url) == nil || model.retxRunning != nil)
                SmallButton(icon: "trash", help: "기록 지우기") { model.confirmDelete = true }
                    .disabled(busy)
            }
            .padding(.horizontal, 10)
            .frame(height: 46)
            if !live && Notes.audioURL(url) != nil {
                PlayerBar(player: model.player)
            }
            if let retx = AppDelegate.shared?.retx {
                RetxBar(retx: retx, url: url)
            }
            Divider().opacity(0.4)
            TranscriptList(entries: entries, follow: live && state.listening, pending: false,
                           // 녹음이 끝난 기록만: 줄 옆 ▶ 를 누르면 그 줄의 말만 듣는다 (앞뒤 0.3초 여유)
                           onPlay: live || Notes.audioURL(url) == nil ? nil : { t in
                               model.player.play(from: t.lowerBound - 0.3, to: t.upperBound + 0.3)
                           })
        }
        .confirmationDialog("저장된 소리로 다시 받아 적을까요?", isPresented: $model.confirmRetx) {
            Button("다시 받아 적기") {
                AppDelegate.shared?.retx.start(url, state: state) { done in
                    model.reloadSessions()
                    if model.opened == done { model.open(done) }
                }
            }
            .disabled(retxShort)
        } message: {
            Text(retxMessage)
        }
        .confirmationDialog("이 기록을 지울까요?", isPresented: $model.confirmDelete) {
            Button("휴지통으로 이동", role: .destructive) {
                guard !retxBusy(url) else { return }
                model.open(nil)                         // 듣던 소리를 먼저 놓는다
                Notes.delete(url) { error in
                    model.deleteError = error
                    model.reloadSessions()
                }
            }
        } message: {
            Text("받아 적은 글과 녹음 소리를 함께 휴지통으로 옮깁니다.")
        }
    }

    private var retxNeeded: Int { Retranscriber.estimate(duration: model.player.duration) }
    /// 받아쓰기 두 모델의 오늘 남은 요청 합 (모르면 nil)
    private var whisperLeft: Int? {
        let known = GroqClient.models.compactMap { state.usage[$0]?.remaining }
        return known.isEmpty ? nil : known.reduce(0, +)
    }
    private var retxShort: Bool { whisperLeft.map { $0 < retxNeeded } ?? false }
    private var retxMessage: String {
        let left = whisperLeft.map { "오늘 남은 받아쓰기 요청 \($0)번" } ?? "남은 요청 수는 아직 모름"
        let warn = retxShort ? "\n남은 요청이 모자라 시작할 수 없습니다." : ""
        return "Groq 요청 약 \(retxNeeded)번 (\(left)). 인식 언어는 지금 설정(\(state.language))을 씁니다. " +
            "원래 기록은 휴지통으로 옮겨져 되살릴 수 있습니다.\(warn)"
    }

    private func retxBusy(_ url: URL) -> Bool {
        guard AppDelegate.shared?.retx.running == url else { return false }
        state.notice = "다시 받아 적는 중에는 이름을 바꾸거나 지울 수 없습니다"
        return true
    }

    private func rename(_ url: URL) {
        guard !retxBusy(url) else { return }
        do {
            let new = try Notes.rename(url, to: model.titleDraft)
            model.reloadSessions()
            model.open(new)
        } catch {
            state.notice = "이름을 바꾸지 못했습니다: \(error.localizedDescription)"
        }
    }
}

/// 다시 받아 적기 진행 (이 기록일 때만) 또는 끝난 뒤 알림
private struct RetxBar: View {
    @ObservedObject var retx: Retranscriber
    let url: URL

    var body: some View {
        if retx.running == url {
            HStack(spacing: 8) {
                ProgressView(value: Double(retx.done), total: Double(max(retx.total, 1))).controlSize(.small)
                Text(retx.total == 0 ? "소리 읽는 중…" : retx.message ?? "다시 받아 적는 중 \(retx.done)/\(retx.total)")
                    .font(.system(size: 11)).foregroundStyle(.secondary).monospacedDigit().fixedSize()
                Button("취소") { retx.cancel() }.controlSize(.small)
            }
            .padding(.horizontal, 12).padding(.bottom, 8)
        } else if retx.running == nil, let m = retx.message {
            HStack(spacing: 6) {
                Text(m).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
                Spacer(minLength: 0)
                Button { retx.message = nil } label: { Image(systemName: "xmark").font(.system(size: 9)) }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12).padding(.bottom, 8)
        }
    }
}

/// 녹음 듣기: ▶/⏸, 현재 위치, 진행 막대, 길이
private struct PlayerBar: View {
    @ObservedObject var player: Player

    var body: some View {
        // 재생 중에만 0.25초마다 위치를 다시 읽는다. 멈춰 있을 땐 seek 가 화면을 갱신한다
        TimelineView(.animation(minimumInterval: 0.25, paused: !player.isPlaying)) { _ in
            HStack(spacing: 8) {
                Button { player.toggle() } label: {
                    Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 12))
                        .frame(width: 28, height: 26)
                        .background(CardBackground())
                }
                .buttonStyle(.plain)
                .help(player.isPlaying ? "일시정지" : "녹음 듣기")
                Text(Self.clock(player.position)).font(.system(size: 11)).monospacedDigit().foregroundStyle(.secondary)
                Slider(value: Binding(get: { player.position }, set: { player.seek(to: $0) }),
                       in: 0...max(player.duration, 0.1))
                    .controlSize(.small)
                Text(Self.clock(player.duration)).font(.system(size: 11)).monospacedDigit().foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    static func clock(_ t: TimeInterval) -> String {
        let s = Int(t)
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60)
                         : String(format: "%d:%02d", s / 60, s % 60)
    }
}

/// 원문·번역 줄 목록. follow 면 새 줄을 따라 내려간다.
struct TranscriptList: View {
    let entries: [Entry]
    let follow: Bool
    let pending: Bool
    var onPlay: ((ClosedRange<Double>) -> Void)? = nil
    @StateObject private var bottom = BottomWatch()

    /// 맨 아래 표시가 화면에 보이는지. 위쪽 옛 줄을 읽는 중이면 새 줄이 와도 따라 내려가지 않는다
    final class BottomWatch: ObservableObject {
        var visible = true
    }

    private var scrollKey: String {
        "\(entries.count)-\(entries.filter { $0.translation != nil }.count)-\(pending)"
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(entries) { e in
                        EntryRow(entry: e, onPlay: onPlay).id(e.id)
                    }
                    if pending {
                        Text("받아 적는 중…").font(.system(size: 11.5)).foregroundStyle(.tertiary)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                        .onAppear { bottom.visible = true }
                        .onDisappear { bottom.visible = false }
                }
                .padding(16)
                .textSelection(.enabled)
            }
            .onAppear { if follow { proxy.scrollTo("bottom", anchor: .bottom) } }
            // 새 줄뿐 아니라 번역이 나중에 붙을 때(같은 줄이 길어짐)와 "받아 적는 중…" 이 바뀔 때도 따라간다.
            // 늘어난 높이가 자리 잡은 다음에 내려가도록 한 박자 미룬다
            .onChange(of: scrollKey) { _ in
                guard follow, bottom.visible else { return }
                DispatchQueue.main.async {
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
        }
    }
}

private struct SessionRow: View {
    let session: Notes.Session
    let live: Bool

    static let fmt: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "ko_KR")
        f.dateFormat = "M월 d일 (E) HH:mm"
        return f
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(session.title.isEmpty ? Self.fmt.string(from: session.date) : session.title)
                    .font(.system(size: 12.5, weight: .semibold)).lineLimit(1)
                if session.audio != nil {
                    Image(systemName: "waveform").font(.system(size: 10)).foregroundStyle(.secondary)
                        .help("녹음 소리 있음")
                }
                if live {
                    Text("진행 중")
                        .font(.system(size: 9.5, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5).padding(.vertical, 1.5)
                        .background(Capsule().fill(.red))
                }
                Spacer()
                Image(systemName: "chevron.right").font(.system(size: 10)).foregroundStyle(.tertiary)
            }
            Text(session.title.isEmpty ? preview : Self.fmt.string(from: session.date) + " · " + preview)
                .font(.system(size: 11.5)).foregroundStyle(.secondary).lineLimit(2)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.04)))
        .contentShape(Rectangle())
    }

    /// 목록이 길어도 빠르게 — 파일 앞부분만 읽는다
    private var preview: String {
        guard let h = try? FileHandle(forReadingFrom: session.url) else { return "" }
        defer { try? h.close() }
        let head = String(decoding: (try? h.read(upToCount: 400)) ?? Data(), as: UTF8.self)
        return head.split(separator: "\n").first { !$0.hasPrefix("──") }.map(String.init) ?? ""
    }
}

private struct EntryRow: View {
    let entry: Entry
    var onPlay: ((ClosedRange<Double>) -> Void)?

    var body: some View {
        if entry.kind == .gap {
            Text(entry.original)
                .font(.system(size: 11))
                .foregroundStyle(.orange.opacity(0.85))
        } else {
            HStack(alignment: .top, spacing: 6) {
                if let onPlay, let time = entry.time {
                    Button { onPlay(time) } label: {
                        Image(systemName: "play.circle").font(.system(size: 13)).foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 1)
                    .help("이 줄만 듣기")
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(entry.original).font(.system(size: 13.5))
                    if let t = entry.translation {
                        Text(t).font(.system(size: 12.5)).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}

private struct SmallButton: View {
    let icon: String
    let help: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: icon).font(.system(size: 12))
                .frame(width: 28, height: 26)
                .background(CardBackground())
        }
        .buttonStyle(.plain)
        .help(help)
    }
}
