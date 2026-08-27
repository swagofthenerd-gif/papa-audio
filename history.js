'use strict'
// Play history: the shape migration, the reconciliation, and the cap.
//
// Pure functions, no fs and no electron, so the decisions can be tested against
// the real shapes rather than inferred from the code that uses them.

const HISTORY_CAP = 2000

// A timestamp far enough outside the plausible range that the entry is unusable.
// Not a guess about the user's clock: entries before 2000 or more than a day in
// the future cannot be a real play by this app.
const TS_MIN = Date.UTC(2000, 0, 1)
const TS_FUTURE_SLACK_MS = 24 * 60 * 60 * 1000

function isSaneTs(v, now) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return false
  return v >= TS_MIN && v <= (now || Date.now()) + TS_FUTURE_SLACK_MS
}

// Every reader looked only at `ts`. The key was renamed from `timestamp` to `ts`
// with no migration, so the older entries were silently invisible to all of
// them — 38% of the history in the reported case, running back two months.
//
// This does not delete history. An earlier report called those entries corrupt
// and proposed dropping the tail; every one of them had a valid time, and
// dropping them would have destroyed two months of real listening. Entries whose
// time is genuinely unusable are quarantined, not discarded, so the decision
// stays reversible.
function normaliseHistory(entries, opts = {}) {
  const now = opts.now || Date.now()
  const list = Array.isArray(entries) ? entries : []
  const out = []
  const quarantined = []
  let renamed = 0
  let alreadyOk = 0
  let oldest = null
  let newest = null

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') { quarantined.push({ reason: 'not-an-object', entry: raw }); continue }
    const fromTs = isSaneTs(raw.ts, now)
    const fromLegacy = isSaneTs(raw.timestamp, now)
    if (!fromTs && !fromLegacy) {
      quarantined.push({ reason: 'no usable timestamp', entry: raw })
      continue
    }
    // Prefer ts when both are present and sane; they should agree, and ts is the
    // key the app has been writing since the rename.
    const ts = fromTs ? raw.ts : raw.timestamp
    if (fromTs) alreadyOk++
    else renamed++
    const entry = { ...raw, ts }
    // Remove the old key only once its value is safely in the new one.
    delete entry.timestamp
    out.push(entry)
    if (oldest === null || ts < oldest) oldest = ts
    if (newest === null || ts > newest) newest = ts
  }

  return {
    entries: out,
    quarantined,
    renamed,
    alreadyOk,
    total: out.length,
    oldest,
    newest,
    // True when anything actually changed, so a no-op startup writes nothing.
    changed: renamed > 0 || quarantined.length > 0,
  }
}

// Newest first, which is the order every reader assumes.
function sortNewestFirst(entries) {
  return entries.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0))
}

// Counts were incremented on gapless auto-advance; history was not written at
// all. So the two disagree by construction, and every statistic drawn from
// history under-reports album listening specifically — the exact listening style
// this app is for.
//
// Reports the difference and does NOT rewrite either side. The counts are the
// more complete record here, and silently overwriting one with the other would
// destroy the evidence of which was right.
function reconcile(history, playCounts) {
  const counts = playCounts && typeof playCounts === 'object' ? playCounts : {}
  const fromHistory = new Map()
  for (const e of Array.isArray(history) ? history : []) {
    if (!e || !e.filePath) continue
    fromHistory.set(e.filePath, (fromHistory.get(e.filePath) || 0) + 1)
  }
  const rows = []
  let countedTotal = 0
  let historyTotal = 0
  for (const [filePath, counted] of Object.entries(counts)) {
    const n = Number(counted) || 0
    const recorded = fromHistory.get(filePath) || 0
    countedTotal += n
    historyTotal += recorded
    if (n !== recorded) rows.push({ filePath, counted: n, recorded, missing: n - recorded })
  }
  // Tracks with history but no count: the opposite direction, and worth seeing.
  for (const [filePath, recorded] of fromHistory) {
    if (Object.prototype.hasOwnProperty.call(counts, filePath)) continue
    historyTotal += recorded
    rows.push({ filePath, counted: 0, recorded, missing: -recorded })
  }
  rows.sort((a, b) => Math.abs(b.missing) - Math.abs(a.missing))
  return {
    countedTotal,
    historyTotal,
    // Positive: plays that were counted but never recorded in history.
    missingFromHistory: rows.reduce((n, r) => n + Math.max(0, r.missing), 0),
    extraInHistory: rows.reduce((n, r) => n + Math.max(0, -r.missing), 0),
    disagreeing: rows.length,
    worst: rows.slice(0, 20),
  }
}

// The cap used to splice the oldest entries away with nothing keeping them.
// Once the migration recovers the older entries, that starts discarding real
// history — so the overflow is split off to be archived instead of dropped.
function splitForArchive(entries, cap = HISTORY_CAP) {
  const list = Array.isArray(entries) ? entries : []
  if (list.length <= cap) return { keep: list, overflow: [] }
  return { keep: list.slice(0, cap), overflow: list.slice(cap) }
}

// Which archive file an entry belongs in. Monthly: small enough to read, few
// enough files to list.
function archiveMonth(ts) {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return 'undated'
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function groupForArchive(overflow) {
  const byMonth = new Map()
  for (const e of overflow) {
    const key = archiveMonth(e && e.ts)
    if (!byMonth.has(key)) byMonth.set(key, [])
    byMonth.get(key).push(e)
  }
  return byMonth
}

module.exports = {
  HISTORY_CAP,
  isSaneTs,
  normaliseHistory,
  sortNewestFirst,
  reconcile,
  splitForArchive,
  archiveMonth,
  groupForArchive,
}
