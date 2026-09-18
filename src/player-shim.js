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
// How long after a load settles mpv is allowed to still be reporting the file
// it is replacing. The player-load IPC resolves when MAIN has sent `loadfile`,
// not when mpv has opened it: in between, `mpvPath` is the PREVIOUS file and
// every read of it is a false disagreement. Measured on the D10 soak, 13 of
// them across 40 Nexts at a ~650 ms cadence. Generous enough to cover a cold
// mpv, short enough that a load mpv genuinely dropped still gets reported.
const LOAD_SETTLE_BLIND_MS = 1200

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
    // The in-flight player-load, if any. play() waits on it — see the src setter.
    this._pendingLoad = null
    // True only for the duration of an atomic switchToTrack.
    this._switching = false
    // True from the moment a load is asked for until mpv says something about
    // the file it opened. Together with _loadSettledAt this is the blind
    // window between the IPC reply and mpv's own answer.
    this._awaitingMpvPath = false
    this._loadSettledAt = 0
    // The last path mpv reported. Not what the renderer asked for — what mpv
    // says it has open.
    this._mpvPath = null
    // When the progress clock last had a reason to be moving: a position
    // report, a load, or a resume. `null` means playback has never started, so
    // there is no bar that could be frozen. Deliberately not 0: 0 is a real
    // instant, and treating it as "unset" makes a clock that has just been
    // started read as one that never was.
    this._lastPositionAt = null
    this.audioParams = null
    // mpv's own volume, not the slider's. See main.js's engineVolume relay.
    this.engineVolume = null

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
        case 'engineVolume':
          this.engineVolume = data
          this.dispatchEvent(new CustomEvent('enginevolume', { detail: data }))
          break
        case 'autoAdvanced':
          this._src = `file://${data}`
          this._mpvPath = data
          this._awaitingMpvPath = false
          this._currentTime = 0
          // The next track's clock starts here, not at its first position
          // report — a gapless advance is a load like any other.
          this._lastPositionAt = Date.now()
          this._ended = false
          this.dispatchEvent(new CustomEvent('autoadvanced', { detail: data }))
          break
        case 'trackChanged':
          // Previously dropped here on the grounds that the renderer issued the
          // load and therefore already knows. It does know what it ASKED for;
          // this is what mpv is actually playing, which is the thing several
          // desync findings turn on.
          this._mpvPath = data
          // mpv has answered: the blind window closes here, not on a timer.
          this._awaitingMpvPath = false
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
    // The clock restarts AT the load. It used to be zeroed, which the age
    // getter read as "never reported" and answered with Infinity — so for the
    // whole gap between asking mpv to open a file and mpv's first position
    // report, a perfectly healthy track looked infinitely frozen.
    this._lastPositionAt = Date.now()
    // Keep the load's promise. play() has to wait for it, because the load and
    // the play are two separate ipcRenderer.invoke calls and NOTHING in main
    // orders them: player-load awaits a real mpv round trip (applyLoudnessGain's
    // volume set) before it sends its own `pause true` + `loadfile`, so an
    // unsequenced player-play overtakes it. Traced on the live app, the socket
    // order was volume / pause=false / pause=true / loadfile — mpv opened the
    // newly picked track while paused and stayed there. That is the report
    // "when i select a song to play, it just pauses": the bar paints, the queue
    // is right, and nothing comes out until play is pressed by hand.
    // A rejection is folded into a value so a failed load can never surface as
    // an unhandled rejection from a fire-and-forget assignment.
    // Cleared once it settles, so the field answers "is a load in flight right
    // now" rather than "has a load ever happened". The renderer's reconciler
    // needs the first question: mpv still has the PREVIOUS file open for the
    // whole gap between asking and opening, so reconciling across that gap
    // reads a stale path as a disagreement and drags the queue index backwards.
    const pending = Promise.resolve(window.api.playerLoad({ path: this._pathOf(v), play: false }))
      .catch(e => ({ ok: false, error: String((e && e.message) || e) }))
    this._pendingLoad = pending
    this._awaitingMpvPath = true
    pending.then(() => {
      if (this._pendingLoad !== pending) return
      this._pendingLoad = null
      this._loadSettledAt = Date.now()
    })
  }

  async play() {
    if (this._switching) return
    this._guessPaused(false)
    // Order before latency: mpv must already have the file open when it is
    // unpaused, or the unpause lands on the file it is replacing and the new
    // one loads paused. See the src setter.
    if (this._pendingLoad) await this._pendingLoad
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
    this._lastPositionAt = Date.now()
    this._switching = true
    this._awaitingMpvPath = true
    try {
      var r = await window.api.playerSwitch(this._pathOf(path))
      if (!r.ok) throw new Error(r.error)
    } finally {
      this._switching = false
      this._loadSettledAt = Date.now()
    }
  }

  // Truth from mpv. Clears the overlay once mpv agrees with it, so the guess
  // never lingers past the moment it stopped being a guess.
  _observePaused(value) {
    const wasPaused = this._pausedTruth
    this._pausedTruth = !!value
    // mpv stops reporting position while paused, so on the way back out the
    // age is however long the pause lasted. Restarting the clock at the resume
    // is what stops a ten-second pause from being announced as a ten-second
    // freeze the instant playback comes back.
    if (wasPaused && !this._pausedTruth) this._lastPositionAt = Date.now()
    if (this._pausedGuess === this._pausedTruth) this._clearPausedGuess()
  }

  // A value we are asserting before mpv has confirmed it.
  _guessPaused(value) {
    this._pausedGuess = !!value
    this._pausedGuessUntil = Date.now() + OPTIMISTIC_PAUSE_MS
    // `paused` flips optimistically, so the renderer counts this as playing
    // from right here. The age has to start from the same moment, or the
    // optimistic window is spent looking frozen.
    if (!this._pausedGuess) this._lastPositionAt = Date.now()
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

  // True while mpv has been asked to open a file and has not answered yet —
  // either route in, the src setter's load or switchToTrack's atomic switch.
  // Derived from the two fields that already track those; nothing else to keep
  // in step.
  get loadInFlight() {
    if (this._pendingLoad || this._switching) return true
    // The reply said main sent the loadfile. mpv answers separately, and until
    // it does its path is the file being replaced — not evidence of a
    // disagreement, evidence that the change has not landed yet. Blind, not
    // wrong, for at most LOAD_SETTLE_BLIND_MS; after that a load mpv silently
    // dropped is a real disagreement again and gets reported.
    if (!this._awaitingMpvPath) return false
    return (Date.now() - this._loadSettledAt) < LOAD_SETTLE_BLIND_MS
  }

  get engineDown() { return this._engineDown }
  // What mpv has open, for reconciling against what the UI is showing.
  get mpvPath() { return this._mpvPath }
  // Milliseconds since the progress clock last had a reason to move. Always a
  // real elapsed time: the clock is started by a load and by a resume, not
  // only by mpv's first position report. It used to answer Infinity for the
  // gap in between, which the renderer's stall watchdog printed verbatim —
  // "the progress bar has not moved for Infinityms" — on a track that had only
  // just been asked for. Nothing has ever played: 0, because there is no bar
  // to freeze.
  get positionAgeMs() {
    return this._lastPositionAt === null ? 0 : Date.now() - this._lastPositionAt
  }
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
