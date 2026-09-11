'use strict'
// yt-dlp self-maintenance. YouTube playback broke silently once because the
// system yt-dlp (/usr/bin, from dnf) went stale enough that a fresh resolve
// HUNG forever. The fix was `pip install --user --upgrade yt-dlp`, which lands a
// newer binary in ~/.local/bin. This module makes that never-recur automatic:
// it finds the best yt-dlp on the machine, decides when it is due for an update,
// runs the pip upgrade, and probes that resolving actually works.
//
// The file is two halves on purpose. Everything above the "Exec layer" divider
// is pure — no spawn, no fs, no clock except what is passed in — so the
// staleness policy, the discovery order, and the throttle/cap arithmetic are all
// testable without a real yt-dlp, a real clock, or a real network. The exec
// layer below is the thin shell that binds those pure decisions to child_process
// and the filesystem.

const path = require('path')
const os = require('os')

// ── Constants (policy) ───────────────────────────────────────────────────────

// A yt-dlp older than this is treated as due for an update even if it still
// resolves — yt-dlp ships fixes for YouTube's frequent breakage roughly weekly,
// so three weeks is already living dangerously.
const STALE_AFTER_DAYS = 21

// The automatic check runs this long after startup (once the app has settled)
// and then no more often than every few days. The interval is deliberately not
// aggressive: the update is a network install, not something to do hourly.
const STARTUP_CHECK_DELAY_MS = 60 * 1000
const CHECK_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000

// A resolve failure during real playback may trigger at most one immediate
// update per day, so a persistently broken YouTube cannot spawn a pip install on
// every single track.
const IMMEDIATE_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000

// Per-call timeouts for the three things we run yt-dlp / pip for.
const VERSION_TIMEOUT_MS = 5 * 1000
const PROBE_TIMEOUT_MS = 20 * 1000
const UPDATE_TIMEOUT_MS = 120 * 1000

// A stable, always-available video id for the health probe. "Me at the zoo",
// the first YouTube video ever uploaded — it is never going to be taken down,
// age-gated, or region-locked, which is exactly what a health check needs.
const PROBE_VIDEO_ID = 'jNQXAC9IVRw'

// How much of a spawned command's output to keep. Enough to show the user why a
// pip install failed without dumping megabytes into the log or the event.
const OUTPUT_TAIL_BYTES = 2000

// ── Discovery (pure) ─────────────────────────────────────────────────────────

// Where to look for yt-dlp, best first. The pip --user upgrade lands in
// ~/.local/bin, so that has to win over the dnf-managed /usr/bin one — the exact
// ordering that fixed the original hang. A bare 'yt-dlp' is the final fallback,
// resolved against PATH by the OS at spawn time.
//
// homeDir is injected so the order is testable without reading the real HOME.
function candidatePaths(homeDir) {
  const home = homeDir || os.homedir()
  return [
    path.join(home, '.local', 'bin', 'yt-dlp'),
    path.join('/usr', 'bin', 'yt-dlp'),
    'yt-dlp',
  ]
}

// Given the candidate paths and a predicate that says whether an absolute path
// is an executable file, return the first that exists — or the bare 'yt-dlp'
// PATH fallback if none of the absolute ones do. `exists` is only asked about
// absolute paths; the trailing bare name is never stat-able and is always the
// answer of last resort.
function pickBinary(candidates, exists) {
  for (const c of candidates) {
    if (!path.isAbsolute(c)) return c // the bare 'yt-dlp' fallback
    if (exists(c)) return c
  }
  // candidates always ends in the bare fallback, so this is unreachable in
  // practice; kept so the function is total for any input.
  return 'yt-dlp'
}

// ── Version parsing (pure) ───────────────────────────────────────────────────

// yt-dlp --version prints a date-based version like "2026.08.19" (occasionally
// with a trailing build suffix). Parse the date so staleness is a real
// comparison, not a string sort. Returns a millisecond timestamp, or null if the
// line is not a recognisable yt-dlp version.
function parseVersionDate(versionString) {
  const m = /(\d{4})\.(\d{2})\.(\d{2})/.exec(String(versionString || '').trim())
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  // UTC so the same version string yields the same age regardless of timezone.
  const ts = Date.UTC(year, month - 1, day)
  return Number.isFinite(ts) ? ts : null
}

// ── Staleness policy (pure) ──────────────────────────────────────────────────

// The one decision at the heart of the module: is this yt-dlp due for an update?
// Two independent triggers, either sufficient:
//   1. The version date is older than STALE_AFTER_DAYS.
//   2. The resolve health check failed (a live signal that beats any date).
// An unparseable / unknown version counts as stale too — better to update a
// binary we cannot date than to trust it silently.
//
//   input:  { versionDate, probeOk, now, staleAfterDays? }
//   output: { due, reason }
function isUpdateDue({ versionDate, probeOk, now, staleAfterDays = STALE_AFTER_DAYS } = {}) {
  if (probeOk === false) {
    return { due: true, reason: 'health-check-failed' }
  }
  if (versionDate == null) {
    return { due: true, reason: 'version-unknown' }
  }
  const ageMs = now - versionDate
  const staleMs = staleAfterDays * 24 * 60 * 60 * 1000
  if (ageMs >= staleMs) {
    return { due: true, reason: 'version-stale' }
  }
  return { due: false, reason: 'fresh' }
}

// ── Throttle / cap policy (pure) ─────────────────────────────────────────────

// Should the scheduled auto-check run now? Throttled by when it last ran, so
// startup + a long uptime does not re-check every timer tick. A never-checked
// binary (lastCheckAt null) is always due.
//   input:  { lastCheckAt, now, intervalMs? }
function shouldAutoCheck({ lastCheckAt, now, intervalMs = CHECK_INTERVAL_MS } = {}) {
  if (!lastCheckAt) return true
  return (now - lastCheckAt) >= intervalMs
}

// May a playback-error-triggered immediate update run right now? Capped to one
// per IMMEDIATE_UPDATE_INTERVAL_MS by the last update timestamp, so a broken
// YouTube cannot spawn a pip install on every failed track.
//   input:  { lastUpdateAt, now, intervalMs? }
function canImmediateUpdate({ lastUpdateAt, now, intervalMs = IMMEDIATE_UPDATE_INTERVAL_MS } = {}) {
  if (!lastUpdateAt) return true
  return (now - lastUpdateAt) >= intervalMs
}

// ── Spawn-arg construction (pure) ────────────────────────────────────────────
// The exact argv for each of the three subprocesses, built as arrays so no shell
// ever parses them. Kept pure and exported so the tests can assert the flags
// without spawning anything.

function versionArgs() {
  return ['--version']
}

// The health probe: resolve a known-stable video's direct URL without
// downloading. --simulate + --get-url is the cheapest "does resolving work at
// all" question yt-dlp can answer.
function probeArgs(videoId = PROBE_VIDEO_ID) {
  return ['--simulate', '--get-url', '-f', 'bestaudio/best',
    '--no-playlist', '--', videoId]
}

// The update: `pip install --user --upgrade yt-dlp`. `pipBinary` is whichever of
// pip3 / pip was feature-detected; if neither exists the caller must never reach
// here (see pipAvailable).
function updateArgs(pipBinary) {
  return [pipBinary, ['install', '--user', '--upgrade', 'yt-dlp']]
}

// ── mpv wiring (pure) ────────────────────────────────────────────────────────

// The mpv option that pins mpv's bundled ytdl_hook to a specific yt-dlp, instead
// of letting it search PATH (which is how the stale /usr/bin one got picked up).
// Verified against mpv's ytdl_hook.lua: the script reads the script-opt
// `ytdl_hook-ytdl_path`. --script-opts-append is used rather than --script-opts
// so this never clobbers any other script-opt already on the command line.
//
//   ytdlPath => '--script-opts-append=ytdl_hook-ytdl_path=/home/u/.local/bin/yt-dlp'
function ytdlPathArg(ytdlPath) {
  if (!ytdlPath) return null
  return `--script-opts-append=ytdl_hook-ytdl_path=${ytdlPath}`
}

// yt-dlp (2025.11+) refuses YouTube without a JavaScript runtime: "No
// supported JavaScript runtime could be found... Requested format is not
// available". Only deno is on by default; node is enabled with
// --js-runtimes node:<path>. Every trailer in the app (hero, hover, detail,
// theatre) and YouTube music playback through mpv died of this on 2026-09-11.
// The candidates, best first; the caller passes an exists check.
function nodeCandidatePaths(homeDir) {
  const home = homeDir || ''
  return [
    process.env.PAPA_NODE_PATH || null,
    '/usr/bin/node', '/usr/local/bin/node', '/opt/homebrew/bin/node',
    home ? path.join(home, '.local', 'bin', 'node') : null,
    home ? path.join(home, '.volta', 'bin', 'node') : null,
  ].filter(Boolean)
}
function pickNode(candidates, existsFn) {
  for (const c of candidates) { try { if (existsFn(c)) return c } catch (_) {} }
  return null
}
// The yt-dlp argv fragment: [] when no node was found (yt-dlp then does what
// it can, and the error it prints is honest).
function jsRuntimeArgs(nodePath) {
  return nodePath ? ['--js-runtimes', 'node:' + nodePath] : []
}
// The same for mpv's ytdl_hook, which forwards raw options to yt-dlp.
//   nodePath => '--ytdl-raw-options-append=js-runtimes=node:/usr/bin/node'
function ytdlJsRuntimeArg(nodePath) {
  if (!nodePath) return null
  return `--ytdl-raw-options-append=js-runtimes=node:${nodePath}`
}

// ═════════════════════════════════════════════════════════════════════════════
// Exec layer — the thin shell that binds the pure decisions above to
// child_process and fs. Everything below takes its seams (spawnFn, existsFn,
// nowFn) as options so it stays unit-testable, mirroring how mpv-engine.js
// injects spawnFn.
// ═════════════════════════════════════════════════════════════════════════════

const { spawn } = require('child_process')
const fs = require('fs')

function _isExecutableFile(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return fs.statSync(p).isFile()
  } catch (_) {
    return false
  }
}

// Run one command to completion, capturing the tail of stdout+stderr and
// enforcing a hard timeout. Resolves { code, ok, out } and never rejects — a
// failed spawn (ENOENT) surfaces as ok:false with the error text in `out`, so
// callers branch on one shape.
function _run(spawnFn, bin, args, timeoutMs) {
  return new Promise(resolve => {
    let proc
    let out = ''
    let done = false
    const finish = r => { if (!done) { done = true; resolve(r) } }
    const append = d => { out = (out + d.toString()).slice(-OUTPUT_TAIL_BYTES) }
    let timer = setTimeout(() => {
      try { proc && proc.kill() } catch (_) {}
      finish({ code: null, ok: false, out: (out + '\n[timed out]').trim() })
    }, timeoutMs)
    try {
      proc = spawnFn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      clearTimeout(timer)
      finish({ code: null, ok: false, out: String((e && e.message) || e) })
      return
    }
    proc.stdout && proc.stdout.on('data', append)
    proc.stderr && proc.stderr.on('data', append)
    proc.on('error', e => {
      clearTimeout(timer)
      finish({ code: null, ok: false, out: String((e && e.message) || e) })
    })
    proc.on('close', code => {
      clearTimeout(timer)
      finish({ code, ok: code === 0, out: out.trim() })
    })
  })
}

class YtdlpManager {
  constructor(opts = {}) {
    this._spawnFn = opts.spawnFn || spawn
    this._existsFn = opts.existsFn || _isExecutableFile
    this._nowFn = opts.nowFn || Date.now
    this._homeDir = opts.homeDir || os.homedir()
    // Feature-detect pip once and cache it. null means neither pip3 nor pip
    // exists, in which case automatic updates are unavailable and we must never
    // spawn a pip.
    this._pipBinary = opts.pipBinary !== undefined ? opts.pipBinary : undefined
  }

  // The discovered yt-dlp, best first (see candidatePaths / pickBinary).
  binaryPath() {
    return pickBinary(candidatePaths(this._homeDir), this._existsFn)
  }

  // The node binary yt-dlp may use as its JavaScript runtime, or null.
  nodePath() {
    return pickNode(nodeCandidatePaths(this._homeDir), this._existsFn)
  }
  // The yt-dlp argv fragment enabling it (empty when there is none).
  jsRuntimeArgs() { return jsRuntimeArgs(this.nodePath()) }

  // Feature-detect pip. Returns the pip binary name, or null. Cached after the
  // first call. Injected pipBinary (including an explicit null) wins outright so
  // tests never spawn.
  async pipAvailable() {
    if (this._pipBinary !== undefined) return this._pipBinary
    for (const name of ['pip3', 'pip']) {
      const r = await _run(this._spawnFn, name, ['--version'], VERSION_TIMEOUT_MS)
      if (r.ok) { this._pipBinary = name; return name }
    }
    this._pipBinary = null
    return null
  }

  // Read the installed version string (raw first line of --version), 5s cap.
  // Returns { ok, version, versionDate } — versionDate is the parsed timestamp
  // or null.
  async readVersion() {
    const bin = this.binaryPath()
    const r = await _run(this._spawnFn, bin, versionArgs(), VERSION_TIMEOUT_MS)
    const version = r.ok ? (r.out.split('\n')[0] || '').trim() : null
    return { ok: r.ok, version, versionDate: parseVersionDate(version), path: bin }
  }

  // The health probe: does resolving a known-stable video work? 20s cap.
  // Returns { ok, out }.
  async probe(videoId) {
    const bin = this.binaryPath()
    const r = await _run(this._spawnFn, bin, probeArgs(videoId), PROBE_TIMEOUT_MS)
    // A real success prints a googlevideo URL; guard against a 0 exit with no
    // URL (has been seen on partial breakage).
    const ok = r.ok && /https?:\/\//.test(r.out)
    return { ok, out: r.out }
  }

  // Run the pip upgrade, 120s cap. Refuses (and never spawns) when no pip is
  // available. Returns { ok, out, unavailable? }.
  async update() {
    const pip = await this.pipAvailable()
    if (!pip) return { ok: false, unavailable: true, out: 'pip is not installed' }
    const [bin, args] = updateArgs(pip)
    return _run(this._spawnFn, bin, args, UPDATE_TIMEOUT_MS)
  }

  now() { return this._nowFn() }
}

module.exports = {
  YtdlpManager,
  nodeCandidatePaths, pickNode, jsRuntimeArgs, ytdlJsRuntimeArg,
  // Pure functions (exported for tests and for main.js's scheduling code).
  candidatePaths,
  pickBinary,
  parseVersionDate,
  isUpdateDue,
  shouldAutoCheck,
  canImmediateUpdate,
  versionArgs,
  probeArgs,
  updateArgs,
  ytdlPathArg,
  // Constants (exported so callers and tests share one source of truth).
  STALE_AFTER_DAYS,
  STARTUP_CHECK_DELAY_MS,
  CHECK_INTERVAL_MS,
  IMMEDIATE_UPDATE_INTERVAL_MS,
  VERSION_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  UPDATE_TIMEOUT_MS,
  PROBE_VIDEO_ID,
}
