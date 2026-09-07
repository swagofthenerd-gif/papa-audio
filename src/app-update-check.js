'use strict'
// Papa Audio self-update notifier (roadmap #57, pragmatic first step).
//
// The app is shipped from github.com/swagofthenerd-gif/papa-audio. When a newer
// release is tagged there this module notices — on a weekly cadence — and
// surfaces a row + a toast pointing the user at the release page. It is a
// NOTIFIER, not an updater: there is no silent binary self-update here, because
// that needs code-signing and a hosting/verification story this repo has not
// made yet. The button opens the release page in the browser; the download and
// install stay a deliberate, human step.
//
// No new npm dependencies — the semver comparison is a few lines of pure code
// below, and the release check is one fetch against the GitHub API. Honest about
// the common early state: a repo with no releases yet returns 404, which this
// reports as "no release channel yet" rather than as an error.
//
// Everything above the "Exec layer" divider is pure: the semver parse/compare,
// the staleness window, and the "is this release newer" decision are testable
// without a network.

// ── Constants (policy) ───────────────────────────────────────────────────────

const REPO = 'swagofthenerd-gif/papa-audio'
const RELEASES_LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`

// The human-facing releases page the "Get it" button opens.
const RELEASES_PAGE_URL = `https://github.com/${REPO}/releases/latest`

// One fetch, capped.
const FETCH_TIMEOUT_MS = 10 * 1000

// Weekly. A desktop app's release cadence is measured in weeks, and this only
// pops a non-blocking notice — nothing to hammer.
const CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

// ── Semver (pure) ────────────────────────────────────────────────────────────

// Parse a version string into { major, minor, patch }, tolerating a leading 'v'
// and any -prerelease / +build suffix (ignored for the comparison — a stable
// release is what the notifier cares about). Returns null on junk.
function parseSemver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

// Compare two version strings. Returns 1 if a > b, -1 if a < b, 0 if equal or
// either is unparseable (an unknown version is never treated as newer — the
// notifier stays silent rather than nagging on garbage).
function compareSemver(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return 0
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1
  return 0
}

// Is `latest` strictly newer than `current`? The one decision the notifier is
// built around. Unparseable inputs → false (stay silent).
function isNewer(latest, current) {
  return compareSemver(latest, current) > 0
}

// Is a weekly check due? never-checked is always due; else throttled.
//   input: { lastCheckAt, now, intervalMs? }
function isCheckDue({ lastCheckAt, now, intervalMs = CHECK_INTERVAL_MS } = {}) {
  if (!lastCheckAt) return true
  return (now - lastCheckAt) >= intervalMs
}

// ═════════════════════════════════════════════════════════════════════════════
// Exec layer — one fetch against the GitHub releases API. fetchFn/nowFn injected
// for tests.
// ═════════════════════════════════════════════════════════════════════════════

async function _fetchJson(fetchFn, url, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchFn(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'papa-audio/1.0', Accept: 'application/vnd.github+json' },
    })
    return res
  } finally {
    clearTimeout(timer)
  }
}

class AppUpdateCheck {
  // opts:
  //   currentVersion — the running app version (package.json version).
  //   fetchFn        — global fetch by default.
  //   nowFn          — Date.now by default.
  constructor(opts = {}) {
    this._current = String(opts.currentVersion || '0.0.0')
    this._fetchFn = opts.fetchFn || (typeof fetch === 'function' ? fetch : null)
    this._nowFn = opts.nowFn || Date.now
    this._url = opts.url || RELEASES_LATEST_URL
    this._pageUrl = opts.pageUrl || RELEASES_PAGE_URL
  }

  now() { return this._nowFn() }
  currentVersion() { return this._current }
  releasePageUrl() { return this._pageUrl }

  // Check the latest release. Returns one of:
  //   { ok:true, available:false }                       — up to date
  //   { ok:true, available:true, latest, url }           — newer release exists
  //   { ok:true, noReleaseChannel:true }                 — repo has no releases (404)
  //   { ok:false, error }                                — network/parse failure
  // Never throws.
  async check() {
    if (!this._fetchFn) return { ok: false, error: 'no fetch available' }
    let res
    try {
      res = await _fetchJson(this._fetchFn, this._url, FETCH_TIMEOUT_MS)
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
    // No releases yet is the honest common state for a young repo, and the
    // GitHub API says so with a 404 on /releases/latest. Report it as its own
    // outcome, not an error — the panel says "no release channel yet".
    if (res && res.status === 404) return { ok: true, noReleaseChannel: true }
    if (!res || !res.ok) return { ok: false, error: `HTTP ${res ? res.status : '?'}` }
    let body
    try { body = await res.json() } catch (e) { return { ok: false, error: 'unreadable release JSON' } }
    const tag = body && (body.tag_name || body.name)
    const latest = parseSemver(tag)
    if (!latest) return { ok: false, error: 'release had no recognisable version' }
    const url = (body && body.html_url) || this._pageUrl
    const latestStr = `${latest.major}.${latest.minor}.${latest.patch}`
    if (isNewer(latestStr, this._current)) {
      return { ok: true, available: true, latest: latestStr, url }
    }
    return { ok: true, available: false, latest: latestStr }
  }
}

module.exports = {
  AppUpdateCheck,
  parseSemver,
  compareSemver,
  isNewer,
  isCheckDue,
  REPO,
  RELEASES_LATEST_URL,
  RELEASES_PAGE_URL,
  FETCH_TIMEOUT_MS,
  CHECK_INTERVAL_MS,
}
