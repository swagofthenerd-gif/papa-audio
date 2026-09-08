'use strict'
// Performance budgets for the Manage overhaul, in the shape of
// test/slsk-shelves-bench.test.js: a deterministic synthetic corpus, a warm-up
// pass, then a measured pass asserted under a ceiling.
//
// Budgets (from the overhaul spec, measured on a ~2,400-track synthetic library):
//   • dashboard model build   < 50ms
//   • duplicates compare build (findDuplicates + keep-best over the whole lib) < 100ms
//   • redundant-lossy scan     < 100ms
const test = require('node:test')
const assert = require('node:assert')
const L = require('../src/library-manage')
const R = require('../src/manage-reclaim')
const RD = require('../src/manage-redundant')
const D = require('../src/manage-dashboard')
const MT = require('../src/music-tools')
const S = require('../src/slsk-shelves')

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ARTISTS = [
  'Pink Floyd', 'Radiohead', 'Miles Davis', 'Aphex Twin', 'The Beatles',
  'Boards of Canada', 'Portishead', 'Led Zeppelin', 'Nirvana', 'Opeth',
  'Autechre', 'Massive Attack', 'John Coltrane', 'Kraftwerk', 'Björk',
]
const WORDS = ['Ambient', 'Works', 'Selected', 'Dark', 'Side', 'Moon', 'Blue',
  'Kind', 'Dummy', 'Physical', 'Nevermind', 'Amnesiac', 'Mezzanine', 'Rounds']

function pick(rnd, arr) { return arr[Math.floor(rnd() * arr.length)] }
function title(rnd) {
  const n = 1 + Math.floor(rnd() * 3)
  const out = []
  for (let i = 0; i < n; i++) out.push(pick(rnd, WORDS))
  return out.join(' ')
}

// A ~2,400-track library: ~300 albums × ~8 tracks, with a realistic scatter of
// duplicates (a second copy of some albums) and lossy/lossless mixes.
function buildLibrary(seed, albumCount) {
  const rnd = mulberry32(seed)
  const albums = []
  for (let i = 0; i < albumCount; i++) {
    const artist = pick(rnd, ARTISTS)
    const name = title(rnd)
    const lossless = rnd() > 0.4
    const ext = lossless ? 'flac' : 'mp3'
    const tracks = 6 + Math.floor(rnd() * 6)
    const sizeEach = lossless ? 30e6 + Math.floor(rnd() * 20e6) : 6e6 + Math.floor(rnd() * 4e6)
    const bd = lossless ? (rnd() > 0.5 ? 24 : 16) : 0
    const sr = lossless ? (bd === 24 ? 96000 : 44100) : 0
    const dir = `/m/${artist}/${name}#${i}`
    albums.push({
      id: `alb${i}`, name, artist, genre: pick(rnd, ['Rock', 'rock', 'Jazz', 'Electronic', '']),
      maxBitsPerSample: bd, maxSampleRate: sr,
      tracks: Array.from({ length: tracks }, (_, t) => ({
        filePath: `${dir}/${t + 1} ${WORDS[t % WORDS.length]}.${ext}`,
        title: WORDS[t % WORDS.length],
        fileSize: sizeEach, codec: ext, channels: 2,
        bitsPerSample: bd, sampleRate: sr,
      })),
    })
    // ~20% of albums get a second copy (a duplicate) in a different format.
    if (rnd() > 0.8) {
      const ext2 = lossless ? 'mp3' : 'flac'
      albums.push({
        id: `alb${i}b`, name, artist, genre: 'Rock',
        maxBitsPerSample: ext2 === 'flac' ? 16 : 0, maxSampleRate: ext2 === 'flac' ? 44100 : 0,
        tracks: Array.from({ length: tracks }, (_, t) => ({
          filePath: `/m/${artist}/${name}#${i}-copy/${t + 1} ${WORDS[t % WORDS.length]}.${ext2}`,
          title: WORDS[t % WORDS.length],
          fileSize: ext2 === 'flac' ? 40e6 : 8e6, codec: ext2, channels: 2,
        })),
      })
    }
  }
  return albums
}

function tracksFromLibrary(library) {
  const out = []
  for (const a of library) {
    for (const t of (a.tracks || [])) {
      out.push({
        filePath: t.filePath, title: t.title, channels: t.channels || 0,
        fileSize: t.fileSize || 0, codec: t.codec || null,
        bitsPerSample: t.bitsPerSample || 0, sampleRate: t.sampleRate || 0,
        album: a.name, albumArtist: a.artist, artist: t.artist || a.artist,
      })
    }
  }
  return out
}

const LIB = buildLibrary(2024, 240)
const TRACK_COUNT = LIB.reduce((n, a) => n + a.tracks.length, 0)

// The whole suite runs 200+ test files in parallel (node --test), so a single
// timed run is at the mercy of a GC pause or the scheduler on someone else's
// file. GC pauses only ever INFLATE a measurement, never shrink one below the
// true cost — so the minimum of several runs is the honest "how fast is this
// code" number, immune to that noise, while still failing loudly if the code is
// genuinely over budget (then even the fastest run exceeds the ceiling).
function bestOf(runs, fn) {
  let best = Infinity
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    const ms = performance.now() - t0
    if (ms < best) best = ms
  }
  return best
}

test(`synthetic library is ~2,400 tracks (got ${TRACK_COUNT})`, () => {
  assert.ok(TRACK_COUNT >= 2000 && TRACK_COUNT <= 3200, `track count ${TRACK_COUNT} out of expected band`)
})

test('BENCH: duplicates compare build (findDuplicates + keep-best) < 100ms', () => {
  const tracks = tracksFromLibrary(LIB)
  L.findDuplicates(tracks.slice(0, 200)) // warm
  const ms = bestOf(5, () => {
    const groups = L.findDuplicates(tracks)
    for (const g of groups) R.pickKeepBest(g)
    R.reclaimableAcross(groups, 'best')
  })
  assert.ok(ms < 100, `duplicates compare took ${ms.toFixed(1)}ms, ceiling 100ms`)
})

test('BENCH: redundant-lossy scan < 100ms', () => {
  RD.findRedundantLossy(LIB.slice(0, 50), S) // warm
  const ms = bestOf(5, () => RD.findRedundantLossy(LIB, S))
  assert.ok(ms < 100, `redundant-lossy scan took ${ms.toFixed(1)}ms, ceiling 100ms`)
})

test('BENCH: dashboard model build < 50ms', () => {
  // The dashboard folds already-computed tool results; building it from those
  // must be trivially fast. Feed it the real tool outputs so it is honest.
  const tracks = tracksFromLibrary(LIB)
  const dupGroups = L.findDuplicates(tracks)
  const storage = MT.storageByFormat(LIB)
  const genres = MT.analyzeGenres(LIB)
  const input = {
    storage,
    duplicates: { groups: dupGroups, reclaimBytes: R.reclaimableAcross(dupGroups, 'best') },
    health: [{ severity: 'medium', count: 12 }, { severity: 'low', count: 40 }],
    genres,
    trash: { items: [{}, {}], totalBytes: 3e9 },
  }
  for (let i = 0; i < 50; i++) D.buildDashboard(input) // warm the JIT
  // Minimum of a few batches: robust to GC pauses under the parallel test run.
  const ms = bestOf(5, () => { for (let i = 0; i < 20; i++) D.buildDashboard(input) })
  assert.ok(ms < 50, `dashboard build (20×) took ${ms.toFixed(3)}ms, ceiling 50ms`)
})
