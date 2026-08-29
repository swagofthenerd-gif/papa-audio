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

// 7.1 counts as multichannel too; the original only recognised '5.1', so a
// TrueHD 7.1 release scored below a stereo one of the same resolution.
function _score(e, preferSurround) {
  const quality = qualityRank(e.quality)
  const surround = isMultichannel(e.audioLayout)
  const bonus = preferSurround && surround ? 1 : 0
  return { quality, surround, score: quality + bonus }
}

function rankStreams(entries, { preferSurround = true } = {}) {
  const ranked = entries.map(e => ({ entry: e, ..._score(e, preferSurround) }))
  ranked.sort((a, b) => {
    // Cam rips and telesyncs are a filmed cinema screen, not a source encode.
    // They stay in the list so a film with nothing else is still playable, but
    // they never outrank a real release regardless of resolution or seeds.
    const lowA = a.entry.lowQuality === true
    const lowB = b.entry.lowQuality === true
    if (lowA !== lowB) return lowA ? 1 : -1
    if (b.score !== a.score) return b.score - a.score
    if (b.surround !== a.surround) return b.surround ? 1 : -1
    if (b.quality !== a.quality) return b.quality - a.quality
    // Seed count decides whether a torrent actually plays, so it outranks the
    // alphabetical source fallback. Entries without seeds (direct HTTP) sort
    // as 0 and keep their previous relative order.
    const seedsA = Number(a.entry.seeds) || 0
    const seedsB = Number(b.entry.seeds) || 0
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

async function resolveStream(request, backends, { preferSurround = true, timeoutMs = 8000 } = {}) {
  const settled = await Promise.allSettled(
    (backends || []).map(b => _withTimeout(Promise.resolve().then(() => b(request)), timeoutMs))
  )
  const seen = new Set()
  const merged = []
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue
    const list = result.value
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue
      const key = _dedupeKey(entry)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(entry)
    }
  }
  return rankStreams(merged, { preferSurround })
}

module.exports = {
  qualityRank,
  isMultichannel,
  rankStreams,
  resolveStream,
}
