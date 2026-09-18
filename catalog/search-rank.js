'use strict'
// Junk sinks (roadmap R10). A catalogue search returns entries that are not
// really the thing you asked for: no year, no poster, no rating — a stray
// record that shares a title with the real show. They used to rank wherever
// the catalogue put them, sometimes above the real entry, and (until the
// enrichment gate) wore the real show's IMDb rating. Now they go last, in
// their original order, and the real entries keep theirs.
function isJunk(r) {
  if (!r || typeof r !== 'object') return true
  const year = r.year != null && String(r.year).trim() !== ''
  const poster = !!(r.poster || r.posterUrl || r.image)
  return !year && !poster
}

function sortJunkLast(results) {
  const list = Array.isArray(results) ? results : []
  const good = [], junk = []
  for (const r of list) (isJunk(r) ? junk : good).push(r)
  return good.concat(junk)
}

// ── Cross-catalogue relevance ───────────────────────────────────────────────
// The film catalogue and the anime catalogue each rank their own results well.
// The merged search then threw that away: it appended the anime list after the
// film list, so the obvious answer could land at the bottom of the page.
// Measured: "Attack on Titan" put the live-action films above the famous
// series, "君の名は" put five 1950s melodramas above Your Name.
//
// There is no score the two catalogues share — TMDB's search payload carries no
// popularity at all — so the only honest common measure is how well the TITLE
// matches what was typed. That, plus each entry's rank inside its own
// catalogue, is what orders the merged page.

const _CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/

function hasCJK(text) {
  return _CJK.test(String(text == null ? '' : text))
}

// Case, accents, punctuation and spacing all disagree freely between TMDB and
// AniList for the same show, and between either of them and what a person
// types. Everything is compared through this.
function normTitle(v) {
  return String(v == null ? '' : v)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

// Every name an entry goes by. A TMDB film has title + original_title; an
// AniList entry has English, romaji and native. All of them count: someone who
// types the romaji name must not be told there is no such show.
function titlesOf(entry) {
  const t = (entry && entry.titles) || {}
  return [entry && entry.title, entry && entry.originalName,
    t.english, t.romaji, t.native]
}

function _tokens(s) {
  return s ? s.split(' ').filter(Boolean) : []
}

// 0 (nothing to do with the query) to 1 (this is exactly what was typed).
// Deliberately coarse: it decides ORDER between entries that a catalogue
// already thought were relevant, not whether they are relevant at all.
function matchScore(query, entry) {
  const q = normTitle(query)
  if (!q) return 0
  const qt = _tokens(q)
  let best = 0
  for (const raw of titlesOf(entry)) {
    const n = normTitle(raw)
    if (!n) continue
    let s = 0
    if (n === q) s = 1
    // "Spider-Man: No Way Home" for "Spider-Man" — the thing asked for, plus
    // more. Still a strong answer.
    else if (n.indexOf(q + ' ') === 0) s = 0.9
    // "Dune" for "Dune Part Two" — the query is the more specific one.
    else if (q.indexOf(n + ' ') === 0) s = 0.8
    // The query appears as whole words inside a longer title.
    else if (n.indexOf(' ' + q + ' ') > -1 || n.lastIndexOf(' ' + q) === n.length - q.length - 1) s = 0.7
    // Japanese and Chinese titles have no spaces to put a boundary on, so a
    // plain containment is the best available test there.
    else if (hasCJK(q) && q.length > 1 && n.indexOf(q) > -1) s = 0.7
    else {
      const nt = new Set(_tokens(n))
      let hit = 0
      for (const tok of qt) if (nt.has(tok)) hit++
      s = qt.length ? 0.6 * (hit / qt.length) : 0
      // One shared short word is a coincidence, not a match: "no", "the",
      // "my" are in half the catalogue.
      if (hit === 1 && qt.length === 1 && qt[0].length < 3) s = 0
    }
    if (s > best) best = s
  }
  return best
}

// Merge several already-ranked lists into one page without losing either
// catalogue's own judgement.
//
// The alternative considered and rejected was a single flat grid with type
// badges. Grouping is worth keeping — a film, a series and an anime are
// different answers to the same question, and the type chips above the results
// are built from it — so the groups stay and the ORDER within the page is what
// changes. The renderer then orders the groups themselves by where their best
// entry landed here.
//
// Ties are broken by rank-within-source first and source order second, which
// is a round-robin: at equal title match the pages interleave rather than one
// catalogue's whole list preceding the other's. That is precisely the thing
// that buried Attack on Titan.
function rankByRelevance(query, lists) {
  const rows = []
  const all = Array.isArray(lists) ? lists : []
  for (let listIdx = 0; listIdx < all.length; listIdx++) {
    const list = Array.isArray(all[listIdx]) ? all[listIdx] : []
    for (let idx = 0; idx < list.length; idx++) {
      rows.push({ item: list[idx], listIdx, idx, score: matchScore(query, list[idx]) })
    }
  }
  rows.sort(function (a, b) {
    return (b.score - a.score) || (a.idx - b.idx) || (a.listIdx - b.listIdx)
  })
  return rows.map(function (r) { return r.item })
}

module.exports = {
  isJunk,
  sortJunkLast,
  hasCJK,
  normTitle,
  titlesOf,
  matchScore,
  rankByRelevance,
}
