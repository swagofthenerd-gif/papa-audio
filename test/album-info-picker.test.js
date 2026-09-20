'use strict'
// The release picker, and the words the panel builds out of what it picks.
//
// The fixtures in test/fixtures/album-info/ are SAVED LIVE RESPONSES, not
// hand-written shapes. That matters most for the Pink Floyd search: the four
// candidates really do all score 100, and the real 1975 album really is fourth
// in the list MusicBrainz returns. A hand-written fixture would have been
// written by someone who already knew the answer.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const E = require('../src/peer-enrich')
// typeWord and formatReleaseDate live beside the section that renders them.
const D = require('../src/slsk-dossier')

const fixture = n => JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'album-info', n), 'utf8'))

const WYWH_SEARCH = fixture('mb-release-group-search-wywh.json')
const WYWH_DETAIL = fixture('mb-release-group-wywh.json')
const PORTISHEAD_RGS = fixture('mb-release-groups-portishead.json')
const MADE_IN_JAPAN = fixture('mb-release-group-search-made-in-japan.json')
const WEEZER = fixture('mb-release-group-search-weezer.json')
const HARVEST = fixture('mb-release-group-search-harvest.json')
const STICKY = fixture('mb-release-group-search-sticky-fingers.json')
const BLUR = fixture('mb-release-group-search-blur.json')
const SWIFT_1989 = fixture('mb-release-group-search-1989.json')
const VA_ARTISTS = fixture('mb-artist-search-va.json')

// The folder is where every one of these lookups starts, so the tests below
// take the same route the app does: the real folder name, through the real
// parser and the real edition reader, into the picker.
const SH = require('../src/slsk-shelves')
function fromFolder(folderName) {
  const p = SH.parseAlbumFolder([folderName])
  return { title: p.album, artist: p.artist, year: p.year, editionNote: D.editionOf(folderName) }
}

// ── pickReleaseGroup ─────────────────────────────────────────────────────────

test('the live Wish You Were Here search has four candidates, all scoring 100', () => {
  // The premise of the whole picker. If MusicBrainz ever starts ranking this
  // sensibly the test below stops proving anything, so the premise is pinned
  // separately and will be the thing that goes red.
  const rgs = WYWH_SEARCH['release-groups']
  const hundreds = rgs.filter(r => r.score === 100)
  assert.equal(hundreds.length, 4, 'four candidates tie on search score')
  assert.equal(rgs[0]['primary-type'] + '/' + (rgs[0]['secondary-types'] || []).join(','),
    'Album/Compilation', 'the compilation is what [0] would hand you')
  assert.equal(rgs[3]['first-release-date'], '1975-09-12',
    'the real album is fourth in the list')
})

test('pickReleaseGroup takes the 1975 studio album, not the first result', () => {
  const p = E.pickReleaseGroup(WYWH_SEARCH, { title: 'Wish You Were Here', year: 1975 })
  assert.equal(p.date, '1975-09-12')
  assert.equal(p.id, WYWH_SEARCH['release-groups'][3].id)
  assert.equal(p.primaryType, 'Album')
  assert.deepEqual(p.secondaryTypes, [])
  assert.equal(p.confidence, 'firm')
})

test('with no year in the folder name, the release type still picks the album', () => {
  // A folder called just "Pink Floyd - Wish You Were Here" gives the picker no
  // year to agree with, so every candidate ties on yearScore and typeScore is
  // the only thing left holding the compilation and the two singles off.
  const p = E.pickReleaseGroup(WYWH_SEARCH, { title: 'Wish You Were Here' })
  assert.equal(p.date, '1975-09-12')
  assert.equal(p.confidence, 'firm')
})

test('year agreement outranks release type', () => {
  // A live album from the folder's own year beats a studio album from a
  // different decade: the folder said 1970, and it meant it.
  const json = {
    'release-groups': [
      { id: 'studio', title: 'Live at Leeds', score: 100, 'first-release-date': '1965-01-01', 'primary-type': 'Album', 'secondary-types': [] },
      { id: 'live', title: 'Live at Leeds', score: 100, 'first-release-date': '1970-05-16', 'primary-type': 'Album', 'secondary-types': ['Live'] },
    ],
  }
  const p = E.pickReleaseGroup(json, { title: 'Live at Leeds', year: 1970 })
  assert.equal(p.id, 'live')
  assert.equal(p.confidence, 'firm')
  assert.equal(D.typeWord(p.primaryType, p.secondaryTypes), 'Live album')
})

test('a one-year gap still counts as agreement', () => {
  const json = {
    'release-groups': [
      { id: 'far', title: 'Kid A', score: 100, 'first-release-date': '1994', 'primary-type': 'Album', 'secondary-types': [] },
      { id: 'near', title: 'Kid A', score: 90, 'first-release-date': '2001', 'primary-type': 'Album', 'secondary-types': [] },
    ],
  }
  assert.equal(E.pickReleaseGroup(json, { title: 'Kid A', year: 2000 }).id, 'near')
})

test('a title under the 0.6 album bar is not an answer at all', () => {
  // This USED to come back as the record with a hedge under it, and the hedge
  // was not enough: a folder called "Harvest" was answered with Neil Young's
  // "Harvest Time" (0.5 against the folder) and "Sticky Fingers" with a Spotify
  // spoken-word edition (0.4), each given the record's heading, date and
  // paragraph. Nothing is a better answer than a near-miss.
  const json = {
    'release-groups': [
      { id: 'x', title: 'The Dark Side of the Moon', score: 88, 'first-release-date': '1973-03-01', 'primary-type': 'Album', 'secondary-types': [] },
    ],
  }
  assert.equal(E.pickReleaseGroup(json, { title: 'Animals' }), null)
})

test('a title that matches but a year that does not is loose', () => {
  // The self-titled trap: the words agree perfectly and the record does not.
  const json = {
    'release-groups': [
      { id: 'x', title: 'Weezer', score: 100, 'first-release-date': '1994-05-10', 'primary-type': 'Album', 'secondary-types': [] },
    ],
  }
  assert.equal(E.pickReleaseGroup(json, { title: 'Weezer', year: 2001 }).confidence, 'loose')
})

test('nothing above the score floor returns null rather than a guess', () => {
  const json = { 'release-groups': [{ id: 'junk', title: 'Whatever', score: 42, 'primary-type': 'Album' }] }
  assert.equal(E.pickReleaseGroup(json, { title: 'Dummy' }), null)
  assert.equal(E.pickReleaseGroup({}, { title: 'Dummy' }), null)
  assert.equal(E.pickReleaseGroup(null, { title: 'Dummy' }), null)
})

test('on a tie the earliest release date wins, missing dates last', () => {
  const json = {
    'release-groups': [
      { id: 'undated', title: 'Dummy', score: 100, 'primary-type': 'Album', 'secondary-types': [] },
      { id: 'late', title: 'Dummy', score: 100, 'first-release-date': '2008-01-01', 'primary-type': 'Album', 'secondary-types': [] },
      { id: 'first', title: 'Dummy', score: 100, 'first-release-date': '1994-08-22', 'primary-type': 'Album', 'secondary-types': [] },
    ],
  }
  assert.equal(E.pickReleaseGroup(json, { title: 'Dummy' }).id, 'first')
})

// ── a reissue year is not a release year ─────────────────────────────────────

test('the live Made in Japan search really does tie a 2014 EP with the 1972 album', () => {
  // The premise. Both score 100; one of them is a four-track EP MusicBrainz
  // filed under 2014, the other is the record everybody means.
  const rgs = MADE_IN_JAPAN['release-groups']
  const ep = rgs.find(r => r['primary-type'] === 'EP')
  const live = rgs.find(r => (r['secondary-types'] || []).includes('Live') && r.title === 'Made in Japan')
  assert.equal(ep.score, 100)
  assert.equal(ep['first-release-date'], '2014')
  assert.equal(live.score, 100)
  assert.equal(live['first-release-date'], '1972-12')
})

test('a remaster year in the folder name does not pick the record', () => {
  // "Deep Purple - Made in Japan (2014 Remaster) [FLAC]" parses to year 2014,
  // and 2014 is the year of the EP, not of the album. Reading the edition note
  // — which was threaded all the way from the dossier and never once read —
  // takes the year out of the vote and leaves type and title to decide.
  const opts = fromFolder('Deep Purple - Made in Japan (2014 Remaster) [FLAC]')
  assert.equal(opts.year, 2014, 'the folder really does parse to the reissue year')
  assert.equal(opts.editionNote, '2014 Remaster')
  const p = E.pickReleaseGroup(MADE_IN_JAPAN, opts)
  assert.equal(p.date, '1972-12')
  assert.deepEqual(p.secondaryTypes, ['Live'])
  assert.equal(p.confidence, 'firm')

  // And the year signal is still real when the year is not a pressing note:
  // drop the edition note and 2014 votes again, which is what shipped.
  const blind = E.pickReleaseGroup(MADE_IN_JAPAN, { ...opts, editionNote: '' })
  assert.equal(blind.primaryType, 'EP', 'this is the wrong record the fix removes')
})

test('yearIsReissue wants the marker AND that year, not one or the other', () => {
  assert.equal(E.yearIsReissue('2014 Remaster', 2014), true)
  assert.equal(E.yearIsReissue('2015 Deluxe Edition', 2015), true)
  assert.equal(E.yearIsReissue('50th Anniversary Edition', 1972), false, 'no year in the marker')
  assert.equal(E.yearIsReissue('2014 Remaster', 1972), false,
    '"Deep Purple - 1972 - Made in Japan (2014 Remaster)" still knows its year')
  assert.equal(E.yearIsReissue('Japan', 2014), false, 'a pressing country is not a reissue marker')
  assert.equal(E.yearIsReissue('', 1972), false)
  assert.equal(E.yearIsReissue('2014 Remaster', null), false)
})

test('a deluxe-edition year does not hand back a spoken-word release', () => {
  // The live reply for Sticky Fingers carries a "Spotify Landmark edition"
  // filed as Album/Spokenword in 2015 — the folder's own edition year.
  const opts = fromFolder('The Rolling Stones - Sticky Fingers (2015 Deluxe Edition)')
  assert.equal(opts.year, 2015)
  const p = E.pickReleaseGroup(STICKY, opts)
  assert.equal(p.date, '1971-04-23')
  assert.deepEqual(p.secondaryTypes, [])
  assert.equal(p.confidence, 'firm')
})

// ── a near-miss title is not the record ──────────────────────────────────────

test('Harvest does not come back as Harvest Time', () => {
  const p = E.pickReleaseGroup(HARVEST, fromFolder('Neil Young - Harvest (2022 Remaster)'))
  assert.equal(p.title, 'Harvest')
  assert.equal(p.date, '1972-02-14')
  assert.equal(p.confidence, 'firm')
})

test('with only near-misses left, the answer is nothing', () => {
  // The same live reply with the one exact title removed: Harvest Moon, Harvest
  // Time, Harvest Live and a two-album twofer all survive the score floor and
  // not one of them is this record.
  const thin = { 'release-groups': HARVEST['release-groups'].filter(r => r.title !== 'Harvest') }
  assert.ok(thin['release-groups'].length >= 4, 'there is still plenty to choose wrongly from')
  assert.equal(E.pickReleaseGroup(thin, fromFolder('Neil Young - Harvest (2022 Remaster)')), null)
})

// ── seven records with the same name ─────────────────────────────────────────

test('MusicBrainz really does hold seven self-titled Weezer albums, all at 100', () => {
  const rgs = WEEZER['release-groups']
  assert.equal(WEEZER.count, 18, 'and eighteen hits in all')
  const selfTitled = rgs.filter(r => r.title === 'Weezer' &&
    r['primary-type'] === 'Album' && !(r['secondary-types'] || []).length)
  assert.equal(selfTitled.length, 7)
  assert.ok(selfTitled.every(r => r.score === 100), 'nothing in the reply tells them apart')
  assert.equal(rgs.slice(0, 5).filter(r => r.title === 'Weezer').length, 5,
    'a five-wide window cannot even see two of the seven')
})

test('a self-titled album with nothing to tell the candidates apart is never firm', () => {
  const opts = fromFolder('Weezer - Weezer')
  assert.equal(opts.year, null, 'the folder gives the picker no year to work with')
  const p = E.pickReleaseGroup(WEEZER, opts)
  assert.ok(p, 'the best of them is still offered')
  assert.equal(p.title, 'Weezer')
  assert.equal(p.confidence, 'loose', 'seven records answer to this folder name')
})

test('a folder that DOES say which year gets a firm answer', () => {
  // The hedge is about ambiguity, not about self-titled albums: name the year
  // and one of the seven is the record.
  const p = E.pickReleaseGroup(WEEZER, fromFolder('Weezer - Weezer (2008)'))
  assert.equal(p.date, '2008-06-03')
  assert.equal(p.confidence, 'firm')
})

// ── the artist credit ────────────────────────────────────────────────────────

test('a reply for Blur carries Blur Licker, by Flex Blur', () => {
  const licker = BLUR['release-groups'].find(r => r.title === 'Blur Licker')
  assert.equal(licker['artist-credit'][0].name, 'Flex Blur')
  assert.equal(licker['primary-type'], 'Album')
  assert.ok(licker.score >= 70, 'it clears the score floor on its own')
})

test('a candidate by another band is refused even when its title matches', () => {
  // "Blur Beside You" is a different band, and the reply carries their album.
  // Titled exactly what the folder says, an Album with no secondary types, over
  // the score floor: the artist credit is the only thing between it and the
  // panel's heading.
  const other = BLUR['release-groups'].find(r => r.title === 'Blur Beside You')
  assert.equal(other['artist-credit'][0].name, 'Blur Beside You')
  const only = { 'release-groups': [other] }
  assert.equal(E.pickReleaseGroup(only, { title: 'Blur Beside You', artist: 'Blur' }), null)
  assert.ok(E.pickReleaseGroup(only, { title: 'Blur Beside You', artist: 'Blur Beside You' }),
    'and that band can still look up their own record')
})

test('a half-matching artist credit can never be firm', () => {
  // "Flex Blur" scores 0.5 against a folder artist of "Blur" — too close to
  // throw away, nowhere near close enough to state as fact.
  const licker = BLUR['release-groups'].find(r => r.title === 'Blur Licker')
  const only = { 'release-groups': [licker] }
  assert.equal(E.pickReleaseGroup(only, { title: 'Blur Licker', artist: 'Blur' }).confidence, 'loose')
  assert.equal(E.pickReleaseGroup(only, { title: 'Blur Licker', artist: 'Flex Blur' }).confidence, 'firm')
})

test('artistScore reads a punctuation difference as the same artist', () => {
  // The bar refuses records, so it must not refuse one over a slash: token
  // overlap alone scores "ACDC" against "AC/DC" at zero.
  assert.equal(E.artistScore('ACDC', 'AC/DC'), 1)
  assert.equal(E.artistScore("Guns N Roses", "Guns N' Roses"), 1)
  assert.equal(E.artistScore('Beatles', 'The Beatles'), 1)
  assert.equal(E.artistScore('Blur', 'Flex Blur'), 0.5)
  assert.equal(E.artistScore('', 'Anyone At All'), 1, 'an absent side cannot refuse anything')
})

test('Blur by Blur is what a folder called Blur gets', () => {
  const p = E.pickReleaseGroup(BLUR, fromFolder('Blur - Blur'))
  assert.equal(p.title, 'Blur')
  assert.equal(p.date, '1997-01-29')
  assert.equal(p.confidence, 'firm')
})

// ── an album whose title is a year ───────────────────────────────────────────

test('an album named after a year keeps its name and gets a firm answer', () => {
  // "Taylor Swift\1989" used to parse to an empty album, and when the title did
  // survive, the 1989 read off it was handed over as the release year — against
  // a record MusicBrainz dates to 2014. The lookup found the right album and
  // then told him it might be the wrong one.
  const folder = fromFolder('Taylor Swift - 1989')
  assert.equal(folder.title, '1989')
  assert.equal(folder.year, null, 'the digits are the name of the record, not a date')
  const p = E.pickReleaseGroup(SWIFT_1989, folder)
  assert.equal(p.title, '1989')
  assert.equal(p.date, '2014-10-24')
  assert.equal(p.confidence, 'firm')
})

test('and the same album with its real year in the folder still lands firm', () => {
  const folder = fromFolder('Taylor Swift - 1989 (2014)')
  assert.equal(folder.title, '1989')
  assert.equal(folder.year, 2014)
  const p = E.pickReleaseGroup(SWIFT_1989, folder)
  assert.equal(p.date, '2014-10-24')
  assert.equal(p.confidence, 'firm')
})

// ── pickArtist ───────────────────────────────────────────────────────────────

test('the artist fallback will not hand back a band that is not the one asked for', () => {
  // The live search for "VA" puts "No Te Va Gustar" first, at score 100. Taking
  // artists[0] blind printed that band's catalogue under a heading reading
  // "More by VA".
  assert.equal(VA_ARTISTS.artists[0].name, 'No Te Va Gustar')
  assert.equal(VA_ARTISTS.artists[0].score, 100)
  const got = E.pickArtist(VA_ARTISTS, 'VA')
  assert.ok(!got || got.name !== 'No Te Va Gustar', 'never the wrong band')
  if (got) assert.equal(got.name.toLowerCase().replace(/[^a-z0-9]/g, ''), 'va',
    'and whatever comes back is actually called this')
  // Half the words in common is not the same band, however well it scores.
  assert.equal(E.pickArtist(VA_ARTISTS, 'Va Gustar Nobody'), null)
})

test('pickArtist wants the score floor as well as the name', () => {
  const low = { artists: [{ id: 'a', name: 'Portishead', score: 40 }] }
  assert.equal(E.pickArtist(low, 'Portishead'), null)
  const good = { artists: [{ id: 'a', name: 'Portishead', score: 100 }] }
  assert.equal(E.pickArtist(good, 'Portishead').id, 'a')
  assert.equal(E.pickArtist({ artists: [] }, 'Portishead'), null)
  assert.equal(E.pickArtist(null, 'Portishead'), null)
  assert.equal(E.pickArtist(good, ''), null)
})

// ── typeWord ─────────────────────────────────────────────────────────────────

test('typeWord: an empty secondary-types array is what makes it a studio album', () => {
  assert.equal(D.typeWord('Album', []), 'Studio album')
  assert.equal(D.typeWord('Album', ['Live']), 'Live album')
  assert.equal(D.typeWord('Album', ['Compilation']), 'Compilation')
  assert.equal(D.typeWord('Album', ['Soundtrack']), 'Soundtrack')
  assert.equal(D.typeWord('Album', ['Remix']), 'Remix album')
  assert.equal(D.typeWord('Album', ['Demo']), 'Demo')
  assert.equal(D.typeWord('Album', ['Mixtape/Street']), 'Mixtape')
  assert.equal(D.typeWord('Album', ['DJ-mix']), 'DJ mix')
})

test('typeWord: two secondary types join, and the primary type is the fallback', () => {
  assert.equal(D.typeWord('Album', ['Live', 'Compilation']), 'Live album · Compilation')
  assert.equal(D.typeWord('EP', []), 'EP')
  assert.equal(D.typeWord('Single', []), 'Single')
  assert.equal(D.typeWord('Broadcast', []), 'Broadcast')
  assert.equal(D.typeWord('', []), 'Release')
  assert.equal(D.typeWord('Other', ['Audiobook']), 'Release')
  assert.equal(D.typeWord(null, null), 'Release')
})

// ── formatReleaseDate ────────────────────────────────────────────────────────

test('formatReleaseDate speaks all three MusicBrainz precisions', () => {
  assert.equal(D.formatReleaseDate('1975-09-12'), '12 September 1975')
  assert.equal(D.formatReleaseDate('1975-09'), 'September 1975')
  assert.equal(D.formatReleaseDate('1975'), '1975')
  assert.equal(D.formatReleaseDate(''), '')
  assert.equal(D.formatReleaseDate(null), '')
  assert.equal(D.formatReleaseDate('not a date'), '')
  assert.equal(D.formatReleaseDate('1975-13-01'), '', 'a month that does not exist is no date')
})

// ── releaseGroupFacts ────────────────────────────────────────────────────────

test('releaseGroupFacts reads the genres, both relations and the artist MBID', () => {
  const f = E.releaseGroupFacts(WYWH_DETAIL)
  assert.equal(f.title, 'Wish You Were Here')
  assert.equal(f.date, '1975-09-12')
  assert.equal(f.primaryType, 'Album')
  assert.deepEqual(f.secondaryTypes, [])
  assert.equal(f.artistMbid, '83d91898-7763-47d7-b03b-b92132375c47')
  assert.equal(f.artistName, 'Pink Floyd')
  assert.equal(f.wikidataId, 'Q200872')
  assert.equal(f.discogsUrl, 'https://www.discogs.com/master/11703')
  assert.equal(f.genres[0].name, 'progressive rock', 'sorted by count, not by name')
  assert.ok(f.genres.every(g => g.count > 0))
})

test('releaseGroupFacts keeps downvoted genres out', () => {
  const f = E.releaseGroupFacts({ genres: [{ name: 'laut.de', count: -2 }, { name: 'male vocalist', count: 0 }, { name: 'rock', count: 4 }] })
  assert.deepEqual(f.genres, [{ name: 'rock', count: 4 }])
})

test('releaseGroupFacts survives an empty response', () => {
  const f = E.releaseGroupFacts(null)
  assert.deepEqual(f.genres, [])
  assert.equal(f.wikidataId, null)
  assert.equal(f.discogsUrl, null)
  assert.equal(f.artistMbid, null)
})

test('releaseGroupFacts will not hand back a non-https discogs link', () => {
  // openExternal refuses anything that is not https, so a button built from one
  // would be a button that does nothing.
  const f = E.releaseGroupFacts({ relations: [{ type: 'discogs', url: { resource: 'http://www.discogs.com/master/1' } }] })
  assert.equal(f.discogsUrl, null)
})

// ── studioAlbums ─────────────────────────────────────────────────────────────

test('studioAlbums reduces 49 Portishead release-groups to the three real ones', () => {
  assert.equal(PORTISHEAD_RGS['release-groups'].length, 49, 'the live browse really does return 49')
  const s = E.studioAlbums(PORTISHEAD_RGS)
  assert.deepEqual(s.map(r => r.title), ['Dummy', 'Portishead', 'Third'])
  assert.deepEqual(s.map(r => r.date), ['1994-08-22', '1997-09-29', '2008-04-08'])
})

test('studioAlbums drops live albums and compilations that type=album still returns', () => {
  const s = E.studioAlbums({
    'release-groups': [
      { id: 'a', title: 'Roseland NYC Live', 'primary-type': 'Album', 'secondary-types': ['Live'], 'first-release-date': '1998' },
      { id: 'b', title: 'Dummy', 'primary-type': 'Album', 'secondary-types': [], 'first-release-date': '1994' },
      { id: 'c', title: 'An EP', 'primary-type': 'EP', 'secondary-types': [] },
    ],
  })
  assert.deepEqual(s.map(r => r.id), ['b'])
  assert.deepEqual(E.studioAlbums(null), [])
})
