import AppKit
import AVFoundation
import CoreGraphics
import SwiftUI
import WebKit

/// 처음 쓰는 사람 안내: ① 무료 Groq 키 ② 마이크·화면 녹화 권한 ③ 첫 녹음. Groq 키가 없을 때 앱을 켜면 뜬다
final class OnboardingModel: ObservableObject {
    @Published var keyDraft = ""
    @Published var mic: Bool = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    @Published var screen: Bool = CGPreflightScreenCaptureAccess()
    @Published var screenAsked = false

    func refresh() {
        mic = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        screen = CGPreflightScreenCaptureAccess()
    }
}

struct OnboardingView: View {
    @EnvironmentObject var state: AppState
    @StateObject private var model = OnboardingModel()
    let onFinish: () -> Void

    private var hasKey: Bool { APIKey.groq() != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Ezrite 시작하기").font(.system(size: 20, weight: .bold))
                Text("강의 소리를 받아 적고, 영어·일본어 강의는 한국어로 옮겨 줍니다. 세 가지만 준비하면 됩니다.")
                    .font(.system(size: 12.5)).foregroundStyle(.secondary)
            }

            Step(n: 1, done: hasKey, title: "무료 Groq 키 넣기",
                 detail: "받아쓰기에 Groq 를 씁니다. 가입하고 키를 만든 뒤 아래에 붙여넣으세요. 카드 등록 없이 무료입니다.") {
                GuideAnimation().frame(width: 462, height: 290)
                HStack(spacing: 8) {
                    Button("무료 키 발급받기 ↗") { NSWorkspace.shared.open(Provider.groq.keyPage) }
                    SecureField(hasKey ? "저장됨" : "gsk_… 붙여넣기", text: $model.keyDraft)
                        .textFieldStyle(.roundedBorder)
                    Button("저장") {
                        state.saveKey(.groq, model.keyDraft.trimmingCharacters(in: .whitespacesAndNewlines))
                        model.keyDraft = ""
                    }
                    .disabled(model.keyDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if let status = state.providerStatus[Provider.groq.rawValue] {
                    Text(status).font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }

            Step(n: 2, done: model.mic && model.screen, title: "권한 허용",
                 detail: "마이크는 내 목소리나 강의실 소리를, 화면 녹화는 유튜브·줌 같은 컴퓨터 소리를 받을 때 씁니다. 화면 녹화는 소리만 쓰고 화면은 저장하지 않습니다.") {
                HStack(spacing: 8) {
                    Button(model.mic ? "마이크 ✓" : "마이크 허용") {
                        Task { @MainActor in
                            _ = await MicCapture.requestPermission()
                            model.refresh()
                        }
                    }
                    .disabled(model.mic)
                    Button(model.screen ? "화면 녹화 ✓" : "화면 녹화 허용") {
                        _ = CGRequestScreenCaptureAccess()      // 처음엔 시스템 창, 이미 거절했으면 시스템 설정으로 안내된다
                        model.screenAsked = true
                        model.refresh()
                    }
                    .disabled(model.screen)
                }
                if model.screenAsked && !model.screen {
                    HStack(spacing: 6) {
                        Text("시스템 설정에서 Ezrite 를 켠 뒤, 앱을 다시 켜야 적용됩니다.")
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                        Button("앱 다시 켜기") { Self.relaunch() }.controlSize(.small)
                    }
                }
            }

            Step(n: 3, done: false, title: "첫 녹음",
                 detail: "메뉴바의 마이크 아이콘을 누르고 ● 버튼으로 받아 적기를 시작하세요. ⚙ 에서 소리 출처(컴퓨터 소리·특정 앱·마이크)와 인식 언어를 고를 수 있습니다. ✨ 를 누르면 그 순간 화면이 AI 서비스로 전송됩니다.") {
                Button("시작하기") { onFinish() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!hasKey)
            }
        }
        .padding(24)
        .frame(width: 560)
        .onAppear { model.refresh() }
        // 시스템 설정에서 돌아오면 권한 상태를 다시 본다
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            model.refresh()
        }
    }

    /// 화면 녹화 권한은 앱을 다시 켜야 적용된다
    static func relaunch() {
        let config = NSWorkspace.OpenConfiguration()
        config.createsNewApplicationInstance = true
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: config) { _, _ in
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }
}

private struct Step<Content: View>: View {
    let n: Int
    let done: Bool
    let title: String
    let detail: String
    @ViewBuilder var content: Content

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                Circle().fill(done ? Color.green : Color.blue).frame(width: 26, height: 26)
                if done {
                    Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundStyle(.white)
                } else {
                    Text("\(n)").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.system(size: 14, weight: .semibold))
                Text(detail).font(.system(size: 12)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                content
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CardBackground())
    }
}

/// 키 발급 과정을 보여주는 애니메이션 (Resources/web/groq-guide.html — 실제 Groq 콘솔 화면 구성을 따라 그렸다)
private struct GuideAnimation: NSViewRepresentable {
    func makeNSView(context: Context) -> WKWebView {
        let web = WKWebView()
        web.setValue(false, forKey: "drawsBackground")
        if let page = Bundle.main.url(forResource: "groq-guide", withExtension: "html", subdirectory: "web") {
            web.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
        }
        return web
    }
    func updateNSView(_ web: WKWebView, context: Context) {}
}
