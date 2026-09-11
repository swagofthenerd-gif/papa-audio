'use strict'
// Release names, read for what they say (video plan V2.2): the group that made
// the file, the resolution, whether it is a batch or season pack. Two families:
//   fansub   [SubsPlease] Frieren - 01 (1080p) [ABCD1234].mkv
//   scene    Frieren.S01E01.1080p.WEB.H264-VARYG.mkv
// Pure; tested in test/release-name.test.js. The renderer shows the group as a
// badge and remembers the last-chosen group per show, so the second episode
// does not ask again.
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.PapaReleaseName = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  const RES = /\b(2160p|1080p|720p|480p|4k|uhd)\b/i
  const BATCH = /\b(batch|complete|season\s*\d+|s\d{2}(?!e\d)|\d{2,3}\s*-\s*\d{2,3}\b|all episodes)/i
  // Bracketed tags that are not groups: hashes, codecs, sources, languages.
  const NOT_GROUP = /^(?:[0-9a-f]{8}|\d{3,4}p|x26[45]|h\.?26[45]|hevc|av1|aac|flac|opus|ac3|eac3|dual[- ]?audio|multi(?:ple)?[- ]?subs?|web(?:-?dl|rip)?|bd(?:rip)?|blu-?ray|hdtv|dvd(?:rip)?|10[- ]?bit|8[- ]?bit|hi10p|eng|jpn|jap|ja|en|raw|uncensored|censored|ncop|nced|hdr|sdr|dts|truehd)$/i

  function _s(v) { return typeof v === 'string' ? v.trim() : '' }

  function group(name) {
    const t = _s(name)
    if (!t) return ''
    // Fansub: the first bracketed tag that is not a codec/hash/etc.
    const tags = []
    const re = /\[([^\]]{1,40})\]/g
    let m
    while ((m = re.exec(t))) tags.push(m[1].trim())
    for (const tag of tags) if (tag && !NOT_GROUP.test(tag) && !/^\d+$/.test(tag)) return tag
    // Scene: the "-GROUP" tail before the extension.
    const base = t.replace(/\.(mkv|mp4|avi|torrent)$/i, '')
    const tail = /-([A-Za-z0-9]{2,20})(?:\[[^\]]*\])?$/.exec(base)
    if (tail && !NOT_GROUP.test(tail[1]) && !/^\d+$/.test(tail[1]) && !RES.test(tail[1])) return tail[1]
    return ''
  }

  function resolution(name) {
    const m = RES.exec(_s(name))
    if (!m) return ''
    const r = m[1].toLowerCase()
    return r === '4k' || r === 'uhd' ? '2160p' : r
  }

  function isBatch(name) { return BATCH.test(_s(name)) }

  // Does this release name plausibly belong to the requested title? The
  // request carries the display title and any known variants (TMDB's
  // original name, AniList's english/romaji/native). A variant matches when
  // every one of its words appears in the release name; a one- or two-letter
  // title ("X", "It") must also show an episode/season marker (series) or a
  // year (film), or "Logic Pro X" would pass for the anime "X". A source
  // with no release name cannot be judged and is let through.
  const MARKER = /\b(s\d{1,2}e\d{1,3}|e\d{1,3}|ep\.?\s*\d{1,3}|episode\s*\d{1,3}|season\s*\d{1,2}|s\d{2}\b|\d{1,3}v\d|batch|complete)\b|\s-\s\d{1,3}\b|\(tv\)/i
  function _words(str) {
    return String(str || '').toLowerCase().replace(/['’]s\b/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean)
  }
  function _variants(req) {
    const out = []
    const push = function (t) { if (typeof t === 'string' && t.trim()) out.push(t.trim()) }
    push(req && req.title)
    push(req && req.originalName)
    const ts = req && req.titles
    if (ts && typeof ts === 'object') { push(ts.english); push(ts.romaji); push(ts.native); push(ts.en); push(ts.en_jp) }
    // The part before a colon or a dash is a title of its own ("Frieren").
    for (const t of out.slice()) { const m = /^(.{3,}?)\s*[:\u2013\u2014-]\s+.+$/.exec(t); if (m) push(m[1]) }
    return Array.from(new Set(out))
  }
  function plausible(req, releaseName) {
    const name = String(releaseName || '')
    if (!name.trim()) return true
    const rel = _words(name)
    const relSet = new Set(rel)
    const relJoined = ' ' + rel.join(' ') + ' '
    const isFilm = req && req.type === 'movie'
    for (const v of _variants(req)) {
      const w = _words(v)
      if (!w.length) continue
      const short = w.length === 1 && w[0].length <= 2
      // Multi-word titles: every word of two letters or more must appear, in
      // order somewhere in the name (so "Two Dune" is not "Dune Part Two").
      const need = w.filter(function (x) { return x.length >= 2 || w.length === 1 })
      if (!need.length) continue
      if (need.length > 1) {
        if (relJoined.indexOf(' ' + need.join(' ') + ' ') !== -1) return true
        if (need.every(function (x) { return relSet.has(x) })) return true
        continue
      }
      if (!relSet.has(need[0])) continue
      if (!short) return true
      // A one- or two-letter title must be the first word once the leading
      // group tags are gone ("X (TV) - 01", "It.2017"), not a connector in
      // the middle ("Kateikyoushi x Saimin", "Logic Pro X").
      const lead = _words(name.replace(/^(\s*\[[^\]]*\]\s*)+/, ''))[0]
      if (lead !== need[0]) continue
      if (isFilm ? /\b(19|20)\d{2}\b/.test(name) : MARKER.test(name)) return true
    }
    return false
  }

  function parse(name) {
    return { group: group(name), resolution: resolution(name), batch: isBatch(name), title: _s(name) }
  }

  return { parse, group, resolution, isBatch, plausible }
})
