'use strict';
// Track-by-track comparison of a peer's album against my copy. Pure: takes the
// peer's file list (slskd shape: filename, size, bitDepth, sampleRate, bitRate,
// length) and my library album's tracks (library-cache shape), returns rows a
// drawer can paint and one honest verdict line. Pairing is by track number
// first, then by cleaned title, then by position — never by size or duration,
// which is exactly what differs between two rips of one album.
(function () {
  const AUDIO_RE = /\.(flac|wav|aiff?|ape|wv|alac|mp3|m4a|aac|ogg|opus|wma|dsf|dff)$/i
  const LOSSLESS_RE = /\.(flac|wav|aiff?|ape|wv|alac|dsf|dff)$/i

  function baseName(p) { return String(p || '').split(/[\\/]/).pop() }
  function trackNumOf(name) {
    const m = baseName(name).match(/^\s*(\d{1,3})(?=[\s._)\-]|$)/)
    if (!m) return null
    const n = parseInt(m[1], 10)
    return n >= 1 && n <= 999 ? n : null
  }
  function normTitle(s) {
    return String(s || '').toLowerCase()
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/^\s*\d{1,3}\s*[\s._)\-]+\s*/, '')
      .replace(/[\[(].*?[\])]/g, '')
      .replace(/[^a-z0-9]+/g, ' ').trim()
  }
  function fmtOf(name) {
    const ext = (baseName(name).match(/\.([a-z0-9]+)$/i) || [, ''])[1].toUpperCase()
    return ext || '?'
  }

  // A quality tuple: lossless first, then depth, then rate, then bitrate for lossy.
  function qualityOf(t) {
    return {
      lossless: !!t.lossless,
      bd: Number(t.bitDepth) || 0,
      sr: Number(t.sampleRate) || 0,
      kbps: Number(t.bitRate) || 0,
    }
  }
  // Positive: theirs better; negative: mine better; 0: same. Unknown fields are
  // treated as equal so a missing tag never manufactures a verdict.
  function cmpQuality(theirs, mine) {
    const a = qualityOf(theirs), b = qualityOf(mine)
    if (a.lossless !== b.lossless) return a.lossless ? 1 : -1
    if (a.lossless) {
      if (a.bd && b.bd && a.bd !== b.bd) return a.bd > b.bd ? 1 : -1
      if (a.sr && b.sr && a.sr !== b.sr) return a.sr > b.sr ? 1 : -1
      return 0
    }
    if (a.kbps && b.kbps && a.kbps !== b.kbps) return a.kbps > b.kbps ? 1 : -1
    return 0
  }

  function peerTrack(f) {
    const name = f.filename || f.name || ''
    return {
      side: 'theirs', title: normTitle(baseName(name)) || baseName(name), rawTitle: baseName(name).replace(/\.[a-z0-9]+$/i, ''),
      n: trackNumOf(name), fmt: fmtOf(name), lossless: !!f.isFlac || LOSSLESS_RE.test(name),
      bitDepth: f.bitDepth, sampleRate: f.sampleRate, bitRate: f.bitRate,
      duration: Number(f.length) || Number(f.duration) || 0, size: Number(f.size) || 0,
    }
  }
  function myTrack(t) {
    const name = t.filePath || ''
    return {
      side: 'mine', title: normTitle(t.title || name) || baseName(name), rawTitle: t.title || baseName(name),
      n: Number(t.trackNumber) || trackNumOf(name), fmt: (t.codec || fmtOf(name)).toUpperCase(),
      lossless: LOSSLESS_RE.test(name) || /flac|alac|wav|aiff|ape/i.test(t.codec || ''),
      bitDepth: t.bitsPerSample, sampleRate: t.sampleRate, bitRate: t.bitrate,
      duration: Number(t.duration) || 0, size: Number(t.fileSize) || 0,
    }
  }

  function compareAlbums(peerFiles, myTracks) {
    const theirs = (Array.isArray(peerFiles) ? peerFiles : [])
      .filter(f => AUDIO_RE.test(f.filename || f.name || '')).map(peerTrack)
    const mine = (Array.isArray(myTracks) ? myTracks : []).map(myTrack)
    const usedMine = new Set()
    const pairs = []
    // 1. by track number
    for (const t of theirs) {
      if (t.n == null) continue
      const i = mine.findIndex((m, idx) => !usedMine.has(idx) && m.n === t.n)
      if (i >= 0) { usedMine.add(i); pairs.push([t, mine[i]]) } else pairs.push([t, null])
    }
    // 2. by title for the un-numbered
    for (const t of theirs) {
      if (t.n != null) continue
      const i = mine.findIndex((m, idx) => !usedMine.has(idx) && m.title && m.title === t.title)
      if (i >= 0) { usedMine.add(i); pairs.push([t, mine[i]]) } else pairs.push([t, null])
    }
    // 3. leftovers on my side
    mine.forEach((m, idx) => { if (!usedMine.has(idx)) pairs.push([null, m]) })
    pairs.sort((a, b) => ((a[0] || a[1]).n || 999) - ((b[0] || b[1]).n || 999))

    let better = 0, same = 0, worse = 0
    const rows = pairs.map(([t, m]) => {
      let verdict
      if (!t) verdict = 'only-mine'
      else if (!m) verdict = 'only-theirs'
      else { const c = cmpQuality(t, m); verdict = c > 0 ? 'better' : c < 0 ? 'worse' : 'same'; if (c > 0) better++; else if (c < 0) worse++; else same++ }
      return { n: (t || m).n, theirs: t, mine: m, verdict }
    })
    const countsMatch = theirs.length === mine.length
    const summary = {
      theirsCount: theirs.length, mineCount: mine.length, countsMatch, better, same, worse,
      onlyTheirs: rows.filter(r => r.verdict === 'only-theirs').length,
      onlyMine: rows.filter(r => r.verdict === 'only-mine').length,
    }
    summary.line = verdictLine(summary)
    // Replace is safe only when whole and equal in count and not worse anywhere.
    summary.replaceOk = countsMatch && worse === 0 && summary.onlyMine === 0 && better > 0
    return { rows, summary }
  }

  function verdictLine(s) {
    const paired = s.better + s.same + s.worse
    const parts = []
    if (!s.countsMatch) parts.push(`${s.theirsCount} track${s.theirsCount === 1 ? '' : 's'} vs your ${s.mineCount} — not a straight swap`)
    if (paired === 0) parts.push('no tracks could be matched to yours')
    else if (s.worse === 0 && s.better === paired) parts.push(`better on all ${paired} matched track${paired === 1 ? '' : 's'}`)
    else if (s.better === 0 && s.worse === 0) parts.push(`same quality on all ${paired} matched`)
    else parts.push(`better on ${s.better}, same on ${s.same}, worse on ${s.worse}`)
    if (s.onlyTheirs) parts.push(`${s.onlyTheirs} only in theirs`)
    if (s.onlyMine) parts.push(`${s.onlyMine} only in yours`)
    return parts.join(' · ')
  }

  const api = { compareAlbums, cmpQuality, trackNumOf, normTitle }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (typeof window !== 'undefined') window.PapaSlskCompare = api
})()
