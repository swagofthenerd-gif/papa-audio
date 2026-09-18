'use strict'
// One malformed entry in a real watch history painted an empty Continue
// Watching card and could throw (Movies & TV audit N17).
//
// The entry carried a position and a duration and nothing else — no type, no
// id, no title. It passed the in-progress filter, so it reached the shelf as a
// card with no poster and no name; and every reader that asks an entry WHAT it
// is (the card's navigation, the per-show collapse in continueWatching, the
// airing seed) reads `it.type` and `it.id`, both undefined.
//
// The store's read path now drops entries it cannot turn into a card, once, on
// load, with a single warning naming the count — and never touches the stored
// blob, so nothing is deleted off disk.

const test = require('node:test')
const assert = require('node:assert')
const path = require('path')

const { createVideoStore } = require(path.join(__dirname, '..', 'src', 'video-store.js'))

// The same in-memory backend shape the store's own tests use: one slot holding
// a parsed blob, so a seed can be handed in whole.
function memoryStorage(seed) {
  const slots = { main: seed == null ? null : seed, bak: null, corrupt: null }
  return {
    _slots: slots,
    // A deep copy on every read, like the real adapters: both the localStorage
    // and the SideStore backends hand back a freshly parsed object, so the
    // store can never reach through them and edit what is on disk.
    read() { return slots.main == null ? null : JSON.parse(JSON.stringify(slots.main)) },
    write(v) { slots.main = JSON.parse(JSON.stringify(v)); return true },
    readBackup() { return slots.bak },
    writeBackup(v) { slots.bak = JSON.parse(JSON.stringify(v)); return true },
    quarantine(t) { slots.corrupt = t; return true },
  }
}

// One corrupt entry among four good ones, exactly as it was found: an
// in-progress position and duration, and nothing that says what it is.
function seed() {
  return {
    items: {
      'tv:1396:s1e2': { type: 'tv', id: '1396', title: 'Breaking Bad', season: 1, episode: 2, position: 900, duration: 2700, updatedAt: 40 },
      'movie:27205': { type: 'movie', id: '27205', title: 'Inception', position: 600, duration: 1800, updatedAt: 30 },
      'anime:21:e14': { type: 'anime', id: '21', title: 'One Piece', episode: 14, position: 300, duration: 1440, updatedAt: 20 },
      // The corrupt one. A good-looking key; an entry that says nothing.
      'tv:99999:s2e4': { position: 700, duration: 1500, updatedAt: 50 },
      'movie:603': { type: 'movie', id: '603', title: 'The Matrix', position: 400, duration: 8160, updatedAt: 10 },
    },
    watchlist: [], skip: {}, prefs: {},
  }
}

function captureWarnings(fn) {
  const lines = []
  const real = console.error
  console.error = (...a) => lines.push(a.join(' '))
  try { return { value: fn(), lines } } finally { console.error = real }
}

test('the corrupt entry never reaches Continue Watching', () => {
  const { value: store } = captureWarnings(() =>
    createVideoStore({ storage: memoryStorage(seed()), now: () => 100 }))
  const cw = store.continueWatching(10)
  assert.strictEqual(cw.length, 4, 'the four real titles survive')
  for (const it of cw) {
    assert.ok(it.type, 'every card knows what kind of thing it is')
    assert.ok(it.id, 'and which one')
  }
  assert.ok(!cw.some(it => it.duration === 1500), 'the corrupt entry is gone')
})

test('the good entries are untouched', () => {
  const { value: store } = captureWarnings(() =>
    createVideoStore({ storage: memoryStorage(seed()), now: () => 100 }))
  const titles = store.continueWatching(10).map(i => i.title).sort()
  assert.deepStrictEqual(titles, ['Breaking Bad', 'Inception', 'One Piece', 'The Matrix'])
  // And the reader still answers a direct get for one of them.
  assert.strictEqual(store.get('movie:603').title, 'The Matrix')
})

test('it says so once, with the count, not once per entry', () => {
  const twoBad = seed()
  twoBad.items['anime:404:e1'] = { position: 50, duration: 1400, updatedAt: 60 }
  const { lines } = captureWarnings(() => {
    const store = createVideoStore({ storage: memoryStorage(twoBad), now: () => 100 })
    store.continueWatching(10)
    store.continueWatching(10)
    store.history(10)
  })
  const dropLines = lines.filter(l => /dropped/.test(l))
  assert.strictEqual(dropLines.length, 1, 'exactly one line, got: ' + JSON.stringify(lines))
  assert.match(dropLines[0], /\b2\b/, 'the line names how many were dropped: ' + dropLines[0])
})

test('a clean history says nothing at all', () => {
  const clean = seed()
  delete clean.items['tv:99999:s2e4']
  const { lines } = captureWarnings(() =>
    createVideoStore({ storage: memoryStorage(clean), now: () => 100 }).continueWatching(10))
  assert.deepStrictEqual(lines.filter(l => /dropped/.test(l)), [])
})

test('the drop happens on read, and the stored blob is left alone', () => {
  const backend = memoryStorage(seed())
  captureWarnings(() => createVideoStore({ storage: backend, now: () => 100 }).continueWatching(10))
  // load()'s rolling backup is a copy of the CLEANED state — that is fine — but
  // nothing may have rewritten the main key behind his back on a plain read.
  assert.ok('tv:99999:s2e4' in backend._slots.main.items,
    'a read must not delete anything from the stored history')
})

test('an entry with a type but no id is unusable too', () => {
  const s = seed()
  s.items['movie:777'] = { type: 'movie', title: 'Ghost', position: 300, duration: 1000, updatedAt: 70 }
  const { value: store } = captureWarnings(() =>
    createVideoStore({ storage: memoryStorage(s), now: () => 100 }))
  assert.ok(!store.continueWatching(10).some(i => i.title === 'Ghost'),
    'an entry that cannot be navigated to must not be offered')
})
