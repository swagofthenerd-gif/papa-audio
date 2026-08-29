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
      // 64MiB is only a few seconds of a 1080p stream, so mpv kept draining its
      // buffer and stalling on a torrent that was actually keeping up. A larger
      // readahead window costs RAM and nothing else — it does not touch the
      // decode path, so there is no quality change.
      '--demuxer-max-bytes=256MiB',
      // Keeping some of the past in memory makes a small seek backwards
      // instant instead of a re-fetch from the torrent.
      '--demuxer-max-back-bytes=96MiB',
      // Read ahead by time as well as by bytes, so a high-bitrate scene does
      // not shrink the buffer to nothing.
      '--cache-secs=300',
      '--demuxer-readahead-secs=20',
      // The torrent server briefly returns errors while a piece is still in
      // flight. Without reconnect mpv treats that as end-of-stream and stops;
      // with it, playback rides through the gap.
      '--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_delay_max=5',
      '--network-timeout=30',
      // Hardware decoding where the driver supports it. This offloads decode
      // from the CPU; it does not re-encode or rescale, so the picture is
      // unchanged. auto-safe falls back to software whenever the hardware path
      // is not known-good for the codec.
      '--hwdec=auto-safe',
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
    // A second start() must never leave the previous mpv running. Without this
    // every play stacked another process (and another audio output) on top of
    // the last one, because start() simply overwrote this.proc.
    if (this.proc || this.client) this.stop()
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
    try {
      await this.client.connect()
    } catch (err) {
      // mpv spawned but its socket never became ready — do not leak an idle
      // process. Tear down and surface the real connect error.
      this.client = null
      try { this.proc?.kill() } catch { /* already dead */ }
      this.proc = null
      throw err
    }
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
