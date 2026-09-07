'use strict'
// slskd daemon self-maintenance. The Soulseek side of Papa Audio runs a bundled
// slskd daemon that we first-installed by fetching the latest linux-x64 release
// zip from GitHub, unzipping it next to the app config, and chmod +x'ing the
// binary (see downloadSlskd in main.js). A daemon installed once and never
// touched slowly falls behind: slskd ships protocol fixes and search-reliability
// improvements, and an old build eventually talks to a Soulseek network that has
// moved on. This module keeps it current — on a slow, safe cadence — with an
// update that NEVER runs while a transfer is in flight, keeps the old binary,
// swaps the new one in, restarts through the existing health machinery, verifies
// the daemon reports the new version, and ROLLS BACK to the kept binary on any
// failure.
//
// The file is two halves, exactly like ytdlp-manager.js. Everything above the
// "Exec layer" divider is pure — no fetch, no fs, no spawn, no clock except what
// is passed in — so the version parse, the staleness policy, the throttle, the
// release-asset selection, and the swap/rollback STATE MACHINE are all testable
// without a real slskd, a real network, or a real disk. The exec layer below is
// the thin shell that binds those decisions to the daemon's REST API, GitHub, and
// the filesystem.

// ── Constants (policy) ───────────────────────────────────────────────────────

const GITHUB_LATEST_URL = 'https://api.github.com/repos/slskd/slskd/releases/latest'

// A daemon is checked for an update no more often than this. slskd's own release
// cadence is measured in weeks; a swap loses the daemon's warm search/peer state
// for a few seconds, so this is deliberately unhurried — a week between checks.
const CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

// The scheduled check runs this long after startup, once the app (and the
// daemon) have settled. Never on the hot path of launch.
const STARTUP_CHECK_DELAY_MS = 90 * 1000

// Per-call caps. The release lookup and download go over the network; the
// version probe hits the local daemon; verification polls the restarted daemon.
const RELEASE_TIMEOUT_MS = 10 * 1000
const DOWNLOAD_TIMEOUT_MS = 120 * 1000
const VERSION_TIMEOUT_MS = 5 * 1000
// After a restart the daemon needs a moment before /application answers with the
// new version; poll up to this long before declaring the swap unverified.
const VERIFY_TIMEOUT_MS = 30 * 1000

// The release asset we install: slskd publishes one linux-x64 zip per release,
// the same one downloadSlskd's first-install path picks. Matched by name so a
// future extra asset (arm64, checksums) is never grabbed by mistake.
const ASSET_PATTERN = /linux-x64.*\.zip$/i

// ── Version parsing (pure) ───────────────────────────────────────────────────

// slskd reports its version two ways and we read whichever we can get:
//   1. GET /api/v0/application → { version: "0.22.3", ... } (the running daemon).
//   2. `slskd --version` on the binary → a line like "0.22.3" (sometimes with a
//      build/commit suffix "0.22.3+abc1234" or a leading "slskd ").
// Both collapse to a plain "major.minor.patch". Returns the normalised string,
// or null when nothing recognisable is present. A build suffix is dropped: two
// binaries of the same release are the same version for our purposes.
function parseVersion(raw) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(raw || '').trim())
  if (!m) return null
  return `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`
}

// Pull the version string out of whatever shape GET /application returned. slskd
// has historically nested it (`{ version: { full, ... } }`) and flattened it
// (`{ version: "0.22.3" }`), so probe both plus a couple of sibling keys before
// giving up. Pure so the shape handling is testable against captured payloads.
function versionFromApplication(app) {
  if (!app || typeof app !== 'object') return null
  const candidates = [
    app.version,
    app.version && app.version.full,
    app.version && app.version.version,
    app.versionString,
    app.build && app.build.version,
  ]
  for (const c of candidates) {
    const v = parseVersion(c)
    if (v) return v
  }
  return null
}

// ── Semver compare (pure) ────────────────────────────────────────────────────

// Compare two normalised "a.b.c" strings. 1 if a>b, -1 if a<b, 0 if equal or
// either is unparseable (an unknown version is never "newer" — we stay put
// rather than swap on garbage).
function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  const na = pa.split('.').map(Number)
  const nb = pb.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (na[i] !== nb[i]) return na[i] > nb[i] ? 1 : -1
  }
  return 0
}

function isNewer(latest, current) {
  return compareVersions(latest, current) > 0
}

// ── Update policy (pure) ─────────────────────────────────────────────────────

// The one decision at the heart of the module: should we swap? An update is due
// only when a newer version genuinely exists AND no transfer is active. A
// missing current version (we could not read the running daemon) is treated as
// "unknown, do not swap" — unlike yt-dlp, an unreadable slskd is not itself a
// reason to reinstall, because the swap is disruptive and the daemon may just be
// mid-restart. force=true (the manual button) still respects the transfers gate:
// we never yank the binary out from under a live download.
//   input:  { latest, current, transfersActive, force? }
//   output: { due, reason }
function isUpdateDue({ latest, current, transfersActive, force = false } = {}) {
  if (transfersActive) {
    return { due: false, reason: 'transfers-active' }
  }
  if (force) {
    // The user asked explicitly; still only act if there is something newer.
    if (isNewer(latest, current)) return { due: true, reason: 'newer-available' }
    return { due: false, reason: 'up-to-date' }
  }
  if (!current) return { due: false, reason: 'current-unknown' }
  if (isNewer(latest, current)) return { due: true, reason: 'newer-available' }
  return { due: false, reason: 'up-to-date' }
}

// Should the scheduled auto-check run now? Throttled by the last check time so a
// long uptime does not re-check every timer tick. never-checked is always due.
//   input: { lastCheckAt, now, intervalMs? }
function shouldAutoCheck({ lastCheckAt, now, intervalMs = CHECK_INTERVAL_MS } = {}) {
  if (!lastCheckAt) return true
  return (now - lastCheckAt) >= intervalMs
}

// ── Release-asset selection (pure) ───────────────────────────────────────────

// From a GitHub release JSON, pick the linux-x64 zip and its download URL and
// the release's tag as a version. Returns { version, assetName, url, size } or
// null when the release has no usable asset — matching downloadSlskd's own
// asset-finding logic so the update installs exactly what a fresh install would.
function selectAsset(release) {
  if (!release || typeof release !== 'object') return null
  const assets = Array.isArray(release.assets) ? release.assets : []
  const asset = assets.find(a => a && ASSET_PATTERN.test(String(a.name || '')))
  if (!asset || !asset.browser_download_url) return null
  const version = parseVersion(release.tag_name || release.name)
  return {
    version,
    assetName: asset.name,
    url: asset.browser_download_url,
    size: Number(asset.size) || 0,
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Exec layer — the thin shell that binds the pure decisions above to the daemon
// REST API, GitHub, and the filesystem. Every seam (fetchFn, spawnFn, fs ops,
// nowFn, and the daemon-control callbacks startFn/stopFn/waitFn/appVersionFn) is
// injected so the whole swap/rollback state machine is unit-testable without a
// real daemon, network, or disk — mirroring how ytdlp-manager injects spawnFn.
// ═════════════════════════════════════════════════════════════════════════════

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

// Run one command to completion, capturing the tail of stdout+stderr with a hard
// timeout. Resolves { ok, out }; ENOENT surfaces as ok:false. Never rejects.
// Same shape as ytdlp-manager's _run.
function _run(spawnFn, bin, args, timeoutMs) {
  return new Promise(resolve => {
    let proc
    let out = ''
    let done = false
    const finish = r => { if (!done) { done = true; resolve(r) } }
    const append = d => { out = (out + d.toString()).slice(-2000) }
    const timer = setTimeout(() => {
      try { proc && proc.kill() } catch (_) {}
      finish({ ok: false, out: (out + '\n[timed out]').trim() })
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
    proc.on('error', e => { clearTimeout(timer); finish({ ok: false, out: String((e && e.message) || e) }) })
    proc.on('close', code => { clearTimeout(timer); finish({ ok: code === 0, out: out.trim() }) })
  })
}

// A hard-deadline fetch — AbortController + timer, matching slskdFetch's and the
// tracker-list's approach so a hung GitHub cannot hold a check open.
async function _fetchJson(fetchFn, url, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchFn(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'papa-audio/1.0', Accept: 'application/vnd.github+json' },
    })
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : '?'}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

class SlskdUpdater {
  // opts:
  //   binPath     — absolute path to the slskd binary (SLSKD_BIN).
  //   dir         — SLSKD_DIR, where the download/unzip happen.
  //   fetchFn     — global fetch by default.
  //   spawnFn     — child_process.spawn by default (for `slskd --version` and unzip).
  //   nowFn       — Date.now by default.
  //   fsOps       — { existsSync, copyFileSync, renameSync, unlinkSync, chmodSync,
  //                   mkdirSync, writeFileSync }. Real fs by default; injected in tests.
  //   unzipFn     — async (zipPath, destDir) => void. Real unzip by default.
  //   url         — release API url override (tests).
  //
  // Daemon-control seams (wired to main.js's existing machinery):
  //   transfersActiveFn — () => boolean. Consults _downloadsAreActive().
  //   applicationFn     — async () => appJson|null. GET /api/v0/application via slskdFetch.
  //   stopFn            — async () => void. stopSlskd().
  //   startFn           — async () => void. startSlskd().
  constructor(opts = {}) {
    this._binPath = opts.binPath || null
    this._dir = opts.dir || (this._binPath ? path.dirname(this._binPath) : null)
    this._fetchFn = opts.fetchFn || (typeof fetch === 'function' ? fetch : null)
    this._spawnFn = opts.spawnFn || spawn
    this._nowFn = opts.nowFn || Date.now
    this._url = opts.url || GITHUB_LATEST_URL
    this._fs = opts.fsOps || {
      existsSync: fs.existsSync,
      copyFileSync: fs.copyFileSync,
      renameSync: fs.renameSync,
      unlinkSync: fs.unlinkSync,
      chmodSync: fs.chmodSync,
      mkdirSync: fs.mkdirSync,
      writeFileSync: fs.writeFileSync,
    }
    this._unzipFn = opts.unzipFn || null
    this._transfersActiveFn = opts.transfersActiveFn || (() => false)
    this._applicationFn = opts.applicationFn || (async () => null)
    this._stopFn = opts.stopFn || (async () => {})
    this._startFn = opts.startFn || (async () => {})
    this._updating = false
  }

  now() { return this._nowFn() }
  binPath() { return this._binPath }

  // The running daemon's version, from GET /application. Null when the daemon is
  // down or the shape is unrecognised.
  async runningVersion() {
    let app = null
    try { app = await this._applicationFn() } catch (_) { app = null }
    return versionFromApplication(app)
  }

  // The installed binary's version via `slskd --version`. A fallback for when the
  // daemon is not answering (so a check can still tell "am I behind?").
  async binaryVersion() {
    if (!this._binPath || !this._fs.existsSync(this._binPath)) return null
    const r = await _run(this._spawnFn, this._binPath, ['--version'], VERSION_TIMEOUT_MS)
    return parseVersion(r.out)
  }

  // The best-known current version: prefer the live daemon, fall back to the
  // binary probe.
  async currentVersion() {
    return (await this.runningVersion()) || (await this.binaryVersion())
  }

  // The latest published release, as selectAsset's shape. Null on any network or
  // shape failure — a check that cannot reach GitHub simply reports nothing to do.
  async latestRelease() {
    if (!this._fetchFn) return null
    let release
    try {
      release = await _fetchJson(this._fetchFn, this._url, RELEASE_TIMEOUT_MS)
    } catch (_) {
      return null
    }
    return selectAsset(release)
  }

  // Download the asset zip and unzip it into a staging path INSIDE the dir, then
  // return the path to the freshly-extracted binary. Does NOT touch the live
  // binary — that is the swap's job. Returns { ok, stagedBin?, error? }.
  async _stageDownload(asset) {
    if (!this._fetchFn) return { ok: false, error: 'no fetch available' }
    const stageDir = path.join(this._dir, '.slskd-update')
    const zipPath = path.join(stageDir, 'slskd.zip')
    try {
      // A stale stage from an aborted run must never be extracted-over silently.
      this._fs.mkdirSync(stageDir, { recursive: true })
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS)
      let buf
      try {
        const res = await this._fetchFn(asset.url, { signal: ctrl.signal })
        if (!res || !res.ok) throw new Error(`download HTTP ${res ? res.status : '?'}`)
        buf = Buffer.from(await res.arrayBuffer())
      } finally {
        clearTimeout(timer)
      }
      this._fs.writeFileSync(zipPath, buf)
      // unzip into the stage dir; slskd's zip contains a top-level `slskd` binary.
      if (this._unzipFn) {
        await this._unzipFn(zipPath, stageDir)
      } else {
        const r = await _run(this._spawnFn, 'unzip', ['-o', zipPath, '-d', stageDir], DOWNLOAD_TIMEOUT_MS)
        if (!r.ok) throw new Error('unzip failed: ' + (r.out || '').slice(-200))
      }
      const stagedBin = path.join(stageDir, 'slskd')
      if (!this._fs.existsSync(stagedBin)) {
        return { ok: false, error: 'extracted archive had no slskd binary' }
      }
      this._fs.chmodSync(stagedBin, 0o755)
      try { this._fs.unlinkSync(zipPath) } catch (_) {}
      return { ok: true, stagedBin }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  }

  // ── The swap / rollback state machine ──────────────────────────────────────
  //
  // The one operation that must never leave a half-installed daemon:
  //
  //   1. stage      download + unzip the new binary into .slskd-update/ (the live
  //                 binary is untouched; a failure here is a clean no-op).
  //   2. backup     copy the live binary to <bin>.bak (kept until we are sure the
  //                 new one is good — this is the rollback source).
  //   3. stop       stop the daemon so the binary file is not busy.
  //   4. swap       rename the staged binary over the live path.
  //   5. start      start the daemon again through the normal health machinery.
  //   6. verify     poll GET /application until it reports the NEW version, up to
  //                 VERIFY_TIMEOUT_MS.
  //   7a. success   delete <bin>.bak, delete the stage dir → done.
  //   7b. failure   stop, restore <bin>.bak over the live path, start again,
  //                 delete the stage dir → the daemon is exactly as it was.
  //
  // Every step past the swap has a rollback; a failure before the swap is a plain
  // early return that never disturbed the running daemon. Returns
  //   { ok, from, to }                      — swapped and verified
  //   { ok:false, error, rolledBack? }      — failed (rolledBack:true = restored)
  //   { ok:false, skipped }                 — a gate said no (transfers, throttle)
  async performUpdate({ force = false } = {}) {
    if (this._updating) return { ok: false, error: 'an update is already running' }
    // The transfers gate is checked HERE too, not just in isUpdateDue, because a
    // download can start between the decision and the swap. This is the last line
    // of defence against yanking a busy binary.
    if (this._transfersActiveFn()) return { ok: false, skipped: 'transfers-active' }

    this._updating = true
    const stageDir = path.join(this._dir, '.slskd-update')
    const backup = this._binPath + '.bak'
    let swapped = false
    let from = null
    try {
      from = await this.currentVersion()
      const asset = await this.latestRelease()
      if (!asset) return { ok: false, error: 'could not fetch latest release' }
      const decision = isUpdateDue({ latest: asset.version, current: from, transfersActive: false, force })
      if (!decision.due) return { ok: false, skipped: decision.reason, from, to: asset.version }

      // 1. stage
      const staged = await this._stageDownload(asset)
      if (!staged.ok) return { ok: false, error: staged.error }

      // 2. backup — copy, do not move, so the live binary survives a crash here.
      this._fs.copyFileSync(this._binPath, backup)

      // 3. stop — one more transfers check right before we take the daemon down.
      if (this._transfersActiveFn()) {
        this._cleanupStage(stageDir)
        try { this._fs.unlinkSync(backup) } catch (_) {}
        return { ok: false, skipped: 'transfers-active' }
      }
      await this._stopFn()

      // 4. swap
      this._fs.renameSync(staged.stagedBin, this._binPath)
      this._fs.chmodSync(this._binPath, 0o755)
      swapped = true

      // 5. start
      await this._startFn()

      // 6. verify
      const verified = await this._verifyVersion(asset.version)
      if (!verified.ok) {
        throw new Error(verified.error || 'new daemon did not report the expected version')
      }

      // 7a. success
      try { this._fs.unlinkSync(backup) } catch (_) {}
      this._cleanupStage(stageDir)
      return { ok: true, from, to: verified.version || asset.version }
    } catch (e) {
      // 7b. failure → rollback if we had already swapped.
      let rolledBack = false
      if (swapped) {
        try {
          await this._stopFn()
          this._fs.renameSync(backup, this._binPath)
          this._fs.chmodSync(this._binPath, 0o755)
          await this._startFn()
          rolledBack = true
        } catch (_) { /* leave the .bak in place for manual recovery */ }
      } else {
        // Never swapped: the daemon is untouched; just drop the backup copy.
        try { this._fs.unlinkSync(backup) } catch (_) {}
      }
      this._cleanupStage(stageDir)
      return { ok: false, error: String((e && e.message) || e), rolledBack, from }
    } finally {
      this._updating = false
    }
  }

  // Poll the restarted daemon until GET /application reports `expected` (or any
  // parseable version that is not older than expected — slskd occasionally tags a
  // release one patch ahead of what /application prints). Times out after
  // VERIFY_TIMEOUT_MS. Returns { ok, version?, error? }.
  async _verifyVersion(expected) {
    const deadline = this._nowFn() + VERIFY_TIMEOUT_MS
    let last = null
    while (this._nowFn() < deadline) {
      await new Promise(r => setTimeout(r, 1000))
      const v = await this.runningVersion()
      if (v) {
        last = v
        // Accept an exact match, or a daemon that is at/above the expected tag.
        if (v === expected || compareVersions(v, expected) >= 0) {
          return { ok: true, version: v }
        }
      }
    }
    return { ok: false, version: last, error: last ? `reported ${last}, expected ${expected}` : 'daemon did not report a version' }
  }

  _cleanupStage(stageDir) {
    try { fs.rmSync(stageDir, { recursive: true, force: true }) } catch (_) {}
  }
}

module.exports = {
  SlskdUpdater,
  // Pure functions (exported for tests and main.js's scheduling code).
  parseVersion,
  versionFromApplication,
  compareVersions,
  isNewer,
  isUpdateDue,
  shouldAutoCheck,
  selectAsset,
  // Constants (one source of truth for callers and tests).
  GITHUB_LATEST_URL,
  CHECK_INTERVAL_MS,
  STARTUP_CHECK_DELAY_MS,
  RELEASE_TIMEOUT_MS,
  DOWNLOAD_TIMEOUT_MS,
  VERSION_TIMEOUT_MS,
  VERIFY_TIMEOUT_MS,
  ASSET_PATTERN,
}
