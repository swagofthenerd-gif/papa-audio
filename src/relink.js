'use strict'
// Guided relink (roadmap 083/085): a folder moved or renamed outside the
// app leaves every saved reference — likes, history, playlists, queues —
// pointing at paths that no longer exist. Given the dead paths and the files
// found under the folder the person pointed at, pair them up by the longest
// matching tail of the path (…/Artist/Album/01.flac beats …/01.flac), so a
// whole moved tree relinks in one go and two albums with a "01.flac" each
// are never confused. Pure; tested in test/relink.test.js.
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.PapaRelink = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  function norm(p) { return String(p || '').replace(/\\/g, '/') }
  function parts(p) { return norm(p).split('/').filter(Boolean) }

  // dead: string[] of missing paths. found: string[] of existing files under
  // the new root. → { remaps: [{from,to}], unresolved: string[], ambiguous: [{from, candidates}] }
  function plan(dead, found) {
    const byTail = new Map()   // tail (last k segments joined) → [paths]
    const foundParts = (found || []).map(f => ({ path: f, parts: parts(f) }))
    const MAXK = 6
    for (const f of foundParts) {
      for (let k = 1; k <= Math.min(MAXK, f.parts.length); k++) {
        const tail = f.parts.slice(-k).join('/').toLowerCase()
        if (!byTail.has(tail)) byTail.set(tail, [])
        byTail.get(tail).push(f.path)
      }
    }
    const remaps = [], unresolved = [], ambiguous = []
    const taken = new Set()
    for (const from of dead || []) {
      const dp = parts(from)
      let hit = null, cands = null
      // Longest tail first: the most specific match wins.
      for (let k = Math.min(MAXK, dp.length); k >= 1; k--) {
        const tail = dp.slice(-k).join('/').toLowerCase()
        const c = (byTail.get(tail) || []).filter(p => !taken.has(p))
        if (c.length === 1) { hit = c[0]; break }
        if (c.length > 1) { cands = c; break }   // more specific would have been unique; ambiguous here
      }
      if (hit) { remaps.push({ from, to: hit }); taken.add(hit) }
      else if (cands) ambiguous.push({ from, candidates: cands.slice(0, 5) })
      else unresolved.push(from)
    }
    return { remaps, unresolved, ambiguous }
  }

  function describe(p) {
    const n = p.remaps.length, u = p.unresolved.length, a = p.ambiguous.length
    const bits = [n + ' file' + (n === 1 ? '' : 's') + ' matched']
    if (a) bits.push(a + ' ambiguous (left alone)')
    if (u) bits.push(u + ' not found')
    return bits.join(' · ')
  }

  return { plan, describe }
})
