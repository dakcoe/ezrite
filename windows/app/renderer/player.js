'use strict';

// 지난 기록의 녹음 듣기 (맥 Player.swift). <audio> 하나를 감싼다. 시험에서는 가짜 audio·타이머를 넣는다.
//   - 열면 멈춰 있다. 다른 기록을 열면 듣던 소리는 멈추고 처음부터
//   - 끝까지 들으면 ▶ 로 돌아오고 위치는 0 (맥 AVAudioPlayer 와 같다)
//   - 막대로 옮기기만 해서는 재생되지 않는다
//   - 줄 옆 ▶ 는 그 구간만 듣는다. 그 사이 다른 조작을 하면 예약한 정지는 취소한다
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EzPlayer = api;
})(typeof self !== 'undefined' ? self : this, () => {
  class Player {
    constructor(audio, timers = { setTimeout, clearTimeout }) {
      this.audio = audio;
      this.timers = timers;
      this.stopAt = null;
      this.opened = false;
      this.isPlaying = false;
      this.onChange = () => {};
      audio.addEventListener('loadedmetadata', () => this.changed());
      audio.addEventListener('timeupdate', () => this.changed());
      audio.addEventListener('ended', () => {
        this.cancelStop();
        this.isPlaying = false;
        audio.currentTime = 0;
        this.changed();
      });
    }

    get duration() {
      return this.opened && Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
    }

    get position() {
      return this.opened ? this.audio.currentTime : 0;
    }

    changed() {
      this.onChange();
    }

    open(src) {
      this.cancelStop();
      this.audio.pause();
      this.audio.src = src;
      this.audio.currentTime = 0;
      this.opened = true;
      this.isPlaying = false;
      this.changed();
    }

    close() {
      this.cancelStop();
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      this.opened = false;
      this.isPlaying = false;
      this.changed();
    }

    toggle() {
      this.cancelStop();
      if (!this.opened) return;
      if (this.audio.paused) {
        this.audio.play().catch(() => { this.isPlaying = false; this.changed(); });
        this.isPlaying = true;
      } else {
        this.audio.pause();
        this.isPlaying = false;
      }
      this.changed();
    }

    seek(t) {
      this.cancelStop();
      if (!this.opened) return;
      this.audio.currentTime = Math.min(Math.max(t, 0), this.duration);
      this.changed();
    }

    /** 받아 적은 한 줄만 듣는다: start 에서 재생해 end 에서 멈춘다 */
    playRange(start, end) {
      if (!this.opened) return;
      this.cancelStop();
      this.audio.currentTime = Math.min(Math.max(start, 0), this.duration);
      this.audio.play().catch(() => { this.isPlaying = false; this.changed(); });
      this.isPlaying = true;
      this.stopAt = this.timers.setTimeout(() => {
        this.stopAt = null;
        this.audio.pause();
        this.audio.currentTime = Math.min(end, this.duration);
        this.isPlaying = false;
        this.changed();
      }, Math.max(0, end - start) * 1000);
      this.changed();
    }

    cancelStop() {
      if (this.stopAt != null) this.timers.clearTimeout(this.stopAt);
      this.stopAt = null;
    }
  }

  return { Player };
});
