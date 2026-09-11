// Performance + equivalence guards for the peer-library speed wave (W-S1/W-S2).
// A 140,599-file peer library used to cost one synchronous ~2.8s main-thread
// block per tree build (paid at least twice per open: cached open + background
// refresh) and ~2.4s per search keystroke. The fixes live in slsk-shelves.js as
// chunked, budget-yielding twins of the sync builders, plus precomputed search
// indexes and a browse-payload fingerprint for skipping unchanged refreshes.
//
// Locked in here:
//   1. GOLDEN EQUALITY — every chunked builder produces byte-identical output
//      to its sync twin (deepStrictEqual on nasty fixtures: disc folders,
//      mixed shelf+album nodes, case-duplicate folders, root loose files).
//   2. BENCH — on a synthetic 140k-file browse payload, no single synchronous
//      slice of any build stage may exceed 150ms (budget is 24ms; the ceiling
//      leaves CI headroom), and a full search-keystroke pass stays under 150ms.
//   3. FINGERPRINT — identical payloads fingerprint identically, any content
//      mutation changes it, and the shop-ui source keeps the unchanged-refresh
//      skip wired in front of the rebuild.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const S = require('../src/slsk-shelves')
const T = require('../src/slsk-tree')

// ── Deterministic fixture generators ──────────────────────────────────────────
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

// A synthetic slskd browse payload: `dirs` album folders under artist shelves,
// with tags, occasional disc subfolders and the odd non-audio file — the shape
// slskBrowseUser hands the shop.
function makeBrowse(seed, dirCount, filesPerDir) {
  const rnd = mulberry32(seed)
  const directories = []
  for (let i = 0; i < dirCount; i++) {
    const artist = pick(rnd, ARTISTS)
    const album = makeTitle(rnd) + ' #' + i
    const year = 1960 + Math.floor(rnd() * 65)
    const lossless = rnd() > 0.3
    const ext = lossless ? 'flac' : 'mp3'
    const hi = lossless && rnd() > 0.6
    const base = `Music\\${artist}\\${artist} - ${album} (${year}) [${ext.toUpperCase()}]`
    const disc = rnd() > 0.9 ? `${base}\\CD1` : base
    const files = []
    for (let f = 0; f < filesPerDir; f++) {
      files.push({
        filename: `${disc}\\${String(f + 1).padStart(2, '0')} - ${pick(rnd, WORDS)} ${pick(rnd, WORDS)}.${ext}`,
        size: 10000000 + Math.floor(rnd() * 40000000),
        bitDepth: lossless ? (hi ? 24 : 16) : 0,
        sampleRate: lossless ? (hi ? 96000 : 44100) : 0,
      })
    }
    if (rnd() > 0.85) files.push({ filename: `${disc}\\cover.jpg`, size: 500000 })
    directories.push({ name: disc, files })
  }
  return directories
}

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
function makeLibrary(seed, n) {
  const rnd = mulberry32(seed)
  const lib = []
  for (let i = 0; i < n; i++) lib.push(makeLibAlbum(rnd, i))
  return lib
}

// A hand-built nasty fixture: wrapper folder, disc subfolders, a mixed node
// (own loose audio AND real subfolders), case-duplicate folders, forward
// slashes, a below-threshold single-file folder, and non-audio noise.
function nastyBrowse() {
  return [
    { name: 'Shared\\Music\\Opeth\\Blackwater Park (2001) [FLAC]\\CD1',
      files: [
        { filename: 'Shared\\Music\\Opeth\\Blackwater Park (2001) [FLAC]\\CD1\\01 The Leper Affinity.flac', size: 41000000, bitDepth: 16, sampleRate: 44100 },
        { filename: 'Shared\\Music\\Opeth\\Blackwater Park (2001) [FLAC]\\CD1\\02 Bleak.flac', size: 39000000, bitDepth: 16, sampleRate: 44100 },
      ] },
    { name: 'Shared\\Music\\Opeth\\Blackwater Park (2001) [FLAC]\\CD2',
      files: [
        { filename: 'Shared\\Music\\Opeth\\Blackwater Park (2001) [FLAC]\\CD2\\01 Harvest (live).flac', size: 30000000, bitDepth: 16, sampleRate: 44100 },
      ] },
    // Mixed node: loose audio directly in the artist shelf that ALSO has albums.
    { name: 'Shared\\Music\\Dark The Suns',
      files: [
        { filename: 'Shared\\Music\\Dark The Suns\\rare demo 1.mp3', size: 5000000 },
        { filename: 'Shared\\Music\\Dark The Suns\\rare demo 2.mp3', size: 5100000 },
      ] },
    // Case-duplicate of the shelf above (Windows-insensitive merge).
    { name: 'Shared\\Music\\dark the suns\\In Darkness Comes Beauty (2007)',
      files: [
        { filename: 'Shared\\Music\\dark the suns\\In Darkness Comes Beauty (2007)\\01 Ghosts.mp3', size: 8000000, bitRate: 320 },
        { filename: 'Shared\\Music\\dark the suns\\In Darkness Comes Beauty (2007)\\02 Alone.mp3', size: 8100000, bitRate: 320 },
      ] },
    // Forward slashes and a lone file (below minTracks).
    { name: 'Shared/Loose/One Track Wonder',
      files: [{ filename: 'Shared/Loose/One Track Wonder/only.flac', size: 20000000, bitDepth: 24, sampleRate: 96000 }] },
    // Non-audio only.
    { name: 'Shared\\Docs', files: [{ filename: 'Shared\\Docs\\readme.txt', size: 100 }] },
  ]
}

// Measures the length of every synchronous slice between yields of a chunked
// run. The injected yieldFn resolves on a microtask (fast for tests); what we
// assert is the SYNC time between yields, which is exactly what would block the
// main thread in the app.
function sliceRecorder() {
  const slices = []
  let last = performance.now()
  return {
    slices,
    yieldFn: async () => {
      slices.push(performance.now() - last)
      await Promise.resolve()
      last = performance.now()
    },
    finish() { slices.push(performance.now() - last); return slices },
  }
}
function maxSlice(rec) { return Math.max(...rec.finish()) }

// The CI-safe ceiling. Budget is 24ms; anything under 150ms proves the multi-
// second block is gone even on a slow shared runner (roadmap target: <150ms).
const SLICE_CEILING = 150

// ── Golden equality ───────────────────────────────────────────────────────────
test('buildTreeChunked output is deep-identical to slsk-tree buildTree', async () => {
  for (const dirs of [nastyBrowse(), makeBrowse(11, 200, 8), []]) {
    const ref = T.buildTree(dirs)
    const got = await S.buildTreeChunked(dirs)
    assert.deepStrictEqual(got, ref)
  }
})

test('extractAlbumsChunked output is deep-identical to extractAlbums', async () => {
  for (const dirs of [nastyBrowse(), makeBrowse(23, 300, 6)]) {
    const tree = T.buildTree(dirs)
    const ref = S.extractAlbums(tree, { minTracks: 2 })
    const got = await S.extractAlbumsChunked(tree, { minTracks: 2 })
    assert.deepStrictEqual(got, ref)
  }
  // Root-level loose files fallback.
  const rootLoose = T.buildTree([{ name: '', files: [
    { filename: 'a.flac', size: 1 }, { filename: 'b.flac', size: 2 }] }])
  assert.deepStrictEqual(
    await S.extractAlbumsChunked(rootLoose, { minTracks: 2 }),
    S.extractAlbums(rootLoose, { minTracks: 2 }))
})

test('buildShelvesChunked classification, order and stats equal buildShelves exactly', async () => {
  const detectSurround = (s) => /5\.1|surround|dts/i.test(s) ? { label: '5.1' } : null
  for (const seed of [3, 77]) {
    const tree = T.buildTree(makeBrowse(seed, 400, 6))
    const albums = S.extractAlbums(tree, { minTracks: 2 })
    const lib = makeLibrary(seed ^ 0x5f5f, 300)
    const ref = S.buildShelves(albums, lib, { detectSurround })
    const got = await S.buildShelvesChunked(albums, lib, { detectSurround })
    assert.deepStrictEqual(got.upgrades.map(a => a.folderPath + '|' + a.upgrade.kind),
      ref.upgrades.map(a => a.folderPath + '|' + a.upgrade.kind))
    assert.deepStrictEqual(got.missing.map(a => a.folderPath), ref.missing.map(a => a.folderPath))
    assert.deepStrictEqual(got.everything.map(a => a.folderPath), ref.everything.map(a => a.folderPath),
      `everything order diverged at seed ${seed} (collator vs localeCompare?)`)
    assert.deepStrictEqual(got.surround.map(a => a.folderPath), ref.surround.map(a => a.folderPath))
    assert.deepStrictEqual(got.hires.map(a => a.folderPath), ref.hires.map(a => a.folderPath))
    assert.deepStrictEqual(got.stats, ref.stats)
  }
})

test('buildShelvesChunked markInLibrary stamps the same inLibrary the old two-pass path did', async () => {
  const tree = T.buildTree(makeBrowse(9, 300, 5))
  const albums = S.extractAlbums(tree, { minTracks: 2 })
  const lib = makeLibrary(4242, 250)
  // The old shop path: a separate buildLibraryIndex sweep with bare identities.
  const libIndex = S.buildLibraryIndex(lib)
  const ref = albums.map(a => !!libIndex.findMatch({ artist: a.artist, album: a.album }))
  await S.buildShelvesChunked(albums, lib, { markInLibrary: true })
  assert.deepStrictEqual(albums.map(a => a.inLibrary), ref)
})

test('searchTreeIndex matches searchTree exactly, including the limit cap', async () => {
  const tree = T.buildTree(makeBrowse(31, 250, 6))
  const index = await S.buildTreeSearchIndexChunked(tree)
  // 'music' cascades through every path (dir-path matching), 'dark' mixes dir
  // and file hits, '.flac' is file-heavy, 'zzznope' misses.
  for (const q of ['music', 'dark', '.flac', 'moon', 'zzznope', '']) {
    for (const limit of [5, 120, 300]) {
      assert.deepStrictEqual(S.searchTreeIndex(index, q, limit), T.searchTree(tree, q, limit),
        `diverged for query "${q}" limit ${limit}`)
    }
  }
  // Nasty fixture too (case-merged dirs, forward slashes).
  const nasty = T.buildTree(nastyBrowse())
  const nastyIdx = await S.buildTreeSearchIndexChunked(nasty)
  for (const q of ['dark', 'cd1', 'harvest', 'only']) {
    assert.deepStrictEqual(S.searchTreeIndex(nastyIdx, q, 300), T.searchTree(nasty, q, 300))
  }
})

test('buildAlbumSearchIndexChunked haystacks equal the on-the-fly per-keystroke strings', async () => {
  const tree = T.buildTree(makeBrowse(5, 150, 5))
  const albums = S.extractAlbums(tree, { minTracks: 2 })
  const idx = await S.buildAlbumSearchIndexChunked(albums)
  assert.equal(idx.hays.length, albums.length)
  albums.forEach((a, i) => {
    assert.equal(idx.hays[i], `${a.artist} ${a.album} ${a.folderName}`.toLowerCase())
  })
  // Folder map resolves to the FIRST album with that folder path (old
  // shFlat.find semantics).
  for (const a of albums) {
    const hit = idx.byFolderLower.get(a.folderPath.toLowerCase())
    assert.equal(hit, albums.find(x => x.folderPath.toLowerCase() === a.folderPath.toLowerCase()))
  }
})

// ── Fingerprint (the unchanged-refresh skip) ──────────────────────────────────
test('fingerprintBrowse: identical payloads match, any content mutation differs, chunked equals sync', async () => {
  const dirs = makeBrowse(66, 120, 6)
  const copy = JSON.parse(JSON.stringify(dirs))
  const fp = S.fingerprintBrowse(dirs)
  assert.equal(S.fingerprintBrowse(copy), fp, 'identical content must fingerprint identically')
  assert.equal(await S.fingerprintBrowseChunked(dirs), fp, 'chunked must equal sync')

  const mutSize = JSON.parse(JSON.stringify(dirs)); mutSize[40].files[2].size += 1
  const mutName = JSON.parse(JSON.stringify(dirs)); mutName[7].files[0].filename += 'x'
  const mutDir = JSON.parse(JSON.stringify(dirs)); mutDir.push({ name: 'New\\Folder', files: [] })
  const mutDrop = JSON.parse(JSON.stringify(dirs)); mutDrop[3].files.pop()
  for (const [label, m] of [['size', mutSize], ['rename', mutName], ['new dir', mutDir], ['removed file', mutDrop]]) {
    assert.notEqual(S.fingerprintBrowse(m), fp, `${label} mutation must change the fingerprint`)
  }
})

test('chunked builders abort cleanly (resolve null) when shouldAbort trips', async () => {
  const dirs = makeBrowse(2, 500, 8)
  let yielded = false
  const abortAfterFirstYield = {
    budgetMs: 1,
    yieldFn: async () => { yielded = true },
    shouldAbort: () => yielded,
  }
  assert.equal(await S.buildTreeChunked(dirs, abortAfterFirstYield), null)
  yielded = false
  const tree = T.buildTree(dirs)
  assert.equal(await S.extractAlbumsChunked(tree, abortAfterFirstYield), null)
  yielded = false
  assert.equal(await S.buildShelvesChunked(S.extractAlbums(tree), makeLibrary(1, 50), abortAfterFirstYield), null)
  yielded = false
  assert.equal(await S.buildTreeSearchIndexChunked(tree, abortAfterFirstYield), null)
  yielded = false
  assert.equal(await S.fingerprintBrowseChunked(dirs, abortAfterFirstYield), null)
})

// ── BENCH: the 140k-file library ──────────────────────────────────────────────
// One shared corpus at Marlowe242 scale: ~7,030 folders × 20 audio files
// ≈ 140,600 files. Built once; the stages run in the real pipeline order.
test('BENCH 140k files: every build stage stays under the slice ceiling and search under 150ms', async () => {
  const dirs = makeBrowse(140599, 7030, 20)
  const lib = makeLibrary(90210, 2000)

  // Stage 1: tree build (was one 2,785ms synchronous block).
  let rec = sliceRecorder()
  const tree = await S.buildTreeChunked(dirs, { yieldFn: rec.yieldFn })
  const treeMax = maxSlice(rec)
  assert.ok(tree.fileCount >= 140000, `corpus too small: ${tree.fileCount} files`)
  assert.deepStrictEqual(
    { fileCount: tree.fileCount, totalSize: tree.totalSize, topDirs: tree.dirs.size },
    (() => { const r = T.buildTree(dirs); return { fileCount: r.fileCount, totalSize: r.totalSize, topDirs: r.dirs.size } })(),
    'chunked tree invariants must match the sync build at scale')
  assert.ok(treeMax < SLICE_CEILING, `tree build slice ${treeMax.toFixed(1)}ms >= ${SLICE_CEILING}ms`)

  // Stage 2: album extraction.
  rec = sliceRecorder()
  const albums = await S.extractAlbumsChunked(tree, { minTracks: 2, yieldFn: rec.yieldFn })
  const exMax = maxSlice(rec)
  assert.ok(albums.length > 5000, `expected thousands of albums, got ${albums.length}`)
  assert.ok(exMax < SLICE_CEILING, `extract slice ${exMax.toFixed(1)}ms >= ${SLICE_CEILING}ms`)

  // Stage 3: shelf classification against a 2,000-album library.
  rec = sliceRecorder()
  const shelves = await S.buildShelvesChunked(albums, lib, {
    detectSurround: (s) => /5\.1|surround/i.test(s) ? { label: '5.1' } : null,
    markInLibrary: true, yieldFn: rec.yieldFn,
  })
  const shMax = maxSlice(rec)
  assert.equal(shelves.everything.length, albums.length)
  assert.ok(shMax < SLICE_CEILING, `shelves slice ${shMax.toFixed(1)}ms >= ${SLICE_CEILING}ms`)

  // Stage 4: search indexes.
  rec = sliceRecorder()
  const treeIdx = await S.buildTreeSearchIndexChunked(tree, { yieldFn: rec.yieldFn })
  const tiMax = maxSlice(rec)
  assert.ok(tiMax < SLICE_CEILING, `tree-index slice ${tiMax.toFixed(1)}ms >= ${SLICE_CEILING}ms`)
  rec = sliceRecorder()
  const albumIdx = await S.buildAlbumSearchIndexChunked(albums, { yieldFn: rec.yieldFn })
  const aiMax = maxSlice(rec)
  assert.ok(aiMax < SLICE_CEILING, `album-index slice ${aiMax.toFixed(1)}ms >= ${SLICE_CEILING}ms`)

  // Stage 5: fingerprint (the refresh gate).
  rec = sliceRecorder()
  const fp = await S.fingerprintBrowseChunked(dirs, { yieldFn: rec.yieldFn })
  const fpMax = maxSlice(rec)
  assert.ok(fp && fp.length > 4)
  assert.ok(fpMax < SLICE_CEILING, `fingerprint slice ${fpMax.toFixed(1)}ms >= ${SLICE_CEILING}ms`)

  // The keystroke: album-haystack scan + capped tree search + owner resolution
  // — the full renderShelvesSearch data pass (was 2,387ms per debounce).
  for (const q of ['dark', 'moon', 'blackwater park']) {
    const ql = q.toLowerCase()
    const t0 = performance.now()
    const albumHits = []
    for (let i = 0; i < albums.length; i++) {
      if (albumIdx.hays[i].includes(ql)) albumHits.push(albums[i])
    }
    const fileHits = S.searchTreeIndex(treeIdx, q, 120).filter(h => h.type === 'file')
    const extra = new Set(albumHits.map(a => a.folderPath.toLowerCase()))
    for (const h of fileHits) {
      const owner = albumIdx.byFolderLower.get(String(h.path).toLowerCase())
      if (owner && !extra.has(owner.folderPath.toLowerCase())) {
        albumHits.push(owner); extra.add(owner.folderPath.toLowerCase())
      }
    }
    const ms = performance.now() - t0
    assert.ok(albumHits.length > 0, `query "${q}" found nothing — fixture drifted`)
    assert.ok(ms < 150, `keystroke pass for "${q}" took ${ms.toFixed(1)}ms, ceiling is 150ms`)
  }
})

// ── Shop-ui wiring: the unchanged-refresh skip and the chunked entry points ───
// slsk-shop-ui.js cannot be imported in Node (DOM at call time), so — like the
// wiring guards — these assert the source keeps the invariants.
const SHOP = fs.readFileSync(path.join(__dirname, '../src/slsk-shop-ui.js'), 'utf8')

test('the shop opens through the chunked tree build with a progress line', () => {
  assert.match(SHOP, /await SH\.buildTreeChunked\(res\.directories/,
    'the open path must use the chunked build')
  assert.match(SHOP, /onProgress: \(done, total\)/, 'with the loading-line progress affordance')
  assert.match(SHOP, /T\.buildTree\(res\.directories \|\| \[\]\)/,
    'and keep the sync fallback for an old shelves module')
})

test('a content-unchanged background refresh skips the rebuild entirely', () => {
  const handler = SHOP.slice(SHOP.indexOf('onSlskBrowseRefreshed'))
  assert.match(handler, /fingerprintBrowseChunked\(fresh\.directories/,
    'the fresh payload is fingerprinted before any rebuild')
  const skip = handler.indexOf('freshFp && shBrowseFp && freshFp === shBrowseFp')
  const rebuild = handler.indexOf('buildFromTree({ refresh: true })')
  assert.ok(skip > -1, 'the unchanged-content comparison must exist')
  assert.ok(rebuild > -1, 'the changed-content path still rebuilds')
  assert.ok(skip < rebuild, 'the skip gate must sit in front of the rebuild')
  assert.match(handler.slice(0, rebuild), /return\s*\n?\s*\}/,
    'the unchanged branch returns without rebuilding')
})

test('the keystroke paths read the precomputed indexes with the old scans as fallback', () => {
  assert.match(SHOP, /SH\.searchTreeIndex\(shTreeSearchIndex, q, 120\)/,
    'shelves search files via the index')
  assert.match(SHOP, /T\.searchTree\(tree, q, 120\)/, 'with the direct-scan fallback')
  assert.match(SHOP, /SH\.searchTreeIndex\(shTreeSearchIndex, searching, 300\)/,
    'folders search via the index')
  assert.match(SHOP, /shAlbumByFolder\s*\n?\s*\? shAlbumByFolder\.get/,
    'file hits resolve owners through the O(1) folder map')
  assert.match(SHOP, /const gen = \+\+_buildGen/,
    'rebuilds are generation-guarded so stale chunked slices abort')
})
