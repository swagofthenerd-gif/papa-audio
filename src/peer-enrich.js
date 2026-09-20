'use strict'
// Pure shaping of MusicBrainz and Discogs replies for the peer library. main.js
// does the HTTP; these functions decide what the UI gets to see.

// normKey/tokenScore are the project's own matching vocabulary, and the 0.6
// album bar below is the one buildLibraryIndex already uses. Importing them
// rather than re-deriving a second notion of "same album" is the whole point:
// two thresholds that drift apart are two different answers to one question.
const SH = require('./slsk-shelves.js')

// The album bar. 0.6 token overlap is what buildLibraryIndex treats as the same
// record, and both the release-group confidence and the Discogs master guard
// below answer to it.
const ALBUM_MATCH_MIN = 0.6

// The artist bar, and it is the project's own: markReleases already calls 0.34
// token overlap "the same artist" when it decides whether a library row belongs
// to this one. A candidate under it is not this artist's record — the live
// artist search for "VA" hands back "No Te Va Gustar" at score 100, which
// scores 0.25 against the name that was asked about.
const ARTIST_MATCH_MIN = 0.34
// ...and clearing that bar is not the same as being this artist. MusicBrainz
// credits the release group "Blur Licker" to "Flex Blur", which scores 0.5
// against a folder artist of "Blur" — enough to keep as a candidate, nowhere
// near enough to call the pick firm.
const ARTIST_FIRM_MIN = 0.6

function pickArtistTags(json) {
  const list = Array.isArray(json && json.artists) ? json.artists : []
  if (!list.length) return []
  const top = list.slice().sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))[0]
  return (top.tags || [])
    .filter(t => t && t.name && (Number(t.count) || 0) > 0)
    .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
    .slice(0, 8)
    .map(t => String(t.name).toLowerCase())
}

// A Discogs search result's title is "Artist - Album", so the album half is
// what the folder title should be compared against. Both forms are scored and
// the better one wins, because an album whose own name contains " - " would
// otherwise be cut in half by this.
function _discogsTitles(r) {
  const full = String((r && r.title) || '').trim()
  const at = full.indexOf(' - ')
  return at > 0 ? [full, full.slice(at + 3).trim()] : [full]
}

// Score a candidate master against the folder title, 0..1.
function _discogsTitleScore(r, want) {
  let best = 0
  for (const t of _discogsTitles(r)) {
    const s = SH.tokenScore(SH.normKey(t), SH.normKey(want))
    if (s > best) best = s
  }
  return best
}

// The master whose title is actually this record — not merely the first master
// the search returned. Taking [0] blind is how `discogs:mike oldfield::tubular
// bells` ended up cached against master 937480, "Tubular Bells II / Tubular
// Bells III", and then printed that record's pressing notes under this one's
// heading. A candidate under the 0.6 album bar is not this album, and no master
// is a better answer than the wrong master.
function pickDiscogsMaster(json, opts) {
  const list = (Array.isArray(json && json.results) ? json.results : [])
    .filter(x => x && x.type === 'master' && x.id)
  if (!list.length) return null
  const shape = r => ({
    id: r.id,
    title: _discogsTitles(r).slice(-1)[0],
    url: 'https://www.discogs.com' + String(r.uri || ('/master/' + r.id)),
  })
  const want = String((opts && opts.title) || '').trim()
  // No folder title to check against (never happens from the dossier, which
  // guards on m.title): the old behaviour, first master wins.
  if (!want) return shape(list[0])
  let best = null
  for (const r of list) {
    const s = _discogsTitleScore(r, want)
    if (s >= ALBUM_MATCH_MIN && (!best || s > best.s)) best = { s, r }
  }
  return best ? shape(best.r) : null
}

// Discogs submitter markup, out. The raw `notes` field is free text with CRLF
// runs and Discogs' own bracket vocabulary in it:
//   [url=https://…]Danube Incident[/url] → Danube Incident
//   [a=Beth Gibbons] → Beth Gibbons, [l=Go! Beat] → Go! Beat, [m=…] → its text
//   [a1234] / [b] / [i] and any other wrapper → gone
// A single line break is a wrapped sentence and becomes a space; a double break
// is the submitter's own paragraph and survives as one, so bioPreview can cut
// there.
function cleanDiscogsNotes(text) {
  let s = String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  s = s.replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1')
  s = s.replace(/\[[a-z]=([^\]]*)\]/gi, '$1')
  s = s.replace(/\[\/?[^\]\n]{0,120}\]/g, '')
  return s.split(/\n{2,}/)
    .map(p => p.replace(/\n/g, ' ').replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n')
}

// Everything the panel can use out of a Discogs master. `rating` and `count`
// are kept in the shape because the cache and the handler contract carry them,
// but nothing renders them any more: a Discogs MASTER has no community rating
// at all — verified live, /masters/5542 returns no `community` key, and all 18
// cached entries read rating:null, count:0 — so the star row was printing
// "★☆☆☆☆ — · 0 ratings" on every album ever opened.
function discogsSummary(json) {
  const c = (json && json.community && json.community.rating) || {}
  return {
    rating: c.average != null ? Math.round(Number(c.average) * 10) / 10 : null,
    count: Number(c.count) || 0,
    genres: Array.isArray(json && json.genres) ? json.genres : [],
    styles: Array.isArray(json && json.styles) ? json.styles : [],
    year: Number(json && json.year) > 0 ? Number(json.year) : null,
    masterTitle: String((json && json.title) || ''),
    notes: cleanDiscogsNotes(json && json.notes),
  }
}

// ── MusicBrainz release groups ───────────────────────────────────────────────
// The words these shapes are printed as — typeWord, formatReleaseDate — live in
// src/slsk-dossier.js beside the section that renders them. Nothing in main
// needs them, and copy belongs next to the surface that speaks it.

// Ascending by first-release-date, with a missing date sorting last.
function _cmpDate(a, b) {
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  return a < b ? -1 : a > b ? 1 : 0
}

// A year inside a REISSUE marker is not the year the record came out.
//
// "Deep Purple - Made in Japan (2014 Remaster) [FLAC]" parses to year 2014, and
// the live search for that album returns BOTH a 2014 Deep Purple EP and the
// real 1972-12 live album at score 100. Letting 2014 earn the year bonus put
// the EP first and marked it firm — a different record's date, type and
// paragraph, stated confidently. editionOf() has already lifted "2014 Remaster"
// out of the folder name, so when the folder's year is the one sitting inside
// that marker, the year is evidence of a pressing and nothing else, and the
// pick falls back to type and title.
const EDITION_MARKER = /remaster|reissue|anniversar|deluxe|edition|expanded|mono|vinyl|sacd/i
function yearIsReissue(editionNote, folderYear) {
  if (!(Number(folderYear) > 0)) return false
  const note = String(editionNote || '')
  if (!EDITION_MARKER.test(note)) return false
  return (note.match(/(?:19|20)\d{2}/g) || []).includes(String(folderYear))
}

// Every name on a candidate's artist credit, as one string. A collaboration
// carries several, and a folder naming only one of them still means this
// record.
function _creditName(rg) {
  return (Array.isArray(rg && rg['artist-credit']) ? rg['artist-credit'] : [])
    .map(c => (c && c.artist && c.artist.name) || (c && c.name) || '')
    .filter(Boolean).join(' ')
}

// How much two artist names agree, 0..1, with an absent side scoring neutral.
//
// Token overlap alone is not safe to REFUSE a record on: a folder that says
// "ACDC" scores 0 against MusicBrainz's "AC/DC", because normKey splits one
// into two tokens and not the other. Identical-once-squashed names are scored
// as the match they obviously are before the token comparison gets a say.
function artistScore(want, credit) {
  const a = SH.normKey(want), b = SH.normKey(credit)
  if (!a || !b) return 1
  if (a.replace(/ /g, '') === b.replace(/ /g, '')) return 1
  return SH.tokenScore(a, b)
}

// THE RANKING. A MusicBrainz search for `releasegroup:"Wish You Were Here" AND
// artist:"Pink Floyd"` returns four candidates ALL SCORING 100, in the order
// live-single, compilation, single, and the real 1975 album fourth. Taking [0]
// shows a different record's date, type, genres and paragraph — and states them
// confidently. So the search score decides nothing until the artist credit, the
// title, year agreement and release type have all spoken.
//
// Returns null rather than a guess when nothing clears the floors: an unmatched
// record says so, which is a fact, where a wrong match is a lie.
function pickReleaseGroup(searchJson, opts) {
  const o = opts || {}
  const want = String(o.title || '').trim()
  const wantArtist = String(o.artist || '').trim()
  const rawYear = Number(o.year) > 0 ? Number(o.year) : null
  const folderYear = yearIsReissue(o.editionNote, rawYear) ? null : rawYear
  const list = Array.isArray(searchJson && searchJson['release-groups'])
    ? searchJson['release-groups'] : []
  const cands = []
  for (const rg of list) {
    if (!rg || !rg.id) continue
    if ((Number(rg.score) || 0) < 70) continue
    const title = String(rg.title || '')
    // The title bar comes FIRST, because a candidate that isn't this record
    // can't be ranked into being it. Live proof: a folder called "Harvest"
    // came back as Neil Young's "Harvest Time" (0.5 against the folder) and
    // "Sticky Fingers" as a Spotify spoken-word edition (0.4), each described
    // as the record. 0.6 is the project's own album bar.
    const titleScore = want
      ? SH.tokenScore(SH.normKey(want), SH.normKey(title))
      : 1
    if (titleScore < ALBUM_MATCH_MIN) continue
    // And it has to be by this artist. A reply for Blur really does carry
    // "Blur Beside You", by the band Blur Beside You (0.33), and "Blur Licker",
    // credited to Flex Blur (0.5) — the first is not a candidate at all, and
    // the second can never be firm.
    const credScore = artistScore(wantArtist, _creditName(rg))
    if (credScore < ARTIST_MATCH_MIN) continue
    const date = String(rg['first-release-date'] || '')
    const rgYear = Number(String(date).slice(0, 4)) || null
    const primaryType = String(rg['primary-type'] || '')
    const secondaryTypes = (Array.isArray(rg['secondary-types']) ? rg['secondary-types'] : [])
      .map(s => String(s || '')).filter(Boolean)
    // A folder with no year in its name can't vote, so every candidate gets the
    // same middling mark and the type preference decides instead.
    const yearScore = folderYear == null
      ? 1
      : (rgYear != null && Math.abs(rgYear - folderYear) <= 1 ? 2 : 0)
    const typeScore = primaryType === 'Album'
      ? (secondaryTypes.length ? 2 : 3)
      : (primaryType === 'EP' ? 1 : 0)
    cands.push({
      id: rg.id, title, date, rgYear,
      primaryType, secondaryTypes, score: Number(rg.score) || 0,
      yearScore, typeScore, titleScore, artistScore: credScore,
    })
  }
  if (!cands.length) return null
  cands.sort((a, b) =>
    b.artistScore - a.artistScore ||
    b.yearScore - a.yearScore ||
    b.typeScore - a.typeScore ||
    b.titleScore - a.titleScore ||
    _cmpDate(a.date, b.date) ||
    b.score - a.score)
  const best = cands[0]
  // Nothing left to tell them apart. MusicBrainz holds SEVEN release groups
  // called "Weezer" by Weezer — verified live: the search reports 18 hits and
  // seven of them are self-titled studio albums, every one scoring 100. They
  // tie on artist, on title, on type and (with no year in the folder) on year,
  // so the only thing that separated them was the date tiebreak, which handed
  // back the 1994 album and called it firm. "The earliest one" is not evidence
  // about which record this folder is.
  const ties = cands.filter(c =>
    c.artistScore === best.artistScore &&
    c.yearScore === best.yearScore &&
    c.typeScore === best.typeScore &&
    c.titleScore === best.titleScore).length
  // Confidence is not about the ranking: the ranking's own type preference will
  // happily steer a folder called "Live at Leeds" onto the studio record, and
  // the panel has to be able to say so.
  const yearOk = folderYear == null ||
    (best.rgYear != null && Math.abs(best.rgYear - folderYear) <= 1)
  const artistOk = best.artistScore >= ARTIST_FIRM_MIN
  return {
    id: best.id, title: best.title, date: best.date,
    primaryType: best.primaryType, secondaryTypes: best.secondaryTypes,
    score: best.score,
    confidence: (yearOk && artistOk && ties === 1) ? 'firm' : 'loose',
  }
}

// The artist fallback, for when the album match was too loose to inherit an
// MBID. Taking artists[0] blind is how a folder whose artist parsed as "VA"
// resolved to "No Te Va Gustar" — score 100, and 0.25 against the name we
// asked about — and then headed a discography with the folder's own name. A hit
// has to clear the search floor AND actually be called this; otherwise there is
// no artist, which the panel can say.
function pickArtist(json, name) {
  const want = String(name || '').trim()
  if (!want) return null
  let best = null
  for (const a of (Array.isArray(json && json.artists) ? json.artists : [])) {
    if (!a || !a.id) continue
    if ((Number(a.score) || 0) < 70) continue
    const s = artistScore(want, a.name || '')
    if (s < ARTIST_FIRM_MIN) continue
    if (!best || s > best.s) best = { s, a }
  }
  return best ? { id: String(best.a.id), name: String(best.a.name || '') } : null
}

// Hop 2's one response carries the genres, the wikidata relation, the discogs
// relation and the artist MBID. Genres, not tags: MusicBrainz free-text tags
// carry downvoted junk at count -1 and -2 ("groundbreaking", "laut.de", "male
// vocalist"), which is why only genres with a positive count survive here.
function releaseGroupFacts(json) {
  const genres = (Array.isArray(json && json.genres) ? json.genres : [])
    .filter(g => g && g.name && (Number(g.count) || 0) > 0)
    .map(g => ({ name: String(g.name), count: Number(g.count) || 0 }))
    .sort((a, b) => b.count - a.count)
  let wikidataId = null, discogsUrl = null
  for (const r of (Array.isArray(json && json.relations) ? json.relations : [])) {
    const res = r && r.url && typeof r.url.resource === 'string' ? r.url.resource : ''
    if (!res) continue
    if (r.type === 'wikidata' && !wikidataId) {
      const m = /\/(Q\d+)(?:[#?].*)?$/.exec(res)
      if (m) wikidataId = m[1]
    }
    // openExternal refuses anything that is not https, so a relation that is
    // not https is not a link we could ever open.
    if (r.type === 'discogs' && !discogsUrl && /^https:\/\//i.test(res)) discogsUrl = res
  }
  const credit = (Array.isArray(json && json['artist-credit']) ? json['artist-credit'] : [])[0]
  return {
    title: String((json && json.title) || ''),
    date: String((json && json['first-release-date']) || ''),
    primaryType: String((json && json['primary-type']) || ''),
    secondaryTypes: (Array.isArray(json && json['secondary-types']) ? json['secondary-types'] : [])
      .map(s => String(s || '')).filter(Boolean),
    genres,
    wikidataId,
    discogsUrl,
    artistMbid: (credit && credit.artist && credit.artist.id) || null,
    artistName: (credit && credit.artist && credit.artist.name) || (credit && credit.name) || '',
  }
}

// What the artist actually MADE, out of a release-group browse. type=album
// still returns live albums, compilations and soundtracks; primary-type Album
// with an empty secondary-types array is the studio discography — verified, it
// leaves exactly Dummy / Portishead / Third out of Portishead's 49 groups.
function studioAlbums(json) {
  return (Array.isArray(json && json['release-groups']) ? json['release-groups'] : [])
    .filter(rg => rg && rg.id &&
      String(rg['primary-type'] || '') === 'Album' &&
      (Array.isArray(rg['secondary-types']) ? rg['secondary-types'] : []).length === 0)
    .map(rg => ({
      id: rg.id,
      title: String(rg.title || ''),
      date: String(rg['first-release-date'] || ''),
      primaryType: 'Album',
      secondaryTypes: [],
    }))
    .sort((a, b) => _cmpDate(a.date, b.date))
}

module.exports = {
  ALBUM_MATCH_MIN, ARTIST_MATCH_MIN, ARTIST_FIRM_MIN,
  pickArtistTags, pickDiscogsMaster, discogsSummary, cleanDiscogsNotes,
  pickReleaseGroup, yearIsReissue, artistScore, pickArtist,
  releaseGroupFacts, studioAlbums,
}
