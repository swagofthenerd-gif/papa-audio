'use strict';
// Upload awareness (App roadmap #54) — good-citizenship visibility into what the
// user is sharing back to Soulseek. slskd knows the data (/transfers/uploads);
// this is the pure accounting half: fold a fresh uploads snapshot into a set of
// daily counters, rolling them over when the local calendar day changes.
//
// The daily counters persist in a side-store so "uploaded today" survives a
// restart, but reset at local midnight so the number always means today. The
// distinct-peers count is a set of usernames served today, also reset daily.
//
// Kept pure — no clock, no I/O — so the rollover, the byte accumulation and the
// peer set are all testable with an injected `now` and injected snapshots. main
// wires the poll (60s while any upload is active, 5min idle) and the persistence.
//
// UMD-wrapped so it loads under Node's test runner and, if ever needed, as a
// classic renderer script — same pattern as the other src/ pure modules.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaUploadStats = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // The empty counters shape, stamped with the day it belongs to. `day` is a
  // local "YYYY-MM-DD" string; `peers` is the set of distinct usernames served
  // today, stored as an object-set for JSON round-tripping through the side-store.
  function emptyState(day) {
    return {
      day: day || null,
      totalUploadedToday: 0,   // bytes transferred to peers today
      peers: {},               // username -> true, for distinctPeersToday
      // The last-seen transferred bytes per upload key, so a growing transfer
      // contributes only its delta each poll rather than its whole size again.
      seen: {},                // uploadKey -> lastTransferredBytes
    }
  }

  function _dayKey(ms) {
    const d = new Date(Number(ms))
    if (!Number.isFinite(d.getTime())) return null
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  // slskd's /transfers/uploads is grouped by user, each with a `directories`
  // array of `files`. Flatten to a list of { key, username, transferred, state }.
  // Each file's identity is username + filename, stable across polls so the same
  // transfer is not double-counted as it grows. Tolerant of shapes: a flat array
  // of files, or the grouped form, or an already-flat file list.
  function flattenUploads(raw) {
    const out = []
    const users = Array.isArray(raw) ? raw : []
    for (const u of users) {
      if (!u || typeof u !== 'object') continue
      const username = String(u.username || u.user || '')
      // Grouped form: user -> directories[] -> files[].
      const dirs = Array.isArray(u.directories) ? u.directories : null
      if (dirs) {
        for (const d of dirs) {
          const files = d && Array.isArray(d.files) ? d.files : []
          for (const f of files) _pushFile(out, username, f)
        }
        continue
      }
      // Flat-per-user form: user -> files[].
      const files = Array.isArray(u.files) ? u.files : null
      if (files) {
        for (const f of files) _pushFile(out, username, f)
        continue
      }
      // The user object IS a file (already-flattened snapshot).
      _pushFile(out, username, u)
    }
    return out
  }

  function _pushFile(out, username, f) {
    if (!f || typeof f !== 'object') return
    const filename = String(f.filename || f.name || '')
    if (!filename && !username) return
    const transferred = Number(f.bytesTransferred)
    const state = String(f.state || '')
    out.push({
      key: `${username} ${filename}`,
      username,
      filename,
      transferred: Number.isFinite(transferred) && transferred >= 0 ? transferred : 0,
      state,
    })
  }

  // An upload is "active" when slskd reports it in flight — anything that is not
  // a terminal state. slskd states look like "InProgress", "Queued, Remotely",
  // "Completed, Succeeded", "Completed, Cancelled". Active = InProgress or a
  // Queued/Initializing family that is not Completed.
  function isActiveUpload(state) {
    const s = String(state || '')
    if (/completed/i.test(s)) return false
    return /inprogress|queued|initializing|requested/i.test(s)
  }

  // Fold a fresh uploads snapshot into the counters. Pure: returns a NEW state
  // (the caller persists it) plus a small summary of what is active right now.
  //
  //   state: the previous counters (emptyState() on first run)
  //   uploads: the raw /transfers/uploads payload
  //   now: epoch ms (or a Date)
  //
  // Returns { state, activeUploads, totalUploadedToday, distinctPeersToday }.
  // On a day change the counters reset first, so the returned totals are today's.
  function ingest(prevState, uploads, now) {
    const nowMs = now instanceof Date ? now.getTime() : Number(now)
    const day = _dayKey(nowMs)
    let state = prevState && typeof prevState === 'object' ? prevState : emptyState(day)
    // Rollover: a new local day starts the counters fresh. The `seen` deltas also
    // reset — a transfer that spanned midnight simply starts counting again today.
    if (state.day !== day) state = emptyState(day)
    // Defensive: an older persisted shape may lack a field.
    state.peers = state.peers && typeof state.peers === 'object' ? state.peers : {}
    state.seen = state.seen && typeof state.seen === 'object' ? state.seen : {}
    if (!Number.isFinite(Number(state.totalUploadedToday))) state.totalUploadedToday = 0

    const files = flattenUploads(uploads)
    let activeUploads = 0
    const seenThisPoll = {}
    for (const f of files) {
      seenThisPoll[f.key] = f.transferred
      const last = Number(state.seen[f.key]) || 0
      // Count only the growth since we last saw this transfer. A transfer that
      // shrank (slskd re-reported a fresh attempt) contributes its new value from
      // zero rather than a negative delta.
      const delta = f.transferred >= last ? (f.transferred - last) : f.transferred
      if (delta > 0) {
        state.totalUploadedToday += delta
        if (f.username) state.peers[f.username] = true
      }
      state.seen[f.key] = f.transferred
      if (isActiveUpload(f.state)) activeUploads++
    }
    // Forget transfers slskd no longer reports, so `seen` cannot grow without
    // bound over a long session — only keys present this poll are retained.
    state.seen = seenThisPoll

    return {
      state,
      activeUploads,
      totalUploadedToday: state.totalUploadedToday,
      distinctPeersToday: Object.keys(state.peers).length,
    }
  }

  return { emptyState, flattenUploads, isActiveUpload, ingest, _dayKey }
})
