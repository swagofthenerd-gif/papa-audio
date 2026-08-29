'use strict'
const { EventEmitter } = require('events')
const { MpvEngine } = require('./mpv-engine')

const FADE_STEPS = 20

// Wraps two MpvEngine instances and exposes the same surface as one engine.
// Gapless prefetch is disabled in this mode; "next" is faded in instead.
class MpvCrossfade extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.crossfadeSecs = opts.crossfadeSecs ?? 4
    this._tickMs = opts.tickMs ?? (this.crossfadeSecs * 1000) / FADE_STEPS
    this._factory = opts.engineFactory || (() => new MpvEngine(opts.engineOpts || {}))
    this.engines = []
    this.activeIdx = 0
    this.userVolume = 100
    this._nextPath = null
    this._fading = false
  }

  get _active() { return this.engines[this.activeIdx] }
  get _inactive() { return this.engines[1 - this.activeIdx] }

  async start() {
    this.engines = [this._factory(), this._factory()]
    for (let i = 0; i < 2; i++) this._wire(this.engines[i], i)
    await Promise.all(this.engines.map(e => e.start()))
  }

  stop() { this.engines.forEach(e => e.stop()) }

  _wire(engine, idx) {
    const ifActive = fn => (...args) => { if (idx === this.activeIdx && !this._fading) fn(...args) }
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
    // A stop on the engine being faded out is the fade doing its job. Only the
    // active engine going quiet is a stop the user can hear.
    engine.on('stopped', ifActive(d => this.emit('stopped', d)))
    engine.on('stalled', ifActive(d => this.emit('stalled', d)))
    // Device faults are about the output, not about which engine is faded up.
    engine.on('audioDeviceLost', d => this.emit('audioDeviceLost', d))
    engine.on('audioDeviceFallback', d => this.emit('audioDeviceFallback', d))
    engine.on('engineDown', d => this.emit('engineDown', d))
    engine.on('engineFailed', d => this.emit('engineFailed', d))
    engine.on('engineRecovered', d => this.emit('engineRecovered', d))
    // Diagnostics are never filtered by which engine is active — the whole
    // point is that the evidence survives regardless of who was playing.
    engine.on('diagnostic', d => this.emit('diagnostic', { ...d, engine: idx }))
  }

  _maybeStartFade(position) {
    const st = this._active.getState()
    if (this._fading || !this._nextPath || !st.duration) return
    if (position < st.duration - this.crossfadeSecs) return
    this._startFade().catch(() => {})
  }

  async _startFade() {
    this._fading = true
    const next = this._nextPath
    this._nextPath = null
    const from = this._active
    const to = this._inactive
    await to.setVolume(0)
    await to.load(next, { play: true })
    for (let i = 1; i <= FADE_STEPS; i++) {
      const t = i / FADE_STEPS
      await from.setVolume(Math.round(this.userVolume * (1 - t)))
      await to.setVolume(Math.round(this.userVolume * t))
      await new Promise(r => setTimeout(r, this._tickMs))
    }
    await from.pause()
    this.activeIdx = 1 - this.activeIdx
    this._fading = false
    this.emit('autoAdvanced', next)
  }

  // ── MpvEngine-compatible surface ──
  async load(p, o) { this._nextPath = null; await this._active.setVolume(this.userVolume); await this._active.load(p, o) }
  async setNext(p) { this._nextPath = p || null }
  async play() { await this._active.play() }
  async pause() { await this._active.pause() }
  async seek(s) { await this._active.seek(s) }
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
      .flatMap((e, i) => e.getFlightRecorder().map(r => ({ ...r, engine: i })))
      .sort((a, b) => a.at - b.at)
  }
  getLogTail() {
    return this.engines
      .flatMap((e, i) => e.getLogTail().map(r => ({ ...r, engine: i })))
      .sort((a, b) => a.at - b.at)
  }
}

module.exports = { MpvCrossfade }
