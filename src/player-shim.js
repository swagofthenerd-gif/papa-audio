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
          this.dispatchEvent(new Event('error'))
          break
      }
    })
  }

  _pathOf(src) {
    const s = String(src)
    if (/^https?:\/\//.test(s)) return s
    return decodeURI(s.replace(/^file:\/\//, ''))
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
    const r = await window.api.playerPlay()
    if (!r.ok) throw new Error(r.error)
    this._paused = false
  }

  pause() { this._paused = true; window.api.playerPause() }

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
