'use strict'
// Layer 2 skip source: AniSkip — exact OP/ED intervals for anime, no key.
//
// AniSkip's API is a GET per (malId, episode) that returns precise opening and
// ending timestamps. It is verified working (§6); the malId comes from AniList
// (Phase 0 added idMal). Like a provider, this never throws and returns [] on
// any failure — a dead skip service must not be able to stop playback.

const DEFAULT_BASE_URL = 'https://api.aniskip.com'

// AniSkip's skipType values → our segment kinds. 'op'/'ed' are the exact
// opening/ending; 'mixed-*' mean the segment contains other material, still
// worth a skip for the same kind.
const SKIP_KIND = {
  op: 'intro',
  ed: 'credits',
  'mixed-op': 'intro',
  'mixed-ed': 'credits',
  recap: 'recap',
}

function buildUrl({ malId, episode, episodeLength = 0, baseUrl = DEFAULT_BASE_URL } = {}) {
  const ep = Number(episode)
  const mal = Number(malId)
  const length = Number(episodeLength) || 0
  return `${baseUrl}/v2/skip-times/${mal}/${ep}?types=op&types=ed&episodeLength=${length}`
}

function normalizeResult(result) {
  const kind = result && SKIP_KIND[result.skipType]
  if (!kind) return null
  const interval = result.interval
  const start = interval && interval.startTime
  const end = interval && interval.endTime
  if (typeof start !== 'number' || typeof end !== 'number' || end <= start) return null
  return { kind, start, end, origin: 'aniskip', confidence: 0.95 }
}

function createAniSkip({ fetchFn, baseUrl = DEFAULT_BASE_URL } = {}) {
  const fetcher = fetchFn || fetch

  return async function aniSkip({ malId, episode, episodeLength } = {}) {
    if (!Number(malId) || !Number(episode)) return []
    try {
      const res = await fetcher(buildUrl({ malId, episode, episodeLength, baseUrl }))
      if (!res || !res.ok) return []
      const data = await res.json()
      // `found: false` is AniSkip saying "we have nothing", not an error; treat
      // it the same as an empty list and do not cache it.
      if (!data || data.found !== true || !Array.isArray(data.results)) return []
      return data.results.map(normalizeResult).filter(Boolean)
    } catch (_) {
      return []
    }
  }
}

module.exports = { createAniSkip, buildUrl, normalizeResult, SKIP_KIND, DEFAULT_BASE_URL }
