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

test('a title under the 0.6 album bar comes back loose, not firm', () => {
  const json = {
    'release-groups': [
      { id: 'x', title: 'The Dark Side of the Moon', score: 88, 'first-release-date': '1973-03-01', 'primary-type': 'Album', 'secondary-types': [] },
    ],
  }
  const p = E.pickReleaseGroup(json, { title: 'Animals' })
  assert.equal(p.id, 'x', 'it is still returned — the identity line is never silent')
  assert.equal(p.confidence, 'loose')
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
