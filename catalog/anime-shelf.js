'use strict'
// The anime shelf fallback chain, as ONE pure decision function.
//
// The Anime tab's fixed rows (Trending / Popular / This Season) come from
// AniList. AniList has recurring global outages (a 403 that blanks every anime
// row), so the row must degrade rather than lie about being empty. The order is:
//
//   1. live AniList          — the home source; a non-empty result always wins
//   2. live Jikan/MyAnimeList — same rows, different source, only tried when
//                               AniList is actually DOWN (not healthy-but-empty)
//   3. live Kitsu             — the third source, only tried when Jikan came back
//                               empty too (the 2026-09-11 double outage: AniList
//                               403 AND MyAnimeList 504 at once). Kitsu serves
//                               only the sections it has a cheap keyless endpoint
//                               for (trending); a section it cannot serve yields
//                               nothing and the chain moves on to the saved list.
//   4. the last saved list   — a stale-but-real shelf beats an error page
//   5. an honest outage       — never the "nothing here" lie for a downed API
//
// This function owns only the CHOICE between those four. It performs no I/O
// itself: the caller passes in the already-fetched AniList result, a Jikan
// fetcher, and cache read/write callbacks. That keeps the whole chain — including
// the jikan-fails-then-cache branch and the force-scoping of the source mark —
// testable without a network or Electron. The main-process handler
// (video-catalog-get) is a thin wrapper that wires the real catalogs and side
// store to it.

// Resolve one shelf.
//
//   anilist  : { results:[], failure } from _anilistListWithOutage — `failure` is
//              { message, status } when the empty is an outage, else null.
//   deps     : {
//     fetchJikan : async () => [cards]   — live Jikan shelf, [] on any failure
//     fetchKitsu : async () => [cards]   — live Kitsu shelf, [] on any failure or
//                                          for a section Kitsu cannot serve
//                                          (optional: absent means no third rung)
//     readCache  : () => ({ value:[] }|null) — the last saved shelf, or null
//     writeCache : (results) => void     — mirror a fresh good result through
//     memoWrite  : (results) => void     — memo-cache a fresh good result
//   }
//
// Returns the exact object the handler returns to the renderer:
//   { ok:true, results, viaMal?, fromCache?, outage? }
// One card per show (R19). A season list can carry the same show twice — a
// split cour listed under two ids, or the same title from two databases when
// a fallback mixes sources — and "This Season" painted both. Identity is the
// catalogue id when the source matches, else the normalised title + year.
function dedupeCards(list) {
  const seen = new Set()
  const out = []
  for (const r of (Array.isArray(list) ? list : [])) {
    if (!r) continue
    const idKey = (r.type || 'anime') + ':' + String(r.id == null ? '' : r.id)
    const title = String(r.title || r.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    const titleKey = title ? 'title:' + title + ':' + (r.year || '') : null
    if (seen.has(idKey) || (titleKey && seen.has(titleKey))) continue
    seen.add(idKey)
    if (titleKey) seen.add(titleKey)
    out.push(r)
  }
  return out
}

async function resolveAnimeShelf(anilist, deps) {
  const results = dedupeCards(Array.isArray(anilist && anilist.results) ? anilist.results : [])
  const failure = anilist && anilist.failure

  // 1. Live AniList, non-empty: the good case. Memo it and mirror to the saved
  //    list so a later outage can serve it.
  if (results.length) {
    if (deps.memoWrite) deps.memoWrite(results)
    if (deps.writeCache) deps.writeCache(results)
    return { ok: true, results }
  }

  // A genuinely healthy-but-empty AniList result is not an outage: fall through
  // to a plain empty list, which the renderer shows as "nothing here". Only when
  // AniList is DOWN do the fallbacks come into play.
  if (!failure) return { ok: true, results: [] }

  // 2. Live Jikan/MyAnimeList. Its cards are already marked source:'mal' and
  //    route by their own id, so a fresh hit is cached (marked) and memo'd
  //    exactly like an AniList hit. `viaMal` tells the renderer to note where it
  //    came from; `outage` carries AniList's own message so the note is honest.
  const jikanResults = deps.fetchJikan ? await deps.fetchJikan() : []
  if (Array.isArray(jikanResults) && jikanResults.length) {
    if (deps.memoWrite) deps.memoWrite(jikanResults)
    if (deps.writeCache) deps.writeCache(jikanResults)
    return { ok: true, results: dedupeCards(jikanResults), viaMal: true, outage: failure.message }
  }

  // 3. Live Kitsu. Reached only when Jikan came back empty too — the 2026-09-11
  //    double outage (AniList 403 and MyAnimeList 504 at once). Its cards are
  //    marked source:'kitsu' and route by their own `kitsu-` id, so a fresh hit
  //    is cached and memo'd exactly like a Jikan or AniList hit. `viaMal` marks
  //    it as a non-AniList fallback so the renderer notes where it came from
  //    (the note is generic across MAL/Kitsu); `outage` carries AniList's own
  //    message. Kitsu only serves the sections it has a cheap keyless endpoint
  //    for, so for the others fetchKitsu returns [] and the chain moves on.
  const kitsuResults = deps.fetchKitsu ? await deps.fetchKitsu() : []
  if (Array.isArray(kitsuResults) && kitsuResults.length) {
    if (deps.memoWrite) deps.memoWrite(kitsuResults)
    if (deps.writeCache) deps.writeCache(kitsuResults)
    return { ok: true, results: dedupeCards(kitsuResults), viaMal: true, outage: failure.message }
  }

  // 4. The last saved list. It may itself be Jikan or Kitsu cards from a previous
  //    fallback; that is fine, they route the same. Marked fromCache so the
  //    renderer admits it may be stale.
  const saved = deps.readCache ? deps.readCache() : null
  if (saved && Array.isArray(saved.value) && saved.value.length) {
    return { ok: true, results: dedupeCards(saved.value), fromCache: true, outage: failure.message }
  }

  // 5. Nothing anywhere. Say so honestly.
  return { ok: true, results: [], outage: failure.message }
}

module.exports = { resolveAnimeShelf, dedupeCards }
