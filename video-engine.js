'use strict'
const { spawn } = require('child_process')
const { EventEmitter } = require('events')
const os = require('os')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const net = require('net')
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

// Double-click is the universal gesture for fullscreen, and the click lands on
// mpv rather than on the page, so the app never sees it. mpv's own default for
// it — cycle fullscreen — is wrong when embedded: it would fullscreen the
// child surface alone, putting the picture over the deck, the skip offer and
// the episode list with no way to reach any of them. Relaying it lets the app
// expand instead, which is what its fullscreen already does.
//
// Only bound when embedded. When mpv owns its window, its own default is the
// correct behaviour and is left alone.
const EMBED_MOUSE = [
  // A single click on the picture is the universal gesture for play/pause —
  // and, embedded, the click lands on mpv so the page never sees it. Relayed
  // rather than handled inside mpv so the deck's own pause state stays the
  // single source of truth.
  //
  // mpv tells the two clicks apart natively: the first press always fires
  // MBTN_LEFT, and a second press inside the double-click window fires
  // MBTN_LEFT_DBL instead of another MBTN_LEFT. So a double-click delivers one
  // 'playPause' followed by one 'fullscreen' — the same toggle-then-expand
  // sequence YouTube and VLC produce — never two fights over the same press.
  ['MBTN_LEFT', 'playPause'],
  ['MBTN_LEFT_DBL', 'fullscreen'],
]

function inputConfBody(embedded) {
  const rows = APP_KEYS.concat(embedded ? EMBED_MOUSE : [])
  return rows.map(([key, action]) => `${key} script-message papa ${action}`).join('\n') + '\n'
}

function writeInputConf(dir, embedded) {
  try {
    const file = path.join(dir, embedded ? 'papa-input-embedded.conf' : 'papa-input.conf')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, inputConfBody(embedded), 'utf8')
    return file
  } catch (_) {
    // Losing a shortcut must never stop playback.
    return null
  }
}

// mpv does not die with the app. If Papa Audio is killed rather than closed —
// a crash, an OOM kill, a SIGKILL — the mpv it spawned keeps running, keeps
// playing, and keeps holding an audio device. The next launch spawns its own
// mpv, so the user hears one process while the app's controls drive a
// different one: audio with no picture and a deck that appears to do nothing.
// Observed exactly that way, with an orphan from a long-dead instance still
// playing alongside a live one.
//
// The socket name carries the pid that spawned it, so an orphan is one whose
// owner is gone. It is stopped by asking it to quit over its own socket rather
// than by matching process names: if something answers, it is an mpv of ours
// and it exits cleanly; if nothing answers, the socket is stale and is simply
// removed. This mirrors purgeOrphanStreams, which solves the same problem for
// the download caches.
function orphanPlayerSockets(dir) {
  let names = []
  try { names = fs.readdirSync(dir) } catch (_) { return [] }
  const out = []
  for (const name of names) {
    const m = /^papa-video-(\d+)-[0-9a-f]+\.sock$/.exec(name)
    if (!m) continue
    const pid = Number(m[1])
    if (pid === process.pid) continue
    if (isProcessAlive(pid)) continue
    out.push(path.join(dir, name))
  }
  return out
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e && e.code === 'EPERM' }
}

function purgeOrphanPlayers({ dir = (process.env.XDG_RUNTIME_DIR || os.tmpdir()), timeoutMs = 1200 } = {}) {
  const sockets = orphanPlayerSockets(dir)
  if (!sockets.length) return Promise.resolve({ quit: 0, stale: 0 })
  let quit = 0
  let stale = 0
  return Promise.all(sockets.map(file => new Promise(resolve => {
    let done = false
    const finish = () => { if (!done) { done = true; try { fs.unlinkSync(file) } catch (_) {} ; resolve() } }
    let sock
    try { sock = net.connect(file) } catch (_) { stale++; return finish() }
    const timer = setTimeout(() => { try { sock.destroy() } catch (_) {} ; finish() }, timeoutMs)
    sock.on('connect', () => {
      quit++
      try { sock.write(JSON.stringify({ command: ['quit'] }) + '\n') } catch (_) {}
      // Give mpv a moment to act on it before the socket goes away.
      setTimeout(() => { try { sock.end() } catch (_) {} ; clearTimeout(timer); finish() }, 150)
    })
    sock.on('error', () => { stale++; clearTimeout(timer); finish() })
  }))).then(() => ({ quit, stale }))
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
  // Whether the mouse is moving over the picture. The video is a native child
  // window composited above the page, so it swallows every pointer event that
  // lands on it -- the page sees no mousemove at all while the cursor is over
  // the film. Anything that hides chrome after a period of stillness would
  // therefore hide it and never bring it back, because moving the mouse across
  // the one place the user is looking is invisible to the document. mpv does
  // see it, and reports it here.
  'mouse-pos',
  // cache-duration, not cache-time. cache-time is the ABSOLUTE timestamp of the
  // end of the cache; the UI wants seconds ahead of the playhead. Measured on a
  // 120-second file at position 32.96: cache-time 119.98, cache-duration 86.77.
  // The bar was adding the absolute value to the position, so it read 152s of a
  // 120s film and sat permanently full.
  'demuxer-cache-duration',
  // What is genuinely seekable, which is a different question. A demuxer window
  // says how far ahead mpv has read; it says nothing about whether the bytes
  // for a position elsewhere exist. On a torrent they usually do not, which is
  // why a bar that looked full still bought a wait on every seek.
  'demuxer-cache-state',
  'video-params', 'video-codec',
  'audio-params', 'audio-codec-name',
]

// A seek bar does not need 60fps. ~4/s is what the UI asked for (§4.2).
const STATE_THROTTLE_MS = 250

// How long the position may sit still — unpaused, with a file loaded — before
// the engine calls it a stall. The renderer keeps its own 10s watchdog; this
// fires earlier and carries engine truth rather than a guess from across the
// bridge.
const STALL_MS = 8000

// Every status flash paints for the same beat, so volume, seeks and pauses
// read as one vocabulary rather than three widgets.
const OSD_FLASH_MS = 1200

// 754 -> '12:34', 3725 -> '1:02:05'. The hour digit appears only when there is
// an hour to show, which is how every player the user knows writes it.
function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

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
    seekable: [],
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
    // Whether mpv is embedded is not known until start(), and the mouse
    // binding differs between the two, so the embedded config is resolved then
    // rather than here. An explicit inputConf from the caller wins in both.
    this._inputConfOverride = opts.inputConf
    this._inputConf = opts.inputConf !== undefined ? opts.inputConf : writeInputConf(configDir(), false)
    // The live §4.2 payload, plus the raw lists the track/chapter endpoints read.
    this.state = emptyState()
    this._trackList = []
    this._chapterList = []
    this._stateTimer = null
    this._lastActivity = 0
    // Stall detection rides the state ticks: when the position last moved,
    // what it last was, and whether the stall has already been announced.
    this._stalled = false
    this._lastPos = null
    this._lastAdvanceAt = 0
    this._stallTimer = null
    // How many distinct stalls this file has suffered (Player #27). A stall is
    // one event no matter how long it lasts; the count rises only when a fresh
    // stall begins after a recovery. Reset whenever a new file loads or the
    // engine (re)starts, so the UI can escalate — "switch source?" — on a file
    // that keeps stalling without carrying a grudge from the last one.
    this._stallCount = 0
    // Timing seams for tests; production uses STATE_THROTTLE_MS (~4/s) and
    // STALL_MS.
    this._stateThrottleMs = opts.stateThrottleMs ?? STATE_THROTTLE_MS
    this._stallMs = opts.stallMs ?? STALL_MS
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
      ...(() => {
        const conf = this._inputConfOverride !== undefined
          ? this._inputConfOverride
          : (wid ? writeInputConf(configDir(), true) : this._inputConf)
        return conf ? [`--input-conf=${conf}`] : []
      })(),
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
    // Everything below belongs to THIS start(). If the user switches sources
    // while the connect below is still awaiting, the newer start() bumps _gen
    // and stop()s this generation's process itself — any teardown from here
    // after that point would be aimed at the replacement's mpv, not ours.
    const gen = this._gen
    this.state = emptyState()
    this._trackList = []
    this._chapterList = []
    this._stalled = false
    this._lastPos = null
    this._lastAdvanceAt = 0
    // A (re)start is a clean slate: the stall history belongs to the previous
    // engine, not this one.
    this._stallCount = 0
    this._clearStallTimer()
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
      // process. Tear down and surface the real connect error. Only while this
      // start() is still the current one: a stale generation's proc and client
      // were already dealt with by the start() that replaced it, and this.proc
      // now names the replacement's process.
      if (gen === this._gen) {
        this.client = null
        try { this.proc?.kill() } catch { /* already dead */ }
        this.proc = null
      }
      throw err
    }
    // Replaced while connecting: this.client is the replacement's client now,
    // and attaching our handlers to it would deliver every event twice.
    if (gen !== this._gen) throw new EngineGone('start')
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
        // The throw alone left mpv running idle with its socket open — a
        // process nothing would ever reach again, since alive was never set.
        // Same generation rule as the connect failure above: a stale start()
        // must not touch the replacement's process.
        if (gen === this._gen) {
          this.client?.close()
          this.client = null
          try { this.proc?.kill() } catch { /* already dead */ }
          this.proc = null
        }
        throw err
      }
    }
    this.alive = true
    this.emit('ready')
    if (url) await this.load(url)
  }

  async load(url) {
    // A new file is a fresh stall history (Player #27). Reset here as well as on
    // the 'file-loaded' event: this fires the moment a new load is requested, so
    // a stall count from the previous file cannot briefly leak into the new one
    // in the window before mpv reports the file open.
    this._stallCount = 0
    this._stalled = false
    this._lastPos = null
    this._lastAdvanceAt = Date.now()
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

  // Paint status text on the picture itself. The HTML UI is composited UNDER
  // the native mpv surface, so a toast drawn by the page is invisible while a
  // film is playing — mpv's own OSD is the only text the viewer can see.
  // Deliberately a no-op when nothing is playing: the message has nowhere to
  // go, and losing a status line must never become an error.
  async osdMessage(text, durationMs) {
    if (!this.alive || !this.client) return
    const args = ['show-text', String(text ?? '')]
    const ms = Number(durationMs)
    // mpv takes the duration in milliseconds; omitted, --osd-duration applies.
    if (Number.isFinite(ms) && ms > 0) args.push(Math.round(ms))
    try {
      await this._guard('osdMessage')(...args)
    } catch (e) {
      // A generation swap between the check above and the send is the same
      // "nothing playing" case, not a failure.
      if (!(e instanceof EngineGone)) throw e
    }
  }

  // The handful of statuses the app flashes constantly, formatted once here so
  // every caller paints them identically. osdMessage stays as the free-form
  // door; this is the house style on top of it.
  //   osdFlash('volume', 85)                             -> 'Volume 85%'
  //   osdFlash('seek', { position: 754, forward: true }) -> '→ 12:34'
  //   osdFlash('pause', true)                            -> '⏸ Paused'
  //   osdFlash('pause', false)                           -> '▶'
  // An unknown kind is dropped, mirroring osdMessage's own discipline: a
  // status flash must never become an error.
  async osdFlash(kind, value) {
    let text = null
    if (kind === 'volume') {
      text = `Volume ${Math.round(Number(value) || 0)}%`
    } else if (kind === 'seek') {
      const forward = !!(value && value.forward)
      text = `${forward ? '→' : '←'} ${formatClock(value && value.position)}`
    } else if (kind === 'pause') {
      text = value ? '⏸ Paused' : '▶'
    }
    if (text === null) return
    await this.osdMessage(text, OSD_FLASH_MS)
  }

  stop() {
    this._stopping = true
    this.alive = false
    this._clearStateTimer()
    this._clearStallTimer()
    this._stalled = false
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
    this._clearStallTimer()
    this._stalled = false
    this.client?.close()
    this.client = null
    this.emit('engineDown', {})
  }

  // ── Property observation ───────────────────────────────────────────────────

  _onEvent(e) {
    if (!e) return
    if (e.event === 'property-change') return this._onProp(e.name, e.data)
    // The fate of the file. Without this a load that dies inside mpv — a dead
    // URL, a truncated download, a container it cannot open — is silent: the
    // engine stays alive, no state arrives, and the app cannot tell a film
    // that ended from one that never began. Only the two endings a consumer
    // must act on are emitted. 'stop' and 'redirect' are the engine's own
    // doing (a new load() replacing the file), and 'quit' already surfaces as
    // engineDown through the process exit; announcing those as endings would
    // make every episode change look like a finished film.
    if (e.event === 'end-file') {
      const reason = e.reason || 'unknown'
      if (reason === 'eof' || reason === 'error') {
        this.emit('ended', { reason, error: e.file_error || null })
      }
      return
    }
    // The moment mpv has actually opened the file — distinct from 'loaded',
    // which only says the loadfile command was sent and accepted.
    if (e.event === 'file-loaded') {
      // A fresh file starts a fresh stall clock and a fresh stall count.
      this._stalled = false
      this._lastPos = null
      this._lastAdvanceAt = Date.now()
      this._stallCount = 0
      return this.emit('fileLoaded')
    }
    // Keys bound in _bindAppKeys arrive as client messages. They are the only
    // way an action that lives in the app — skip intro, next episode — can be
    // triggered from the video window, which owns the keyboard while focused.
    if (e.event === 'client-message' && Array.isArray(e.args) && e.args[0] === 'papa') {
      this.emit('appKey', { action: e.args[1] || null })
    }
  }



  _onProp(name, data) {
    const s = this.state
    // Handled before the switch and returned from deliberately: this is not
    // playback state. It arrives at pointer rate, it would push the throttled
    // state stream to its ceiling for the whole time a hand rests on the mouse,
    // and nothing in the UI reads a cursor position. Only the fact of movement
    // is wanted, so only that is emitted -- and at most five times a second,
    // which is far more than a five-second idle timer needs.
    if (name === 'mouse-pos') {
      if (!data || data.hover !== true) return
      const now = Date.now()
      if (now - this._lastActivity < 200) return
      this._lastActivity = now
      this.emit('activity')
      return
    }
    switch (name) {
      case 'time-pos':
        if (data != null) {
          // The stall clock resets on any movement, including seeks: a jump is
          // the viewer going somewhere, not the stream getting stuck. And the
          // position moving again is what recovery IS, so 'unstalled' is
          // announced from here rather than from a poll that might be late.
          if (this._lastPos === null || data !== this._lastPos) {
            this._lastPos = data
            this._lastAdvanceAt = Date.now()
            if (this._stalled) {
              this._stalled = false
              this.emit('unstalled')
            }
          }
          s.position = data
        }
        break
      case 'duration':
        if (data != null) s.duration = data
        break
      case 'pause':
        s.paused = data === true
        // Unpausing restarts the stall clock from now: nothing advanced while
        // paused, and that was nobody's fault.
        if (!s.paused) this._lastAdvanceAt = Date.now()
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
      case 'demuxer-cache-duration':
        if (data != null) s.buffered = data
        break
      case 'demuxer-cache-state': {
        // Ranges mpv can seek within right now, in seconds. Everything outside
        // them costs a refetch, and on a torrent that means waiting for pieces
        // that may not have been asked for yet.
        const ranges = data && Array.isArray(data['seekable-ranges']) ? data['seekable-ranges'] : []
        // Number(null) is 0, so coercing first and checking isFinite after
        // silently turns a missing start into the beginning of the film — the
        // range would be drawn, and drawn wrong. The type is checked before the
        // value.
        const num = v => (typeof v === 'number' && isFinite(v) ? v : null)
        s.seekable = ranges
          .map(r => ({ start: num(r && r.start), end: num(r && r.end) }))
          .filter(r => r.start !== null && r.end !== null && r.end > r.start)
        break
      }
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
      if (this.alive) {
        this.emit('state', this.getState())
        this._checkStall()
      }
    }, this._stateThrottleMs)
    this._stateTimer.unref?.()
  }

  _clearStateTimer() {
    if (this._stateTimer) {
      clearTimeout(this._stateTimer)
      this._stateTimer = null
    }
  }

  // ── Stall detection ────────────────────────────────────────────────────────
  // Rides the state ticks: every tick asks how long the position has sat still
  // while unpaused with a file loaded. Ticks alone are not enough — a properly
  // stuck mpv stops changing properties, so the ticks stop with it — hence the
  // one-shot timer armed for the moment the deadline would pass. Recovery is
  // announced by the position itself moving again (see time-pos above).
  _checkStall() {
    const s = this.state
    if (!this.alive || s.paused || !(s.duration > 0)) {
      // Not a stall candidate. Leaving the stalled state this way — a pause,
      // an unload — still announces the recovery, so a spinner keyed to
      // 'stalled' can never be left spinning.
      this._clearStallTimer()
      if (this._stalled) {
        this._stalled = false
        this.emit('unstalled')
      }
      return
    }
    // Eligible before any position ever arrived: the clock starts now, not at
    // some zero that would read as an eight-second-old stall immediately.
    if (!this._lastAdvanceAt) this._lastAdvanceAt = Date.now()
    if (this._stalled) return
    const sinceMs = Date.now() - this._lastAdvanceAt
    if (sinceMs >= this._stallMs) {
      this._clearStallTimer()
      this._stalled = true
      // Each distinct stall counts once. The UI escalates on the tally — a
      // single stall is a spinner, a third is grounds to offer another source.
      this._stallCount++
      this.emit('stalled', { position: s.position, sinceMs, stallCount: this._stallCount })
      return
    }
    // Not yet — but make sure a check happens when the deadline passes even if
    // mpv goes completely silent between now and then.
    this._armStallTimer(this._stallMs - sinceMs)
  }

  _armStallTimer(delayMs) {
    this._clearStallTimer()
    this._stallTimer = setTimeout(() => {
      this._stallTimer = null
      this._checkStall()
    }, delayMs)
    this._stallTimer.unref?.()
  }

  _clearStallTimer() {
    if (this._stallTimer) {
      clearTimeout(this._stallTimer)
      this._stallTimer = null
    }
  }
}

module.exports = {
  VideoEngine,
  purgeOrphanPlayers,
  orphanPlayerSockets,
  screenshotDir,
  configDir,
  inputConfBody,
  APP_KEYS,
  EngineGone,
  OBSERVED_PROPS,
  STATE_THROTTLE_MS,
  STALL_MS,
  OSD_FLASH_MS,
  formatClock,
  SUB_STYLE_PROPS,
  normalizeTrack,
  normalizeChapter,
  emptyState,
}
