'use strict'
// Drop-in replacement for the #audio element, backed by the mpv engine.
// Implements only the HTMLAudioElement surface renderer.js actually uses.
// How long an optimistic paused value outranks mpv's own. Clicking play has to
// flip `paused` immediately — waiting for the round trip meant a second click
// landing mid-flight saw "still paused" and started a second play, so rapid
// toggling silently dropped every other click. But the optimistic value must
// expire: two independent writers with no expiry is how state.isPlaying and
// this flag ended up disagreeing, and both staying wrong after an engineDown.
const OPTIMISTIC_PAUSE_MS = 1500

class PapaPlayerShim extends EventTarget {
  constructor() {
    super()
    this._src = ''
    this._currentTime = 0
    this._duration = 0
    // mpv's observed pause property: the only thing that is actually true.
    this._pausedTruth = true
    // The overlay, and when it stops outranking the truth.
    this._pausedGuess = null
    this._pausedGuessUntil = 0
    this._ended = false
    this._volume = 0.8
    this._engineDown = false
    // The last path mpv reported. Not what the renderer asked for — what mpv
    // says it has open.
    this._mpvPath = null
    // When the last position update arrived, so a frozen progress bar can be
    // told apart from a paused one.
    this._lastPositionAt = 0
    this.audioParams = null

    window.api.on('player-event', ({ type, data }) => {
      switch (type) {
        case 'position':
          this._currentTime = data
          this._lastPositionAt = Date.now()
          this.dispatchEvent(new Event('timeupdate'))
          break
        case 'duration':
          this._duration = data
          this.dispatchEvent(new Event('durationchange'))
          this.dispatchEvent(new Event('loadedmetadata'))
          break
        case 'paused':
          this._observePaused(data)
          this.dispatchEvent(new Event(data ? 'pause' : 'play'))
          break
        case 'audioParams':
          this.audioParams = data
          this.dispatchEvent(new CustomEvent('audioparams', { detail: data }))
          break
        case 'autoAdvanced':
          this._src = `file://${data}`
          this._mpvPath = data
          this._currentTime = 0
          this._ended = false
          this.dispatchEvent(new CustomEvent('autoadvanced', { detail: data }))
          break
        case 'trackChanged':
          // Previously dropped here on the grounds that the renderer issued the
          // load and therefore already knows. It does know what it ASKED for;
          // this is what mpv is actually playing, which is the thing several
          // desync findings turn on.
          this._mpvPath = data
          this.dispatchEvent(new CustomEvent('trackchanged', { detail: data }))
          break
        case 'ended':
          this._ended = true
          this._clearPausedGuess()
          this._pausedTruth = true
          this.dispatchEvent(new Event('ended'))
          break
        case 'loadError':
          // The path matters: the renderer has to know WHICH file failed so it
          // can skip it. A bare Event threw that away.
          this.dispatchEvent(new CustomEvent('error', { detail: { src: data } }))
          break
        // ── Engine lifecycle ────────────────────────────────────────────────
        // These four were emitted by the engine and forwarded by main, and then
        // fell off the end of the world here: the shim had no case for them, so
        // during a respawn the UI went on claiming it was playing.
        case 'engineDown':
          this._engineDown = true
          // Any optimistic value is void: there is no mpv left to confirm it.
          this._clearPausedGuess()
          this._pausedTruth = true
          this.dispatchEvent(new CustomEvent('enginedown', { detail: data || {} }))
          break
        case 'engineRecovered':
          this._engineDown = false
          this._clearPausedGuess()
          this._pausedTruth = !(data && data.wasPlaying)
          if (data && typeof data.position === 'number') this._currentTime = data.position
          this.dispatchEvent(new CustomEvent('enginerecovered', { detail: data || {} }))
          break
        case 'stopped':
          // mpv ended the file for a reason that is not eof and not an error.
          // Nothing else is coming: no ended, no autoadvanced, no error.
          this._clearPausedGuess()
          this._pausedTruth = true
          this._ended = false
          this.dispatchEvent(new CustomEvent('enginestopped', { detail: data || {} }))
          break
        case 'engineFailed':
          this._engineDown = true
          this._clearPausedGuess()
          this._pausedTruth = true
          this.dispatchEvent(new CustomEvent('enginefailed', { detail: data || {} }))
          break
        case 'engineRestored':
          // main got a working engine back on its own, without a recheck.
          this._engineDown = false
          this._clearPausedGuess()
          this._pausedTruth = true
          this.dispatchEvent(new CustomEvent('enginerestored', { detail: data || {} }))
          break
        case 'engineRebuilding':
          // A settings change is about to tear the engine down mid-track. Said
          // before the audio stops, not after.
          this._engineDown = true
          this._clearPausedGuess()
          this._pausedTruth = true
          this.dispatchEvent(new CustomEvent('enginerebuilding', { detail: data || {} }))
          break
        case 'stalled':
          // Position stopped advancing while mpv says it is not paused — and
          // mpv itself was asked before this was sent.
          this.dispatchEvent(new CustomEvent('enginestalled', { detail: data || {} }))
          break
        case 'audioDeviceLost':
          this.dispatchEvent(new CustomEvent('audiodevicelost', { detail: data || {} }))
          break
        case 'audioDeviceFallback':
          this.dispatchEvent(new CustomEvent('audiodevicefallback', { detail: data || {} }))
          break
      }
    })
  }

  // The renderer assigns `src` as 'file://' + the RAW path, with no encoding, so
  // decoding it here was guarding against an encoding that never happened: a real
  // filename containing %20 or %25 was silently rewritten to a different path,
  // mpv failed to open it, and the load-error policy then removed a file that was
  // sitting on disk. Strip the scheme and nothing else.
  _pathOf(src) {
    const s = String(src)
    if (/^https?:\/\//.test(s)) return s
    return s.replace(/^file:\/\//, '')
  }

  get src() { return this._src }
  set src(v) {
    this._src = v
    this._ended = false
    this._currentTime = 0
    this._duration = 0
    this._lastPositionAt = 0
    window.api.playerLoad({ path: this._pathOf(v), play: false })
  }

  async play() {
    if (this._switching) return
    this._guessPaused(false)
    try {
      const r = await window.api.playerPlay()
      if (!r.ok) throw new Error(r.error)
      // mpv accepted it; the pause observation confirms it a moment later.
    } catch (e) {
      // It did not happen, so stop asserting that it did.
      this._clearPausedGuess()
      throw e
    }
  }

  async pause() {
    if (this._switching) return
    this._guessPaused(true)
    try {
      const r = await window.api.playerPause()
      if (r && r.ok === false) throw new Error(r.error)
    } catch (e) {
      this._clearPausedGuess()
      throw e
    }
  }

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

  // Truth from mpv. Clears the overlay once mpv agrees with it, so the guess
  // never lingers past the moment it stopped being a guess.
  _observePaused(value) {
    this._pausedTruth = !!value
    if (this._pausedGuess === this._pausedTruth) this._clearPausedGuess()
  }

  // A value we are asserting before mpv has confirmed it.
  _guessPaused(value) {
    this._pausedGuess = !!value
    this._pausedGuessUntil = Date.now() + OPTIMISTIC_PAUSE_MS
  }

  _clearPausedGuess() {
    this._pausedGuess = null
    this._pausedGuessUntil = 0
  }

  get paused() {
    if (this._pausedGuess !== null && Date.now() < this._pausedGuessUntil) return this._pausedGuess
    // An expired guess is one that was wrong, or a reply that never came.
    if (this._pausedGuess !== null) this._clearPausedGuess()
    return this._pausedTruth
  }

  get engineDown() { return this._engineDown }
  // What mpv has open, for reconciling against what the UI is showing.
  get mpvPath() { return this._mpvPath }
  // Milliseconds since mpv last reported a position, or Infinity if never. A
  // frozen bar is otherwise indistinguishable from a paused track.
  get positionAgeMs() { return this._lastPositionAt ? Date.now() - this._lastPositionAt : Infinity }
  get ended() { return this._ended }
  get duration() { return this._duration }
  get currentTime() { return this._currentTime }
  set currentTime(s) { this._currentTime = s; window.api.playerSeek(s) }
  get volume() { return this._volume }
  set volume(v) { this._volume = v; window.api.playerSetVolume(Math.round(v * 100)) }
  set playbackRate(x) { window.api.playerSetSpeed(x) }

  // renderer uses audio.addEventListener/removeEventListener — inherited from EventTarget
  // Returns the result. Fire-and-forget meant a failed gapless prefetch was
  // invisible until the album stopped at a track boundary.
  setNext(path) { return window.api.playerSetNext(path) }
}

window.__papaPlayer = new PapaPlayerShim()
