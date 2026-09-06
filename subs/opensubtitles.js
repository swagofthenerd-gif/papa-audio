'use strict'
// OpenSubtitles.com — external subtitles for anything the release itself
// does not carry.
//
// Same shape as the catalog modules: pure normalisation around a thin fetch
// shell, an injectable fetcher so tests never touch the network, and no
// throwing — a failure returns the empty/null shape and the caller carries on.
//
// The REST API lives at https://api.opensubtitles.com/api/v1 and wants an
// `Api-Key` header on every request (free key from opensubtitles.com).
// Search is `GET /subtitles?...`; a download link is minted by
// `POST /download` with `{ file_id }` — the search result carries file ids,
// not URLs, and each minted link counts against the key's daily quota.
//
// Contract published for the main-process wiring:
//   createOpenSubtitles({ apiKey, fetcher, timeoutMs })
//     `apiKey` may be a string or a () => string so the settings value is
//     read fresh per call, like omdb.js does.
//   search({ imdbId, tmdbId, query, season, episode, languages })
//     -> [{ id, language, release, downloadCount, fileId }]
//        sorted most-downloaded first.
//     No key is not an error — it is a feature the user has not set up. The
//     returned empty array then carries a `needsKey: true` property
//     (`out.needsKey === true`) so the UI can say "add a key in Settings"
//     instead of "no subtitles found".
//   download(fileId)
//     -> { url } — the temporary direct-download URL for the .srt.
//     -> { url: null, needsKey: true } without a key,
//        { url: null } on any failure.

const BASE = 'https://api.opensubtitles.com/api/v1'

// The API wants the bare digits, not the "tt" prefix TMDB hands back.
function toNumericImdb(imdbId) {
  const m = /^(?:tt)?(\d+)$/.exec(String(imdbId == null ? '' : imdbId).trim())
  return m ? m[1] : null
}

// Accepts ['en', 'ES'] or 'en,es'; the API wants a lowercase comma list.
function normalizeLanguages(languages) {
  const list = Array.isArray(languages)
    ? languages
    : String(languages == null ? '' : languages).split(',')
  const out = []
  for (const l of list) {
    const t = String(l == null ? '' : l).trim().toLowerCase()
    if (t && !out.includes(t)) out.push(t)
  }
  return out.length ? out.join(',') : null
}

function buildSearchUrl(params) {
  const q = new URLSearchParams()
  const imdb = toNumericImdb(params.imdbId)
  if (imdb) q.set('imdb_id', imdb)
  if (params.tmdbId != null && params.tmdbId !== '') q.set('tmdb_id', String(params.tmdbId))
  if (params.query) q.set('query', String(params.query))
  if (params.season != null && params.season !== '') q.set('season_number', String(Number(params.season)))
  if (params.episode != null && params.episode !== '') q.set('episode_number', String(Number(params.episode)))
  const langs = normalizeLanguages(params.languages)
  if (langs) q.set('languages', langs)
  // The API's CDN caches by exact URL and asks for alphabetised parameters;
  // sorting costs nothing and makes the URL deterministic for tests too.
  q.sort()
  return `${BASE}/subtitles?${q.toString()}`
}

// One row per subtitle file. A result without a file id cannot be downloaded,
// so it is dropped rather than offered as a dead button.
function normalizeSearchResult(raw) {
  const a = raw && raw.attributes
  if (!a || typeof a !== 'object') return null
  const file = Array.isArray(a.files) && a.files[0] ? a.files[0] : null
  if (!file || file.file_id == null) return null
  return {
    id: raw.id != null ? String(raw.id) : null,
    language: typeof a.language === 'string' && a.language ? a.language : null,
    release: typeof a.release === 'string' && a.release ? a.release : null,
    downloadCount: Number(a.download_count) || 0,
    fileId: file.file_id,
  }
}

function _needsKeyList() {
  const out = []
  out.needsKey = true
  return out
}

function createOpenSubtitles({ apiKey, fetcher, timeoutMs = 15000 } = {}) {
  const doFetch = fetcher || fetch
  const key = () => (typeof apiKey === 'function' ? apiKey() : apiKey)

  function _headers(k, { json = false } = {}) {
    const h = {
      'Api-Key': k,
      // The API rejects requests with no User-Agent product name.
      'User-Agent': 'PapaAudio v1.0',
      Accept: 'application/json',
    }
    if (json) h['Content-Type'] = 'application/json'
    return h
  }

  function _signal() {
    // A hung subtitle lookup must never hang playback setup: every request
    // aborts on its own timer even when the injected fetcher has no timeout.
    return timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
  }

  return {
    async search(params = {}) {
      const k = key()
      if (!k) return _needsKeyList()
      try {
        const res = await doFetch(buildSearchUrl(params), {
          headers: _headers(k),
          signal: _signal(),
        })
        if (!res || !res.ok) return []
        const data = await res.json()
        const rows = data && Array.isArray(data.data) ? data.data : []
        const out = rows.map(normalizeSearchResult).filter(Boolean)
        // Download count is the crowd's verdict on sync and quality; the
        // most-fetched subtitle for a release is nearly always the right one.
        out.sort((a, b) => b.downloadCount - a.downloadCount)
        return out
      } catch (_err) {
        return []
      }
    },

    async download(fileId) {
      const k = key()
      if (!k) return { url: null, needsKey: true }
      if (fileId == null || fileId === '') return { url: null }
      try {
        const res = await doFetch(`${BASE}/download`, {
          method: 'POST',
          headers: _headers(k, { json: true }),
          body: JSON.stringify({ file_id: fileId }),
          signal: _signal(),
        })
        if (!res || !res.ok) return { url: null }
        const data = await res.json()
        const url = data && typeof data.link === 'string' && data.link ? data.link : null
        return { url }
      } catch (_err) {
        return { url: null }
      }
    },
  }
}

module.exports = {
  BASE,
  toNumericImdb,
  normalizeLanguages,
  buildSearchUrl,
  normalizeSearchResult,
  createOpenSubtitles,
}
