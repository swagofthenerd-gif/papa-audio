'use strict'
const { spawn } = require('child_process')
const { EventEmitter } = require('events')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { MpvIpcClient } = require('./mpv-ipc')
const { channelsValue } = require('./mpv-engine')

// Thrown instead of a TypeError when mpv dies between two awaits of the same
// sequence, mirroring mpv-engine.js's discipline.
class EngineGone extends Error {
  constructor(op) {
    super(`video engine went away during ${op}`)
    this.name = 'EngineGone'
    this.code = 'ENGINE_GONE'
  }
}

class VideoEngine extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.binary = opts.binary || 'mpv'
    this.config = {
      outputMode: 'default',
      alsaDevice: null,
      audioChannels: 'auto',
      ...opts.config,
    }
    this._spawnFn = opts.spawnFn || spawn
    this._fixedSocketPath = opts.socketPath || null
    this.client = null
    this.proc = null
    this.alive = false
    this._stopping = false
    // Incremented on every start(), so a command belonging to one mpv can never
    // be delivered to the mpv that replaced it.
    this._gen = 0
    this._socketPath = null
  }

  _args(socketPath, { wid } = {}) {
    const a = [
      '--no-terminal',
      '--idle=yes',
      `--input-ipc-server=${socketPath}`,
      `--audio-channels=${channelsValue(this.config.audioChannels)}`,
      '--cache=yes',
      '--demuxer-max-bytes=64MiB',
      '--ytdl=no',
    ]
    if (wid) a.push(`--wid=${wid}`)
    if (this.config.outputMode === 'exclusive' && this.config.alsaDevice) {
      a.push(`--audio-device=${this.config.alsaDevice}`, '--audio-exclusive=yes')
    }
    return a
  }

  _guard(op) {
    const gen = this._gen
    return (...args) => {
      if (!this.client || !this.alive || gen !== this._gen) {
        return Promise.reject(new EngineGone(op))
      }
      return this.client.command(...args)
    }
  }

  async start(url, { wid } = {}) {
    const runtimeDir = process.env.XDG_RUNTIME_DIR || os.tmpdir()
    const socketPath = this._fixedSocketPath ||
      path.join(runtimeDir, `papa-video-${process.pid}-${crypto.randomBytes(4).toString('hex')}.sock`)
    this._socketPath = socketPath
    this._stopping = false
    this._gen++
    this.proc = this._spawnFn(this.binary, this._args(socketPath, { wid }), { stdio: ['ignore', 'ignore', 'pipe'] })
    // mpv is chatty on stderr; without a drain the pipe buffer fills and the
    // process blocks. The log content is not needed here. Optional: a test's
    // injected proc may not carry a stderr stream.
    this.proc.stderr?.resume()
    this.proc.on('exit', () => this._onExit())
    this.proc.on('error', () => this._onExit())
    this.client = new MpvIpcClient(socketPath)
    await this.client.connect()
    this.client.on('event', e => this.emit('event', e))
    this.client.on('disconnected', () => this._onExit())
    this.alive = true
    this.emit('ready')
    if (url) await this.load(url)
  }

  async load(url) {
    await this._guard('load')('loadfile', url, 'replace')
    this.emit('loaded', url)
  }

  command(...args) {
    return this._guard('command')(...args)
  }

  stop() {
    this._stopping = true
    this.alive = false
    this.client?.close()
    this.client = null
    try { this.proc?.kill() } catch { /* already dead */ }
    this.proc = null
    if (this._socketPath && !this._fixedSocketPath) {
      try { require('fs').unlinkSync(this._socketPath) } catch { /* mpv may have taken it already */ }
    }
  }

  _onExit() {
    if (this._stopping || !this.alive) return
    this.alive = false
    this.client?.close()
    this.client = null
    this.emit('engineDown', {})
  }
}

module.exports = { VideoEngine, EngineGone }
