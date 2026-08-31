'use strict'
const { spawn } = require('child_process')
const { EventEmitter } = require('events')
const os = require('os')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { MpvIpcClient } = require('./mpv-ipc')

// The app's own actions, bound inside mpv so they work while the video window
// has focus — the deck is in another window and never sees those keypresses.
// Written as an input.conf rather than sent as keybind commands after connect:
// a config file is applied at startup with no round trip, and four pending IPC
// commands outliving the socket held the event loop open.
//
// Only the listed keys are overridden; every other mpv default still applies,
// which is the point — the window keeps its full native transport.
const APP_KEYS = [
  ['s', 'skip'],
  ['n', 'next'],
  ['b', 'bookmark'],
]

function inputConfBody() {
  return APP_KEYS.map(([key, action]) => `${key} script-message papa ${action}`).join('\n') + '\n'
}

function writeInputConf(dir) {
  try {
    const file = path.join(dir, 'papa-input.conf')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, inputConfBody(), 'utf8')
    return file
  } catch (_) {
    // Losing a shortcut must never stop playback.
    return null
  }
}

// Resolved lazily so the module stays loadable in tests that have no Electron
// app object.
function _dataDir(leaf) {
  try {
    const { app } = require('electron')
    if (app && typeof app.getPath === 'function') return path.join(app.getPath('userData'), leaf)
  } catch (_) { /* not running under Electron */ }
  return path.join(os.tmpdir(), 'papa-video-' + leaf)
}

// Screenshots must never land in the process working directory, which is the
// application folder.
function screenshotDir() { return _dataDir('screenshots') }
function configDir() { return _dataDir('config') }
const { channelsValue } = require('./mpv-engine')
const { classify } = require('./src/surround-verify')

// The properties mpv must push back. Observation mirrors mpv-engine.js:52 so the
// two engines stay the same shape; the video engine adds everything the theatre
// needs that a music player never asked about (tracks, chapters, codecs).
const OBSERVED_PROPS = [
  'time-pos', 'duration', 'pause', 'volume', 'mute', 'speed',
  'track-list', 'sid', 'aid', 'chapter-list', 'eof-reached',
  'demuxer-cache-time', 'video-params', 'video-codec',
  'audio-params', 'audio-codec-name',
]

// A seek bar does not need 60fps. ~4/s is what the UI asked for (§4.2).
const STATE_THROTTLE_MS = 250

// The friendly names the `subStyle` verb accepts, mapped to the mpv properties
// they set. Anything not in this table is ignored, so a UI sending a style key
// the engine does not know cannot silently set an arbitrary mpv property.
const SUB_STYLE_PROPS = {
  scale: 'sub-scale',
  pos: 'sub-pos',
  color: 'sub-color',
  borderColor: 'sub-border-color',
  backColor: 'sub-back-color',
  fontSize: 'sub-font-size',
  font: 'sub-font',
  bold: 'sub-bold',
  borderSize: 'sub-border-size',
  shadowOffset: 'sub-shadow-offset',
  blur: 'sub-blur',
}

// mpv reports a deselected track as `false` or the string "no", never null.
function _trackId(value) {
  return (value === false || value == null || value === 'no') ? null : value
}

// Track shape (§4.3): { id, type:'sub'|'audio', title, lang, codec,
//   default, forced, external }. Only sub and audio are exposed — the video
//   track is implied, not selectable.
function normalizeTrack(raw, index) {
  if (!raw || (raw.type !== 'sub' && raw.type !== 'audio')) return null
  return {
    id: raw.id ?? index,
    type: raw.type,
    title: raw.title ?? null,
    lang: raw.lang ?? null,
    codec: raw.codec ?? null,
    default: raw.default === true,
    forced: raw.forced === true,
    external: raw.external === true,
  }
}

// Chapter shape (§4.3): { index, title, start }. mpv's chapter-list is
// `[{ title, time }]` — time in seconds, index is the array position.
function normalizeChapter(raw, index) {
  if (!raw || typeof raw.time !== 'number') return null
  return { index, title: raw.title ?? null, start: raw.time }
}

function emptyState() {
  return {
    position: 0,
    duration: 0,
    paused: true,
    volume: 0,
    muted: false,
    speed: 1,
    buffered: 0,
    eof: false,
    video: { width: null, height: null, codec: null },
    audio: { layout: 'unknown', channels: 0, codec: null },
    tracks: { sub: null, audio: null },
    chapters: [],
  }
}

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
    this._inputConf = opts.inputConf !== undefined ? opts.inputConf : writeInputConf(configDir())
    // The live §4.2 payload, plus the raw lists the track/chapter endpoints read.
    this.state = emptyState()
    this._trackList = []
    this._chapterList = []
    this._stateTimer = null
    // Timing seam for tests; production uses STATE_THROTTLE_MS (~4/s).
    this._stateThrottleMs = opts.stateThrottleMs ?? STATE_THROTTLE_MS
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
      // The video plays in its own window, so it needs its own controls: the
      // app's deck is in a different window and unreachable while the video
      // has focus. mpv's on-screen controller is a complete transport — seek
      // bar, play/pause, volume, fullscreen, track selection — and its default
      // keybindings come with it. Stripping them left a bare picture with no
      // way to do anything, which is worse than any styling gained.
      // Only when mpv has its own window. Embedded, the app's deck sits
      // directly beneath the picture and is fully reachable, so mpv's
      // controller is a second transport stacked on the first — its own seek
      // bar, filename and cache readout drawn over the bottom of the video,
      // immediately above ours. One set of controls, and it should be the
      // app's.
      ...(wid ? ['--osc=no'] : ['--osc=yes', '--osd-bar=yes']),
      // Papa's own actions are bound on top in _bindAppKeys(); those bindings
      // override the defaults for the keys they claim.
      '--title=Papa Video',
      ...(this._inputConf ? [`--input-conf=${this._inputConf}`] : []),
      // Without this mpv writes mpv-shot0001.jpg into the process working
      // directory, which is the application folder.
      `--screenshot-directory=${screenshotDir()}`,
      '--ytdl=no',
    ]
    if (wid) {
      // --gpu-context is not optional when embedding. Left to choose for
      // itself under XWayland, mpv picks a context that renders nothing into a
      // foreign window: it starts, reports no error, exits 0, and leaves the
      // surface pure black. That is the whole of the "blank black window"
      // failure, and it is silent, which is why it read as an mpv limitation
      // rather than a missing flag.
      //
      // Measured on this machine by capturing the embedded window's pixels:
      // default gpu -> 1 unique colour (black); x11egl -> 26297; x11vk ->
      // 28660; x11 -> 22107; xv -> 19288. x11egl is the pick because it is
      // hardware-accelerated and needs no Vulkan driver.
      a.push(`--wid=${wid}`, '--gpu-context=x11egl')
    }
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
    this.state = emptyState()
    this._trackList = []
    this._chapterList = []
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
    this.client.on('event', e => this._onEvent(e))
    this.client.on('disconnected', () => this._onExit())
    // Report WHICH property failed, not a bare "observe failed" that names
    // nothing. A dead observation means a dead control deck.
    let obsId = 1
    for (const prop of OBSERVED_PROPS) {
      try {
        await this.client.observe(obsId++, prop)
      } catch (e) {
        const err = new Error(`could not observe ${prop}: ${(e && e.message) || e}`)
        err.code = 'OBSERVE_FAILED'
        err.property = prop
        throw err
      }
    }
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

  getState() {
    // A deep-enough copy that the UI cannot mutate the engine's live object.
    return {
      ...this.state,
      video: { ...this.state.video },
      audio: { ...this.state.audio },
      tracks: { ...this.state.tracks },
      chapters: this.state.chapters.slice(),
    }
  }

  async getTracks() {
    const list = await this._guard('getTracks')('get_property', 'track-list')
    return (Array.isArray(list) ? list : []).map(normalizeTrack).filter(Boolean)
  }

  async getChapters() {
    const list = await this._guard('getChapters')('get_property', 'chapter-list')
    return (Array.isArray(list) ? list : []).map(normalizeChapter).filter(Boolean)
  }

  // ── Control verbs ──────────────────────────────────────────────────────────
  // Each maps one §4.1 verb onto the mpv command or property that realises it.

  async seek(seconds, mode = 'relative') {
    await this._guard('seek')('seek', seconds, mode)
  }

  async setPause(paused) {
    await this._guard('setPause')('set_property', 'pause', !!paused)
  }

  async setVolume(volume) {
    await this._guard('setVolume')('set_property', 'volume', Number(volume))
  }

  async setMute(muted) {
    await this._guard('setMute')('set_property', 'mute', !!muted)
  }

  async setSpeed(speed) {
    await this._guard('setSpeed')('set_property', 'speed', Number(speed))
  }

  async setTrack(type, id) {
    const prop = type === 'sub' ? 'sid' : type === 'audio' ? 'aid' : null
    if (!prop) throw new Error(`unknown track type: ${type}`)
    await this._guard('setTrack')('set_property', prop, _trackId(id) ?? 'no')
  }

  async addSubtitle(filePath, select = true) {
    await this._guard('addSubtitle')('sub-add', filePath, select ? 'select' : '')
  }

  async setSubDelay(ms) {
    await this._guard('setSubDelay')('set_property', 'sub-delay', Number(ms) / 1000)
  }

  async setAudioDelay(ms) {
    await this._guard('setAudioDelay')('set_property', 'audio-delay', Number(ms) / 1000)
  }

  async setSubStyle(patch) {
    for (const [key, value] of Object.entries(patch || {})) {
      const prop = SUB_STYLE_PROPS[key]
      if (!prop) continue
      await this._guard('setSubStyle')('set_property', prop, value)
    }
  }

  async setAspect(aspect) {
    await this._guard('setAspect')('set_property', 'video-aspect-override', aspect)
  }

  async setZoom(zoom) {
    await this._guard('setZoom')('set_property', 'video-zoom', Number(zoom))
  }

  async setAudioFilter(af) {
    // Empty string clears the filter chain. Night mode (dynaudnorm) and
    // dialogue boost ride this same property, so clearing is the one way back.
    await this._guard('setAudioFilter')('set_property', 'af', af || '')
  }

  async screenshot(filePath) {
    await this._guard('screenshot')('screenshot-to-file', filePath, 'video')
  }

  async frameStep(dir = 1) {
    await this._guard('frameStep')(dir < 0 ? 'frame-back-step' : 'frame-step')
  }

  stop() {
    this._stopping = true
    this.alive = false
    this._clearStateTimer()
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
    this._clearStateTimer()
    this.client?.close()
    this.client = null
    this.emit('engineDown', {})
  }

  // ── Property observation ───────────────────────────────────────────────────

  _onEvent(e) {
    if (!e) return
    if (e.event === 'property-change') return this._onProp(e.name, e.data)
    // Keys bound in _bindAppKeys arrive as client messages. They are the only
    // way an action that lives in the app — skip intro, next episode — can be
    // triggered from the video window, which owns the keyboard while focused.
    if (e.event === 'client-message' && Array.isArray(e.args) && e.args[0] === 'papa') {
      this.emit('appKey', { action: e.args[1] || null })
    }
  }



  _onProp(name, data) {
    const s = this.state
    switch (name) {
      case 'time-pos':
        if (data != null) s.position = data
        break
      case 'duration':
        if (data != null) s.duration = data
        break
      case 'pause':
        s.paused = data === true
        break
      case 'volume':
        if (data != null) s.volume = data
        break
      case 'mute':
        s.muted = data === true
        break
      case 'speed':
        if (data != null) s.speed = data
        break
      case 'demuxer-cache-time':
        if (data != null) s.buffered = data
        break
      case 'eof-reached':
        s.eof = data === true
        break
      case 'video-params':
        if (data) {
          s.video.width = data.dw ?? data.w ?? null
          s.video.height = data.dh ?? data.h ?? null
        }
        break
      case 'video-codec':
        if (typeof data === 'string') s.video.codec = data
        break
      case 'audio-params': {
        if (data) {
          const channels = Number(data['channel-count'] ?? data.channels) || 0
          s.audio.channels = channels
          s.audio.layout = classify(channels)
        }
        break
      }
      case 'audio-codec-name':
        if (typeof data === 'string') s.audio.codec = data
        break
      case 'track-list':
        this._trackList = Array.isArray(data) ? data : []
        break
      case 'chapter-list': {
        this._chapterList = Array.isArray(data) ? data : []
        s.chapters = this._chapterList.map(normalizeChapter).filter(Boolean)
        break
      }
      case 'sid':
        s.tracks.sub = _trackId(data)
        break
      case 'aid':
        s.tracks.audio = _trackId(data)
        break
    }
    this._scheduleState()
  }

  // Trailing-edge throttle: the first change arms a 250ms timer, later changes
  // coalesce into it, so a 60fps time-pos stream still emits ~4/s.
  _scheduleState() {
    if (this._stateTimer) return
    this._stateTimer = setTimeout(() => {
      this._stateTimer = null
      if (this.alive) this.emit('state', this.getState())
    }, this._stateThrottleMs)
    this._stateTimer.unref?.()
  }

  _clearStateTimer() {
    if (this._stateTimer) {
      clearTimeout(this._stateTimer)
      this._stateTimer = null
    }
  }
}

module.exports = {
  VideoEngine,
  screenshotDir,
  configDir,
  inputConfBody,
  APP_KEYS,
  EngineGone,
  OBSERVED_PROPS,
  STATE_THROTTLE_MS,
  SUB_STYLE_PROPS,
  normalizeTrack,
  normalizeChapter,
  emptyState,
}
