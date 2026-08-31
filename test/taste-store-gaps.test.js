'use strict';
// The six things the store could not do.
//
// Each was found by the agent that built the panel, which worked around them
// rather than changing the store — so each of these tests describes a fix, and
// each fails against the store as it was.
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

const { createTasteStore, _memoryStorage } = require(path.join(__dirname, '..', 'src', 'taste-store.js'))

function fresh(seed) {
  const storage = _memoryStorage(seed)
  let t = 1700000000000
  return createTasteStore({ storage, now: () => (t += 1000) })
}

// ── 1. un-seeing ───────────────────────────────────────────────────────────

test('deleting the last viewing of a title stops it being seen', () => {
  // The seen flag is a shadow of the diary and used to outlive it, so a title
  // stayed hidden behind "hide watched" with nothing left to explain why.
  const store = fresh()
  const a = store.logViewing('movie:238')
  assert.strictEqual(store.hasSeen('movie:238'), true)
  store.removeViewing(a.id)
  assert.strictEqual(store.hasSeen('movie:238'), false)
  assert.strictEqual(store.watchCount('movie:238'), 0)
})

test('deleting one of several viewings leaves the title seen', () => {
  const store = fresh()
  const a = store.logViewing('movie:238', { date: '2024-01-01' })
  store.logViewing('movie:238', { date: '2024-06-01' })
  store.removeViewing(a.id)
  assert.strictEqual(store.hasSeen('movie:238'), true)
  assert.strictEqual(store.watchCount('movie:238'), 1)
})

test('undoing that deletion gives the watched state back too', () => {
  const store = fresh()
  const a = store.logViewing('movie:238')
  const gone = store.removeViewing(a.id)
  assert.strictEqual(store.hasSeen('movie:238'), false)
  store.restoreViewing(gone)
  assert.strictEqual(store.hasSeen('movie:238'), true, 'the entry came back without the flag')
})

test('unsee forgets every viewing but keeps the verdict', () => {
  const store = fresh()
  store.rate('movie:238', 4.5)
  store.logViewing('movie:238', { date: '2024-01-01' })
  store.logViewing('movie:238', { date: '2024-02-01' })
  const removal = store.unsee('movie:238')
  assert.strictEqual(store.hasSeen('movie:238'), false)
  assert.strictEqual(store.watchCount('movie:238'), 0)
  assert.strictEqual(removal.viewings.length, 2)
  // A rating is a verdict on the film; it survives deciding you logged the
  // evening by mistake.
  assert.strictEqual(store.ratingOf('movie:238'), 4.5)
})

test('unsee is undoable, and does not touch other titles', () => {
  const store = fresh()
  store.logViewing('movie:238')
  store.logViewing('movie:278')
  const removal = store.unsee('movie:238')
  assert.strictEqual(store.hasSeen('movie:278'), true, 'unrelated title affected')
  store.resee(removal)
  assert.strictEqual(store.hasSeen('movie:238'), true)
  assert.strictEqual(store.watchCount('movie:238'), 1)
})

test('unsee on an unseen title says nothing happened', () => {
  const store = fresh()
  assert.strictEqual(store.unsee('movie:999'), null)
  assert.strictEqual(store.unsee(''), null)
  assert.strictEqual(store.unsee(null), null)
})

test('resee refuses to duplicate entries it already holds', () => {
  const store = fresh()
  store.logViewing('movie:238')
  const removal = store.unsee('movie:238')
  store.resee(removal)
  store.resee(removal)
  assert.strictEqual(store.watchCount('movie:238'), 1, 'a double undo duplicated the viewing')
})

// ── 2. reordering one favourite ────────────────────────────────────────────

test('a favourite moves without rewriting the whole array', () => {
  // setFavourites(wholeArray) is the stale-array hazard moveInList exists to
  // avoid, and it was the only way to reorder.
  const store = fresh()
  for (const k of ['a', 'b', 'c', 'd']) store.addFavourite(k)
  assert.deepStrictEqual(store.moveFavourite('d', 0), ['d', 'a', 'b', 'c'])
  assert.deepStrictEqual(store.moveFavourite('d', 2), ['a', 'b', 'd', 'c'])
})

test('moveFavourite clamps rather than dropping the key', () => {
  const store = fresh()
  for (const k of ['a', 'b', 'c']) store.addFavourite(k)
  assert.deepStrictEqual(store.moveFavourite('a', 99), ['b', 'c', 'a'])
  assert.deepStrictEqual(store.moveFavourite('a', -5), ['a', 'b', 'c'])
  // Nothing is ever lost, whatever the index.
  assert.strictEqual(store.favourites().length, 3)
})

test('moveFavourite refuses what it cannot do', () => {
  const store = fresh()
  store.addFavourite('a')
  assert.strictEqual(store.moveFavourite('not-a-favourite', 0), null)
  assert.strictEqual(store.moveFavourite('a', 'sideways'), null)
})

// ── 3. correcting a date or a rewatch flag ─────────────────────────────────

test('a viewing date can be corrected, keeping its id', () => {
  // Only the note could move, so fixing a date meant delete-and-re-log, which
  // loses the id the UI holds.
  const store = fresh()
  const e = store.logViewing('movie:238', { date: '2024-03-05' })
  const fixed = store.editViewing(e.id, { date: '2024-03-06' })
  assert.strictEqual(fixed.id, e.id)
  assert.strictEqual(fixed.date, '2024-03-06')
  assert.strictEqual(store.viewingsOf('movie:238').length, 1)
})

test('a rewatch flag can be corrected', () => {
  const store = fresh()
  const first = store.logViewing('movie:238')
  assert.strictEqual(first.rewatch, false)
  const fixed = store.editViewing(first.id, { rewatch: true })
  assert.strictEqual(fixed.rewatch, true)
})

test('editViewing refuses an unparseable date rather than moving it to today', () => {
  // Silently relocating a viewing to now is worse than not moving it.
  const store = fresh()
  const e = store.logViewing('movie:238', { date: '2024-03-05' })
  assert.strictEqual(store.editViewing(e.id, { date: 'last Tuesday' }), null)
  assert.strictEqual(store.viewingsOf('movie:238')[0].date, '2024-03-05', 'the date moved anyway')
})

test('editViewing touches only the fields it is given', () => {
  const store = fresh()
  const e = store.logViewing('movie:238', { date: '2024-03-05', note: 'on 35mm' })
  const fixed = store.editViewing(e.id, { date: '2024-03-06' })
  assert.strictEqual(fixed.note, 'on 35mm')
  assert.strictEqual(fixed.rewatch, false)
})

test('a rating supplied to editViewing also becomes the title rating', () => {
  // The same rule logViewing follows: the diary records the sitting, the
  // ratings map records the verdict.
  const store = fresh()
  const e = store.logViewing('movie:238')
  store.editViewing(e.id, { rating: 4 })
  assert.strictEqual(store.ratingOf('movie:238'), 4)
})

test('editViewing on a missing id changes nothing', () => {
  const store = fresh()
  assert.strictEqual(store.editViewing('nope', { date: '2024-01-01' }), null)
})

test('a corrected date is observed through the diary, not a stale index', () => {
  // byKey holds references into state.diary, so a date change has to invalidate
  // or the sort reads the old value.
  const store = fresh()
  store.logViewing('movie:1', { date: '2024-01-01' })
  const e = store.logViewing('movie:2', { date: '2024-01-02' })
  store.editViewing(e.id, { date: '2023-01-01' })
  const dates = store.diary().map(d => d.date)
  assert.deepStrictEqual(dates, ['2024-01-01', '2023-01-01'], 'newest first, using the corrected date')
})

// ── 4. the year's average, not a lifetime one ─────────────────────────────

test("yearInReview's average rating is that year's", () => {
  // profile() averaged the whole ratings map regardless of its own `entries`
  // filter, so a year in review reported a lifetime average as that year's.
  const store = fresh()
  // Watched and rated in 2023: 2 stars.
  store.logViewing('movie:old', { date: '2023-05-01' })
  store.rate('movie:old', 2)
  // Watched and rated in 2024: 5 and 4.
  store.logViewing('movie:a', { date: '2024-05-01' })
  store.rate('movie:a', 5)
  store.logViewing('movie:b', { date: '2024-06-01' })
  store.rate('movie:b', 4)

  const y = store.yearInReview(2024, {})
  assert.strictEqual(y.averageRating, 4.5, 'this is the lifetime average, not 2024')
  assert.strictEqual(y.ratedTitles, 2)

  // And the lifetime figure is still available unscoped.
  assert.strictEqual(store.profile({}).averageRating, 3.67)
})

test('a year with viewings but no ratings has no average, not zero', () => {
  const store = fresh()
  store.logViewing('movie:a', { date: '2024-05-01' })
  const y = store.yearInReview(2024, {})
  assert.strictEqual(y.averageRating, null)
  assert.strictEqual(y.ratedTitles, 0)
})

test('the year average counts a rewatched title once', () => {
  // Same reasoning as the unscoped average: a verdict per film, not per sitting.
  const store = fresh()
  store.logViewing('movie:a', { date: '2024-01-01' })
  store.logViewing('movie:a', { date: '2024-02-01' })
  store.logViewing('movie:a', { date: '2024-03-01' })
  store.rate('movie:a', 5)
  store.logViewing('movie:b', { date: '2024-04-01' })
  store.rate('movie:b', 3)
  assert.strictEqual(store.yearInReview(2024, {}).averageRating, 4)
})

// ── 5. which years have entries ───────────────────────────────────────────

test('diaryYears lists the years that have viewings, newest first', () => {
  // A year picker had to scan the whole diary, so every caller reimplemented
  // the loop and chose its own sort order.
  const store = fresh()
  store.logViewing('movie:a', { date: '2022-01-01' })
  store.logViewing('movie:b', { date: '2024-01-01' })
  store.logViewing('movie:c', { date: '2024-07-01' })
  assert.deepStrictEqual(store.diaryYears(), [
    { year: 2024, viewings: 2 },
    { year: 2022, viewings: 1 },
  ])
})

test('diaryYears on an empty diary is empty', () => {
  assert.deepStrictEqual(fresh().diaryYears(), [])
})

// ── 6. a list's description ───────────────────────────────────────────────

test("a list's description can be changed after it has titles in it", () => {
  // createList accepted one and nothing could ever change it, so the sentence
  // explaining what a list is for was fixed at the moment of least knowledge.
  const store = fresh()
  const l = store.createList('Sunday afternoons', { description: 'nothing demanding' })
  store.addToList(l.id, 'movie:238')
  const updated = store.describeList(l.id, 'comfort films, nothing after 1979')
  assert.strictEqual(updated.description, 'comfort films, nothing after 1979')
  assert.strictEqual(updated.entries.length, 1, 'the entries were disturbed')
  assert.strictEqual(updated.name, 'Sunday afternoons')
})

test('an empty description clears it', () => {
  const store = fresh()
  const l = store.createList('Untitled', { description: 'placeholder' })
  assert.strictEqual(store.describeList(l.id, '   ').description, null)
  assert.strictEqual(store.describeList(l.id, null).description, null)
})

test('describeList refuses a non-string and a missing list', () => {
  const store = fresh()
  const l = store.createList('A')
  assert.strictEqual(store.describeList(l.id, 42), null)
  assert.strictEqual(store.describeList('no-such-list', 'x'), null)
})

// ── all six survive a round trip through storage ─────────────────────────

test('every new field persists', () => {
  const storage = _memoryStorage()
  let t = 1700000000000
  const a = createTasteStore({ storage, now: () => (t += 1000) })
  const e = a.logViewing('movie:238', { date: '2024-01-01' })
  a.editViewing(e.id, { date: '2024-02-02', rewatch: true })
  for (const k of ['x', 'y']) a.addFavourite(k)
  a.moveFavourite('y', 0)
  const l = a.createList('L')
  a.describeList(l.id, 'why')

  const b = createTasteStore({ storage, now: () => (t += 1000) })
  assert.strictEqual(b.viewingsOf('movie:238')[0].date, '2024-02-02')
  assert.strictEqual(b.viewingsOf('movie:238')[0].rewatch, true)
  assert.deepStrictEqual(b.favourites(), ['y', 'x'])
  assert.strictEqual(b.lists()[0].description, 'why')
  assert.deepStrictEqual(b.diaryYears(), [{ year: 2024, viewings: 1 }])
})
