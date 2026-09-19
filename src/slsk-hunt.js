// Hunt mode's ledger: one row per peer album with a plain-words verdict. Pure —
// takes the shelves object buildShelves already made and the library, returns
// rows. The renderer in slsk-room-ui.js only paints these.
;(function () {
  const SH = () => (typeof window !== 'undefined' && window.PapaSlskShelves) ||
    (typeof require === 'function' ? require('./slsk-shelves.js') : null)

  const VERDICT_ORDER = { upgrade: 0, surround: 0, missing: 1, same: 2, worse: 3 }

  function tierOf(a) {
    if (a.surround) return 'surround'
    if (a.isHiRes) return 'hires'
    if (a.lossless) return 'lossless'
    return 'lossy'
  }

  // The album title rides along with the folder path: two shelves entries for
  // the same folder but different records must not collapse onto one key.
  function keyOf(a) {
    return (String(a.folderPath || a.folderName || '') + '::' + String(a.album || '')).toLowerCase()
  }

  function qualityOf(a) {
    const s = SH()
    return s && s.qualityString ? s.qualityString(a) : ''
  }

  // The verdict for a matched, non-upgrade album. buildShelves has already
  // ruled out every upgrade, so the only question left is whether my copy is
  // actively better: a lossy peer copy of a record I already hold is.
  function sameOrWorse(a, lib) {
    if (!lib) return 'same'
    return a.lossless ? 'same' : 'worse'
  }

  function verdictText(row) {
    switch (row.verdictKind) {
      case 'surround': return 'surround you lack'
      case 'upgrade': {
        const u = row.album.upgrade || {}
        if (u.better != null && u.of != null) return 'upgrade · ' + u.better + '/' + u.of + ' tracks'
        return 'upgrade · all tracks'
      }
      case 'missing': return 'not in library'
      case 'worse': return 'yours is better'
      default: return 'same as yours'
    }
  }

  function buildRows(shelves, library) {
    const libById = new Map((library || []).map(l => [l.id, l]))
    const upgradeKeys = new Map((shelves.upgrades || []).map(a => [keyOf(a), a]))
    const missingKeys = new Set((shelves.missing || []).map(keyOf))
    const s = SH()
    // Built ONCE: rebuilding per row would be O(n·lib).
    const idx = s && s.buildLibraryIndex ? s.buildLibraryIndex(library || []) : null
    const rows = []
    for (const a of shelves.everything || []) {
      const key = keyOf(a)
      const up = upgradeKeys.get(key)
      let verdictKind, yours = '—', lib = null
      if (up) {
        lib = libById.get(up.matchedLibId) || null
        verdictKind = (up.upgrade && up.upgrade.kind === 'surround') ? 'surround' : 'upgrade'
        yours = (up.upgrade && up.upgrade.yours) || (lib && s ? s.qualityString(s.libAlbumToComparable(lib)) : '—')
      } else if (missingKeys.has(key)) {
        verdictKind = 'missing'
      } else {
        // Matched but not an upgrade: find my copy the same way the shelves did.
        const m = idx ? idx.findMatch(s.albumComparable(a)) : null
        lib = m && m.ref ? m.ref : null
        verdictKind = sameOrWorse(a, lib)
        yours = lib && s ? s.qualityString(s.libAlbumToComparable(lib)) : '—'
      }
      const row = { album: up || a, key, theirs: qualityOf(a), yours, verdictKind, size: a.totalSize || 0,
        year: a.year || null, title: a.album || a.folderName || '', artist: a.artist || '', tier: tierOf(a), lib }
      row.verdictText = verdictText(row)
      rows.push(row)
    }
    return rows
  }

  function sortRows(rows, key, dir) {
    const sign = dir === 'desc' ? -1 : 1
    const cmp = {
      verdict: (a, b) => (VERDICT_ORDER[a.verdictKind] ?? 9) - (VERDICT_ORDER[b.verdictKind] ?? 9),
      title:   (a, b) => String(a.title).localeCompare(String(b.title)),
      artist:  (a, b) => String(a.artist).localeCompare(String(b.artist)),
      year:    (a, b) => (a.year || 0) - (b.year || 0),
      size:    (a, b) => (a.size || 0) - (b.size || 0),
      theirs:  (a, b) => String(a.theirs).localeCompare(String(b.theirs)),
    }[key] || (() => 0)
    return rows.slice().sort((a, b) => sign * cmp(a, b) || String(a.title).localeCompare(String(b.title)))
  }

  function filterRows(rows, query) {
    const q = String(query || '').trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r => (r.title + ' ' + r.artist).toLowerCase().includes(q))
  }

  function tiles(shelves, freshCount) {
    return [
      { id: 'upgrades', n: (shelves.upgrades || []).length, label: 'upgrades over your copies' },
      { id: 'missing',  n: (shelves.missing || []).length,  label: 'albums you don\'t have' },
      { id: 'surround', n: (shelves.surround || []).length, label: 'surround mixes' },
      { id: 'new',      n: Number(freshCount) || 0,          label: 'new since last visit' },
    ]
  }

  const api = { buildRows, verdictText, sortRows, filterRows, tiles, tierOf, keyOf }
  if (typeof window !== 'undefined') window.PapaSlskHunt = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})()
