// Wander mode's shelves: the collection as music, not as file quality. Pure.
;(function () {
  const GENRES = ['rock', 'jazz', 'electronic', 'classical', 'hip hop', 'hip-hop', 'rap', 'metal', 'folk',
    'soul', 'funk', 'blues', 'pop', 'punk', 'reggae', 'country', 'ambient', 'techno', 'house', 'soundtrack',
    'ost', 'indie', 'world', 'latin', 'r&b', 'rnb', 'prog', 'psychedelic', 'disco', 'dance', 'experimental']

  // Fewest dated albums that can speak for a collection's decade.
  const MIN_DATED = 3

  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() }
  function albumKey(a) { return norm(a.artist) + '::' + norm(a.album) }

  function goDeep(albums, ownsFn, min) {
    const by = new Map()
    for (const a of albums || []) {
      const k = norm(a.artist)
      if (!k) continue
      if (!by.has(k)) by.set(k, { artist: a.artist, count: 0, lacking: 0, albums: [] })
      const e = by.get(k)
      e.count++; e.albums.push(a)
      if (!ownsFn || !ownsFn(a)) e.lacking++
    }
    return [...by.values()].filter(e => e.count >= (min || 8)).sort((x, y) => y.count - x.count)
  }

  function decadeShelf(albums) {
    const dated = (albums || []).filter(a => Number(a.year) >= 1900)
    // Under three dated albums a "decade" is an accident, not a shelf.
    if (dated.length < MIN_DATED) return null
    const by = new Map()
    for (const a of dated) { const d = Math.floor(a.year / 10) * 10; by.set(d, (by.get(d) || []).concat(a)) }
    let best = null
    for (const [decade, list] of by) if (!best || list.length > best.albums.length) best = { decade, albums: list }
    best.share = Math.round(best.albums.length / dated.length * 100)
    return best
  }

  function onlyHere(albums, otherPeersAlbums) {
    const peers = (otherPeersAlbums || []).filter(Array.isArray)
    if (peers.length < 3) return null
    const seen = new Set()
    for (const list of peers) for (const a of list) seen.add(albumKey(a))
    return { peersChecked: peers.length, albums: (albums || []).filter(a => !seen.has(albumKey(a))) }
  }

  function becauseYouOwn(albums, seeds, tagsByArtist) {
    const tags = k => new Set((tagsByArtist && tagsByArtist[norm(k)]) || [])
    const out = []
    for (const seed of seeds || []) {
      const st = tags(seed.artist)
      if (st.size < 2) continue
      const members = (albums || []).filter(a => {
        if (norm(a.artist) === norm(seed.artist)) return false
        let shared = 0
        for (const t of tags(a.artist)) if (st.has(t)) shared++
        return shared >= 2
      })
      if (members.length) out.push({ seed, albums: members })
    }
    return out
  }

  function characterLine(tree, albums) {
    const dirs = tree && tree.dirs && typeof tree.dirs.values === 'function' ? [...tree.dirs.values()] : []
    const genres = dirs
      .map(d => ({ name: norm(d.name), files: d.fileCount || 0 }))
      .filter(d => GENRES.includes(d.name))
      .sort((a, b) => b.files - a.files)
      .slice(0, 2)
      .map(d => d.name)
    const dec = decadeShelf(albums)
    const decWord = dec ? String(dec.decade).slice(2) + 's ' : ''
    if (genres.length) {
      const g = genres.length === 2 ? genres[0] + ' and ' + genres[1] : genres[0]
      return 'A ' + decWord + g + ' collector'
    }
    const n = (albums || []).length
    return n + ' album' + (n === 1 ? '' : 's')
  }

  const api = { goDeep, decadeShelf, onlyHere, becauseYouOwn, characterLine, albumKey, norm }
  if (typeof window !== 'undefined') window.PapaSlskWander = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})()
