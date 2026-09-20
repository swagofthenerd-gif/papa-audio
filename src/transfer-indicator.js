'use strict';
// The sidebar transfer indicator's pure model: what the little pills say.
//
// Two directions, one module. Downloads come from the transfers snapshot the
// download poll already fetches (users -> directories -> files); uploads come
// from slskd's /transfers/uploads, slimmed by main into rows of
// { filename, username, state, percentComplete, averageSpeed, bytesTransferred,
// size }. The last two are what make a real rate possible: averageSpeed is a
// cumulative average over the whole transfer and barely moves once a transfer
// is under way, so the live figure has to come from the change in bytes
// between two samples — see currentSpeed below.
//
// slskd's states are a .NET [Flags] enum, so they arrive comma-joined:
// "Queued, Remotely", "Completed, Succeeded", "Requested, Queued". Counting by
// substring is how a finished transfer ends up in a live count, so everything
// here splits the flags and reads them as a set — the same discipline as
// src/dl-state.js.
//
// Pure by design: no DOM, no window reads inside the functions, no clock. The
// only outside thing is the size formatter, reached through the optional
// accessor the other src/ modules use so this still runs under node --test.
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaTransferIndicator = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const SEPS = /[\\/]/

  // Two samples further apart than this are not a rate worth quoting: a
  // suspended laptop, a clock step, or a panel left closed for a while all land
  // here, and dividing a big byte delta by a wrong interval prints a wrong
  // number confidently. Saying nothing is the honest answer.
  const SPEED_MAX_GAP_MS = 60000

  // One size formatter for the whole app; the local fallback only matters when
  // this module is loaded on its own (node tests, or before the shelves script).
  function fmtSize(n) {
    const f = (typeof window !== 'undefined' && window.PapaSlskShelves
      && window.PapaSlskShelves.fmtSize)
    if (f) return f(n)
    let v = Number(n) || 0
    if (v < 0) v = 0
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
    let i = 0
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
    if (i <= 1) return Math.round(v) + ' ' + units[i]
    let s = v.toFixed(1)
    if (s.endsWith('.0')) s = s.slice(0, -2)
    return s + ' ' + units[i]
  }

  function flags(stateStr) {
    return String(stateStr == null ? '' : stateStr)
      .split(',').map(p => p.trim()).filter(Boolean)
  }

  // Over, however it ended: nothing Completed is ever counted as in flight.
  function isDone(p) {
    return p.includes('Completed') || p.includes('Succeeded')
      || p.includes('Errored') || p.includes('Failed') || p.includes('TimedOut')
      || p.includes('Aborted') || p.includes('Rejected')
      || p.includes('Cancelled') || p.includes('Canceled')
  }

  // Both spellings: slskd has shipped Initializing and Initialising.
  function isMoving(stateStr) {
    const p = flags(stateStr)
    if (!p.length || isDone(p)) return false
    return p.includes('InProgress') || p.includes('Initializing') || p.includes('Initialising')
  }

  function isWaiting(stateStr) {
    const p = flags(stateStr)
    if (!p.length || isDone(p)) return false
    return p.includes('Queued')
  }

  // Any of the three shapes slskd has answered with: user -> directories ->
  // files, user -> files, or a snapshot that is already a flat file list.
  function flatten(raw) {
    const out = []
    const users = Array.isArray(raw) ? raw : []
    for (const u of users) {
      if (!u || typeof u !== 'object') continue
      const username = String(u.username || u.user || '')
      const dirs = Array.isArray(u.directories) ? u.directories : null
      if (dirs) {
        for (const d of dirs) {
          const files = d && Array.isArray(d.files) ? d.files : []
          for (const f of files) _push(out, username, f)
        }
        continue
      }
      const files = Array.isArray(u.files) ? u.files : null
      if (files) {
        for (const f of files) _push(out, username, f)
        continue
      }
      _push(out, username, u)
    }
    return out
  }

  function _push(out, username, f) {
    if (!f || typeof f !== 'object') return
    const filename = String(f.filename || f.name || '')
    if (!filename && !username) return
    out.push({
      username: username,
      filename: filename,
      state: String(f.state || ''),
      percentComplete: Number(f.percentComplete) || 0,
      averageSpeed: Number(f.averageSpeed) || 0,
      bytesTransferred: _n(f.bytesTransferred),
      size: _n(f.size),
    })
  }

  // A byte count, or 0. Negative and non-numeric both mean "slskd did not say",
  // and a negative would turn into a negative rate two functions downstream.
  function _n(v) {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : 0
  }

  // ── The pills ──────────────────────────────────────────────────────────────

  // downloadPill(transfers) -> { text, active, queued } | null
  // null means "hide the pill": nothing slskd has taken on is coming in —
  // files still only Requested or Scheduled are deliberately not counted.
  function downloadPill(transfers) {
    const files = flatten(transfers)
    let active = 0
    let queued = 0
    for (const f of files) {
      if (isMoving(f.state)) active++
      else if (isWaiting(f.state)) queued++
    }
    if (!active && !queued) return null
    let text
    if (active && queued) text = '↓ ' + active + ' +' + queued
    else if (active) text = '↓ ' + active
    else text = '↓ +' + queued
    return { text: text, active: active, queued: queued }
  }

  // sharingPill(stats) -> { text, live } | null
  // Live while peers are actually pulling; otherwise the day's tally, muted;
  // null when neither, which hides the whole Sharing row.
  function sharingPill(stats) {
    const s = stats && typeof stats === 'object' ? stats : {}
    const active = Number(s.activeUploads) || 0
    // filesToday only. There is no falling back to a byte total here: the two
    // are the same shape and nothing like the same number, so a missing file
    // count would print two gigabytes shared as "2254857830 today".
    const today = Number(s.filesToday) || 0
    if (active > 0) return { text: '↑ ' + active, live: true }
    if (today > 0) return { text: today + ' today', live: false }
    return null
  }

  // sharingRows(uploads)
  //   -> [{ key, username, file, folder, pct, speed, state, bytes, size }]
  //
  // "Happening now" means exactly that: only transfers slskd reports as in
  // flight or queued survive, and the judgement is made on the state flags
  // through isMoving/isWaiting — never on a name, never on a percentage.
  //
  // This used to sort live-first and keep everything else. slskd's
  // /transfers/uploads holds finished transfers in its list long after they are
  // over, so the panel accumulated the same peers and the same songs for as
  // long as the app stayed up, while the day's byte counter climbed underneath
  // — a growing history wearing the label "Happening now".
  //
  // Nothing lingers after it finishes, deliberately. A finish would have to be
  // dated to expire it, this module holds no clock by design, and the row that
  // would linger is the row that made the list look frozen in the first place.
  // What went out today is the tally underneath, which counts every one of them
  // and is the right place for history.
  //
  // In-flight first, then queued, then alphabetical by peer, so the rows
  // someone is actually watching stay at the top and do not reshuffle
  // underneath them.
  function sharingRows(uploads) {
    const rows = []
    for (const f of flatten(uploads)) {
      if (!isMoving(f.state) && !isWaiting(f.state)) continue
      const parts = f.filename.split(SEPS).filter(Boolean)
      rows.push({
        // The identity of this transfer across polls, so two samples of it can
        // be lined up to get a rate. Peer-controlled, so it is a map key only —
        // it is never rendered.
        key: f.username + '\n' + f.filename,
        username: f.username,
        file: parts.length ? parts[parts.length - 1] : '',
        folder: parts.length > 1 ? parts[parts.length - 2] : '',
        // Bytes over size when slskd gives both: percentComplete is rounded and
        // lags, and the bar is the thing the eye reads as movement.
        pct: f.size > 0 ? _clampPct(f.bytesTransferred / f.size * 100) : f.percentComplete,
        // slskd's cumulative average, the starting point for currentSpeed.
        speed: f.averageSpeed,
        state: f.state,
        bytes: f.bytesTransferred,
        size: f.size,
      })
    }
    rows.sort(function (a, b) {
      const la = isMoving(a.state) ? 0 : 1
      const lb = isMoving(b.state) ? 0 : 1
      if (la !== lb) return la - lb
      if (a.username !== b.username) return a.username < b.username ? -1 : 1
      return a.file < b.file ? -1 : (a.file > b.file ? 1 : 0)
    })
    return rows
  }

  function _clampPct(n) {
    const v = Number(n)
    if (!Number.isFinite(v) || v < 0) return 0
    return v > 100 ? 100 : v
  }

  // currentSpeed(prev, cur, elapsedMs) -> bytes per second, or null.
  //
  // `prev` and `cur` are the same transfer's row from two consecutive samples,
  // `elapsedMs` the wall-clock gap between them. The rate is the change in
  // bytes over that gap — the number that actually moves while a peer pulls,
  // unlike slskd's averageSpeed, which is the whole transfer's running average
  // and settles almost immediately.
  //
  // null means "no honest answer": the caller shows the percentage instead of
  // a made-up figure.
  function currentSpeed(prev, cur, elapsedMs) {
    if (!cur || typeof cur !== 'object') return null
    const avg = Number(cur.speed)
    const fallback = Number.isFinite(avg) && avg > 0 ? avg : null
    // No previous sample yet — the panel just opened, or this transfer is new
    // in this poll. The cumulative average is the only thing there is to say.
    if (!prev || typeof prev !== 'object') return fallback
    const ms = Number(elapsedMs)
    if (!Number.isFinite(ms) || ms <= 0 || ms > SPEED_MAX_GAP_MS) return null
    const was = Number(prev.bytes)
    const now = Number(cur.bytes)
    if (!Number.isFinite(was) || !Number.isFinite(now)) return null
    if (was < 0 || now < 0) return null
    // Fewer bytes than last time: slskd restarted the transfer and is counting
    // again from zero. There is no rate to read out of that.
    if (now < was) return null
    return (now - was) * 1000 / ms
  }

  // todayLine(stats) -> the sentence under the sharing rows. `bytesToday` is
  // optional; without it the line simply omits the size rather than saying 0 B.
  function todayLine(stats) {
    const s = stats && typeof stats === 'object' ? stats : {}
    // filesToday only, for the same reason as sharingPill: bytes are not files.
    const files = Number(s.filesToday) || 0
    const peers = Number(s.distinctPeersToday) || 0
    const bytes = Number(s.bytesToday) || 0
    // Nothing has finished, but bytes have gone out: the first transfer of the
    // day is still running. Saying "nothing shared today yet" under a panel
    // that is visibly sending something is the kind of small lie that makes the
    // whole surface untrustworthy.
    if (files <= 0 && bytes > 0) {
      return 'Nothing finished today yet · ' + fmtSize(bytes) + ' out so far'
    }
    if (files <= 0) return 'Nothing shared today yet.'
    const line = files + ' file' + (files === 1 ? '' : 's')
      + ' to ' + peers + ' ' + (peers === 1 ? 'person' : 'people') + ' today'
    return bytes > 0 ? line + ' · ' + fmtSize(bytes) : line
  }

  return {
    downloadPill: downloadPill,
    sharingPill: sharingPill,
    sharingRows: sharingRows,
    currentSpeed: currentSpeed,
    todayLine: todayLine,
    // Exported for the wiring and for tests that enumerate slskd's states.
    isMoving: isMoving,
    isWaiting: isWaiting,
    flatten: flatten,
  }
})
