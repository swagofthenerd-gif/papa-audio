'use strict'
// Provider router + surround-aware ranker — pure, no I/O, no network.
// `resolveStream` fans out to injectable `backends` functions and merges their
// results; `rankStreams` orders merged entries by a surround-aware score.
//
// The stream "entry" shape used across the Papa Video feature:
//   { kind: 'http'|'torrent', url, magnet, infoHash, fileIndex, source,
//     quality, label, audioLayout, sub, dub }

function qualityRank(q) {
  switch (q) {
    case '2160p':
      return 4
    case '1080p':
      return 3
    case '720p':
      return 2
    case '480p':
      return 1
    default:
      return 0
  }
}

function isMultichannel(audioLayout) {
  return audioLayout === '5.1' || audioLayout === '7.1'
}

// Aggregator indexers (Knaben, SolidTorrents) re-publish other trackers' rows
// and their seeder counts are demonstrably unreliable — a live pick that
// advertised 370 seeders delivered a single real peer. First-party indexers
// (TPB, YTS, EZTV, Nyaa, AnimeTosho) report seeders that hold up far better, so
// their counts are trusted as-is. To keep a fictional aggregator count from
// jumping a genuine first-party source, the seeders SIGNAL is scaled down for
// aggregators when it is used as a ranking tiebreak. This is deliberately mild
// (a 0.5 factor, not a hard cap or an outright drop): the aggregator entry is
// still ranked, still offered, and its displayed seeder number is untouched —
// only its weight when two equal-quality entries are compared changes.
const _AGGREGATOR_SOURCES = new Set(['Knaben', 'SolidTorrents'])
const _AGGREGATOR_SEED_FACTOR = 0.5

// The seeder value used for RANKING only — never for display. First-party
// sources pass through unchanged; aggregators are scaled by the factor above.
function _rankingSeeds(entry) {
  const seeds = Number(entry && entry.seeds) || 0
  if (seeds <= 0) return 0
  return _AGGREGATOR_SOURCES.has(entry && entry.source)
    ? seeds * _AGGREGATOR_SEED_FACTOR
    : seeds
}

// 7.1 counts as multichannel too; the original only recognised '5.1', so a
// TrueHD 7.1 release scored below a stereo one of the same resolution.
function _score(e, preferSurround) {
  const quality = qualityRank(e.quality)
  const surround = isMultichannel(e.audioLayout)
  const bonus = preferSurround && surround ? 1 : 0
  return { quality, surround, score: quality + bonus }
}

// Learned dead-magnet memory (App roadmap #41). `isDead` is an injected
// predicate — isDead(infoHash) → boolean — that the caller wires to the
// persistent failure map (src/dead-magnet.js over a SideStore). A torrent whose
// infohash has repeatedly failed to connect is DEMOTED beneath every live source
// and flagged with `deadHint: true` for a future UI badge. It is never removed:
// coverage at the tail is the point, and a dead swarm can revive. Kept pure and
// optional — with no predicate (tests, and any non-torrent lookup) nothing is
// demoted and no entry is flagged.
function rankStreams(entries, { preferSurround = true, isDead = null, preferDub = false } = {}) {
  const deadFn = typeof isDead === 'function' ? isDead : null
  const ranked = entries.map(e => {
    // The flag rides on the entry the caller receives, so the UI can badge it
    // without a second lookup. Only torrent entries carry an infohash to test;
    // a fresh copy avoids mutating the provider's own object.
    const dead = !!(deadFn && e && e.infoHash && deadFn(e.infoHash))
    const entry = dead ? { ...e, deadHint: true } : e
    return { entry, dead, ..._score(entry, preferSurround) }
  })
  ranked.sort((a, b) => {
    // A known-dead magnet sinks beneath everything live regardless of its
    // quality or seeds — it is offered last, not hidden.
    if (a.dead !== b.dead) return a.dead ? 1 : -1
    // Cam rips and telesyncs are a filmed cinema screen, not a source encode.
    // They stay in the list so a film with nothing else is still playable, but
    // they never outrank a real release regardless of resolution or seeds.
    const lowA = a.entry.lowQuality === true
    const lowB = b.entry.lowQuality === true
    if (lowA !== lowB) return lowA ? 1 : -1
    // When the caller asked for a dub, dubbed releases lead the whole list.
    // Individual providers (nyaa) already order their OWN results dub-first,
    // but this merged ranking was dub-blind — so dubs, which usually seed
    // lower than subs, sank to the bottom the moment sources were combined
    // (found live: the Dub checkbox appeared to do nothing to the order).
    // Below dead/cam only: a dead dub must not beat a live one, but a dub
    // the user asked for beats any sub regardless of quality or seeds.
    if (preferDub) {
      const dubA = a.entry.dub === true
      const dubB = b.entry.dub === true
      if (dubA !== dubB) return dubA ? -1 : 1
    }
    if (b.score !== a.score) return b.score - a.score
    if (b.surround !== a.surround) return b.surround ? 1 : -1
    if (b.quality !== a.quality) return b.quality - a.quality
    // Seed count decides whether a torrent actually plays, so it outranks the
    // alphabetical source fallback. Entries without seeds (direct HTTP) sort
    // as 0 and keep their previous relative order. Aggregator seeder counts are
    // discounted here (see _rankingSeeds) because they are unreliable; the
    // displayed number is left exactly as the provider reported it.
    const seedsA = _rankingSeeds(a.entry)
    const seedsB = _rankingSeeds(b.entry)
    if (seedsB !== seedsA) return seedsB - seedsA
    const sa = a.entry.source
    const sb = b.entry.source
    if (sa < sb) return -1
    if (sa > sb) return 1
    return 0
  })
  return ranked.map(r => r.entry)
}

// The same torrent offered by two indexers carries different tracker lists, so
// the magnet strings differ while the content is identical. The info hash is
// the real identity; fall back to the URL only when there is no hash.
function _dedupeKey(e) {
  if (e.infoHash) return `torrent\u0000${String(e.infoHash).toLowerCase()}`
  return `${e.kind}\u0000${e.url || e.magnet || ''}`
}

// A backend that never settles used to hang the whole lookup: `timeoutMs` was
// accepted and then explicitly discarded. Each backend now races its own timer,
// so one dead indexer costs `timeoutMs` and the rest of the results still land.
function _withTimeout(promise, timeoutMs) {
  if (!(timeoutMs > 0)) return promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`provider timed out after ${timeoutMs}ms`)), timeoutMs)
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolve(value) },
      err => { clearTimeout(timer); reject(err) }
    )
  })
}

// Per-source health memory (checklist #39). A session-level record of how each
// source has been behaving lately, so the router can consult the ones that are
// actually answering first — WITHOUT ever dropping a source, because coverage at
// the tail is the whole point of running many indexers. A source that has been
// failing or coming back empty is demoted, not removed; the moment it answers
// with results its streak resets and it climbs back up.
//
// "Health" here is a small integer streak per source name:
//   +1 recorded on a run that threw, timed out, or returned an empty list;
//   reset to 0 the moment a run returns at least one usable entry.
// Ordering is by ascending streak (healthiest first), stable within a tie, so
// the relative order the caller passed is preserved among equally-healthy
// sources. Kept deliberately simple and exported so tests can drive it directly.
//
// Backends are opaque functions, so a source name is read from an attached
// `b.sourceName` (or the function's own name) — a backend with no discernible
// name is treated as its own always-neutral bucket and never demoted.
const _sourceHealth = new Map()

function _backendName(b, i) {
  if (b && typeof b.sourceName === 'string' && b.sourceName) return b.sourceName
  if (b && typeof b.name === 'string' && b.name && b.name !== 'bound ') return b.name
  return `#${i}` // positional fallback: a distinct, stable, neutral bucket
}

function _healthStreak(name) {
  return _sourceHealth.get(name) || 0
}

// A run that produced nothing usable — threw, timed out, or returned no entries
// — nudges the streak up; a run with results clears it. Callers rarely invoke
// this directly (resolveStream does), but it is exported for tests.
function recordSourceResult(name, ok) {
  if (!name) return
  if (ok) _sourceHealth.set(name, 0)
  else _sourceHealth.set(name, _healthStreak(name) + 1)
}

function _resetSourceHealth() {
  _sourceHealth.clear()
}

// A read-only view for the diagnostics page: every source that has run this
// session, healthy meaning no current failure streak. Sources that have not
// run yet simply are not listed — absence is not a verdict.
function getSourceHealth() {
  return [..._sourceHealth.entries()].map(([name, streak]) => ({
    name,
    healthy: streak === 0,
    failStreak: streak,
  }))
}

// The persisted-health tiebreak key for a source, read from a cross-restart
// health map ({ name: { ok, failStreak } }, produced by src/source-health.js).
// Lower is healthier: an unknown or currently-ok source is 0 (neutral, never
// demoted); a failing one is its persisted failStreak. This only ever breaks a
// tie beneath the live session streak — a source the session has already seen
// answer or fail this run is ordered by that first.
function _persistedKey(persistedHealth, name) {
  const rec = persistedHealth && persistedHealth[name]
  if (!rec || typeof rec !== 'object') return 0
  if (rec.ok) return 0
  return Number(rec.failStreak) || 1
}

// Healthiest (lowest streak) first, stable within a tie so the caller's own
// ordering is respected among equally-healthy sources. Never drops anything.
// When a persisted-health map is passed, durable health breaks the tie BENEATH
// the live session streak: session health stays primary, persisted health only
// orders sources the session has no opinion on yet this run, and the caller's
// own order is the final tiebreak so the result is fully deterministic.
function orderBackendsByHealth(backends, persistedHealth = null) {
  const list = (backends || []).map((b, i) => ({ b, i, name: _backendName(b, i) }))
  list.sort((a, b) => {
    const d = _healthStreak(a.name) - _healthStreak(b.name)
    if (d !== 0) return d
    if (persistedHealth) {
      const pd = _persistedKey(persistedHealth, a.name) - _persistedKey(persistedHealth, b.name)
      if (pd !== 0) return pd
    }
    return a.i - b.i
  })
  return list
}

async function resolveStream(request, backends, { preferSurround = true, timeoutMs = 8000, isDead = null, persistedHealth = null, onSweep = null } = {}) {
  // Order by health first, but keep every backend — a demoted source still runs,
  // it just no longer leads. All run in parallel anyway; the ordering matters
  // for the caller's mental model and for any future first-hit-wins fast path.
  // A persisted-health map (cross-restart, from src/source-health.js) breaks the
  // tie beneath the live session streak.
  const ordered = orderBackendsByHealth(backends, persistedHealth)
  const settled = await Promise.allSettled(
    ordered.map(({ b }) => _withTimeout(Promise.resolve().then(() => b(request)), timeoutMs))
  )
  const seen = new Set()
  const merged = []
  // Per-source answered/failed for this sweep, handed to onSweep so a caller can
  // persist durable health and notice an all-backends-zero run. Keyed by source
  // name; a backend that ran twice in one list keeps its last verdict.
  const sweep = {}
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i]
    const name = ordered[i].name
    if (result.status !== 'fulfilled' || !Array.isArray(result.value)) {
      recordSourceResult(name, false)
      sweep[name] = false
      continue
    }
    const list = result.value
    let produced = 0
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue
      const key = _dedupeKey(entry)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(entry)
      produced++
    }
    // Health is about whether the source ITSELF answered, not whether its
    // results survived cross-source dedupe — so a non-empty raw list counts as
    // healthy even if every entry was a duplicate of another source's.
    recordSourceResult(name, list.length > 0)
    sweep[name] = list.length > 0
    void produced
  }
  // Best-effort durable-health hook: a caller (main.js) records the sweep and,
  // when every backend came back empty, can kick the source-health canary. A
  // throwing callback must never break a search, so it is guarded.
  if (typeof onSweep === 'function') {
    try {
      const names = Object.keys(sweep)
      const allZero = names.length > 0 && names.every(n => !sweep[n])
      onSweep({ results: sweep, allZero })
    } catch (_) { /* health bookkeeping must not fail a search */ }
  }
  // The request's own dub flag drives the merged ranking, so the Dub toggle
  // reorders the final list — not just each provider's slice of it.
  return rankStreams(merged, { preferSurround, isDead, preferDub: request && request.dub === true })
}

module.exports = {
  qualityRank,
  isMultichannel,
  rankStreams,
  resolveStream,
  orderBackendsByHealth,
  recordSourceResult,
  getSourceHealth,
  _resetSourceHealth,
}
