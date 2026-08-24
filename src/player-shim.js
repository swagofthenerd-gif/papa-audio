'use strict'
// Drop-in replacement for the #audio element, backed by the mpv engine.
// Implements only the HTMLAudioElement surface renderer.js actually uses.
class PapaPlayerShim extends EventTarget {
  constructor() {
    super()
    this._src = ''
    this._currentTime = 0
    this._duration = 0
    this._paused = true
    this._ended = false
    this._volume = 0.8
    this.audioParams = null

    window.api.on('player-event', ({ type, data }) => {
      switch (type) {
        case 'position':
          this._currentTime = data
          this.dispatchEvent(new Event('timeupdate'))
          break
        case 'duration':
          this._duration = data
          this.dispatchEvent(new Event('durationchange'))
          this.dispatchEvent(new Event('loadedmetadata'))
          break
        case 'paused':
          this._paused = data
          this.dispatchEvent(new Event(data ? 'pause' : 'play'))
          break
        case 'audioParams':
          this.audioParams = data
          this.dispatchEvent(new CustomEvent('audioparams', { detail: data }))
          break
        case 'autoAdvanced':
          this._src = `file://${data}`
          this._currentTime = 0
          this._ended = false
          this.dispatchEvent(new CustomEvent('autoadvanced', { detail: data }))
          break
        case 'ended':
          this._ended = true
          this._paused = true
          this.dispatchEvent(new Event('ended'))
          break
        case 'loadError':
          // The path matters: the renderer has to know WHICH file failed so it
          // can skip it. A bare Event threw that away.
          this.dispatchEvent(new CustomEvent('error', { detail: { src: data } }))
          break
      }
    })
  }

  _pathOf(src) {
    const s = String(src)
    if (/^https?:\/\//.test(s)) return s
    try {
      return decodeURI(s.replace(/^file:\/\//, ''))
    } catch {
      return s.replace(/^file:\/\//, '')
    }
  }

  get src() { return this._src }
  set src(v) {
    this._src = v
    this._ended = false
    this._currentTime = 0
    this._duration = 0
    window.api.playerLoad({ path: this._pathOf(v), play: false })
  }

  async play() {
    if (this._switching) return
    // Set optimistically, exactly as pause() does. Waiting for the mpv
    // round-trip left `paused` reading true mid-flight, so a click landing
    // before it resolved saw "still paused" and started a second play instead
    // of pausing -- rapid toggling silently dropped every other click.
    const wasPaused = this._paused
    this._paused = false
    try {
      const r = await window.api.playerPlay()
      if (!r.ok) throw new Error(r.error)
    } catch (e) {
      this._paused = wasPaused
      throw e
    }
  }

  pause() { if (this._switching) return; this._paused = true; window.api.playerPause() }

  async switchToTrack(path) {
    this._src = path
    this._ended = false
    this._currentTime = 0
    this._duration = 0
    this._switching = true
    try {
      var r = await window.api.playerSwitch(this._pathOf(path))
      if (!r.ok) throw new Error(r.error)
    } finally {
      this._switching = false
    }
  }

  get paused() { return this._paused }
  get ended() { return this._ended }
  get duration() { return this._duration }
  get currentTime() { return this._currentTime }
  set currentTime(s) { this._currentTime = s; window.api.playerSeek(s) }
  get volume() { return this._volume }
  set volume(v) { this._volume = v; window.api.playerSetVolume(Math.round(v * 100)) }
  set playbackRate(x) { window.api.playerSetSpeed(x) }

  // renderer uses audio.addEventListener/removeEventListener — inherited from EventTarget
  setNext(path) { window.api.playerSetNext(path) }
}

window.__papaPlayer = new PapaPlayerShim()
