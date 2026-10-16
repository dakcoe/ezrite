import AVFoundation
import Foundation

/// 지난 기록의 녹음 소리를 앱 안에서 듣는다
final class Player: NSObject, ObservableObject, AVAudioPlayerDelegate {
    private var player: AVAudioPlayer?
    @Published private(set) var isPlaying = false
    private var stopAt: DispatchWorkItem?          // 구간 재생의 끝. 다른 조작을 하면 취소한다

    var duration: TimeInterval { player?.duration ?? 0 }
    /// 화면은 TimelineView 로 주기적으로 다시 읽는다
    var position: TimeInterval { player?.currentTime ?? 0 }

    /// 다른 기록을 열면 듣던 소리는 멈춘다
    func open(_ url: URL) {
        cancelStop()
        player?.stop()
        player = try? AVAudioPlayer(contentsOf: url)
        player?.delegate = self
        player?.prepareToPlay()
        isPlaying = false
    }

    func toggle() {
        cancelStop()
        guard let player else { return }
        if player.isPlaying { player.pause() } else { player.play() }
        isPlaying = player.isPlaying
    }

    func close() {
        cancelStop()
        player?.stop()
        player = nil
        isPlaying = false
    }

    func seek(to time: TimeInterval) {
        cancelStop()
        guard let player else { return }
        player.currentTime = min(max(time, 0), player.duration)
        objectWillChange.send()
    }

    /// 받아 적은 한 줄만 듣는다: from 에서 재생해 to 에서 멈춘다
    func play(from start: TimeInterval, to end: TimeInterval) {
        guard let player else { return }
        cancelStop()
        player.currentTime = min(max(start, 0), player.duration)
        player.play()
        isPlaying = player.isPlaying
        let item = DispatchWorkItem { [weak self] in
            guard let self, let p = self.player else { return }
            p.pause()
            p.currentTime = min(end, p.duration)
            self.isPlaying = false
            self.stopAt = nil
        }
        stopAt = item
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, end - start), execute: item)
    }

    private func cancelStop() {
        stopAt?.cancel()
        stopAt = nil
    }

    /// 끝까지 들으면 ▶ 로 돌아온다. 위치는 AVAudioPlayer 가 0 으로 되돌린다
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        isPlaying = false
    }
}
