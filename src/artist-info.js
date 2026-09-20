'use strict';
// Artist info for the artist page (Wave 3 contract) — a keyless bio, plus a
// `similar` slot the UI fills from its own library-derived "Fans also like" row.
//
//   artistInfo({ artist }) -> { bio: string|null, similar: string[] }
//
// SOURCE CHOICE. The contract ruled out Last.fm (it needs an api key, and the
// app ships only a PLACEHOLDER key used for scrobbling). The keyless path is the
// MusicBrainz → Wikidata → Wikipedia chain:
//   1. MusicBrainz artist search (`/ws/2/artist?query=`) resolves the name to an
//      MBID and its url-relations, which include a Wikipedia and/or Wikidata link
//      when one exists.
//   2. If the artist has a direct Wikipedia relation, use its page title. If it
//      has only a Wikidata relation (increasingly the common case, as MB migrates
//      to Wikidata-only links), resolve the Wikidata entity's `enwiki` sitelink to
//      the Wikipedia page title.
//   3. The Wikipedia REST summary endpoint
//      (`/api/rest_v1/page/summary/<title>`) returns a clean plain-text extract —
//      the bio. When neither relation yields a title we fall back to a direct
//      Wikipedia summary lookup by artist name, which is what the renderer already
//      did for the bio before this handler existed.
//
// SIMILAR. The app's on-page "Fans also like" is derived entirely from the LOCAL
// library (same-genre artists — src/renderer.js, artist page), which is a
// renderer-side concern the backend cannot and should not reconstruct. There is
// no keyless external "similar artists" source in the app's stack (MusicBrainz
// has no similarity endpoint; Last.fm's needs the key we do not have). So this
// handler returns `similar: []` and the UI keeps its library-based row — exactly
// the "artistInfo only adds bio" division the contract describes. The field is
// kept in the contract shape so a future keyless source can populate it without a
// signature change.
//
// This module is the pure logic — the cache (cap 100, 30-day TTL, side-store
// backed) and the response normalisation — plus a small orchestrator that takes
// injected fetchers so it runs under the test runner with no network. Everything
// is timeout-guarded by an AbortController in the caller (main), 10s per request,
// and every failure degrades to { bio: null, similar: [] } rather than throwing.
//
// UMD-wrapped so it loads under Node's test runner and, if ever needed, as a
// classic renderer script — same pattern as the other src/ pure modules.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaArtistInfo = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const CACHE_CAP = 100
  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000   // 30 days
  const REQUEST_TIMEOUT_MS = 10000

  // The degraded answer. Returned on any failure and used as the shape reference:
  // bio is a string or null, similar is always an array.
  function degraded() {
    return { bio: null, similar: [] }
  }

  // A stable cache key: the artist name, case-folded and whitespace-collapsed, so
  // "Boards of Canada" and "boards  of canada" share one entry.
  function cacheKey(artist) {
    return String(artist == null ? '' : artist).toLowerCase().replace(/\s+/g, ' ').trim()
  }

  // Normalise whatever the fetch path produced into the contract shape. A bio is
  // a non-empty string or null; similar is always an array of non-empty strings.
  function normalize(info) {
    const bio = info && typeof info.bio === 'string' && info.bio.trim()
      ? info.bio.trim() : null
    const similar = Array.isArray(info && info.similar)
      ? info.similar.map(s => String(s || '').trim()).filter(Boolean)
      : []
    return { bio, similar }
  }

  // ── Cache over a plain object (persisted by a side-store in main) ────────────
  // Shape: { "<key>": { value: {bio,similar}, ts: <ms> } }. Kept as a plain
  // object rather than a Map so it JSON round-trips through the side-store, and
  // pure so the cap/TTL/eviction are testable with an injected clock.

  function _fresh(entry, now, ttlMs) {
    return entry && typeof entry === 'object' &&
      Number.isFinite(Number(entry.ts)) && (now - Number(entry.ts)) < ttlMs
  }

  // Read a live (unexpired) entry, or undefined. Does not mutate the store.
  function cacheGet(store, key, now, ttlMs) {
    ttlMs = ttlMs || CACHE_TTL_MS
    now = now == null ? Date.now() : now
    const s = store && typeof store === 'object' ? store : {}
    const entry = s[key]
    if (!_fresh(entry, now, ttlMs)) return undefined
    return entry.value
  }

  // Write an entry and enforce the cap by evicting the OLDEST entries (by ts),
  // dropping expired ones first. Returns a NEW store object (the caller persists
  // it) so the input is never mutated.
  function cacheSet(store, key, value, now, opts) {
    opts = opts || {}
    const cap = Number(opts.cap) > 0 ? Number(opts.cap) : CACHE_CAP
    const ttlMs = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : CACHE_TTL_MS
    now = now == null ? Date.now() : now
    const next = Object.assign({}, store && typeof store === 'object' ? store : {})
    next[key] = { value: normalize(value), ts: now }
    // Drop expired entries first — they are worthless — then, if still over cap,
    // evict oldest-first by timestamp until at the cap.
    const keys = Object.keys(next)
    for (const k of keys) {
      if (!_fresh(next[k], now, ttlMs)) delete next[k]
    }
    let live = Object.keys(next)
    if (live.length > cap) {
      live.sort((a, b) => (Number(next[a].ts) || 0) - (Number(next[b].ts) || 0))
      for (let i = 0; i < live.length - cap; i++) delete next[live[i]]
    }
    return next
  }

  // ── Fetch orchestration ──────────────────────────────────────────────────────
  // Injectable so tests drive it with no network. Each fetcher takes a URL and
  // resolves to a parsed JSON object (or null / throws on failure); the caller in
  // main wraps a real timeout-guarded fetch. Any throw degrades to null here so
  // one dead endpoint never fails the whole lookup.

  function _mbSearchUrl(artist) {
    return 'https://musicbrainz.org/ws/2/artist?fmt=json&limit=1&query=' +
      encodeURIComponent('artist:"' + String(artist || '') + '"')
  }

  // The Wikipedia page title from a MusicBrainz artist's url-relations, if any.
  // MusicBrainz relations look like { type: 'wikipedia', url: { resource: '...' } }.
  function wikipediaTitleFromMb(mbArtist) {
    const rels = mbArtist && Array.isArray(mbArtist.relations) ? mbArtist.relations : []
    for (const r of rels) {
      if (!r || r.type !== 'wikipedia') continue
      const url = r.url && typeof r.url.resource === 'string' ? r.url.resource : ''
      const m = /\/wiki\/([^#?]+)/.exec(url)
      if (m) return decodeURIComponent(m[1])
    }
    return null
  }

  function _mbArtistUrl(mbid) {
    return 'https://musicbrainz.org/ws/2/artist/' + encodeURIComponent(mbid) +
      '?fmt=json&inc=url-rels'
  }

  // The Wikidata entity id (Q…) from a MusicBrainz artist's url-relations, if
  // any. MusicBrainz increasingly carries only a Wikidata relation and no direct
  // Wikipedia one, so this is the middle hop of the MB → Wikidata → Wikipedia
  // chain: a Wikidata entity's sitelinks name the Wikipedia page title.
  function wikidataIdFromMb(mbArtist) {
    const rels = mbArtist && Array.isArray(mbArtist.relations) ? mbArtist.relations : []
    for (const r of rels) {
      if (!r || r.type !== 'wikidata') continue
      const url = r.url && typeof r.url.resource === 'string' ? r.url.resource : ''
      const m = /\/(Q\d+)(?:[#?].*)?$/.exec(url)
      if (m) return m[1]
    }
    return null
  }

  function _wikidataEntityUrl(qid) {
    return 'https://www.wikidata.org/wiki/Special:EntityData/' +
      encodeURIComponent(String(qid || '')) + '.json'
  }

  // The English Wikipedia page title from a Wikidata entity's sitelinks, or null.
  // EntityData JSON is { entities: { Q123: { sitelinks: { enwiki: { title } } } } }.
  function wikipediaTitleFromWikidata(entity, qid) {
    const entities = entity && typeof entity.entities === 'object' ? entity.entities : null
    if (!entities) return null
    const ent = qid && entities[qid] ? entities[qid] : entities[Object.keys(entities)[0]]
    const sitelinks = ent && typeof ent.sitelinks === 'object' ? ent.sitelinks : null
    const enwiki = sitelinks && sitelinks.enwiki
    const title = enwiki && typeof enwiki.title === 'string' ? enwiki.title.trim() : ''
    return title || null
  }

  function _wikiSummaryUrl(title) {
    return 'https://en.wikipedia.org/api/rest_v1/page/summary/' +
      encodeURIComponent(String(title || ''))
  }

  // A Wikipedia REST summary's plain-text extract, or null. Disambiguation and
  // missing pages carry a `type` that is not 'standard'; those are not a bio.
  function bioFromWikiSummary(summary) {
    if (!summary || typeof summary !== 'object') return null
    if (summary.type && summary.type !== 'standard') return null
    const extract = typeof summary.extract === 'string' ? summary.extract.trim() : ''
    return extract || null
  }

  // The keyless full-intro endpoint. The REST summary above returns a lead
  // ABSTRACT by design — 424 characters for Pink Floyd, against 2,736 here —
  // which is why the dossier was cutting a sentence four characters from its
  // end. Same one request, no key, no new IPC.
  function _wikiExtractUrl(title) {
    return 'https://en.wikipedia.org/w/api.php?action=query&format=json' +
      '&prop=extracts&explaintext=1&exintro=1&redirects=1&titles=' +
      encodeURIComponent(String(title || ''))
  }

  // The plain-text intro out of an action=query&prop=extracts response, or
  // null. Shape is { query: { pages: { "<pageid>": { extract } } } }; a pageid
  // of -1 (or a `missing` marker) is the API saying there is no such article.
  // Those two skips are belt-and-braces — a missing page carries no extract
  // either — and are spelled out because the shape is the contract here.
  //
  // A NEW parser beside bioFromWikiSummary rather than a change to it: the
  // summary one is unit-tested against a different contract and still serves
  // the `artist-bio` handler, which needs the thumbnail and description this
  // endpoint does not carry.
  function bioFromQueryExtract(json) {
    const pages = json && json.query && json.query.pages && typeof json.query.pages === 'object'
      ? json.query.pages : null
    if (!pages) return null
    for (const id of Object.keys(pages)) {
      if (String(id) === '-1') continue
      const page = pages[id]
      if (!page || page.missing !== undefined) continue
      // This endpoint carries no `type: 'disambiguation'`, so the same text
      // test the artist-bio handler uses is the only guard available: "Dummy",
      // "Air", "Bush" and "Muse" all resolve to a disambiguation page.
      const raw = typeof page.extract === 'string' ? page.extract : ''
      const extract = raw.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n').trim()
      if (!extract) continue
      if (/may refer to|disambiguation/i.test(extract.slice(0, 120))) return null
      return extract
    }
    return null
  }

  // Resolve an artist to { bio, similar } using injected async fetchers:
  //   fetchers.mb(url)   -> parsed JSON | null   (MusicBrainz)
  //   fetchers.wd(url)   -> parsed JSON | null   (Wikidata EntityData; optional)
  //   fetchers.wiki(url) -> parsed JSON | null   (Wikipedia REST)
  // Order (the MB → Wikidata → Wikipedia chain): MB search for the MBID → MB
  // artist for its url-relations → a direct Wikipedia relation if present, else
  // the Wikidata relation resolved to a Wikipedia title via its sitelinks →
  // Wikipedia summary for the bio; finally a direct Wikipedia-by-name summary as
  // a last resort. similar is always [] (see the module header). The Wikidata hop
  // is skipped when no `wd` fetcher is injected, so the two-fetcher callers still
  // work unchanged.
  async function resolve(artist, fetchers) {
    const name = String(artist == null ? '' : artist).trim()
    if (!name) return degraded()
    const mb = fetchers && typeof fetchers.mb === 'function' ? fetchers.mb : null
    const wd = fetchers && typeof fetchers.wd === 'function' ? fetchers.wd : null
    const wiki = fetchers && typeof fetchers.wiki === 'function' ? fetchers.wiki : null
    if (!wiki) return degraded()

    let wikiTitle = null
    if (mb) {
      try {
        const search = await mb(_mbSearchUrl(name))
        const first = search && Array.isArray(search.artists) && search.artists[0]
          ? search.artists[0] : null
        if (first && first.id) {
          const full = await mb(_mbArtistUrl(first.id))
          wikiTitle = wikipediaTitleFromMb(full)
          // No direct Wikipedia relation, but MB has a Wikidata one: resolve the
          // entity's enwiki sitelink to a page title (the middle hop).
          if (!wikiTitle && wd) {
            const qid = wikidataIdFromMb(full)
            if (qid) {
              try {
                const entity = await wd(_wikidataEntityUrl(qid))
                wikiTitle = wikipediaTitleFromWikidata(entity, qid)
              } catch (_) { /* Wikidata is best-effort; fall through */ }
            }
          }
        }
      } catch (_) { /* MB is a best-effort hop; fall through to name lookup */ }
    }

    // Try the MusicBrainz-resolved Wikipedia title first, then the bare artist
    // name — the latter is what the renderer used before and works for the many
    // artists whose Wikipedia page title is just their name.
    for (const title of [wikiTitle, name].filter(Boolean)) {
      // The full intro first, the REST summary as the fallback when the extract
      // is missing or empty. Both go through the same injected `wiki` fetcher.
      try {
        const bio = bioFromQueryExtract(await wiki(_wikiExtractUrl(title)))
        if (bio) return { bio, similar: [] }
      } catch (_) { /* fall through to the summary */ }
      try {
        const summary = await wiki(_wikiSummaryUrl(title))
        const bio = bioFromWikiSummary(summary)
        if (bio) return { bio, similar: [] }
      } catch (_) { /* try the next title */ }
    }
    return degraded()
  }

  return {
    CACHE_CAP,
    CACHE_TTL_MS,
    REQUEST_TIMEOUT_MS,
    degraded,
    cacheKey,
    normalize,
    cacheGet,
    cacheSet,
    wikipediaTitleFromMb,
    wikidataIdFromMb,
    // Exported so the album dossier's own Wikidata → Wikipedia hop builds the
    // same two URLs this module does, rather than growing a second, drifting
    // copy of them in main.js.
    wikiExtractUrl: _wikiExtractUrl,
    wikiSummaryUrl: _wikiSummaryUrl,
    wikipediaTitleFromWikidata,
    bioFromWikiSummary,
    bioFromQueryExtract,
    resolve,
  }
})
