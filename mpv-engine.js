'use strict'
const { spawn } = require('child_process')
const { EventEmitter } = require('events')
const os = require('os')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { MpvIpcClient } = require('./mpv-ipc')
const { buildAfGraph, defaultSettings } = require('./eq')
const { ytdlPathArg, ytdlJsRuntimeArg } = require('./src/ytdlp-manager')

const POSITION_THROTTLE_MS = 250
const RESPAWN_WINDOW_MS = 60000
const MAX_RESPAWNS = 3
// Deaths on the SAME path before the file — not the engine — is declared the
// culprit and skipped. Two, not one: a single death can be a genuine engine
// hiccup that the resume recovers from cleanly, and a track should get that
// second chance before being written off.
const POISON_DEATHS = 2
// How soon after opening a file a death still counts as the FILE's fault. The
// field crash killed mpv 1.2-2.7s after playback-restart; a track that had
// been playing for minutes and then died is an engine fault, not a bad file.
const POISON_WINDOW_MS = 45000

// Nothing queued behind this file, so eof really is the end of the queue.
const EOF_GRACE_MS = 150
// Something WAS queued. mpv's gapless handoff normally lands in milliseconds,
// so this ceiling is only ever reached when the handoff failed — which is how an
// album stops one track early. Waiting it out means that by the time we tell the
// renderer the track ended, mpv is genuinely idle, so the renderer's loadfile is
// a fresh start rather than a cut across a file mpv is already playing.
const EOF_ADVANCE_TIMEOUT_MS = 3000

// How long after a command of ours that legitimately ends the current file an
// end-file 'stop' is still attributed to that command instead of being reported
// as an unexplained stop. Long enough for an IPC round-trip on a cold cache,
// short enough that a real stop seconds later is not swallowed. Either way the
// classification is recorded, so a wrong guess is visible rather than lost.
const EXPECTED_STOP_WINDOW_MS = 1500

// The resume sequence after a respawn is bounded. Without this, a seek that
// waits for a playback-restart mpv never reaches leaves _onExit pending forever:
// no engineRecovered, no engineFailed, and a UI stuck on "Reconnecting".
const RESUME_TIMEOUT_MS = 15000

// Ring buffer sizes. Both are dumped to the daily log on an abnormal end, so
// they must cover a full track transition and still leave a readable log entry.
const FLIGHT_ENTRIES = 300
const LOG_LINES = 200

// The stall watchdog. time-pos not advancing while pause is false is the exact
// signature of the stop that started this work, and nothing used to notice.
const TICK_MS = 2000
const HEARTBEAT_TICKS = 7          // ~14s between position records
const STALL_THRESHOLD_MS = 8000

// mpv's own message stream, at warn and above. Requested over IPC rather than
// read from stderr because --no-terminal silences mpv's stderr entirely; the
// stderr pipe below only ever catches output that bypasses mpv's logging.
const MPV_LOG_LEVEL = 'warn'

const OBSERVED_PROPS = ['time-pos', 'duration', 'pause', 'path', 'audio-params', 'volume']

// Lines that mean the output device itself went away, as opposed to any other
// mpv complaint. Worth telling apart: it is the one failure where respawning
// with the same arguments cannot possibly work.
const DEVICE_FAULT_RE = /audio device lost|could not open audio device|failed to (?:re)?open audio device|no audio device|device or resource busy|audio output.*fail/i

const FAULT_RE = /error|fail|cannot|unable|lost|denied|no such|refused|underrun|invalid/i

// Thrown instead of a TypeError when mpv dies between two awaits of the same
// sequence. `this.client = null` happens synchronously in _onExit, so any
// multi-step operation in flight would otherwise blow up on `null.command`.
class EngineGone extends Error {
  constructor(op) {
    super(`playback engine went away during ${op}`)
    this.name = 'EngineGone'
    this.code = 'ENGINE_GONE'
  }
}

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
      eq: defaultSettings(),
      // Bit-perfect output (roadmap #65). When true the spawn args drop every
      // sample-altering path — see _args. Off by default; main resolves the store
      // key and the incompatible-feature precedence in src/bit-perfect.js before
      // it ever reaches here.
      bitPerfect: false,
      // The exact yt-dlp mpv's bundled ytdl_hook should use. Pinning it stops
      // mpv from picking whatever is first on PATH — which is how a stale
      // /usr/bin/yt-dlp got selected and hung a resolve. Resolved by
      // src/ytdlp-manager.js's discovery order and passed in by main.js. Null
      // leaves mpv's own PATH search in place.
      ytdlPath: null,
      // The node binary yt-dlp uses as its JavaScript runtime (YouTube needs
      // one since late 2025); null leaves yt-dlp's own default (deno only).
      ytdlJsRuntime: null,
      ...opts.config,
    }
    this._spawnFn = opts.spawnFn || spawn
    this._fixedSocketPath = opts.socketPath || null
    // Timing seams. Defaults are the constants above; tests override them so a
    // watchdog with an 8 s threshold does not need an 8 s test.
    this._tickMs = opts.tickMs ?? TICK_MS
    this._heartbeatTicks = opts.heartbeatTicks ?? HEARTBEAT_TICKS
    this._stallMs = opts.stallMs ?? STALL_THRESHOLD_MS
    this._eofGraceMs = opts.eofGraceMs ?? EOF_GRACE_MS
    this._eofAdvanceMs = opts.eofAdvanceMs ?? EOF_ADVANCE_TIMEOUT_MS
    this._resumeTimeoutMs = opts.resumeTimeoutMs ?? RESUME_TIMEOUT_MS
    this.client = null
    this.proc = null
    this.alive = false
    this._stopping = false
    this._respawns = []
    // Poison-track quarantine. mpv can be killed by the FILE rather than by
    // anything wrong with the engine — a DSD stream the output chain segfaults
    // on, a truncated download, an exotic codec. The respawn path resumed the
    // very file that had just killed mpv, so one bad track burned every
    // respawn and took the whole player down with it: the field report was 17
    // SIGSEGVs in a row on one SACD DSD64 rip, ending in a dead engine.
    // Counting deaths per path lets the engine skip the offender instead.
    this._poisonPath = null
    this._poisonCount = 0
    this._lastPosEmit = 0
    this._nextPath = null
    // What mpv has CONFIRMED it has open, as opposed to state.path, which load()
    // sets optimistically the moment loadfile is issued. They must be separate:
    // comparing mpv's report against the optimistic value made every confirmation
    // look like old news, so the confirmation event was never emitted on a normal
    // track change and the renderer's copy of mpv's path stayed null (or, once
    // set, stale for the rest of the session).
    this._confirmedPath = null
    this._eofTimer = null
    // One state machine for what follows an eof, instead of two independent
    // timers that could both reach the renderer.
    this._eofState = 'idle'
    this._seekable = false
    this._pendingSeek = null
    // Incremented on every start(), so a command belonging to one mpv can never
    // be delivered to the mpv that replaced it.
    this._gen = 0
    this._flight = []
    this._mpvLog = []
    this._expectedStopUntil = 0
    this._ticker = null
    this._tick = 0
    this._lastPosChangeAt = 0
    this._stallReported = false
    this._deviceFault = null
    this._deviceFallback = false
    this._socketPath = null
    this.state = { path: null, position: 0, duration: 0, paused: true, volume: 100, audioParams: null }
  }

  _args(socketPath) {
    const a = [
      '--idle=yes', '--no-video', '--no-terminal', '--audio-display=no',
      `--input-ipc-server=${socketPath}`,
      `--replaygain=${this.config.replaygain}`,
      // 'weak' only stays gapless when the next file's format matches exactly,
      // so a 44.1kHz track following a 48kHz one gets a gap. 'yes' resamples to
      // hold the output open instead, which is what gapless has to mean when a
      // playlist mixes sample rates.
      `--gapless-audio=${this.config.gapless ? 'yes' : 'no'}`,
      // Without this mpv does not open the next file until the current one
      // ends, so every transition pays a demux-and-open delay no matter what
      // gapless-audio is set to. This is the flag that actually removes the gap.
      '--prefetch-playlist=yes',
      `--audio-channels=${channelsValue(this.config.audioChannels)}`,
      // Bit-perfect caps the ceiling at unity (100): any software gain above 100%
      // scales samples, which the mode exists to avoid. The normal path keeps the
      // 130% headroom the volume map relies on.
      this.config.bitPerfect ? '--volume-max=100' : '--volume-max=130',
      '--ytdl-format=bestaudio',
      '--cache=yes', '--cache-secs=30', '--demuxer-max-bytes=32MiB', '--demuxer-readahead-secs=30',
    ]
    // Pin mpv's ytdl_hook to the discovered yt-dlp so playback never depends on
    // PATH order (a stale /usr/bin/yt-dlp first on PATH is what hung a resolve).
    // -append, not the plain --script-opts, so any future script-opt survives.
    const ytdlArg = ytdlPathArg(this.config.ytdlPath)
    if (ytdlArg) a.push(ytdlArg)
    const jsArg = ytdlJsRuntimeArg(this.config.ytdlJsRuntime)
    if (jsArg) a.push(jsArg)
    // After a device-related respawn failure, stop asking for the device that is
    // not there. Exclusive mode on a vanished device fails instantly, which
    // burns all three respawns inside a couple of seconds.
    if (this.config.outputMode === 'exclusive' && this.config.alsaDevice && !this._deviceFallback) {
      a.push(`--audio-device=${this.config.alsaDevice}`, '--audio-exclusive=yes')
    } else if (this.config.bitPerfect && !this._deviceFallback) {
      // Bit-perfect still wants exclusive access even without a hand-picked device,
      // so the OS mixer does not resample to a shared rate. The default device is
      // opened exclusively. (A device fault falls back to shared, since exclusive
      // on a vanished device only burns respawns.)
      a.push('--audio-exclusive=yes')
    }
    // Passing the EQ at spawn time keeps it applied across the respawn and
    // restart paths, which rebuild the process rather than reusing the socket.
    // Bit-perfect resolves eq to null upstream, so buildAfGraph returns '' and no
    // --af filter chain is added — the samples reach the DAC untouched.
    const af = buildAfGraph(this.config.eq)
    if (af) a.push(`--af=${af}`)
    return a
  }

  // ── Command guard ──────────────────────────────────────────────────────────
  // Returns a send function pinned to the mpv that was current when the caller
  // started. Any await inside a multi-step sequence can be the moment mpv dies.
  _guard(op) {
    const gen = this._gen
    return (...args) => {
      if (!this.client || !this.alive || gen !== this._gen) {
        return Promise.reject(new EngineGone(op))
      }
      return this.client.command(...args)
    }
  }

  // ── Flight recorder ────────────────────────────────────────────────────────
  // Every playback-relevant transition lands here with a timestamp, whether or
  // not anything is wrong, so the next unexplained stop has a timeline behind
  // it instead of a silence.
  _rec(ev, fields) {
    this._flight.push({ at: Date.now(), ev, ...fields })
    const over = this._flight.length - FLIGHT_ENTRIES
    if (over > 0) this._flight.splice(0, over)
  }

  // Marks the window in which an end-file 'stop' is our own doing.
  _expectEndFile(cause) {
    this._expectedStopUntil = Date.now() + EXPECTED_STOP_WINDOW_MS
    this._rec('expect-end-file', { cause })
  }

  _pushLog(source, text) {
    const line = String(text || '').trim()
    if (!line) return
    this._mpvLog.push({ at: Date.now(), source, text: line })
    const over = this._mpvLog.length - LOG_LINES
    if (over > 0) this._mpvLog.splice(0, over)
    // Anything that reads like a fault belongs inline in the timeline, not only
    // in the tail — correlating the two by eye is what wastes the evidence.
    if (FAULT_RE.test(line)) {
      this._rec('mpv-log', { source, text: line.slice(0, 300) })
    }
    // The output device going away is the one fault worth separating from the
    // rest: respawning with the same arguments cannot fix it.
    if (DEVICE_FAULT_RE.test(line)) {
      const first = !this._deviceFault
      this._deviceFault = { at: Date.now(), text: line.slice(0, 300), source }
      this._rec('audio-device-fault', { source, text: line.slice(0, 300) })
      if (first) this.emit('audioDeviceLost', { ...this._deviceFault })
    }
  }

  // --no-terminal silences mpv's normal message output, so this pipe is NOT
  // where 'Audio device lost' arrives — that comes over IPC. What it does catch
  // is output bypassing mpv's logging entirely: libav aborts, asserts, and
  // whatever mpv prints while dying before it ever accepts an IPC connection.
  _attachStderr(proc) {
    const s = proc && proc.stderr
    if (!s) return
    try { s.setEncoding('utf8') } catch { /* not a stream we can decode */ }
    let buf = ''
    s.on('data', chunk => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        this._pushLog('stderr', buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
      // A crash can leave a final unterminated line; do not grow without bound.
      if (buf.length > 4096) { this._pushLog('stderr', buf); buf = '' }
    })
    s.on('error', () => { /* a dead pipe is not itself a playback fault */ })
  }

  // What the QA harness and the log dump read. Copies, not the live rings.
  getFlightRecorder() { return this._flight.slice() }
  getLogTail() { return this._mpvLog.slice() }

  // One place that packages "what just went wrong" together with the evidence
  // needed to explain it. main.js writes this to the daily log.
  _emitDiagnostic(kind, detail) {
    this.emit('diagnostic', {
      kind,
      detail,
      state: this.getState(),
      flight: this.getFlightRecorder(),
      log: this.getLogTail(),
    })
  }

  async start() {
    const runtimeDir = process.env.XDG_RUNTIME_DIR || os.tmpdir()
    // A random suffix rather than pid-plus-counter: after a SIGKILL the old
    // socket file is still on disk, and a name that can collide makes the
    // reaper's job ambiguous.
    const socketPath = this._fixedSocketPath ||
      path.join(runtimeDir, `papa-mpv-${process.pid}-${crypto.randomBytes(4).toString('hex')}.sock`)
    this._socketPath = socketPath
    this._stopping = false
    this._gen++
    const gen = this._gen
    this._eofState = 'idle'
    this._rec('spawn', {
      binary: this.binary, socketPath, generation: this._gen,
      outputMode: this.config.outputMode,
      device: this._deviceFallback ? 'fallback:default' : (this.config.alsaDevice || null),
      gapless: this.config.gapless, channels: this.config.audioChannels,
    })
    // stderr is piped rather than ignored so mpv's dying words are readable.
    const proc = this._spawnFn(this.binary, this._args(socketPath), { stdio: ['ignore', 'ignore', 'pipe'] })
    this.proc = proc
    this._attachStderr(proc)
    // Bound to THIS process, by identity. stop() SIGTERMs the old mpv and drops
    // its reference but cannot remove listeners it never held, and the start()
    // that follows clears _stopping in the same tick — while a real mpv takes
    // far longer than a tick to close its files and go. The old process's
    // 'exit' therefore arrived when _stopping was already false and alive
    // already true again, and _onExit tore down (and tried to respawn) the mpv
    // that had just replaced it.
    proc.on('exit', (code, signal) => {
      this._rec('proc-exit', { code: code ?? null, signal: signal ?? null, current: this.proc === proc })
      if (this.proc === proc) this._onExit()
    })
    proc.on('error', err => {
      this._rec('proc-error', { error: String((err && err.message) || err), current: this.proc === proc })
      if (this.proc === proc) this._onExit()
    })
    this.client = new MpvIpcClient(socketPath)
    try {
      await this.client.connect()
    } catch (err) {
      // mpv spawned but its socket never became ready. The bare throw left an
      // idle mpv running with its socket file on disk and nothing holding a
      // reference to either — alive was never set, so stop() would never be
      // called on it. video-engine already tore down on this exact path; this
      // is the same teardown.
      this._rec('connect-failed', { error: String((err && err.message) || err), socketPath })
      this._abandonStart(gen)
      throw err
    }
    // Same identity rule: stop() destroys the socket, but the 'disconnected'
    // that follows is delivered a tick later, by which time this.client may be
    // the replacement's.
    const client = this.client
    client.on('event', e => { if (this.client === client) this._onEvent(e) })
    client.on('disconnected', () => {
      this._rec('ipc-disconnected', { current: this.client === client })
      if (this.client === client) this._onExit()
    })
    // A slow mpv that eventually answered is not the same as a failure, and the
    // app's idea of state is wrong either way. Both are recorded.
    this.client.on('lateReply', d => this._rec('ipc-late-reply', {
      command: JSON.stringify(d.args), afterMs: d.afterMs, ok: d.ok, error: d.error,
    }))
    this.client.on('retry', d => this._rec('ipc-retry', { command: JSON.stringify(d.args), after: d.after }))
    this.client.on('overflow', d => this._rec('ipc-overflow', d))
    // Report WHICH property failed. A bare rejection here reached the respawn
    // path's catch and became an engineFailed with no reason at all.
    let obsId = 1
    for (const prop of OBSERVED_PROPS) {
      try {
        await this.client.observe(obsId++, prop)
      } catch (e) {
        this._rec('observe-failed', { property: prop, error: String((e && e.message) || e) })
        const err = new Error(`could not observe ${prop}: ${(e && e.message) || e}`)
        err.code = 'OBSERVE_FAILED'
        err.property = prop
        // Same leak as the connect failure: the throw alone left mpv running
        // idle with its socket open, a process nothing would ever reach again.
        this._abandonStart(gen)
        throw err
      }
    }
    // mpv's own diagnosis, over the socket we already trust as ground truth.
    // Best-effort: an mpv that does not know the command must still start.
    try {
      await this.client.command('request_log_messages', MPV_LOG_LEVEL)
    } catch (e) {
      this._rec('log-request-failed', { error: String((e && e.message) || e) })
    }
    this.alive = true
    this._startTicker()
    this._rec('ready', { socketPath, generation: this._gen })
    this.emit('ready')
  }

  // ── Stall watchdog ─────────────────────────────────────────────────────────
  _startTicker() {
    clearInterval(this._ticker)
    this._tick = 0
    this._lastPosChangeAt = Date.now()
    this._stallReported = false
    this._ticker = setInterval(() => this._onTick(), this._tickMs)
    this._ticker.unref?.()
  }

  _stopTicker() {
    clearInterval(this._ticker)
    this._ticker = null
  }

  _onTick() {
    if (!this.alive) return
    this._tick++
    if (this._tick % this._heartbeatTicks === 0) {
      this._rec('heartbeat', {
        path: this.state.path,
        position: Math.round(this.state.position),
        paused: this.state.paused,
      })
    }
    const stalledFor = Date.now() - this._lastPosChangeAt
    const shouldBeMoving = this.isActuallyPlaying()
    if (!shouldBeMoving || stalledFor < this._stallMs) {
      if (shouldBeMoving) this._stallReported = false
      return
    }
    if (this._stallReported) return
    this._stallReported = true
    this._rec('stalled', { path: this.state.path, position: this.state.position, stalledForMs: stalledFor })
    // Ask mpv what it thinks, rather than concluding anything from our own view.
    this._probeStall(stalledFor).catch(e => {
      this._rec('stall-probe-failed', { error: String((e && e.message) || e) })
      this._emitDiagnostic('stalled', { reason: 'probe-failed', stalledForMs: stalledFor })
      this.emit('stalled', { path: this.state.path, position: this.state.position, stalledForMs: stalledFor, probe: null })
    })
  }

  async _probeStall(stalledFor) {
    const cmd = this._guard('stall-probe')
    const probe = {}
    for (const prop of ['idle-active', 'core-idle', 'eof-reached', 'path', 'pause']) {
      try { probe[prop] = await cmd('get_property', prop) } catch (e) { probe[prop] = `<${(e && e.message) || e}>` }
    }
    this._rec('stall-probe', probe)
    // mpv idle while we believe we are playing IS the silent stop. Report it as
    // one, with the reason naming how it was found.
    if (probe['idle-active'] === true) {
      const stopped = {
        reason: 'stalled-idle', path: this.state.path,
        position: this.state.position, duration: this.state.duration, stalledForMs: stalledFor,
      }
      this.emit('stopped', stopped)
      this._emitDiagnostic('stopped', stopped)
      return
    }
    this.emit('stalled', { path: this.state.path, position: this.state.position, stalledForMs: stalledFor, probe })
    this._emitDiagnostic('stalled', { stalledForMs: stalledFor, probe })
  }

  // Tear down a start() that failed part-way. Only while this start() is still
  // the current one: a stale generation's process and client were already dealt
  // with by the start() that replaced it, and this.proc now names that
  // replacement's process — killing it here would take down a working engine.
  _abandonStart(gen) {
    if (gen !== this._gen) return
    try { this.client?.close() } catch { /* already closed */ }
    this.client = null
    try { this.proc?.kill() } catch { /* already dead */ }
    this.proc = null
    this.alive = false
    this._stopTicker()
    if (this._socketPath && !this._fixedSocketPath) {
      try { fs.unlinkSync(this._socketPath) } catch { /* mpv may have taken it already */ }
    }
  }

  stop() {
    this._rec('stop-requested', { path: this.state.path, position: this.state.position })
    this._expectEndFile('engine-stop')
    this._stopping = true
    this.alive = false
    this._seekable = false
    this._eofState = 'idle'
    this._stopTicker()
    this._flushPendingSeek({ send: false })
    clearTimeout(this._eofTimer)
    this.client?.close()
    this.client = null
    try { this.proc?.kill() } catch { /* already dead */ }
    this.proc = null
    // Leaving the socket file behind is what made the orphan reaper's job
    // ambiguous. Only ours, only the one we made, and never fatal.
    if (this._socketPath && !this._fixedSocketPath) {
      try { fs.unlinkSync(this._socketPath) } catch { /* mpv may have taken it already */ }
    }
  }

  async load(filePath, { play = true } = {}) {
    const cmd = this._guard('load')
    this._nextPath = null
    this._seekable = false
    this._eofState = 'idle'
    clearTimeout(this._eofTimer)
    this._flushPendingSeek({ send: false })
    this._rec('load', { path: filePath, play })
    // loadfile 'replace' ends whatever is playing, with reason 'stop'.
    this._expectEndFile('load-replace')
    try {
      if (!play) await cmd('set_property', 'pause', true)
      await cmd('loadfile', filePath, 'replace')
      if (play) await cmd('set_property', 'pause', false)
    } catch (e) {
      this._rec('load-failed', { path: filePath, error: String((e && e.message) || e), code: e && e.code })
      throw e
    }
    this.state.path = filePath
    this.state.position = 0
    this._lastPosChangeAt = Date.now()
    // When this path was opened. Poison is specifically an EARLY death — the
    // file kills mpv as it starts decoding it. A track that played happily for
    // an hour before an unrelated engine fault must never be blamed for it.
    this._pathOpenedAt = Date.now()
    this._stallReported = false
  }

  async setNext(filePath) {
    const want = filePath || null
    // The renderer calls this on every prefetch update, usually with the value
    // it already sent. Sending nothing at all is the only guaranteed way not to
    // end the current file, and it removes most of the exposure in one step.
    if (want === this._nextPath) {
      this._rec('set-next-unchanged', { path: want })
      return
    }
    const cmd = this._guard('setNext')
    this._rec('set-next', { path: want, previous: this._nextPath })
    // playlist-clear can end the current file on any edge where mpv does not
    // consider it the current entry, which arrives as reason 'stop'.
    this._expectEndFile('playlist-clear')
    try {
      await cmd('playlist-clear')
      this._nextPath = want
      if (want) await cmd('loadfile', want, 'append')
    } catch (e) {
      this._rec('set-next-failed', { path: want, error: String((e && e.message) || e), code: e && e.code })
      throw e
    }
  }

  async play() { await this._guard('play')('set_property', 'pause', false) }
  async pause() { await this._guard('pause')('set_property', 'pause', true) }

  // mpv rejects seeks between start-file and playback-restart; defer until
  // the file is seekable, keeping only the latest requested position.
  async seek(seconds) {
    this._rec('seek', { seconds, deferred: !this._seekable })
    if (this._seekable) {
      await this._guard('seek')('seek', seconds, 'absolute')
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
      const done = this._guard('deferred-seek')('seek', pending.seconds, 'absolute')
      for (const s of pending.settlers) done.then(s.resolve, s.reject)
      return
    }
    // A new track load cancelling a deferred seek is normal, not an error.
    // Rejecting made it an unhandled rejection at every call site that did not
    // expect a failure it could do nothing about.
    this._rec('seek-cancelled', { seconds: pending.seconds, settlers: pending.settlers.length })
    for (const s of pending.settlers) s.resolve({ cancelled: true, seconds: pending.seconds })
  }

  // Volume and speed are cosmetic: a slider moved during a respawn must never
  // become a playback failure. A real mpv error still propagates — only the
  // engine having gone away is absorbed.
  async setVolume(v) {
    try {
      await this._guard('setVolume')('set_property', 'volume', v)
    } catch (e) {
      if (e && e.code === 'ENGINE_GONE') { this._rec('set-volume-skipped', { volume: v }); return }
      throw e
    }
  }

  async setSpeed(x) {
    try {
      await this._guard('setSpeed')('set_property', 'speed', x)
    } catch (e) {
      if (e && e.code === 'ENGINE_GONE') { this._rec('set-speed-skipped', { speed: x }); return }
      throw e
    }
  }

  async setReplaygain(mode) {
    this.config.replaygain = mode
    await this._guard('setReplaygain')('set_property', 'replaygain', mode)
  }

  // A–B loop repeat (roadmap #5). mpv has native ab-loop-a / ab-loop-b
  // properties: set both to loop that segment, set them to "no" to clear. The
  // renderer passes seconds ({a, b}) or null to clear. Kept off `config` on
  // purpose — an A–B loop is about the current file's timeline and must not
  // survive a respawn onto a different track.
  async setAbLoop(range) {
    if (!range || range.a == null || range.b == null) {
      await this._guard('clearAbLoopA')('set_property', 'ab-loop-a', 'no')
      await this._guard('clearAbLoopB')('set_property', 'ab-loop-b', 'no')
      return { ok: true, cleared: true }
    }
    const a = Number(range.a)
    const b = Number(range.b)
    // mpv wants A before B; a caller that hands them the wrong way round should
    // still get a sane loop rather than an ignored command.
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    await this._guard('setAbLoopA')('set_property', 'ab-loop-a', lo)
    await this._guard('setAbLoopB')('set_property', 'ab-loop-b', hi)
    return { ok: true, a: lo, b: hi }
  }

  async setChannels(layout) {
    this.config.audioChannels = layout
    await this._guard('setChannels')('set_property', 'audio-channels', channelsValue(layout))
  }

  // Applies live to the running stream — mpv rebuilds the filter chain without
  // dropping the current file, so there is no gap when the user moves a slider.
  async setEq(settings) {
    this.config.eq = settings
    await this._guard('setEq')('set_property', 'af', buildAfGraph(settings))
  }

  async listAudioDevices() {
    return this._guard('listAudioDevices')('get_property', 'audio-device-list')
  }

  // One property, read from mpv rather than from our own mirror of it. The
  // device handlers in main.js used to reach for a `player.mpv` that never
  // existed, so every one of them silently did nothing.
  async getProperty(name) {
    return this._guard('getProperty')('get_property', name)
  }

  async setProperty(name, value) {
    return this._guard('setProperty')('set_property', name, value)
  }

  // Replays the state a new mpv has to be put back into. Shared by restart()
  // and the respawn path so they cannot drift apart, and bounded so a resume
  // that cannot finish is reported instead of hanging.
  async _resume(resume, op) {
    if (!resume.path) return { resumed: false }
    const sequence = (async () => {
      await this.load(resume.path, { play: false })
      if (resume.position > 1) await this.seek(resume.position)
      await this.setVolume(resume.volume)
      if (!resume.paused) await this.play()
      return { resumed: true }
    })()
    let timer
    const bound = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`${op} did not complete within ${this._resumeTimeoutMs}ms`)
        err.code = 'RESUME_TIMEOUT'
        reject(err)
      }, this._resumeTimeoutMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([sequence, bound])
    } finally {
      clearTimeout(timer)
    }
  }

  // The supervised resume, as a public entry point. main uses it for a settings
  // rebuild so that path cannot drift from the respawn path — which is exactly
  // how the rebuild ended up replaying load/seek/volume/play with no failure
  // handling of its own.
  async resumeState(resume) { return this._resume(resume, 'resume') }

  async restart(newConfig = {}) {
    const resume = { ...this.state }
    this._rec('restart', { changed: Object.keys(newConfig), path: resume.path, position: resume.position })
    this.stop()
    this.config = { ...this.config, ...newConfig }
    // A device the user just chose deserves a fresh attempt, not the fallback
    // left over from the last failure.
    this._deviceFallback = false
    this._deviceFault = null
    await this.start()
    try {
      await this._resume(resume, 'restart')
    } catch (e) {
      // Half-configured with no event emitted was the old behaviour. Say so, so
      // the UI can offer Resume rather than looking like it is playing.
      this._rec('restart-resume-failed', { error: String((e && e.message) || e), code: e && e.code })
      const stopped = {
        reason: 'restart-incomplete', path: resume.path,
        position: resume.position, duration: resume.duration,
        detail: String((e && e.message) || e),
      }
      this.emit('stopped', stopped)
      this._emitDiagnostic('stopped', stopped)
    }
  }

  getState() { return { ...this.state } }

  // True only while mpv is actually moving audio forward: not paused, has a
  // loaded path, and not sitting in an end-of-file/idle state after a track
  // ended or playback stopped. state.paused alone is stale once mpv goes idle
  // (its 'pause' property observer never fires again), which is why callers
  // that need "can I hog the CPU with a background job right now" must use
  // this instead of `!getState().paused`.
  isActuallyPlaying() {
    return Boolean(!this.state.paused && this.state.path && this._eofState === 'idle')
  }

  _onEvent(e) {
    if (e.event === 'property-change') {
      this._onProp(e.name, e.data)
    } else if (e.event === 'end-file') {
      this._onEndFile(e)
    } else if (e.event === 'start-file') {
      this._rec('start-file', { eofState: this._eofState })
      // mpv is opening a file. If that is the answer to an eof we were waiting
      // on, the 'ended' path is now off the table.
      if (this._eofState === 'pending') {
        clearTimeout(this._eofTimer)
        this._eofState = 'advancing'
      }
      this._seekable = false
    } else if (e.event === 'playback-restart') {
      this._rec('playback-restart', { position: this.state.position })
      this._seekable = true
      this._lastPosChangeAt = Date.now()
      this._stallReported = false
      this._flushPendingSeek({ send: true })
    } else if (e.event === 'log-message') {
      this._pushLog(`mpv/${e.prefix || '?'}`, `[${e.level}] ${e.text}`)
    } else if (e.event === 'audio-reconfig' || e.event === 'idle') {
      this._rec(e.event, {})
    }
  }

  // mpv emits more end-file reasons than eof and error. The rest used to
  // produce no event at all: mpv went idle, isPlaying stayed true, the progress
  // bar froze, and nothing was written anywhere. Every reason is mapped here,
  // including reasons a future mpv invents.
  _onEndFile(e) {
    const reason = e.reason || 'unknown'
    const expected = Date.now() < this._expectedStopUntil
    this._rec('end-file', {
      reason, expected,
      path: this.state.path,
      position: this.state.position,
      duration: this.state.duration,
      hasNext: !!this._nextPath,
      fileError: e.file_error || null,
    })

    if (reason === 'error') {
      this._expectedStopUntil = 0
      this._eofState = 'idle'
      clearTimeout(this._eofTimer)
      this.emit('loadError', this.state.path)
      this._emitDiagnostic('load-error', { reason, path: this.state.path, fileError: e.file_error || null })
      return
    }

    if (reason === 'eof') {
      this._expectedStopUntil = 0
      this._onEof()
      return
    }

    // A redirect is mpv resolving one playlist entry into another. It opens the
    // target itself, so there is nothing to report and nothing to recover.
    if (reason === 'redirect') return

    // Our own loadfile-replace, playlist-clear or stop() ended the file. Normal
    // handoff, already recorded above.
    if (expected) {
      this._expectedStopUntil = 0
      return
    }

    // Everything left — 'stop', 'quit', 'unknown', anything new — leaves mpv
    // idle with nothing playing and no other event on its way. This is the
    // silent mid-album stop, and it now has a name.
    this._eofState = 'idle'
    clearTimeout(this._eofTimer)
    const stopped = {
      reason,
      path: this.state.path,
      position: this.state.position,
      duration: this.state.duration,
    }
    this.emit('stopped', stopped)
    this._emitDiagnostic('stopped', stopped)
  }

  // After an eof, exactly one of 'ended' or 'autoAdvanced' may reach the
  // renderer. They used to be two independent timers, so a late start-file
  // produced both: the track was scrobbled twice and playNext() issued a
  // loadfile replace across a file mpv had already started playing.
  _onEof() {
    clearTimeout(this._eofTimer)
    this._eofState = 'pending'
    const expectingAdvance = !!this._nextPath
    const queued = this._nextPath
    const endedPath = this.state.path
    const wait = expectingAdvance ? this._eofAdvanceMs : this._eofGraceMs
    this._rec('eof', { path: endedPath, expectingAdvance, queued, waitMs: wait })
    this._eofTimer = setTimeout(() => {
      if (this._eofState !== 'pending') return
      this._eofState = 'ended'
      if (expectingAdvance) {
        // We had a file queued and mpv never opened it. That is the gapless
        // handoff failing, which is exactly how an album stops one track early.
        // 'ended' is still emitted, so the renderer advances and the music keeps
        // playing — but the failure is on the record instead of being invisible.
        this._rec('advance-failed', { ended: endedPath, queued, waitedMs: wait })
        this._emitDiagnostic('advance-failed', { ended: endedPath, queued, waitedMs: wait })
      }
      this.emit('ended')
    }, wait)
  }

  _onProp(name, data) {
    switch (name) {
      case 'time-pos': {
        if (data == null) return
        if (data !== this.state.position) {
          this._lastPosChangeAt = Date.now()
          this._stallReported = false
        }
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
        this._rec('pause', { paused: data, position: this.state.position })
        this.state.paused = data
        // Unpausing restarts the stall clock; a long pause is not a stall.
        if (!data) { this._lastPosChangeAt = Date.now(); this._stallReported = false }
        this.emit('paused', data)
        break
      case 'volume':
        if (data == null) return
        this.state.volume = data
        this.emit('volume', data)
        break
      case 'audio-params':
        if (!data) return
        this._rec('audio-params', {
          format: data.format || null,
          samplerate: data.samplerate || null,
          channels: data.channels || data['channel-count'] || null,
        })
        this.state.audioParams = data
        this.emit('audioParams', data)
        break
      case 'path': {
        if (!data || data === this._confirmedPath) return
        const previous = this._confirmedPath
        this._confirmedPath = data
        const eofState = this._eofState
        this.state.path = data
        this._lastPosChangeAt = Date.now()
        this._stallReported = false
        // The renderer has already been told the track ended and has already
        // advanced. Emitting autoAdvanced now is the double-fire.
        if (eofState === 'ended') {
          this._eofState = 'idle'
          this._rec('late-advance-suppressed', { from: previous, to: data })
          if (data === this._nextPath) this._nextPath = null
          // The ADVANCE is the double-fire, not the fact of which file mpv now
          // has open. Returning in total silence left the renderer's copy of
          // mpv's path pinned to the track that just ended — for the rest of
          // the session, since nothing else ever sets it. The desync
          // reconciler treats that copy as ground truth, so it then dragged
          // the queue back to the finished track roughly once a second and
          // every manual Next was undone before the listener could hear it.
          this.emit('trackChanged', data)
          return
        }
        if (eofState === 'pending' || eofState === 'advancing') {
          clearTimeout(this._eofTimer)
          this._eofState = 'idle'
        }
        if (data === this._nextPath) {
          this._nextPath = null
          this._rec('auto-advanced', { from: previous, to: data })
          this.emit('autoAdvanced', data)
        } else {
          this._rec('track-changed', { from: previous, to: data })
          this.emit('trackChanged', data)
        }
        break
      }
    }
  }

  async _onExit() {
    if (this._stopping || !this.alive) return
    this.alive = false
    this._stopTicker()
    clearTimeout(this._eofTimer)
    this._eofState = 'idle'
    this.client?.close()
    this.client = null
    // let, not const: the device-loss policy below rewrites this to come back
    // paused. As a const that reassignment threw a TypeError before start() was
    // ever reached, so unplugging headphones mid-track killed the engine for
    // good — no respawn, no engineFailed, nothing to tell the renderer. The
    // one test that looked like it covered this only regex-matched the source.
    let resume = { ...this.state }
    const now = Date.now()
    this._respawns = this._respawns.filter(t => now - t < RESPAWN_WINDOW_MS)
    // Blame the file before blaming the engine. A second EARLY death on the
    // same path is the signal: the engine is fine, this track kills it.
    // Resuming it again would only spend the remaining respawns reproducing
    // the crash. Late deaths (a track that had been playing for a while) are
    // not the file's fault and never count toward poisoning.
    const earlyDeath = this._pathOpenedAt != null &&
      (now - this._pathOpenedAt) <= POISON_WINDOW_MS
    if (resume.path && earlyDeath) {
      if (resume.path === this._poisonPath) this._poisonCount++
      else { this._poisonPath = resume.path; this._poisonCount = 1 }
    } else {
      this._poisonPath = null
      this._poisonCount = 0
    }
    const poisoned = !!(resume.path && this._poisonCount >= POISON_DEATHS)
    const willRecover = this._respawns.length < MAX_RESPAWNS
    // A device fault means respawning with the same arguments cannot work.
    // Falling back to the default device is the difference between recovering
    // and burning all three attempts in two seconds.
    const deviceFault = this._deviceFault
    if (deviceFault && this.config.outputMode === 'exclusive' && this.config.alsaDevice && !this._deviceFallback) {
      this._deviceFallback = true
      this._rec('device-fallback', { from: this.config.alsaDevice, because: deviceFault.text })
      this.emit('audioDeviceFallback', { from: this.config.alsaDevice, because: deviceFault.text })
    }
    this._rec('engine-down', {
      path: resume.path, position: resume.position, paused: resume.paused,
      willRecover, respawnsInWindow: this._respawns.length,
      deviceFault: deviceFault ? deviceFault.text : null,
    })
    // The renderer needs this before the respawn is attempted, so the UI stops
    // claiming it is playing during the gap.
    this.emit('engineDown', {
      path: resume.path, position: resume.position, willRecover,
      deviceFault: deviceFault ? deviceFault.text : null,
    })
    // A poisoned track is not an engine failure, so it must not reach _fail()
    // and blocker the UI — the engine comes back empty and the renderer skips
    // to the next track. Checked BEFORE the respawn budget: a file that kills
    // mpv should never be able to exhaust it.
    if (poisoned && !deviceFault) {
      this._rec('track-poisoned', { path: resume.path, deaths: this._poisonCount })
      this._respawns.push(now)
      try {
        await this.start()
        this._poisonPath = null
        this._poisonCount = 0
        // Honest and specific: the renderer names the file and moves on. The
        // engine is alive and idle, ready for whatever plays next.
        this.emit('trackUnplayable', {
          path: resume.path,
          deaths: POISON_DEATHS,
          reason: 'the audio engine crashed on this file every time it was opened',
        })
        this._emitDiagnostic('track-poisoned', { path: resume.path })
        return
      } catch (e) {
        this._fail('respawn-error', String((e && e.message) || e))
        return
      }
    }
    if (!willRecover) {
      this._fail(deviceFault ? 'audio-device-lost' : 'respawn-limit',
        deviceFault
          ? `the audio device kept failing: ${deviceFault.text}`
          : `mpv died ${this._respawns.length + 1} times in ${Math.round(RESPAWN_WINDOW_MS / 1000)}s`)
      return
    }
    this._respawns.push(now)
    // Roadmap 038: the device that was playing went away. Coming back on
    // whatever device is now the default — the speakers, when the headphones
    // were what vanished — must not happen at full volume without a say. The
    // policy is a config (onDeviceLoss: 'pause' | 'continue'), default pause:
    // the position is kept and the engine comes back paused, and the renderer
    // says so with a "keep playing" way on.
    const pauseForSafety = !!deviceFault && !resume.paused && (this.config.onDeviceLoss || 'pause') !== 'continue'
    if (pauseForSafety) {
      resume = { ...resume, paused: true }
      this._rec('device-loss-pause', { path: resume.path, position: resume.position, because: deviceFault.text })
    }
    try {
      await this.start()
      const outcome = await this._resume(resume, 'respawn resume')
      this._rec('engine-recovered', { path: resume.path, position: resume.position, resumed: outcome.resumed })
      // Decided behaviour: resume where we were, then say so briefly. Never a
      // blocking prompt, never silent.
      this.emit('engineRecovered', {
        path: resume.path, position: resume.position,
        resumed: outcome.resumed, wasPlaying: !resume.paused,
        deviceFallback: this._deviceFallback,
        pausedForSafety: pauseForSafety,
      })
      this._emitDiagnostic('engine-recovered', { path: resume.path, position: resume.position })
    } catch (e) {
      const code = e && e.code
      this._fail(code === 'RESUME_TIMEOUT' ? 'resume-timeout' : 'respawn-error',
        String((e && e.message) || e))
    }
  }

  // engineFailed used to carry nothing, so the UI told the user to install mpv
  // even when mpv was installed and the real fault was an audio device loss.
  _fail(reason, detail) {
    this._rec('engine-failed', { reason, detail })
    this.emit('engineFailed', {
      reason,
      detail,
      deviceFault: this._deviceFault ? this._deviceFault.text : null,
      log: this._mpvLog.slice(-20).map(l => l.text),
    })
    this._emitDiagnostic('engine-failed', { reason, detail })
  }
}

module.exports = {
  MpvEngine, EngineGone, channelsValue,
  FLIGHT_ENTRIES, LOG_LINES, EXPECTED_STOP_WINDOW_MS,
  EOF_GRACE_MS, EOF_ADVANCE_TIMEOUT_MS, RESUME_TIMEOUT_MS, STALL_THRESHOLD_MS,
}
