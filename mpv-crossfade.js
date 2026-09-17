'use strict'
const { EventEmitter } = require('events')
const { MpvEngine } = require('./mpv-engine')

const FADE_STEPS = 20

// mpv's `volume` property is CUBIC in amplitude — the same fact volume-map.js
// exists for (it cube-ROOTS the renderer's linear 0-1 slider on the way in) and
// the same one loudness.js applies a stored ReplayGain with (it scales the mpv
// volume by the cube root of the linear ratio). Amplitude = (volume/100)^3.
//
// Ramping the volume NUMBER linearly therefore ramps the amplitude as t^3. At
// the midpoint of a crossfade both tracks sit at 0.5^3 = 0.125 amplitude, so the
// pair sums to a quarter of full scale: a ~12 dB hole in the middle of every
// transition, which is the dip the listener hears. Going through amplitude and
// cube-rooting back into mpv's domain is the only way the curve means anything.
function mpvVolumeForAmplitude(userVolume, amplitude) {
  const base = Number(userVolume)
  if (!isFinite(base)) return 0
  const a = Math.min(Math.max(Number(amplitude) || 0, 0), 1)
  // A tenth of a percent, the same resolution volume-map.js and loudness.js
  // round mpv volumes to. mpv takes fractional volume; integers would quantise
  // the quiet end of the ramp into audible steps.
  return Math.round(base * Math.cbrt(a) * 10) / 10
}

// Equal-power (constant-energy) crossfade: sin/cos quarter-circle, so
// out^2 + in^2 === 1 at every point. Two different tracks are uncorrelated
// signals, so their POWERS add — an equal-GAIN ramp (out + in === 1) would
// leave a 3 dB dip at the midpoint even with the cubic domain handled.
function crossfadeAmplitudes(t) {
  const x = Math.min(Math.max(Number(t) || 0, 0), 1) * (Math.PI / 2)
  return { out: Math.cos(x), in: Math.sin(x) }
}

// The pair of mpv volume values for one step of a fade at user volume `userVolume`.
function crossfadeStep(userVolume, t) {
  const a = crossfadeAmplitudes(t)
  return {
    from: mpvVolumeForAmplitude(userVolume, a.out),
    to: mpvVolumeForAmplitude(userVolume, a.in),
  }
}

// Two engines cannot both hold an exclusive handle on one audio device — the
// second mpv gets "device or resource busy", which the engine reads as a device
// fault and burns its respawn budget on. Exclusive output (bit-perfect's
// --audio-exclusive=yes, or the user's own "exclusive" output mode with a chosen
// ALSA device) is therefore incompatible with the two-engine crossfade.
//
// Precedence: EXCLUSIVE OUTPUT WINS, crossfade degrades to gapless. That matches
// the precedence src/bit-perfect.js already sets for the bit-perfect flag
// (forcesGapless) and it is the safer half to keep: exclusive output is a
// deliberate, audible, explicitly chosen setting, while a crossfade is a
// transition effect. Degrading is NOT silent — see _announceDegraded.
function wantsExclusiveDevice(config) {
  const c = config || {}
  return c.bitPerfect === true || c.outputMode === 'exclusive'
}

const EXCLUSIVE_REASON = 'exclusive-output'
const EXCLUSIVE_DETAIL =
  'crossfade needs two audio streams at once, and exclusive/bit-perfect output ' +
  'gives one stream sole ownership of the device — the tracks are joined ' +
  'gaplessly instead'

// Wraps two MpvEngine instances and exposes the same surface as one engine.
// Gapless prefetch is disabled in this mode; "next" is faded in instead.
// The exception is the degraded single-engine mode above, where the wrapper is
// one plain gapless engine and mpv does the prefetching itself.
class MpvCrossfade extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.crossfadeSecs = opts.crossfadeSecs ?? 4
    this._tickMs = opts.tickMs ?? (this.crossfadeSecs * 1000) / FADE_STEPS
    const engineOpts = opts.engineOpts || {}
    // Decided at construction because the device mode is a spawn-time argument:
    // main rebuilds the player on every change to outputMode/alsaDevice/bitPerfect,
    // so this is re-evaluated whenever it can actually differ.
    this.exclusiveOutput = wantsExclusiveDevice(engineOpts.config)
    this.crossfadeEnabled = !this.exclusiveOutput
    this.disabledReason = this.exclusiveOutput ? EXCLUSIVE_REASON : null
    // A degraded wrapper is one ordinary engine, and the crossfade path is what
    // normally replaces mpv's own prefetch — so hand gapless back to mpv, or the
    // "fallback" would transition worse than plain gapless does.
    this._engineOpts = this.crossfadeEnabled
      ? engineOpts
      : { ...engineOpts, config: { ...(engineOpts.config || {}), gapless: true } }
    this._factory = opts.engineFactory || (o => new MpvEngine(o))
    this.engines = []
    this.activeIdx = 0
    this.userVolume = 100
    this._nextPath = null
    this._fading = false
    // Which fade the ramp currently in flight belongs to. A user action during a
    // fade bumps this, and the ramp checks it after every step — that is how a
    // loop already awaiting its next tick is told to stop rather than carrying
    // on setting volumes over the top of the recovery.
    this._fadeSeq = 0
    // An engine that ran out of respawns is gone for the rest of the session.
    // Fading INTO a dead engine is silence, so a fade must never pick one.
    this._failed = [false, false]
  }

  get _active() { return this.engines[this.activeIdx] }
  get _inactive() { return this.engines[1 - this.activeIdx] }

  async start() {
    const count = this.crossfadeEnabled ? 2 : 1
    this.engines = []
    for (let i = 0; i < count; i++) {
      const e = this._factory(this._engineOpts)
      this.engines.push(e)
      this._wire(e, i)
    }
    await Promise.all(this.engines.map(e => e.start()))
    if (!this.crossfadeEnabled) this._announceDegraded(EXCLUSIVE_REASON, EXCLUSIVE_DETAIL)
  }

  stop() { this.engines.forEach(e => e.stop()) }

  // Crossfade turning itself off has to be as loud as crossfade breaking the
  // output would have been. Both a named event (so the UI can say it in words)
  // and a diagnostic (so the daily log carries it even with no UI listening).
  _announceDegraded(reason, detail) {
    this._emitDiagnostic('crossfade-unavailable', { reason, detail })
    this.emit('crossfadeUnavailable', { reason, detail, mode: 'gapless' })
  }

  _wire(engine, idx) {
    const ifActive = fn => (...args) => { if (idx === this.activeIdx && !this._fading) fn(...args) }
    // Engine-lifecycle events are about THIS mpv process, not about which engine
    // is faded up, so they are gated on the active engine but NOT on _fading: a
    // process dying mid-fade is exactly when the report matters most.
    const ifActiveEngine = fn => (...args) => { if (idx === this.activeIdx) fn(...args) }
    engine.on('position', p => {
      if (idx !== this.activeIdx) return
      this.emit('position', p)
      this._maybeStartFade(p)
    })
    engine.on('duration', ifActive(d => this.emit('duration', d)))
    engine.on('paused', ifActive(p => this.emit('paused', p)))
    engine.on('audioParams', ifActive(a => this.emit('audioParams', a)))
    engine.on('ended', ifActive(() => this.emit('ended')))
    engine.on('loadError', ifActive(p => this.emit('loadError', p)))
    engine.on('trackChanged', ifActive(p => this.emit('trackChanged', p)))
    // Inert while two engines are crossfading (setNext never reaches mpv then),
    // live in the degraded single-engine mode where mpv owns the handoff.
    engine.on('autoAdvanced', ifActive(p => this.emit('autoAdvanced', p)))
    // A stop on the engine being faded out is the fade doing its job. Only the
    // active engine going quiet is a stop the user can hear.
    engine.on('stopped', ifActive(d => this.emit('stopped', d)))
    engine.on('stalled', ifActive(d => this.emit('stalled', d)))
    // Device faults are about the output, not about which engine is faded up.
    engine.on('audioDeviceLost', d => this.emit('audioDeviceLost', d))
    engine.on('audioDeviceFallback', d => this.emit('audioDeviceFallback', d))
    // These three used to be forwarded from BOTH engines. The idle engine
    // respawning is invisible to the listener — nothing it does is audible — but
    // the renderer took engineDown as "playback stopped" and showed a paused,
    // reconnecting player over music that never faltered. Worse, engineFailed
    // from the idle engine tore the whole player down in main's onEngineFailed.
    engine.on('engineDown', ifActiveEngine(d => this.emit('engineDown', d)))
    engine.on('engineRecovered', ifActiveEngine(d => this.emit('engineRecovered', d)))
    engine.on('engineFailed', d => {
      this._failed[idx] = true
      if (idx === this.activeIdx) { this.emit('engineFailed', d); return }
      // The idle engine is gone for good. Nothing is audibly wrong, so this must
      // not reach the UI as an engine failure — but there is no second engine to
      // fade into any more, so crossfade is over for this session and mpv takes
      // the handoff back.
      this.crossfadeEnabled = false
      this.disabledReason = 'engine-failed'
      this._announceDegraded('engine-failed',
        'the second playback engine stopped coming back, so tracks are joined ' +
        'gaplessly instead of crossfaded')
    })
    // One file crashed mpv every time it was opened and the engine quarantined
    // it. Not forwarding this was a silent stall: the engine came back alive and
    // idle, and nobody told the renderer to move the queue on.
    engine.on('trackUnplayable', d => {
      if (idx === this.activeIdx) { this.emit('trackUnplayable', d); return }
      // The poisoned file is the one being faded IN, not the one playing. The
      // renderer's trackUnplayable handler skips the CURRENT track, so sending
      // this would cut a healthy track short and skip past the wrong one. Drop
      // the queued path so no further fade re-opens it and report it under its
      // own name; the current track plays out and the normal advance takes over.
      if (d && d.path && d.path === this._nextPath) this._nextPath = null
      this._emitDiagnostic('next-track-unplayable', { path: d && d.path, engine: idx })
      this.emit('nextTrackUnplayable', { ...d, engine: idx })
    })
    // Diagnostics are never filtered by which engine is active — the whole
    // point is that the evidence survives regardless of who was playing.
    engine.on('diagnostic', d => this.emit('diagnostic', { ...d, engine: idx }))
  }

  _maybeStartFade(position) {
    if (!this.crossfadeEnabled || this._fading || !this._nextPath) return
    // Never fade into an engine that is not there or is not coming back.
    if (!this._inactive || this._failed[1 - this.activeIdx]) return
    const st = this._active.getState()
    if (!st.duration) return
    if (position < st.duration - this.crossfadeSecs) return
    this._startFade().catch(e => {
      this._emitDiagnostic('crossfade-failed', { detail: String((e && e.message) || e) })
    })
  }

  async _startFade() {
    this._fading = true
    const token = ++this._fadeSeq
    // True once a user action has cancelled this fade out from under us. Every
    // await below is a point where that can have happened.
    const cancelled = () => this._fadeSeq !== token
    const next = this._nextPath
    this._nextPath = null
    const from = this._active
    const to = this._inactive
    // Set the moment the incoming track reaches full volume. Past that point the
    // listener is hearing the NEW track, so a failure in the tidy-up behind it is
    // not a reason to yank the handoff back.
    let handedOff = false
    try {
      await to.setVolume(0)
      if (cancelled()) return
      await to.load(next, { play: true })
      if (cancelled()) return
      for (let i = 1; i <= FADE_STEPS; i++) {
        const step = crossfadeStep(this.userVolume, i / FADE_STEPS)
        await from.setVolume(step.from)
        await to.setVolume(step.to)
        await new Promise(r => setTimeout(r, this._tickMs))
        // Stop here rather than at the end of the loop: _cancelFade has already
        // put the volumes back, and another step would undo that.
        if (cancelled()) return
      }
      handedOff = true
      await from.pause()
    } catch (e) {
      // A cancelled fade is allowed to throw on the way out — the engine it was
      // talking to has just been paused underneath it. That is not a failure to
      // report or recover from; _cancelFade already restored what he can hear.
      if (cancelled()) return
      // A fade that threw used to leave _fading true forever. Every later fade
      // was blocked by it, every engine event was swallowed by the ifActive gate
      // that reads it, and whichever volumes the ramp had reached when it died
      // stayed there — a player stuck half-silent with no way back.
      if (!handedOff) {
        // Cleared FIRST, before the recovery that can itself throw: this flag is
        // what gates every forwarded engine event, so anything that leaves it set
        // is the wedge this catch exists to prevent.
        this._fading = false
        await this._abortFade(from, to, next, e)
        return
      }
      // The ramp completed and only the pause failed: the old engine is at
      // volume 0, so it is inaudible, and the handoff stands.
      this._emitDiagnostic('crossfade-pause-failed', {
        path: next, detail: String((e && e.message) || e),
      })
    }
    this.activeIdx = 1 - this.activeIdx
    this._fading = false
    this.emit('autoAdvanced', next)
  }

  // Put the audible state back where the listener expects it: the track that was
  // already playing, at the user's volume, and nothing else making sound. The
  // queued track is NOT retried — a fade that just failed would fail again a
  // tick later — so the current track plays to its end and the ordinary 'ended'
  // advance (now unblocked, because _fading is cleared) carries the album on.
  async _abortFade(from, to, next, err) {
    const detail = String((err && err.message) || err)
    await this._restoreAudible(from, to)
    this._emitDiagnostic('crossfade-failed', { path: next, detail, engine: this.activeIdx })
    this.emit('crossfadeFailed', { path: next, detail, recovered: true })
  }

  // The audible half of the recovery above, with nothing said about it: the
  // arriving track silenced and stopped, the departing one — the one he is
  // actually listening to — back at his volume instead of part-way down the ramp.
  async _restoreAudible(from, to) {
    await this._bestEffort(() => to.setVolume(0))
    await this._bestEffort(() => to.pause())
    await this._bestEffort(() => from.setVolume(this.userVolume))
  }

  // Called by play/pause/seek/load before they touch an engine.
  //
  // `activeIdx` does not move until the ramp finishes, so during a fade
  // `this._active` is the engine being thrown away. Acting on it is how Pause
  // used to leave the music playing and getting louder, how a seek moved a track
  // that was about to be discarded, and how choosing a track played the queued
  // one instead. Cancelling first makes `_active` mean what it says again: the
  // track he can hear, still playing, at his volume.
  //
  // Deliberately silent. _abortFade reports a genuine failure to the renderer,
  // which puts "that crossfade did not complete" on screen; nothing failed here,
  // he pressed a button. The queued track is not retried, exactly as in the abort
  // path — the current track plays on and the ordinary 'ended' advance carries
  // the album forward.
  async _cancelFade() {
    if (!this._fading) return false
    const from = this._active
    const to = this._inactive
    // Bumped before anything is awaited, so the ramp stops at its next step
    // rather than painting volumes back over the restore below.
    this._fadeSeq++
    this._fading = false
    await this._restoreAudible(from, to)
    return true
  }

  async _bestEffort(fn) {
    try { await fn() } catch (_) { /* recovery must not fail the recovery */ }
  }

  _emitDiagnostic(kind, detail) {
    let state = null
    try { state = this.getState() } catch (_) { /* nothing started yet */ }
    this.emit('diagnostic', {
      kind,
      detail,
      state,
      flight: this.getFlightRecorder(),
      log: this.getLogTail(),
    })
  }

  // ── MpvEngine-compatible surface ──
  // The four verbs a person drives the player with all cancel a fade in progress
  // first (see _cancelFade): until the ramp ends, `_active` is the engine being
  // faded out and discarded, so without this they each acted on the wrong track.
  async load(p, o) {
    await this._cancelFade()
    this._nextPath = null
    await this._active.setVolume(this.userVolume)
    await this._active.load(p, o)
  }
  async setNext(p) {
    // Degraded to one engine: there is no second engine to fade in, so the queued
    // path has to reach mpv or nothing prefetches it at all.
    if (!this.crossfadeEnabled) { this._nextPath = null; return this._active.setNext(p) }
    this._nextPath = p || null
  }
  async play() { await this._cancelFade(); await this._active.play() }
  async pause() { await this._cancelFade(); await this._active.pause() }
  async seek(s) { await this._cancelFade(); await this._active.seek(s) }
  async setVolume(v) { this.userVolume = v; await this._active.setVolume(v) }
  async setSpeed(x) { await this._active.setSpeed(x) }
  async setReplaygain(m) { await Promise.all(this.engines.map(e => e.setReplaygain(m))) }
  async setChannels(l) { await Promise.all(this.engines.map(e => e.setChannels(l))) }
  async setEq(s) { await Promise.all(this.engines.map(e => e.setEq(s))) }
  async listAudioDevices() { return this._active.listAudioDevices() }
  // Reads come from whichever engine is audible; writes go to both, or the
  // faded-in engine would come up with the wrong device.
  async getProperty(name) { return this._active.getProperty(name) }
  async setProperty(name, value) {
    const results = await Promise.allSettled(this.engines.map(e => e.setProperty(name, value)))
    const failed = results.filter(r => r.status === 'rejected')
    if (failed.length === results.length) throw failed[0].reason
    return true
  }
  async restart(cfg) { for (const e of this.engines) await e.restart(cfg) }
  // Same surface as MpvEngine: the engine that is audible is the one that has to
  // come back holding the track.
  async resumeState(resume) { return this._active.resumeState(resume) }
  getState() { return this._active.getState() }
  isActuallyPlaying() { return this._active.isActuallyPlaying() }
  // Both engines' timelines, interleaved by time and tagged with which engine
  // produced each entry — a crossfade fault is usually about the handoff.
  getFlightRecorder() {
    return this.engines
      .flatMap((e, i) => (typeof e.getFlightRecorder === 'function' ? e.getFlightRecorder() : [])
        .map(r => ({ ...r, engine: i })))
      .sort((a, b) => a.at - b.at)
  }
  getLogTail() {
    return this.engines
      .flatMap((e, i) => (typeof e.getLogTail === 'function' ? e.getLogTail() : [])
        .map(r => ({ ...r, engine: i })))
      .sort((a, b) => a.at - b.at)
  }
}

module.exports = {
  MpvCrossfade,
  FADE_STEPS,
  mpvVolumeForAmplitude,
  crossfadeAmplitudes,
  crossfadeStep,
  wantsExclusiveDevice,
  EXCLUSIVE_REASON,
}
