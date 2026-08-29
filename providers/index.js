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
  return audioLayout === '5.1'
}

function _score(e, preferSurround) {
  const quality = qualityRank(e.quality)
  const surround = isMultichannel(e.audioLayout)
  const bonus = preferSurround && surround ? 1 : 0
  return { quality, surround, score: quality + bonus }
}

function rankStreams(entries, { preferSurround = true } = {}) {
  const ranked = entries.map(e => ({ entry: e, ..._score(e, preferSurround) }))
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (b.surround !== a.surround) return b.surround ? 1 : -1
    if (b.quality !== a.quality) return b.quality - a.quality
    const sa = a.entry.source
    const sb = b.entry.source
    if (sa < sb) return -1
    if (sa > sb) return 1
    return 0
  })
  return ranked.map(r => r.entry)
}

function _dedupeKey(e) {
  return `${e.kind}\u0000${e.url || e.magnet || ''}`
}

async function resolveStream(request, backends, { preferSurround = true, timeoutMs = 8000 } = {}) {
  void request
  void timeoutMs
  const settled = await Promise.allSettled(backends.map(b => b(request)))
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
