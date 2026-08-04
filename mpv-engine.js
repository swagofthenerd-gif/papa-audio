'use strict'
const { spawn } = require('child_process')
const { EventEmitter } = require('events')
const os = require('os')
const path = require('path')
const { MpvIpcClient } = require('./mpv-ipc')

const POSITION_THROTTLE_MS = 250
const RESPAWN_WINDOW_MS = 60000
const MAX_RESPAWNS = 3
const EOF_GRACE_MS = 150

const OBSERVED_PROPS = ['time-pos', 'duration', 'pause', 'path', 'audio-params', 'volume']

let sockCounter = 0

// mpv's plain 'auto' can hand raw multichannel to devices that misreport
// their layout; 'auto-safe' only picks layouts the device is known to handle.
function channelsValue(layout) {
  return layout === 'auto' ? 'auto-safe' : layout
}

class MpvEngine extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.binary = opts.binary || 'mpv'
    this.config = {
      outputMode: 'default',
      alsaDevice: null,
      replaygain: 'no',
      gapless: true,
      audioChannels: 'auto',
      ...opts.config,
    }
    this._spawnFn = opts.spawnFn || spawn
    this._fixedSocketPath = opts.socketPath || null
    this.client = null
    this.proc = null
    this.alive = false
    this._stopping = false
    this._respawns = []
    this._lastPosEmit = 0
    this._nextPath = null
    this._eofTimer = null
    this._seekable = false
    this._pendingSeek = null
    this.state = { path: null, position: 0, duration: 0, paused: true, volume: 100, audioParams: null }
  }

  _args(socketPath) {
    const a = [
      '--idle=yes', '--no-video', '--no-terminal', '--audio-display=no',
      `--input-ipc-server=${socketPath}`,
      `--replaygain=${this.config.replaygain}`,
      `--gapless-audio=${this.config.gapless ? 'weak' : 'no'}`,
      `--audio-channels=${channelsValue(this.config.audioChannels)}`,
      '--volume-max=130',
      '--ytdl-format=bestaudio',
      '--cache=yes', '--cache-secs=30', '--demuxer-max-bytes=32MiB', '--demuxer-readahead-secs=30',
    ]
    if (this.config.outputMode === 'exclusive' && this.config.alsaDevice) {
      a.push(`--audio-device=${this.config.alsaDevice}`, '--audio-exclusive=yes')
    }
    return a
  }

  async start() {
    const runtimeDir = process.env.XDG_RUNTIME_DIR || os.tmpdir()
    const socketPath = this._fixedSocketPath ||
      path.join(runtimeDir, `papa-mpv-${process.pid}-${sockCounter++}.sock`)
    this._stopping = false
    this.proc = this._spawnFn(this.binary, this._args(socketPath), { stdio: 'ignore' })
    this.proc.on('exit', () => this._onExit())
    this.proc.on('error', () => this._onExit())
    this.client = new MpvIpcClient(socketPath)
    await this.client.connect()
    this.client.on('event', e => this._onEvent(e))
    this.client.on('disconnected', () => this._onExit())
    let obsId = 1
    for (const prop of OBSERVED_PROPS) {
      await this.client.observe(obsId++, prop)
    }
    this.alive = true
    this.emit('ready')
  }

  stop() {
    this._stopping = true
    this.alive = false
    this._seekable = false
    this._flushPendingSeek({ send: false })
    clearTimeout(this._eofTimer)
    this.client?.close()
    this.client = null
    try { this.proc?.kill() } catch { /* already dead */ }
    this.proc = null
  }

  async load(filePath, { play = true } = {}) {
    this._nextPath = null
    this._seekable = false
    this._flushPendingSeek({ send: false })
    if (!play) await this.client.command('set_property', 'pause', true)
    await this.client.command('loadfile', filePath, 'replace')
    if (play) await this.client.command('set_property', 'pause', false)
    this.state.path = filePath
    this.state.position = 0
  }

  async setNext(filePath) {
    await this.client.command('playlist-clear')
    this._nextPath = filePath || null
    if (filePath) await this.client.command('loadfile', filePath, 'append')
  }

  async play() { await this.client.command('set_property', 'pause', false) }
  async pause() { await this.client.command('set_property', 'pause', true) }
  // mpv rejects seeks between start-file and playback-restart; defer until
  // the file is seekable, keeping only the latest requested position.
  async seek(seconds) {
    if (this._seekable) {
      await this.client.command('seek', seconds, 'absolute')
      return
    }
    return new Promise((resolve, reject) => {
      if (this._pendingSeek) {
        this._pendingSeek.seconds = seconds
        this._pendingSeek.settlers.push({ resolve, reject })
      } else {
        this._pendingSeek = { seconds, settlers: [{ resolve, reject }] }
      }
    })
  }

  _flushPendingSeek({ send }) {
    const pending = this._pendingSeek
    if (!pending) return
    this._pendingSeek = null
    if (send && this.client) {
      const done = this.client.command('seek', pending.seconds, 'absolute')
      for (const s of pending.settlers) done.then(s.resolve, s.reject)
    } else {
      const err = new Error('seek cancelled by new track load')
      for (const s of pending.settlers) s.reject(err)
    }
  }
  async setVolume(v) { await this.client.command('set_property', 'volume', v) }
  async setSpeed(x) { await this.client.command('set_property', 'speed', x) }
  async setReplaygain(mode) {
    this.config.replaygain = mode
    await this.client.command('set_property', 'replaygain', mode)
  }
  async setChannels(layout) {
    this.config.audioChannels = layout
    await this.client.command('set_property', 'audio-channels', channelsValue(layout))
  }

  async listAudioDevices() {
    return this.client.command('get_property', 'audio-device-list')
  }

  async restart(newConfig = {}) {
    const resume = { ...this.state }
    this.stop()
    this.config = { ...this.config, ...newConfig }
    await this.start()
    if (resume.path) {
      await this.load(resume.path, { play: false })
      if (resume.position > 1) await this.seek(resume.position)
      await this.setVolume(resume.volume)
      if (!resume.paused) await this.play()
    }
  }

  getState() { return { ...this.state } }

  _onEvent(e) {
    if (e.event === 'property-change') {
      this._onProp(e.name, e.data)
    } else if (e.event === 'end-file') {
      if (e.reason === 'error') this.emit('loadError', this.state.path)
      if (e.reason === 'eof') {
        clearTimeout(this._eofTimer)
        this._eofTimer = setTimeout(() => this.emit('ended'), EOF_GRACE_MS)
      }
    } else if (e.event === 'start-file') {
      clearTimeout(this._eofTimer)
      this._seekable = false
    } else if (e.event === 'playback-restart') {
      this._seekable = true
      this._flushPendingSeek({ send: true })
    }
  }

  _onProp(name, data) {
    switch (name) {
      case 'time-pos': {
        if (data == null) return
        this.state.position = data
        const now = Date.now()
        if (now - this._lastPosEmit >= POSITION_THROTTLE_MS) {
          this._lastPosEmit = now
          this.emit('position', data)
        }
        break
      }
      case 'duration':
        if (data == null) return
        this.state.duration = data
        this.emit('duration', data)
        break
      case 'pause':
        this.state.paused = data
        this.emit('paused', data)
        break
      case 'volume':
        if (data == null) return
        this.state.volume = data
        this.emit('volume', data)
        break
      case 'audio-params':
        if (!data) return
        this.state.audioParams = data
        this.emit('audioParams', data)
        break
      case 'path': {
        if (!data || data === this.state.path) return
        this.state.path = data
        if (data === this._nextPath) {
          this._nextPath = null
          this.emit('autoAdvanced', data)
        } else {
          this.emit('trackChanged', data)
        }
        break
      }
    }
  }

  async _onExit() {
    if (this._stopping || !this.alive) return
    this.alive = false
    this.client?.close()
    this.client = null
    this.emit('engineDown')
    const now = Date.now()
    this._respawns = this._respawns.filter(t => now - t < RESPAWN_WINDOW_MS)
    if (this._respawns.length >= MAX_RESPAWNS) {
      this.emit('engineFailed')
      return
    }
    this._respawns.push(now)
    const resume = { ...this.state }
    try {
      await this.start()
      if (resume.path) {
        await this.load(resume.path, { play: false })
        if (resume.position > 1) await this.seek(resume.position)
        await this.setVolume(resume.volume)
        if (!resume.paused) await this.play()
      }
    } catch {
      this.emit('engineFailed')
    }
  }
}

module.exports = { MpvEngine }
