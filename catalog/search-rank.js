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

module.exports = { isJunk, sortJunkLast }
