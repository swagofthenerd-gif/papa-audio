'use strict'
// System-dependency advisor — advisory only, never a package manager.
//
// Papa Audio hard-depends on two system binaries: mpv (both engines drive it)
// and ffmpeg (loudness analysis, probing, transcode fallbacks). When one is
// missing or badly out of date the failures are confusing — a codec that will
// not play, an analysis that silently produces nothing — and the fix is a one
// line `sudo dnf update mpv` the user would never guess. This module checks the
// installed versions on a monthly cadence and, when a binary is missing or below
// a conservative floor, surfaces a copyable command in the Maintenance panel.
//
// It NEVER spawns a package manager, never touches root, never installs
// anything. The only subprocesses it runs are `mpv --version` and
// `ffmpeg -version`, both read-only, both 5-second-capped. Everything above the
// "Exec layer" divider is pure — version parsing, the floor comparison, the
// advice text — so the policy is testable without either binary present.

// ── Constants (policy) ───────────────────────────────────────────────────────

// Conservative floors — a version at or above these is considered fine; below
// is flagged. Deliberately behind the bleeding edge: the point is to catch a
// genuinely ancient distro binary (an mpv 0.32 that predates half the codecs a
// modern release ships), not to nag someone one point release behind.
//
// Maintenance note: bump these only when a hard app requirement actually raises
// the bar. As of 2026 mpv's stable line is ~0.40 and ffmpeg's is ~7.x, so these
// floors (mpv 0.37, ffmpeg 6) sit a comfortable margin below current-stable and
// will not need touching for a long time.
const FLOORS = Object.freeze({
  mpv: { major: 0, minor: 37, label: 'mpv >= 0.37' },
  ffmpeg: { major: 6, minor: 0, label: 'ffmpeg >= 6' },
})

// The one-line fix per binary, per package manager. dnf is this machine's
// package manager (Fedora); apt is the common Debian/Ubuntu alternative the deb
// build targets. The advice names dnf first because that is where the app runs,
// with the apt form in parentheses so a Debian user is not left guessing.
const ADVICE = Object.freeze({
  mpv: 'sudo dnf update mpv   (or: sudo apt update && sudo apt install --only-upgrade mpv)',
  ffmpeg: 'sudo dnf update ffmpeg   (or: sudo apt update && sudo apt install --only-upgrade ffmpeg)',
  'mpv-missing': 'sudo dnf install mpv   (or: sudo apt install mpv)',
  'ffmpeg-missing': 'sudo dnf install ffmpeg   (or: sudo apt install ffmpeg)',
})

// The same advice for the other two desktops the app builds for (roadmap 008).
// A Mac user shown `sudo dnf` has been told nothing; Homebrew and winget are
// the routes most people on those systems actually have.
const ADVICE_BY_PLATFORM = Object.freeze({
  darwin: Object.freeze({
    mpv: 'brew upgrade mpv', ffmpeg: 'brew upgrade ffmpeg',
    'mpv-missing': 'brew install mpv', 'ffmpeg-missing': 'brew install ffmpeg',
  }),
  win32: Object.freeze({
    mpv: 'winget upgrade mpv', ffmpeg: 'winget upgrade ffmpeg',
    'mpv-missing': 'winget install mpv   (or download from mpv.io and add it to PATH)',
    'ffmpeg-missing': 'winget install ffmpeg   (or download from ffmpeg.org and add it to PATH)',
  }),
  linux: ADVICE,
})

function adviceFor(key, platform) {
  const table = ADVICE_BY_PLATFORM[platform] || ADVICE
  return table[key] || null
}

// Monthly. These binaries change on the order of months for a distro user, and
// there is nothing this module can do about an out-of-date one except tell the
// user — so a frequent check would only cost subprocess spawns for no benefit.
const CHECK_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000

// Read-only version probes, capped. A hung `mpv --version` (has happened on a
// broken GPU stack) must not hold the check open.
const VERSION_TIMEOUT_MS = 5 * 1000

// ── Version parsing (pure) ───────────────────────────────────────────────────

// mpv prints "mpv 0.37.0" (sometimes "mpv v0.37.0-..."). ffmpeg prints
// "ffmpeg version 6.1.1 ..." or "ffmpeg version n7.0 ...". Pull the first
// dotted numeric group and return { major, minor } — enough for a floor
// comparison. Returns null when no version is recognisable.
function parseVersion(output) {
  const s = String(output || '')
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(s)
  if (!m) {
    // ffmpeg git builds sometimes print a bare "n7" with no minor.
    const only = /\bn?(\d+)\b/.exec(s.split('\n')[0] || '')
    if (only) return { major: Number(only[1]), minor: 0 }
    return null
  }
  return { major: Number(m[1]), minor: Number(m[2]) }
}

// Is `version` at or above `floor`? A null version (unparseable) counts as below
// — better to advise on a binary we cannot read than to trust it silently.
function meetsFloor(version, floor) {
  if (!version || !floor) return false
  if (version.major !== floor.major) return version.major > floor.major
  return version.minor >= floor.minor
}

// The verdict for one binary given its probe result.
//   input:  { name, present, version }   (version parsed, or null)
//   output: { name, ok, present, version, floor, reason, advice }
// reason ∈ 'ok' | 'missing' | 'outdated'. advice is the copyable command, or
// null when nothing is wrong.
// `platform` defaults to the one this process runs on; tests pass it in.
function adviseFor(name, { present, version } = {}, platform = process.platform) {
  const floor = FLOORS[name]
  const versionStr = version ? `${version.major}.${version.minor}` : null
  if (!present) {
    return {
      name, ok: false, present: false, version: null,
      floor: floor ? floor.label : null,
      reason: 'missing',
      advice: adviceFor(`${name}-missing`, platform),
    }
  }
  if (meetsFloor(version, floor)) {
    return { name, ok: true, present: true, version: versionStr, floor: floor ? floor.label : null, reason: 'ok', advice: null }
  }
  return {
    name, ok: false, present: true, version: versionStr,
    floor: floor ? floor.label : null,
    reason: 'outdated',
    advice: adviceFor(name, platform),
  }
}

// Is a monthly check due? never-checked is always due; else throttled.
//   input: { lastCheckAt, now, intervalMs? }
function isCheckDue({ lastCheckAt, now, intervalMs = CHECK_INTERVAL_MS } = {}) {
  if (!lastCheckAt) return true
  return (now - lastCheckAt) >= intervalMs
}

// ═════════════════════════════════════════════════════════════════════════════
// Exec layer — the only subprocesses are `mpv --version` and `ffmpeg -version`,
// read-only and capped. spawnFn/nowFn injected for tests.
// ═════════════════════════════════════════════════════════════════════════════

const { spawn } = require('child_process')

// Run one read-only version command to completion, capturing stdout+stderr,
// hard-capped. Resolves { ok, out }; a missing binary (ENOENT) surfaces as
// ok:false so the caller reads it as "not present". Never rejects.
function _run(spawnFn, bin, args, timeoutMs) {
  return new Promise(resolve => {
    let proc
    let out = ''
    let done = false
    const finish = r => { if (!done) { done = true; resolve(r) } }
    const append = d => { out = (out + d.toString()).slice(0, 4000) }
    const timer = setTimeout(() => {
      try { proc && proc.kill() } catch (_) {}
      finish({ ok: false, out: out.trim() })
    }, timeoutMs)
    try {
      proc = spawnFn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      clearTimeout(timer)
      finish({ ok: false, out: String((e && e.message) || e) })
      return
    }
    proc.stdout && proc.stdout.on('data', append)
    proc.stderr && proc.stderr.on('data', append)
    proc.on('error', () => { clearTimeout(timer); finish({ ok: false, out: out.trim() }) })
    proc.on('close', code => { clearTimeout(timer); finish({ ok: code === 0, out: out.trim() }) })
  })
}

class SysDepsAdvisor {
  constructor(opts = {}) {
    this._spawnFn = opts.spawnFn || spawn
    this._nowFn = opts.nowFn || Date.now
  }

  now() { return this._nowFn() }

  // Probe one binary: run its version command and parse. Returns
  // { present, version } for adviseFor. mpv uses --version, ffmpeg -version.
  async _probe(name) {
    const args = name === 'mpv' ? ['--version'] : ['-version']
    const r = await _run(this._spawnFn, name, args, VERSION_TIMEOUT_MS)
    if (!r.ok && !r.out) return { present: false, version: null }
    // A binary that ran (even printing a version to stderr) is present.
    const version = parseVersion(r.out)
    // ffmpeg exits 0 and prints a version; a real ENOENT gave ok:false + no out
    // above. A present-but-unparseable output is still "present, version null".
    return { present: !!(r.ok || version), version }
  }

  // Check both binaries and return their verdicts. Pure adviseFor does the
  // judging; this only wires the probes.
  async check() {
    const [mpv, ffmpeg] = await Promise.all([this._probe('mpv'), this._probe('ffmpeg')])
    return {
      mpv: adviseFor('mpv', mpv),
      ffmpeg: adviseFor('ffmpeg', ffmpeg),
    }
  }
}

module.exports = {
  SysDepsAdvisor,
  parseVersion,
  meetsFloor,
  adviseFor,
  isCheckDue,
  FLOORS,
  ADVICE,
  ADVICE_BY_PLATFORM,
  adviceFor,
  CHECK_INTERVAL_MS,
  VERSION_TIMEOUT_MS,
}
