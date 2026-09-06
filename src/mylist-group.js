'use strict';
// My List collection / franchise grouping (App #22).
//
// The honest scope: TMDB knows which collection a film belongs to
// (`belongs_to_collection`), but the watchlist store only ever persisted
// { type, id, title, poster, addedAt } — no collection field. So this grouper
// works two ways, best-data-first:
//
//   1. STORED COLLECTION. If an item carries a `collection` (id + name) —
//      which it now does when it was added from a detail page that had one —
//      items sharing a collection id are grouped under that name, but only when
//      2+ members are actually on the list. A lone member stays a plain card.
//
//   2. FRANCHISE FALLBACK. When the collection field genuinely isn't there,
//      group by the leading words of the title: 2+ items whose titles share a
//      meaningful prefix ("Mission: Impossible …", "The Lord of the Rings …")
//      fold together under that prefix. Bare articles ("The", "A") don't count,
//      so "The Matrix" and "The Terminator" never fake a franchise.
//
// Pure and export-friendly: returns an ordered list of groups, each either a
// real group ({ grouped:true, name, items }) or a passthrough single
// ({ grouped:false, items:[item] }). The renderer decides how to fold/unfold;
// this only decides membership. Order is stable — first appearance wins — so a
// re-render doesn't reshuffle the grid.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaMyListGroup = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Words that carry no franchise identity on their own. A shared leading run
  // made only of these is not a franchise.
  const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'and'])

  function _collId(item) {
    const c = item && item.collection
    if (!c) return null
    const id = c.id != null ? c.id : (typeof c === 'string' || typeof c === 'number' ? c : null)
    return id == null ? null : String(id)
  }

  // Normalise a title into lowercase word tokens for prefix comparison. Keeps
  // it forgiving: punctuation ("Mission: Impossible - Fallout") is dropped so
  // the words line up.
  function _titleWords(title) {
    return String(title || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .split(/\s+/)
      .filter(Boolean)
  }

  // How many leading words two titles share.
  function _sharedPrefixLen(a, b) {
    let n = 0
    while (n < a.length && n < b.length && a[n] === b[n]) n++
    return n
  }

  // A shared prefix is "meaningful" if it has 2+ words, or one word that is not
  // a stop-word (so "Alien"/"Aliens" would NOT match here — different words —
  // but "Rocky"/"Rocky II" share the single meaningful word "rocky").
  function _prefixIsMeaningful(words) {
    if (words.length >= 2) return words.some(w => !STOP_WORDS.has(w))
    if (words.length === 1) return !STOP_WORDS.has(words[0])
    return false
  }

  function _titleCase(words) {
    return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  }

  function groupMyList(list) {
    const items = Array.isArray(list) ? list.slice() : []
    if (!items.length) return []

    // ── Pass 1: stored collections ────────────────────────────────────────────
    const byColl = new Map()      // collId → { name, items:[] }
    for (const it of items) {
      const cid = _collId(it)
      if (!cid) continue
      if (!byColl.has(cid)) {
        byColl.set(cid, { name: (it.collection && it.collection.name) || 'Collection', items: [] })
      }
      byColl.get(cid).items.push(it)
    }
    // A collection only earns a group when 2+ of its members are on the list.
    const collGrouped = new Set()   // the actual item objects that got grouped
    for (const g of byColl.values()) {
      if (g.items.length >= 2) g.items.forEach(i => collGrouped.add(i))
    }

    // ── Pass 2: franchise prefix, over the ungrouped remainder ─────────────────
    const remaining = items.filter(i => !collGrouped.has(i))
    const words = new Map(remaining.map(i => [i, _titleWords(i.title)]))
    const franchiseOf = new Map()   // item → franchise key (joined prefix)
    const franchiseWords = new Map() // key → prefix words (for the display name)
    for (let i = 0; i < remaining.length; i++) {
      for (let j = i + 1; j < remaining.length; j++) {
        const a = remaining[i], b = remaining[j]
        const shared = _sharedPrefixLen(words.get(a), words.get(b))
        if (!shared) continue
        const prefix = words.get(a).slice(0, shared)
        if (!_prefixIsMeaningful(prefix)) continue
        const key = prefix.join(' ')
        // Assign both to this franchise. If either already belongs to a longer
        // franchise key, keep the longer (more specific) one.
        for (const it of [a, b]) {
          const cur = franchiseOf.get(it)
          if (!cur || key.length > cur.length) {
            franchiseOf.set(it, key)
            franchiseWords.set(key, prefix)
          }
        }
      }
    }

    // ── Assemble, stable by first appearance ──────────────────────────────────
    const out = []
    const emittedColl = new Set()
    const emittedFranchise = new Set()
    for (const it of items) {
      const cid = _collId(it)
      if (cid && collGrouped.has(it)) {
        if (emittedColl.has(cid)) continue
        emittedColl.add(cid)
        out.push({ grouped: true, kind: 'collection', name: byColl.get(cid).name, items: byColl.get(cid).items.slice() })
        continue
      }
      const fkey = franchiseOf.get(it)
      if (fkey) {
        if (emittedFranchise.has(fkey)) continue
        emittedFranchise.add(fkey)
        const members = remaining.filter(x => franchiseOf.get(x) === fkey)
        out.push({ grouped: true, kind: 'franchise', name: _titleCase(franchiseWords.get(fkey)), items: members })
        continue
      }
      out.push({ grouped: false, items: [it] })
    }
    return out
  }

  return { groupMyList }
})
