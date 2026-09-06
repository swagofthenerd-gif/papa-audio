'use strict'
const test = require('node:test')
const assert = require('node:assert')
const H = require('../src/wishlist-hunter')

// A raw slskd search response: one peer, its availability signals, and its
// files. Path separators are backslashes, the way slskd sends them, so the
// folder grouping is exercised for real.
function resp(username, folder, files, opts = {}) {
  return Object.assign({
    username,
    hasFreeUploadSlot: false,
    queueLength: 0,
    uploadSpeed: 0,
    files: files.map(f => ({
      filename: `music\\${folder}\\${f.name}`,
      size: f.size || 1000,
      bitRate: f.bitRate,
      bitDepth: f.bitDepth,
      sampleRate: f.sampleRate,
    })),
  }, opts)
}

function flacAlbum(n) {
  const files = []
  for (let i = 1; i <= n; i++) files.push({ name: `${String(i).padStart(2, '0')} Track.flac`, size: 5e6 })
  return files
}

// ── grouping ─────────────────────────────────────────────────────────────────

test('responses group into one folder per user+path, audio only', () => {
  const groups = H.groupResponses([
    resp('alice', 'Album A', [
      { name: '01 Song.flac' }, { name: '02 Song.flac' }, { name: 'cover.jpg' },
    ]),
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].username, 'alice')
  assert.equal(groups[0].folderName, 'Album A')
  assert.equal(groups[0].files.length, 2, 'the jpg is dropped')
  assert.ok(groups[0].files.every(f => f.isFlac))
})

test('forward-slash paths group the same as backslash paths', () => {
  const groups = H.groupResponses([
    { username: 'bob', hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 0,
      files: [{ filename: 'music/Album B/01.flac', size: 1 }, { filename: 'music/Album B/02.flac', size: 1 }] },
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].folderName, 'Album B')
})

// ── scoring mirrors the grid ───────────────────────────────────────────────

test('a free slot outranks a queued peer for the same album', () => {
  const groups = H.groupResponses([
    resp('slow', 'Nevermind', flacAlbum(11), { queueLength: 200 }),
    resp('open', 'Nevermind', flacAlbum(11), { hasFreeUploadSlot: true }),
  ])
  const best = H.pickBest(groups, 'nevermind')
  assert.equal(best.username, 'open')
})

test('lossless outscores a same-size lossy folder', () => {
  const flac = H.groupResponses([resp('a', 'Album', flacAlbum(10))])[0]
  const mp3 = H.groupResponses([resp('b', 'Album',
    Array.from({ length: 10 }, (_, i) => ({ name: `${i}.mp3` })))])[0]
  const words = H.queryWords('album')
  assert.ok(H.scoreGroup(flac, words) > H.scoreGroup(mp3, words))
})

// ── the quality threshold ──────────────────────────────────────────────────

test('a lossless folder with enough tracks crosses the bar', () => {
  const g = H.groupResponses([resp('a', 'Some Album', flacAlbum(H.LOSSLESS_MIN_FILES))])[0]
  assert.ok(H.crossesThreshold(g, 'anything at all'))
})

test('a single stray flac does not cross the bar on format alone', () => {
  const g = H.groupResponses([resp('a', 'Random Folder', [{ name: 'one.flac' }])])[0]
  assert.equal(H.crossesThreshold(g, 'unrelated query'), false)
})

test('a near-exact match crosses the bar even as mp3', () => {
  const g = H.groupResponses([resp('a', 'Radiohead OK Computer 1997',
    [{ name: '01.mp3' }, { name: '02.mp3' }])])[0]
  assert.ok(H.crossesThreshold(g, 'Radiohead OK Computer'))
})

test('a folder missing a query word is not exact-ish', () => {
  assert.equal(H.isExactishMatch('Radiohead The Bends', 'Radiohead OK Computer'), false)
  assert.equal(H.isExactishMatch('Radiohead - OK Computer (1997)', 'radiohead ok computer'), true)
})

// ── the sweep ──────────────────────────────────────────────────────────────

function fakeClock(start = 1000) {
  let t = start
  return {
    now: () => t,
    // The injected sleep advances the fake clock instead of waiting, so the
    // sequential-gap logic is tested without any real time passing.
    sleep: (ms) => { t += ms; return Promise.resolve() },
    at: () => t,
  }
}

test('a sweep enqueues on a lossless hit and reports it', async () => {
  const enqueued = []
  const hits = []
  const r = await H.runSweep({
    entries: [{ query: 'nirvana nevermind' }],
    search: async () => [resp('a', 'Nirvana Nevermind', flacAlbum(11), { hasFreeUploadSlot: true })],
    enqueue: async (items) => { enqueued.push(items) },
    onHit: (h) => hits.push(h),
  })
  assert.equal(r.results.length, 1)
  assert.deepEqual(r.results[0], { query: 'nirvana nevermind', found: true, enqueued: true, notified: false })
  assert.equal(enqueued.length, 1)
  assert.equal(enqueued[0].length, 11, 'every track is handed to the scheduler')
  assert.ok(enqueued[0].every(it => it.sources.length === 1 && it.sources[0].username === 'a'))
  assert.equal(hits.length, 1)
  assert.equal(hits[0].fileCount, 11)
  assert.equal(hits[0].folderName, 'Nirvana Nevermind')
})

test('a found-but-weak result is not enqueued', async () => {
  const enqueued = []
  const r = await H.runSweep({
    entries: [{ query: 'something obscure' }],
    search: async () => [resp('a', 'Unrelated Junk', [{ name: 'a.mp3' }])],
    enqueue: async (items) => { enqueued.push(items) },
  })
  assert.equal(r.results[0].found, true)
  assert.equal(r.results[0].enqueued, false)
  assert.equal(enqueued.length, 0)
})

test('a query already hunted is skipped, not searched again', async () => {
  let searches = 0
  const r = await H.runSweep({
    entries: [{ query: 'Already Got This' }],
    search: async () => { searches++; return [] },
    enqueue: async () => {},
    alreadyHunted: (norm) => norm === 'already got this',
  })
  assert.equal(searches, 0, 'the search is never issued for a known query')
  assert.equal(r.results[0].enqueued, false)
  assert.equal(r.results[0].skipped, 'duplicate')
})

test('within one sweep the same query is not enqueued twice', async () => {
  // Two entries normalize to the same query. The first enqueues and records a
  // hit; the second must see that hit and skip. The dedupe source is injected,
  // so this test drives it the way main.js does — reading a live hit list.
  const seen = new Set()
  const enqueued = []
  const r = await H.runSweep({
    entries: [{ query: 'The Album' }, { query: 'the  album' }],
    search: async () => [resp('a', 'The Album', flacAlbum(5), { hasFreeUploadSlot: true })],
    enqueue: async (items) => { enqueued.push(items) },
    onHit: (h) => seen.add(h.normalized),
    alreadyHunted: (norm) => seen.has(norm),
    sleep: () => Promise.resolve(),
    gapMs: 5000,
  })
  assert.equal(enqueued.length, 1, 'enqueued once despite two entries for it')
  assert.equal(r.results.filter(x => x.enqueued).length, 1)
  assert.ok(r.results.some(x => x.skipped === 'duplicate'))
})

test('a 429 aborts the sweep and reports throttling', async () => {
  let searches = 0
  const r = await H.runSweep({
    entries: [{ query: 'one' }, { query: 'two' }, { query: 'three' }],
    search: async () => {
      searches++
      if (searches === 2) { const e = new Error('slskd 429'); e.throttled = true; throw e }
      return [resp('a', 'X', flacAlbum(4), { hasFreeUploadSlot: true })]
    },
    enqueue: async () => {},
    sleep: () => Promise.resolve(),
    gapMs: 0,
  })
  assert.equal(r.aborted, true)
  assert.equal(r.abortReason, 'throttled')
  assert.equal(searches, 2, 'it stops at the throttled search, does not reach the third')
  assert.equal(r.results.length, 1, 'only the first entry produced a result')
})

test('the SLSKD_THROTTLED code aborts as well as the throttled flag', async () => {
  const r = await H.runSweep({
    entries: [{ query: 'one' }],
    search: async () => { const e = new Error('rate limited'); e.code = 'SLSKD_THROTTLED'; throw e },
    enqueue: async () => {},
  })
  assert.equal(r.aborted, true)
  assert.equal(r.abortReason, 'throttled')
})

test('entries run sequentially with a gap between them, none before the first', async () => {
  const clock = fakeClock(0)
  const searchTimes = []
  await H.runSweep({
    entries: [{ query: 'a' }, { query: 'b' }, { query: 'c' }],
    search: async () => { searchTimes.push(clock.at()); return [] },
    enqueue: async () => {},
    sleep: clock.sleep,
    now: clock.now,
    gapMs: 5000,
  })
  // First search at t=0 (no leading gap), then 5s between each.
  assert.deepEqual(searchTimes, [0, 5000, 10000])
})

test('a non-throttle search error is recorded and the sweep continues', async () => {
  let n = 0
  const r = await H.runSweep({
    entries: [{ query: 'one' }, { query: 'two' }],
    search: async () => { n++; if (n === 1) throw new Error('socket hangup'); return [resp('a', 'Two Album', flacAlbum(5), { hasFreeUploadSlot: true })] },
    enqueue: async () => {},
    sleep: () => Promise.resolve(),
    gapMs: 0,
  })
  assert.equal(r.aborted, false)
  assert.equal(r.results.length, 2)
  assert.ok(r.results[0].error)
  assert.equal(r.results[1].enqueued, true)
})

test('an enqueue failure is recorded, not thrown, and does not record a hit', async () => {
  const hits = []
  const r = await H.runSweep({
    entries: [{ query: 'good album' }],
    search: async () => [resp('a', 'Good Album', flacAlbum(6), { hasFreeUploadSlot: true })],
    enqueue: async () => { throw new Error('scheduler exploded') },
    onHit: (h) => hits.push(h),
  })
  assert.equal(r.results[0].enqueued, false)
  assert.ok(r.results[0].error)
  assert.equal(hits.length, 0, 'a failed enqueue must not be recorded as a satisfied wish')
})

// ── per-entry quality targets + notify-only (roadmap #48) ───────────────────

function surroundFlacAlbum(n) {
  const files = []
  for (let i = 1; i <= n; i++) files.push({ name: `${String(i).padStart(2, '0')} Track (5.1).flac`, size: 5e6 })
  return files
}

test('isSurround reads the label out of folder and file names', () => {
  const s = H.groupResponses([resp('a', 'Dark Side 5.1 Remix', surroundFlacAlbum(4))])[0]
  const stereo = H.groupResponses([resp('b', 'Dark Side', flacAlbum(4))])[0]
  assert.equal(H.isSurround(s), true)
  assert.equal(H.isSurround(stereo), false)
})

test('isSurround does not misread a plain number as 5.1', () => {
  // "Symphony 5 1st Movement" and "Album 51" must not read as surround — the
  // word-boundary anchoring is the whole point.
  const g = H.groupResponses([resp('a', 'Symphony 5 1st Movement', flacAlbum(3))])[0]
  const g2 = H.groupResponses([resp('b', 'Album 51', flacAlbum(3))])[0]
  assert.equal(H.isSurround(g), false)
  assert.equal(H.isSurround(g2), false)
})

test("target 'lossless' rejects a near-exact mp3 that 'any' would take", () => {
  const g = H.groupResponses([resp('a', 'Radiohead OK Computer 1997',
    [{ name: '01.mp3' }, { name: '02.mp3' }])])[0]
  assert.equal(H.crossesThreshold(g, 'Radiohead OK Computer', 'any'), true)
  assert.equal(H.crossesThreshold(g, 'Radiohead OK Computer', 'lossless'), false)
})

test("target 'lossless' still accepts a real lossless album", () => {
  const g = H.groupResponses([resp('a', 'Some Album', flacAlbum(H.LOSSLESS_MIN_FILES))])[0]
  assert.equal(H.crossesThreshold(g, 'anything', 'lossless'), true)
})

test("target 'surround' needs lossless AND a surround label", () => {
  const stereo = H.groupResponses([resp('a', 'Some Album', flacAlbum(5))])[0]
  const surr = H.groupResponses([resp('b', 'Some Album 5.1', surroundFlacAlbum(5))])[0]
  const surrMp3 = H.groupResponses([resp('c', 'Some Album 5.1',
    Array.from({ length: 5 }, (_, i) => ({ name: `${i} (5.1).mp3` })))])[0]
  assert.equal(H.crossesThreshold(stereo, 'some album', 'surround'), false)
  assert.equal(H.crossesThreshold(surr, 'some album', 'surround'), true)
  assert.equal(H.crossesThreshold(surrMp3, 'some album', 'surround'), false, 'surround must be lossless too')
})

test('an absent target behaves exactly like "any"', () => {
  const g = H.groupResponses([resp('a', 'Radiohead OK Computer 1997',
    [{ name: '01.mp3' }, { name: '02.mp3' }])])[0]
  assert.equal(H.crossesThreshold(g, 'Radiohead OK Computer'),
    H.crossesThreshold(g, 'Radiohead OK Computer', 'any'))
})

test("a 'lossless' entry does not enqueue a near-exact mp3 hit", async () => {
  const enqueued = []
  const r = await H.runSweep({
    entries: [{ query: 'Radiohead OK Computer', target: 'lossless' }],
    search: async () => [resp('a', 'Radiohead OK Computer 1997',
      [{ name: '01.mp3' }, { name: '02.mp3' }])],
    enqueue: async (items) => { enqueued.push(items) },
  })
  assert.equal(enqueued.length, 0, 'the mp3 did not clear the lossless bar')
  assert.equal(r.results[0].found, true)
  assert.equal(r.results[0].enqueued, false)
})

test('notify-only records a hit but never enqueues', async () => {
  const enqueued = []
  const hits = []
  const r = await H.runSweep({
    entries: [{ query: 'nirvana nevermind', notifyOnly: true }],
    search: async () => [resp('a', 'Nirvana Nevermind', flacAlbum(11), { hasFreeUploadSlot: true })],
    enqueue: async (items) => { enqueued.push(items) },
    onHit: (h) => hits.push(h),
  })
  assert.equal(enqueued.length, 0, 'notify-only must not spend the user\'s slots')
  assert.equal(hits.length, 1, 'but it still records the find')
  assert.equal(hits[0].notifyOnly, true)
  assert.equal(r.results[0].found, true)
  assert.equal(r.results[0].enqueued, false)
  assert.equal(r.results[0].notified, true)
})

test('the hit payload carries the entry target', async () => {
  const hits = []
  await H.runSweep({
    entries: [{ query: 'some album', target: 'surround' }],
    search: async () => [resp('a', 'Some Album 5.1', surroundFlacAlbum(6), { hasFreeUploadSlot: true })],
    enqueue: async () => {},
    onHit: (h) => hits.push(h),
  })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].target, 'surround')
})

test('normalizeQuery folds case, punctuation and spacing', () => {
  assert.equal(H.normalizeQuery('  Radiohead - OK  Computer!! '), 'radiohead ok computer')
  assert.equal(H.normalizeQuery('The Album'), H.normalizeQuery('the  album'))
})
