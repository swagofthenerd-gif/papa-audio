// Performance + equivalence guards for the record-shop matcher (the open-freeze
// fix). Two things are locked in here:
//
//   1. BENCH — a synthetic 1,000-peer-album × 500-library-album classification
//      must finish well under 150ms. Before the fix this same shape took multiple
//      seconds because inLibrary/upgrade matching was O(peer × library) with
//      normKey/tokenize re-run on every comparison (profiler: normKey 4.5s,
//      tokenScore 2.2s of self-time on a real 438-album open).
//
//   2. SNAPSHOT EQUALITY — the bucketed index must classify EXACTLY the same
//      albums into upgrades/missing/everything as a brute-force full-scan
//      reference. The speedup must not change a single result.
const test = require('node:test')
const assert = require('node:assert')
const S = require('../src/slsk-shelves')

// ── Deterministic fixture generators ──────────────────────────────────────────
// A tiny seeded PRNG so the corpus is identical run to run (a flaky bench is
// worse than no bench).
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
  'Tool', 'Deftones', 'Burial', 'Four Tet', 'Bonobo',
]
const WORDS = [
  'Ambient', 'Works', 'Selected', 'Dark', 'Side', 'Moon', 'Rainbows',
  'Kind', 'Blue', 'Geogaddi', 'Dummy', 'Physical', 'Graffiti', 'Nevermind',
  'Blackwater', 'Park', 'Amnesiac', 'Mezzanine', 'Untrue', 'Rounds',
  'Migration', 'Lateralus', 'Around', 'Fur', 'Homework', 'Discovery',
]

function pick(rnd, arr) { return arr[Math.floor(rnd() * arr.length)] }
function makeTitle(rnd) {
  const n = 1 + Math.floor(rnd() * 4)
  const out = []
  for (let i = 0; i < n; i++) out.push(pick(rnd, WORDS))
  return out.join(' ')
}

// Build a peer album (extractAlbums output shape) with quality flags.
function makePeerAlbum(rnd, i) {
  const lossless = rnd() > 0.35
  const hi = lossless && rnd() > 0.5
  const artist = pick(rnd, ARTISTS)
  const album = makeTitle(rnd)
  const bd = lossless ? (hi ? 24 : 16) : 0
  const sr = lossless ? (hi ? 96000 : 44100) : 0
  return {
    artist, album, year: 1970 + Math.floor(rnd() * 55),
    folderName: `${artist} - ${album}`, folderPath: `X\\${artist}\\${album}#${i}`,
    trackCount: 8 + Math.floor(rnd() * 6),
    totalSize: 100000000 + Math.floor(rnd() * 400000000),
    losslessCount: lossless ? 10 : 0, lossless, isHiRes: hi,
    maxBitDepth: bd, maxSampleRate: sr, topExt: lossless ? 'flac' : 'mp3',
    files: [{ name: `01 ${album}.${lossless ? 'flac' : 'mp3'}`, size: 10000000, bitDepth: bd, sampleRate: sr }],
  }
}

// Build a library album (renderer library shape) — deliberately overlapping the
// peer corpus (some are lossy so peers upgrade them, some lossless so no upgrade).
function makeLibAlbum(rnd, i) {
  const lossless = rnd() > 0.5
  const hi = lossless && rnd() > 0.6
  const bd = lossless ? (hi ? 24 : 16) : 0
  const sr = lossless ? (hi ? 96000 : 44100) : 0
  return {
    id: `lib${i}`, artist: pick(rnd, ARTISTS), name: makeTitle(rnd),
    maxBitsPerSample: bd, maxSampleRate: sr,
    tracks: [{ filePath: `/m/${i}/01.${lossless ? 'flac' : 'mp3'}`, bitsPerSample: bd, sampleRate: sr }],
  }
}

function buildCorpus(seed, peerN, libN) {
  const rnd = mulberry32(seed)
  const peers = []
  for (let i = 0; i < peerN; i++) peers.push(makePeerAlbum(rnd, i))
  const rndL = mulberry32(seed ^ 0x9e3779b9)
  const lib = []
  for (let i = 0; i < libN; i++) lib.push(makeLibAlbum(rndL, i))
  return { peers, lib }
}

// ── Brute-force reference ─────────────────────────────────────────────────────
// The pre-fix classification: for every peer album, scan the WHOLE library in
// order and take the first albumsMatch. Uses the public albumsMatch/upgradeReason
// exactly as buildShelves did before bucketing. This is the oracle the fast path
// must agree with.
function referenceShelves(peers, library) {
  const libComp = library.map(S.libAlbumToComparable)
  const upgrades = []
  const missing = []
  for (const pa of peers) {
    const peerComp = {
      artist: pa.artist, album: pa.album, lossless: pa.lossless,
      maxBitDepth: pa.maxBitDepth, maxSampleRate: pa.maxSampleRate,
    }
    let match = null
    for (const lc of libComp) { if (S.albumsMatch(peerComp, lc)) { match = lc; break } }
    if (match) {
      const reason = S.upgradeReason(peerComp, match)
      if (reason) upgrades.push({ folderPath: pa.folderPath, kind: reason.kind })
    } else {
      missing.push(pa.folderPath)
    }
  }
  return {
    upgrades: upgrades.map(u => u.folderPath + '|' + u.kind).sort(),
    missing: missing.slice().sort(),
  }
}

test('buildShelves matches a brute-force full-scan reference exactly (snapshot equality)', () => {
  for (const seed of [1, 42, 1337, 90210]) {
    const { peers, lib } = buildCorpus(seed, 300, 400)
    const ref = referenceShelves(peers, lib)
    const shelves = S.buildShelves(peers, lib)
    const gotUp = shelves.upgrades.map(a => a.folderPath + '|' + a.upgrade.kind).sort()
    const gotMiss = shelves.missing.map(a => a.folderPath).sort()
    assert.deepEqual(gotUp, ref.upgrades, `upgrades diverged at seed ${seed}`)
    assert.deepEqual(gotMiss, ref.missing, `missing diverged at seed ${seed}`)
    // Everything holds every peer album regardless of match.
    assert.equal(shelves.everything.length, peers.length, `everything count wrong at seed ${seed}`)
  }
})

test('buildLibraryIndex.findMatch agrees with albumsMatch full-scan per album', () => {
  const { peers, lib } = buildCorpus(7, 250, 300)
  const libComp = lib.map(S.libAlbumToComparable)
  const index = S.buildLibraryIndex(lib)
  for (const pa of peers) {
    const peerComp = { artist: pa.artist, album: pa.album }
    let ref = null
    for (const lc of libComp) { if (S.albumsMatch(peerComp, lc)) { ref = lc; break } }
    const got = index.findMatch(peerComp)
    // Same match identity (compare by album+artist strings; both come from the
    // same libComp objects so a null/non-null and identity agreement is enough).
    assert.equal(!!got, !!ref, `presence disagreed for ${pa.artist} — ${pa.album}`)
    if (got && ref) {
      assert.equal(got.album, ref.album)
      assert.equal(got.artist, ref.artist)
    }
  }
})

test('BENCH: 1,000 peer × 500 library classification completes under 150ms', () => {
  const { peers, lib } = buildCorpus(2024, 1000, 500)
  // One warm run so the normKey cache and JIT are hot the way a real second-open
  // would be; then the measured run.
  S.buildShelves(peers.slice(0, 50), lib)
  const t0 = performance.now()
  const shelves = S.buildShelves(peers, lib)
  const ms = performance.now() - t0
  assert.equal(shelves.everything.length, 1000)
  assert.ok(ms < 150, `matching took ${ms.toFixed(1)}ms, ceiling is 150ms`)
})

test('BENCH cold (no warm-up) still comfortably beats the old multi-second freeze', () => {
  // A fresh corpus and a fresh process would see the cache cold; assert a loose
  // 400ms ceiling so even an unwarmed run proves the freeze is gone (the freeze
  // was ~11s of main-thread blockage on a comparable shape).
  const { peers, lib } = buildCorpus(555, 1000, 500)
  const t0 = performance.now()
  S.buildShelves(peers, lib)
  const ms = performance.now() - t0
  assert.ok(ms < 400, `cold matching took ${ms.toFixed(1)}ms`)
})
