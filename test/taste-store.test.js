'use strict';
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

const TasteStore = require(path.join(__dirname, '..', 'src', 'taste-store.js'))
const { createTasteStore, _memoryStorage } = TasteStore

function fresh(seed) {
  const storage = _memoryStorage(seed)
  let t = 1700000000000
  const store = createTasteStore({ storage, now: () => (t += 1000) })
  return { store, storage }
}

// ---------------------------------------------------------------- key scheme

test('keys are the renderer _watchKey shapes, stored verbatim', () => {
  const { store } = fresh()
  store.logViewing('movie:27205')
  store.logViewing('tv:1396:s1e2')
  store.logViewing('anime:21:e5')
  assert.ok(store.hasSeen('movie:27205'))
  assert.ok(store.hasSeen('tv:1396:s1e2'))
  assert.ok(store.hasSeen('anime:21:e5'))
  assert.equal(store.hasSeen('tv:1396:s1e3'), false)
})

// ---------------------------------------------------------------- ratings

test('rate accepts half stars from 0.5 to 5', () => {
  const { store } = fresh()
  for (const v of [0.5, 1, 2.5, 4.5, 5]) {
    assert.equal(store.rate('movie:' + v, v).value, v)
  }
})

// Guards the rejection cases: out of range, not on a half, and non-numbers must
// leave the store untouched rather than storing a nonsense star count.
test('rate rejects out-of-range, non-half and non-numeric values', () => {
  const { store } = fresh()
  for (const bad of [0, -1, 5.5, 6, 3.3, 0.25, NaN, Infinity, null, undefined, 'four', {}]) {
    assert.equal(store.rate('movie:1', bad), null, 'should reject ' + String(bad))
  }
  assert.equal(store.ratingOf('movie:1'), null)
  assert.deepEqual(store._dump().ratings, {})
})

test('a rating is per title, not per viewing', () => {
  const { store } = fresh()
  store.logViewing('movie:1', { date: '2025-01-01', rating: 4 })
  store.logViewing('movie:1', { date: '2025-02-01' })
  store.logViewing('movie:1', { date: '2025-03-01', rating: 4.5 })
  assert.equal(store.watchCount('movie:1'), 3)
  assert.equal(store.ratingOf('movie:1'), 4.5)
  assert.equal(Object.keys(store._dump().ratings).length, 1)
})

test('unrate removes the verdict but keeps the viewings', () => {
  const { store } = fresh()
  store.logViewing('movie:1', { date: '2025-01-01', rating: 4 })
  assert.equal(store.unrate('movie:1').value, 4)
  assert.equal(store.ratingOf('movie:1'), null)
  assert.equal(store.watchCount('movie:1'), 1)
  assert.equal(store.unrate('movie:1'), null)
})

// ---------------------------------------------------------------- diary

test('rewatch defaults from the log and three viewings are three entries', () => {
  const { store } = fresh()
  const a = store.logViewing('movie:1', { date: '2025-01-01' })
  const b = store.logViewing('movie:1', { date: '2025-06-01' })
  const c = store.logViewing('movie:1', { date: '2025-09-01' })
  assert.equal(a.rewatch, false)
  assert.equal(b.rewatch, true)
  assert.equal(c.rewatch, true)
  assert.equal(store.viewingsOf('movie:1').length, 3)
  assert.notEqual(a.id, b.id)
})

test('markSeen needs no playback position and accepts a past date', () => {
  const { store } = fresh()
  const e = store.markSeen('movie:99', { date: '1998-07-14', note: 'saw it at the cinema' })
  assert.equal(e.date, '1998-07-14')
  assert.equal(e.note, 'saw it at the cinema')
  assert.equal(store.isWatched('movie:99'), true)
})

test('diary is newest first and filterable by key', () => {
  const { store } = fresh()
  store.logViewing('movie:1', { date: '2025-01-01' })
  store.logViewing('movie:2', { date: '2025-05-05' })
  store.logViewing('movie:1', { date: '2025-03-03' })
  assert.deepEqual(store.diary().map(e => e.date), ['2025-05-05', '2025-03-03', '2025-01-01'])
  assert.deepEqual(store.diary({ key: 'movie:1' }).map(e => e.date), ['2025-03-03', '2025-01-01'])
  assert.equal(store.diary({ limit: 1 })[0].date, '2025-05-05')
})

test('logViewing rejects an unusable date instead of storing a broken entry', () => {
  const { store } = fresh()
  assert.equal(store.logViewing('movie:1', { date: 'not-a-date' }), null)
  assert.equal(store.logViewing('', { date: '2025-01-01' }), null)
  assert.equal(store._dump().diary.length, 0)
})

test('setNote edits only the note', () => {
  const { store } = fresh()
  const e = store.logViewing('movie:1', { date: '2025-01-01', note: 'first' })
  const updated = store.setNote(e.id, 'second thoughts')
  assert.equal(updated.note, 'second thoughts')
  assert.equal(updated.date, '2025-01-01')
  assert.equal(updated.id, e.id)
  assert.equal(store.setNote('nope', 'x'), null)
})

// Deleting a viewing is destructive; the removed entry is returned whole so the
// UI can offer undo. This guards that the round trip actually restores it.
test('removeViewing returns the entry and restoreViewing puts it back', () => {
  const { store } = fresh()
  const e = store.logViewing('movie:1', { date: '2025-01-01', note: 'hand typed' })
  const gone = store.removeViewing(e.id)
  assert.equal(gone.note, 'hand typed')
  assert.equal(store.watchCount('movie:1'), 0)
  store.restoreViewing(gone)
  assert.equal(store.watchCount('movie:1'), 1)
  assert.equal(store.diary()[0].note, 'hand typed')
  assert.equal(store.restoreViewing(gone), null, 'restoring twice must not duplicate')
})

// ---------------------------------------------------------------- queries

test('unwatchedFilter hides watched titles', () => {
  const { store } = fresh()
  store.logViewing('movie:1', { date: '2025-01-01' })
  const items = [{ key: 'movie:1' }, { key: 'movie:2' }]
  assert.deepEqual(items.filter(store.unwatchedFilter()).map(i => i.key), ['movie:2'])
  assert.deepEqual(['movie:1', 'movie:2'].filter(store.unwatchedFilter()), ['movie:2'])
})

// ---------------------------------------------------------------- favourites

test('favourites hold at most four, in order', () => {
  const { store } = fresh()
  for (const k of ['movie:1', 'movie:2', 'movie:3', 'movie:4']) assert.ok(store.addFavourite(k))
  assert.deepEqual(store.favourites(), ['movie:1', 'movie:2', 'movie:3', 'movie:4'])
  // A fifth is refused outright rather than silently evicting one of the four.
  assert.equal(store.addFavourite('movie:5'), null)
  assert.deepEqual(store.favourites(), ['movie:1', 'movie:2', 'movie:3', 'movie:4'])
  assert.equal(store.setFavourites(['a', 'b', 'c', 'd', 'e']), null)
  assert.deepEqual(store.favourites(), ['movie:1', 'movie:2', 'movie:3', 'movie:4'])
})

test('favourites dedupe and reorder', () => {
  const { store } = fresh()
  assert.deepEqual(store.setFavourites(['a', 'b', 'a']), ['a', 'b'])
  assert.deepEqual(store.setFavourites(['b', 'a']), ['b', 'a'])
  assert.deepEqual(store.removeFavourite('b'), ['a'])
  assert.deepEqual(store.removeFavourite('zzz'), ['a'])
})

// ---------------------------------------------------------------- lists

test('lists: create, rename, add, annotate, reorder, remove', () => {
  const { store } = fresh()
  const l = store.createList('  Noir  ', { description: 'rain and regret' })
  assert.equal(l.name, 'Noir')
  assert.equal(store.createList('   '), null)

  store.addToList(l.id, 'movie:1', 'the one that started it')
  store.addToList(l.id, 'movie:2')
  store.addToList(l.id, 'movie:3')
  assert.deepEqual(store.getList(l.id).entries.map(e => e.key), ['movie:1', 'movie:2', 'movie:3'])
  assert.equal(store.getList(l.id).entries[0].note, 'the one that started it')

  // A double-click must not put the same title in a list twice.
  assert.equal(store.addToList(l.id, 'movie:2'), null)
  assert.equal(store.getList(l.id).entries.length, 3)

  store.annotateListEntry(l.id, 'movie:2', 'because of the ending')
  assert.equal(store.getList(l.id).entries[1].note, 'because of the ending')

  store.moveInList(l.id, 'movie:3', 0)
  assert.deepEqual(store.getList(l.id).entries.map(e => e.key), ['movie:3', 'movie:1', 'movie:2'])
  store.moveInList(l.id, 'movie:3', 99)
  assert.deepEqual(store.getList(l.id).entries.map(e => e.key), ['movie:1', 'movie:2', 'movie:3'])

  store.removeFromList(l.id, 'movie:2')
  assert.deepEqual(store.getList(l.id).entries.map(e => e.key), ['movie:1', 'movie:3'])
  assert.equal(store.removeFromList(l.id, 'movie:2'), null)

  assert.equal(store.renameList(l.id, 'Neo-Noir').name, 'Neo-Noir')
  assert.equal(store.renameList('nope', 'x'), null)
})

// Deleting a hand-curated list has no undo upstream, so the API requires the
// list's own name back. A one-argument call must be a no-op.
test('deleteList requires the name as confirmation', () => {
  const { store } = fresh()
  const l = store.createList('Canon')
  assert.equal(store.deleteList(l.id), null)
  assert.equal(store.deleteList(l.id, 'canon'), null)
  assert.equal(store.lists().length, 1)
  const gone = store.deleteList(l.id, 'Canon')
  assert.equal(gone.name, 'Canon')
  assert.equal(store.lists().length, 0)
})

// ---------------------------------------------------------------- durability

test('a corrupt or half-written store degrades to empty instead of throwing', () => {
  for (const junk of [null, undefined, 'not json', 42, [], { diary: 'nope', ratings: 7, lists: 'x' }]) {
    const storage = _memoryStorage(junk)
    const store = createTasteStore({ storage })
    assert.deepEqual(store.diary(), [])
    assert.deepEqual(store.favourites(), [])
    assert.deepEqual(store.lists(), [])
    assert.equal(store.ratingOf('movie:1'), null)
    // and it must still be usable afterwards
    assert.equal(store.rate('movie:1', 4).value, 4)
  }
})

test('individually broken records are dropped, good ones in the same blob survive', () => {
  const { store } = fresh({
    version: 1,
    ratings: { 'movie:1': { value: 4 }, 'movie:2': { value: 99 }, 'movie:3': 'garbage' },
    diary: [
      { id: 'a', key: 'movie:1', date: '2025-01-01' },
      { id: 'b', key: 'movie:2', date: 'broken' },
      null,
      { id: 'c', date: '2025-01-01' },
    ],
    favourites: ['movie:1', 5, 'movie:2'],
    lists: [{ id: 'l1', name: 'Keep', entries: [{ key: 'movie:1' }, 'junk'] }, 'nope'],
  })
  assert.equal(store.ratingOf('movie:1'), 4)
  assert.equal(store.ratingOf('movie:2'), null)
  assert.deepEqual(store.diary().map(e => e.id), ['a'])
  assert.deepEqual(store.favourites(), ['movie:1', 'movie:2'])
  assert.equal(store.lists().length, 1)
  assert.deepEqual(store.lists()[0].entries.map(e => e.key), ['movie:1'])
})

// A newer build's columns must survive being read and written by an older one:
// this store holds data with no upstream to re-fetch from.
test('unknown fields round-trip untouched at every level', () => {
  const storage = _memoryStorage({
    version: 1,
    futureTop: { rendezvous: true },
    ratings: { 'movie:1': { value: 4, futureRating: 'liked-the-score' } },
    diary: [{ id: 'a', key: 'movie:1', date: '2025-01-01', futureEntry: ['tag'] }],
    favourites: ['movie:1'],
    lists: [{ id: 'l1', name: 'Keep', futureList: 7, entries: [{ key: 'movie:1', futureEntry: 'x' }] }],
    seen: {},
  })
  const store = createTasteStore({ storage })
  store.rate('movie:2', 3)
  const out = storage._dump()
  assert.deepEqual(out.futureTop, { rendezvous: true })
  assert.equal(out.ratings['movie:1'].futureRating, 'liked-the-score')
  assert.deepEqual(out.diary[0].futureEntry, ['tag'])
  assert.equal(out.lists[0].futureList, 7)
  assert.equal(out.lists[0].entries[0].futureEntry, 'x')
  assert.equal(out.ratings['movie:2'].value, 3)
})

test('state survives a reload through the same storage', () => {
  const storage = _memoryStorage()
  const a = createTasteStore({ storage })
  a.logViewing('movie:1', { date: '2025-01-01', rating: 4.5, note: 'n' })
  a.createList('Canon')
  a.addFavourite('movie:1')
  const b = createTasteStore({ storage })
  assert.equal(b.ratingOf('movie:1'), 4.5)
  assert.equal(b.diary().length, 1)
  assert.equal(b.lists()[0].name, 'Canon')
  assert.deepEqual(b.favourites(), ['movie:1'])
})

// ---------------------------------------------------------------- profile

const META = {
  'movie:1': { directors: ['Ridley Scott'], year: 1979, countries: ['GB'], languages: ['en'], runtime: 117 },
  'movie:2': { directors: ['Ridley Scott'], year: 1982, countries: ['US'], languages: ['en'], runtime: 117 },
  'movie:3': { directors: ['Wong Kar-wai'], year: 1994, countries: ['HK'], languages: ['cn'], runtime: 102 },
  'movie:4': { directors: ['Wong Kar-wai'], year: 2000, countries: ['HK'], languages: ['cn'], runtime: 98 },
  'movie:5': { directors: ['Andrei Tarkovsky'], year: 1979, countries: ['SU'], languages: ['ru'], runtime: 162 },
  'movie:6': { directors: ['Wim Wenders'], year: 1984, countries: ['DE'], languages: ['en'], runtime: 145 },
  'movie:7': { directors: ['Bong Joon-ho'], year: 2019, countries: ['KR'], languages: ['ko'], runtime: 132 },
  'movie:8': { directors: ['Bong Joon-ho'], year: 2003, countries: ['KR'], languages: ['ko'], runtime: 132 },
}

function seeded() {
  const { store } = fresh()
  const log = [
    ['movie:3', '2024-11-11', null],
    ['movie:1', '2024-12-01', null],
    ['movie:1', '2025-01-05', 4.5],
    ['movie:2', '2025-02-10', 5],
    ['movie:2', '2025-03-01', null],
    ['movie:3', '2025-03-15', 4],
    ['movie:4', '2025-04-02', 5],
    ['movie:5', '2025-05-20', 3.5],
    ['movie:6', '2025-06-11', 4],
    ['movie:7', '2025-07-04', 4.5],
    ['movie:7', '2025-08-08', null],
    ['movie:8', '2025-09-09', 4],
  ]
  for (const [key, date, rating] of log) store.logViewing(key, { date, rating: rating === null ? undefined : rating })
  return store
}

test('taste profile computes real numbers over the whole diary', () => {
  const store = seeded()
  const p = store.profile(META)
  assert.equal(p.viewings, 12)
  assert.equal(p.titles, 8)
  // 117*2 + 117*2 + 102*2 + 98 + 162 + 145 + 132*2 + 132
  assert.equal(p.totalRuntime, 1473)
  assert.equal(p.ratedTitles, 8)
  // (4.5+5+4+5+3.5+4+4.5+4)/8 = 4.3125, averaged over titles not viewings
  assert.equal(p.averageRating, 4.31)
  // count is how many of their films you have seen; viewings is how often you
  // put one on. Ranking on films alone tied all three at two and broke it
  // alphabetically, which said nothing — the viewing counts say plainly which
  // one this diary keeps returning to.
  assert.deepEqual(p.topDirectors.slice(0, 3), [
    { name: 'Ridley Scott', count: 2, viewings: 4 },
    { name: 'Bong Joon-ho', count: 2, viewings: 3 },
    { name: 'Wong Kar-wai', count: 2, viewings: 3 },
  ])
  // The 1970s and 1980s are level on both films and viewings across the whole
  // diary, so the numeric order decides — deliberately, so the list is stable
  // rather than dependent on insertion order.
  assert.deepEqual(p.decades, [
    { name: 1970, count: 2, viewings: 3 },
    { name: 1980, count: 2, viewings: 3 },
    { name: 2000, count: 2, viewings: 2 },
    { name: 1990, count: 1, viewings: 2 },
    { name: 2010, count: 1, viewings: 2 },
  ])
  assert.deepEqual(p.topCountries[0], { name: 'HK', count: 2, viewings: 3 })
  assert.deepEqual(p.topLanguages.slice(0, 2), [
    { name: 'en', count: 3, viewings: 5 },
    { name: 'cn', count: 2, viewings: 3 },
  ])
})

test('profile tolerates titles with no metadata at all', () => {
  const store = seeded()
  store.logViewing('movie:404', { date: '2025-10-10' })
  const p = store.profile(META)
  assert.equal(p.viewings, 13)
  assert.equal(p.totalRuntime, 1473)
  // Two films by this director, watched four times between them.
  assert.equal(p.topDirectors[0].count, 2)
  assert.equal(p.topDirectors[0].viewings, 4)
})

test('year in review reports one year only', () => {
  const store = seeded()
  const y = store.yearInReview(2025, META)
  assert.equal(y.year, 2025)
  assert.equal(y.viewings, 10)
  assert.equal(y.titles, 8)
  // 117 + 117*2 + 102 + 98 + 162 + 145 + 132*2 + 132 = 1254 minutes
  assert.equal(y.totalRuntime, 1254)
  assert.equal(y.hours, 20.9)
  assert.deepEqual(y.ratingDistribution, { '3.5': 1, '4': 3, '4.5': 2, '5': 2 })
  assert.deepEqual(y.perMonth, [1, 1, 2, 1, 1, 1, 1, 1, 1, 0, 0, 0])
  // Two decades are level on films seen; the 1980s lead on viewings.
  assert.deepEqual(y.decades[0], { name: 1980, count: 2, viewings: 3 })
  // Within 2025 alone, Scott and Bong are level on both films and viewings, so
  // the name breaks it. A tie that reports a real tie beats one that pretends
  // to a winner.
  assert.equal(y.topDirectors[0].name, 'Bong Joon-ho')
  assert.deepEqual(y.topDirectors.slice(0, 2).map(d => [d.count, d.viewings]), [[2, 3], [2, 3]])

  const prev = store.yearInReview(2024, META)
  assert.equal(prev.viewings, 2)
  assert.equal(prev.totalRuntime, 219)
  assert.deepEqual(prev.ratingDistribution, {})
})

test('year in review for an empty year is empty, not an error', () => {
  const store = seeded()
  const y = store.yearInReview(1999, META)
  assert.equal(y.viewings, 0)
  assert.equal(y.hours, 0)
  assert.deepEqual(y.topDirectors, [])
})

// ---------------------------------------------------------------- scale

// Guards against an accidental O(n^2): per-key lookups must use the index, not
// a scan of the whole diary per call.
test('10k entries stay linear', () => {
  const { store } = fresh()
  for (let i = 0; i < 10000; i++) store.logViewing('movie:' + (i % 500), { date: '2025-01-01' })
  const started = Date.now()
  for (let i = 0; i < 500; i++) {
    assert.equal(store.watchCount('movie:' + i), 20)
    assert.equal(store.hasSeen('movie:' + i), true)
  }
  assert.ok(Date.now() - started < 2000, 'per-key lookups should not rescan the diary')
})

// ---------------------------------------------------------------- helpers

test('normalizeDate accepts ISO days, Date objects and epoch millis', () => {
  assert.equal(TasteStore.normalizeDate('2025-03-04'), '2025-03-04')
  assert.equal(TasteStore.normalizeDate(new Date(2025, 2, 4, 12)), '2025-03-04')
  assert.equal(TasteStore.normalizeDate('rubbish'), null)
  assert.equal(TasteStore.normalizeDate(NaN), null)
})

test('module exports a singleton plus the factory', () => {
  assert.equal(typeof TasteStore.createTasteStore, 'function')
  assert.equal(typeof TasteStore.rate, 'function')
  assert.equal(TasteStore.MAX_FAVOURITES, 4)
})
