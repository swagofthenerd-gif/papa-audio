'use strict'
// J5: the Omnibox's pure half — what one box answers with for a query.
const test = require('node:test')
const assert = require('node:assert')
const O = require('../src/omnibox-model')
const LI = require('../src/library-index')

const lib = [
  { id: 'c1', name: 'Mirage', artist: 'Camel', year: 1974, artPath: '/a/m.jpg', tracks: [{ title: 'Lady Fantasy', filePath: '/c/1.flac' }] },
  { id: 'k1', name: 'Discipline', artist: 'King Crimson', year: 1981, tracks: [{ title: 'Elephant Talk', filePath: '/k/1.flac' }] },
]
const commands = [
  { id: 'nav-home', label: 'Go to Home', action() {} },
  { id: 'player-play', label: 'Play / Pause', action() {} },
  { id: 'player-shuffle', label: 'Toggle Shuffle', keys: 'S', action() {} },
]
const playlists = [{ id: 'p1', name: 'Camel favourites', type: 'regular', count: 12 }, { id: 'sp1', name: 'Search: the wall', type: 'smart' }]
const recents = { own: [{ q: 'camel mirage', surfaces: { music: 5 }, opened: [{ label: 'Mirage' }] }], elsewhere: [{ q: 'tokyo revengers', from: ['video'], fromLabel: 'Movies & TV', surfaces: { video: 3 } }] }
const src = () => ({ index: LI.build(lib), commands, playlists, recents, video: null })

test('an empty box offers recents, places and a few commands — never a blank', () => {
  const s = O.buildSections('', src())
  assert.deepEqual(s.map(x => x.key), ['recent', 'go', 'commands'])
  assert.equal(s[0].items[0].label, 'camel mirage')
  assert.match(s[0].items[0].sub, /Search · → Mirage/)
  assert.equal(s[0].items[1].sub, 'Movies & TV')
  assert.ok(s[1].items.some(i => i.page === 'video'))
  assert.equal(s[2].items[s[2].items.length - 1].kind, 'hint')
})

test('"camel" answers with the library (artist, album, track), a playlist, and the three searches', () => {
  const s = O.buildSections('camel', src())
  const keys = s.map(x => x.key)
  assert.ok(keys.includes('library') && keys.includes('playlists') && keys.includes('search'))
  const lib = s.find(x => x.key === 'library').items
  assert.deepEqual(lib.map(i => i.kind).sort(), ['album', 'artist', 'track'])
  assert.equal(lib.find(i => i.kind === 'album').id, 'c1')
  assert.equal(lib.find(i => i.kind === 'track').albumId, 'c1')
  assert.equal(s.find(x => x.key === 'playlists').items[0].id, 'p1')
  const search = s.find(x => x.key === 'search').items
  assert.deepEqual(search.map(i => i.kind), ['search-music', 'search-video', 'search-slsk'])
  assert.equal(search[0].q, 'camel')
})

test('a typo goes through the one brain and the section says what it showed', () => {
  const s = O.buildSections('camle mirraagge', src())
  const lib = s.find(x => x.key === 'library')
  assert.ok(lib && lib.corrected && lib.corrected.to === 'camel mirage')
  assert.match(lib.title, /showing “camel mirage”/)
})

test('places and settings tabs answer by name or by the words people use', () => {
  const s1 = O.buildSections('settings', src())
  assert.ok(s1.find(x => x.key === 'go').items.some(i => i.kind === 'tab' && i.tab === 'settings'))
  const s2 = O.buildSections('films', src())
  assert.ok(s2.find(x => x.key === 'go').items.some(i => i.kind === 'page' && i.page === 'video'))
  const s3 = O.buildSections('shuffle', src())
  assert.equal(s3.find(x => x.key === 'commands').items[0].id, 'player-shuffle')
})

test('an exact page, tab or command name outranks typo-tolerant library hits', () => {
  const big = lib.concat([{ id: 'g1', name: 'Getting Older', artist: 'Someone', tracks: [{ title: 'Getting Older', filePath: '/g/1.flac' }, { title: 'Getting Better', filePath: '/g/2.flac' }] }])
  const s = O.buildSections('settings', Object.assign(src(), { index: LI.build(big) }))
  assert.equal(s[0].key, 'go', 'the tab leads')
  assert.equal(s[0].items[0].tab, 'settings')
  const rows = O.flatten(s)
  assert.equal(rows[0].kind, 'tab', 'Enter opens Settings, not a song')
  const p = O.buildSections('play', src())
  assert.equal(p[0].key, 'commands')
  assert.equal(p[0].items[0].id, 'player-play')
  // A bare prefix of a word is not "the name".
  const set = O.buildSections('set', src())
  assert.notEqual(set[0].key, 'go')
})

test('"> " is command mode: commands only, filtered as you type', () => {
  const all = O.buildSections('>', src())
  assert.deepEqual(all.map(x => x.key), ['commands'])
  assert.equal(all[0].items.length, 3)
  const one = O.buildSections('> shuf', src())
  assert.equal(one[0].items.length, 1)
  assert.equal(one[0].items[0].id, 'player-shuffle')
  assert.ok(O.isCommandMode('>x') && !O.isCommandMode('x>'))
})

test('Movies & TV rows appear when the renderer has fetched them, show a loading hint meanwhile', () => {
  const loading = O.buildSections('reacher', Object.assign(src(), { video: null, videoLoading: true }))
  assert.equal(loading.find(x => x.key === 'video').items[0].kind, 'hint')
  const done = O.buildSections('reacher', Object.assign(src(), { video: [{ id: 108978, type: 'tv', title: 'Reacher', year: '2022', poster: 'p.jpg' }] }))
  const v = done.find(x => x.key === 'video').items[0]
  assert.equal(v.kind, 'video')
  assert.equal(v.key, 'tv:108978')
  assert.equal(v.sub, 'Series · 2022')
})

test('flatten lists every actionable row in reading order and skips hints', () => {
  const rows = O.flatten(O.buildSections('', src()))
  assert.ok(rows.length > 0)
  assert.ok(rows.every(r => r.kind !== 'hint'))
  assert.equal(rows[0].kind, 'recent')
})

test('a missing index or empty sources still yield the search actions', () => {
  const s = O.buildSections('anything', { index: null, commands: [], playlists: [], recents: null })
  assert.deepEqual(s.map(x => x.key), ['search'])
})
