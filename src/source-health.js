'use strict'
// Persisted source-mirror health — the durable companion to the session-level
// health memory in providers/index.js.
//
// providers/index.js already keeps a live, in-session record of which sources
// answered and which came back empty (getSourceHealth / orderBackendsByHealth),
// resetting the moment a source produces results. That is the right primary
// signal — it reflects what is happening RIGHT NOW. But it is thrown away on
// every restart, so a source that has been reliably dead for a week starts each
// launch with a clean slate and gets tried first all over again. This module
// persists a small health record per source across restarts, updated by the
// scheduled canary (every 3 days, and whenever a search returns 0 across every
// backend), so the router can use durable health as a TIEBREAK beneath the live
// session streak — session health stays primary; persisted health only orders
// sources the session has not yet spoken about this run.
//
// The record per source:
//   { ok, lastOkAt, lastCheckAt, failStreak }
// ok        — did the most recent check succeed?
// lastOkAt  — timestamp of the last success (null if never)
// failStreak— consecutive failures (0 after any success)
//
// Everything above the "Exec layer" divider is pure: the record update, the
// tiebreak ordering key, and the merge of session + persisted order. Testable
// without a SideStore.

// ── Record update (pure) ─────────────────────────────────────────────────────

// Apply one check outcome to a source's record. `ok` is whether the check
// succeeded; `now` is the clock. A missing prior record starts neutral. Returns
// the new record; never mutates the input.
function applyResult(prev, ok, now) {
  const base = prev && typeof prev === 'object'
    ? prev
    : { ok: null, lastOkAt: null, lastCheckAt: null, failStreak: 0 }
  if (ok) {
    return { ok: true, lastOkAt: now, lastCheckAt: now, failStreak: 0 }
  }
  return {
    ok: false,
    lastOkAt: base.lastOkAt || null,
    lastCheckAt: now,
    failStreak: (Number(base.failStreak) || 0) + 1,
  }
}

// The durable-health sort key for a source name, read from a health map. Lower
// is healthier, so an ascending sort puts the reliable sources first:
//   never-checked (unknown) → 0   (neutral: no verdict, do not demote)
//   currently ok            → 0
//   failing                 → its failStreak (higher = worse)
// A source with no record is neutral, exactly as providers/index.js treats an
// unseen backend — absence is not a verdict.
function healthKey(health, name) {
  const rec = health && health[name]
  if (!rec || typeof rec !== 'object') return 0
  if (rec.ok) return 0
  return Number(rec.failStreak) || 1
}

// Order a list of source names by persisted health, healthiest first, STABLE
// within a tie (the caller's own order — which is the live-session order from
// providers/index.js — is preserved among equally-healthy sources). This is the
// tiebreak layer: the caller has already ordered by session health, so equal
// entries here are exactly the ones the session has no opinion on, and persisted
// health breaks that tie. Never drops a name.
function orderByPersistedHealth(names, health) {
  const list = (names || []).map((name, i) => ({ name, i, key: healthKey(health, name) }))
  list.sort((a, b) => {
    if (a.key !== b.key) return a.key - b.key
    return a.i - b.i
  })
  return list.map(x => x.name)
}

// A read-only view for the Maintenance panel: one row per known source with a
// traffic-light status. green = last check ok; red = failing (failStreak >= the
// threshold); amber = failing but only just, or never checked with a stale
// record. Pure — the caller passes the health map and the clock.
//   status ∈ 'green' | 'amber' | 'red' | 'unknown'
const RED_STREAK = 3
function statusRows(health, now) {
  const h = health && typeof health === 'object' ? health : {}
  return Object.keys(h).sort().map(name => {
    const rec = h[name] || {}
    let status
    if (rec.ok) status = 'green'
    else if ((Number(rec.failStreak) || 0) >= RED_STREAK) status = 'red'
    else if (rec.lastCheckAt) status = 'amber'
    else status = 'unknown'
    return {
      name,
      status,
      ok: !!rec.ok,
      failStreak: Number(rec.failStreak) || 0,
      lastOkAt: rec.lastOkAt || null,
      lastCheckAt: rec.lastCheckAt || null,
    }
  })
}

// ── Staleness (pure) ─────────────────────────────────────────────────────────

// The scheduled canary runs every 3 days. never-run is always due.
const CHECK_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000
function isCheckDue({ lastRunAt, now, intervalMs = CHECK_INTERVAL_MS } = {}) {
  if (!lastRunAt) return true
  return (now - lastRunAt) >= intervalMs
}

// ═════════════════════════════════════════════════════════════════════════════
// Exec layer — a thin wrapper over a SideStore-shaped store holding
// { sources: { name: record }, lastRunAt }. nowFn injected for tests.
// ═════════════════════════════════════════════════════════════════════════════

class SourceHealthStore {
  // opts:
  //   store — SideStore-shaped get()/set(). Optional; without it everything is
  //           in-memory and non-persistent (used in tests / the e2e profile).
  //   nowFn — Date.now by default.
  constructor(opts = {}) {
    this._store = opts.store || null
    this._nowFn = opts.nowFn || Date.now
    this._mem = { sources: {}, lastRunAt: 0 }
  }

  now() { return this._nowFn() }

  _read() {
    if (this._store) {
      const v = this._store.get()
      if (v && typeof v === 'object') {
        return { sources: v.sources && typeof v.sources === 'object' ? v.sources : {}, lastRunAt: v.lastRunAt || 0 }
      }
      return { sources: {}, lastRunAt: 0 }
    }
    return this._mem
  }

  _write(v) {
    if (this._store) this._store.set(v)
    else this._mem = v
  }

  // The full { name: record } map, for the router tiebreak and the panel.
  health() { return this._read().sources }

  lastRunAt() { return this._read().lastRunAt || 0 }

  // Record one source's check outcome. Persists immediately (the SideStore
  // coalesces its own writes). Returns the new record.
  record(name, ok) {
    if (!name) return null
    const now = this._nowFn()
    const cur = this._read()
    const rec = applyResult(cur.sources[name], ok, now)
    const next = { sources: { ...cur.sources, [name]: rec }, lastRunAt: cur.lastRunAt || 0 }
    this._write(next)
    return rec
  }

  // Record a whole batch (one canary sweep) and stamp lastRunAt in a single
  // write. `results` is { name: okBoolean }.
  recordBatch(results) {
    const now = this._nowFn()
    const cur = this._read()
    const sources = { ...cur.sources }
    for (const [name, ok] of Object.entries(results || {})) {
      if (!name) continue
      sources[name] = applyResult(sources[name], !!ok, now)
    }
    this._write({ sources, lastRunAt: now })
    return sources
  }

  // Rows for the Maintenance panel.
  rows() { return statusRows(this._read().sources, this._nowFn()) }

  // Whether the scheduled canary is due.
  due() { return isCheckDue({ lastRunAt: this.lastRunAt(), now: this._nowFn() }) }
}

module.exports = {
  SourceHealthStore,
  applyResult,
  healthKey,
  orderByPersistedHealth,
  statusRows,
  isCheckDue,
  RED_STREAK,
  CHECK_INTERVAL_MS,
}
