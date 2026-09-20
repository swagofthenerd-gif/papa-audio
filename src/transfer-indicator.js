'use strict';
// The sidebar transfer indicator's pure model: what the little pills say.
//
// Two directions, one module. Downloads come from the transfers snapshot the
// download poll already fetches (users -> directories -> files); uploads come
// from slskd's /transfers/uploads, slimmed by main into rows of
// { filename, username, state, percentComplete, averageSpeed }.
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
    })
  }

  // ── The pills ──────────────────────────────────────────────────────────────

  // downloadPill(transfers) -> { text, active, queued } | null
  // null means "hide the pill": nothing is coming in.
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
    const today = Number(s.filesToday != null ? s.filesToday : s.totalUploadedToday) || 0
    if (active > 0) return { text: '↑ ' + active, live: true }
    if (today > 0) return { text: today + ' today', live: false }
    return null
  }

  // sharingRows(uploads) -> [{ username, file, folder, pct, speed, state }]
  // Live transfers first, then alphabetical by peer — so the rows someone is
  // actually watching stay at the top and do not reshuffle underneath them.
  function sharingRows(uploads) {
    const rows = flatten(uploads).map(function (f) {
      const parts = f.filename.split(SEPS).filter(Boolean)
      return {
        username: f.username,
        file: parts.length ? parts[parts.length - 1] : '',
        folder: parts.length > 1 ? parts[parts.length - 2] : '',
        pct: f.percentComplete,
        speed: f.averageSpeed,
        state: f.state,
      }
    })
    rows.sort(function (a, b) {
      const la = (isMoving(a.state) || isWaiting(a.state)) ? 0 : 1
      const lb = (isMoving(b.state) || isWaiting(b.state)) ? 0 : 1
      if (la !== lb) return la - lb
      if (a.username !== b.username) return a.username < b.username ? -1 : 1
      return a.file < b.file ? -1 : (a.file > b.file ? 1 : 0)
    })
    return rows
  }

  // todayLine(stats) -> the sentence under the sharing rows. `bytesToday` is
  // optional; without it the line simply omits the size rather than saying 0 B.
  function todayLine(stats) {
    const s = stats && typeof stats === 'object' ? stats : {}
    const files = Number(s.filesToday != null ? s.filesToday : s.totalUploadedToday) || 0
    const peers = Number(s.distinctPeersToday) || 0
    if (files <= 0) return 'Nothing shared today yet.'
    const bytes = Number(s.bytesToday) || 0
    const line = files + ' file' + (files === 1 ? '' : 's')
      + ' to ' + peers + ' ' + (peers === 1 ? 'person' : 'people') + ' today'
    return bytes > 0 ? line + ' · ' + fmtSize(bytes) : line
  }

  return {
    downloadPill: downloadPill,
    sharingPill: sharingPill,
    sharingRows: sharingRows,
    todayLine: todayLine,
    // Exported for the wiring and for tests that enumerate slskd's states.
    isMoving: isMoving,
    isWaiting: isWaiting,
    flatten: flatten,
  }
})
