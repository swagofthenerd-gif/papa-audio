# Peer Library Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Soulseek peer-library explorer with one page that has three modes (Hunt ledger, Wander shelves, Folders column browser) and one shared album dossier with rip verification, Discogs reception, and Wikipedia story.

**Architecture:** New renderer modules (`slsk-room-ui.js` shell, `slsk-hunt.js`, `slsk-wander.js`, `slsk-columns.js`, `slsk-dossier.js`) sit on top of the untouched engines (`slsk-tree.js`, `slsk-shelves.js`, `slsk-compare.js`, browse cache). Pure models are separate from renderers so they test in node. Three new main-process IPC handlers (`slsk-verify-rip`, `discogs-album`, `musicbrainz-artist-tags`) add the network/ffmpeg work. A setting switches back to the old shop.

**Tech Stack:** Electron main + plain-script renderer (no bundler; every `src/*.js` page script shares ONE global scope), `node --test`, ffmpeg/ffprobe on PATH, slskd HTTP API, MusicBrainz (keyless, 1 req/s), Discogs (personal token), Wikipedia via the existing `artist-info` handler.

**Spec:** `docs/superpowers/specs/2026-09-19-peer-library-redesign-design.md`

## Global Constraints

- Work in the worktree `/home/shaharyar/flac-player-wt-explorer` on branch `feat/peer-library-redesign`. Never touch `/home/shaharyar/flac-player` (the main checkout). `node_modules` is a symlink there already.
- Page scripts share one top-level scope. Every new file wraps its body in `;(function () { ... })()` and publishes exactly one `window.Papa<Name>` global plus `module.exports` for node. No top-level `const`/`function` outside the wrapper.
- No `<audio>` element, no Web Audio. Playback goes through the existing `startPreview` / `playCurrentTrack` deps.
- Copy is plain words in the user's voice ("not yours", "upgrade · 4/5 tracks"). No jargon in UI text.
- Every IPC failure returns `{ ok: false, reason: '<sentence the UI shows verbatim>' }`, never throws to the renderer.
- Run the whole suite before every commit: `node --test 'test/**/*.test.js'`. It must stay green.
- Commit after every task with a one-line subject in the repo's style (plain sentence, what changed and why) and the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Mutation-check every new pure test once: break the rule under test, confirm red, restore.
- The label colours and scope tokens come from `src/slsk-explorer.css` (`--gold`, `--plum`, `--green`, `--stone` under `.slsk-explore`). The new stylesheet declares the same four under `.slsk-room` so it works even if the old file is later deleted.

---

## Shapes you will consume (from the existing engines)

Peer album (from `PapaSlskShelves.extractAlbums(tree, { minTracks: 2 })`):

```js
{ artist, album, year|null, folderName, folderPath, trackCount, totalSize,
  losslessCount, lossless, isHiRes, maxBitDepth, maxSampleRate, surround, topExt,
  files: [{ name, fullPath, size, bitDepth, sampleRate, bitRate, length }] }
```

Shelves (from `buildShelves(peerAlbums, state.library, { detectSurround })`):

```js
{ upgrades: [album + { upgrade: { kind, yours, theirs }, matchedLibId }],
  missing: [album], surround: [album], hires: [album], everything: [album],
  stats: { albums, tracks, size, losslessPct, hiRes, surround } }
```

Library album (`state.library[i]`): `{ id, name, artist, artPath, year, tracks: [{ filePath, bitsPerSample, sampleRate, channels }] }`.

Tree (`PapaSlskTree`): `buildTree(directories)`, `getNode(root, path)`, `listDir(root, path, { sort, audioOnly })` → `{ node, dirs: [{ name, path, fileCount, totalSize, subdirCount }], files: [...] }`, `breadcrumbs(path)` → `[{ name, path }]`, `AUDIO_RE`.

Deps object handed to the shell (same as `renderSoulseekExplore` passes today): `{ host, onClose, _mgConfirm, _scheduleLibRescan, _slskCardDownloads, _slskCardKey, _slskCardProgress, _slskDirQuality, _slskEnqueue, esc, hideContextMenu, navigate, playCurrentTrack, showSnackbar, slsk, startPreview, state, openSlskChat }`.

`_slskEnqueue(items)` takes `[{ username, filename, size }]` and resolves `{ ok, added }`. `startPreview({ username, filename, title })`. `window.api.slskBrowseUser({ username })` → `{ directories, fromCache, cachedAt, newDirs }`. `window.api.artistInfo({ artist })` → `{ bio, similar }`. `window.api.fetchAlbumArt({ albumId, artist, album })` → art path or null.

---

### Task 1: Rip-check parser and verdict (pure)

**Files:**
- Create: `src/rip-check.js`
- Test: `test/rip-check.test.js`

**Interfaces:**
- Produces: `parseProbe(stdoutText) → { sampleRate, bitDepth, codec }`, `parseAstats(stderrText) → { measuredBits, dynamicRange }`, `parseCeiling(stderrText) → ceilingHz|null`, `verdict({ declaredRate, declaredBits, measuredBits, ceilingHz, ext }) → { kind: 'genuine'|'upsampled'|'padded'|'transcoded'|'unknown', text }`, `pickTrack(files) → file`.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test')
const assert = require('node:assert')
const R = require('../src/rip-check')

test('parseProbe reads rate, bits and codec from ffprobe key=value output', () => {
  const out = 'codec_name=flac\nsample_rate=96000\nbits_per_raw_sample=24\n'
  assert.deepEqual(R.parseProbe(out), { sampleRate: 96000, bitDepth: 24, codec: 'flac' })
})

test('parseAstats takes the Overall block, not channel 1', () => {
  const err = [
    '[Parsed_astats_0 @ 0x1] Channel: 1', '[Parsed_astats_0 @ 0x1] Bit depth: 16/16',
    '[Parsed_astats_0 @ 0x1] Dynamic range: 9.1',
    '[Parsed_astats_0 @ 0x1] Overall', '[Parsed_astats_0 @ 0x1] Bit depth: 24/24',
    '[Parsed_astats_0 @ 0x1] Dynamic range: 13.4',
  ].join('\n')
  assert.deepEqual(R.parseAstats(err), { measuredBits: 24, dynamicRange: 13.4 })
})

test('parseCeiling returns the highest band with energy above the floor', () => {
  // showspectrum is not used; we use a bank of highpass+volumedetect passes.
  const err = 'band=16000 mean_volume: -31.0 dB\nband=20000 mean_volume: -48.2 dB\nband=24000 mean_volume: -91.0 dB\nband=30000 mean_volume: -91.0 dB\n'
  assert.equal(R.parseCeiling(err), 20000)
})

test('verdict: 24/96 declared with a 20 kHz ceiling is upsampled', () => {
  const v = R.verdict({ declaredRate: 96000, declaredBits: 24, measuredBits: 24, ceilingHz: 20000, ext: 'flac' })
  assert.equal(v.kind, 'upsampled')
  assert.match(v.text, /really/)
})

test('verdict: 24-bit declared but 16 measured is padded', () => {
  const v = R.verdict({ declaredRate: 44100, declaredBits: 24, measuredBits: 16, ceilingHz: 20000, ext: 'flac' })
  assert.equal(v.kind, 'padded')
})

test('verdict: lossless with a 16 kHz ceiling is likely transcoded', () => {
  const v = R.verdict({ declaredRate: 44100, declaredBits: 16, measuredBits: 16, ceilingHz: 16000, ext: 'flac' })
  assert.equal(v.kind, 'transcoded')
})

test('verdict: a 24/96 that reaches 40 kHz is genuine', () => {
  const v = R.verdict({ declaredRate: 96000, declaredBits: 24, measuredBits: 24, ceilingHz: 40000, ext: 'flac' })
  assert.equal(v.kind, 'genuine')
  assert.equal(v.text, 'genuine 24/96')
})

test('pickTrack prefers the longest audio file under 80 MB', () => {
  const files = [
    { name: 'a.flac', size: 30e6, length: 200 },
    { name: 'b.flac', size: 79e6, length: 600 },
    { name: 'c.flac', size: 200e6, length: 900 },
    { name: 'cover.jpg', size: 1e5 },
  ]
  assert.equal(R.pickTrack(files).name, 'b.flac')
})

test('pickTrack falls back to the smallest when everything is over 80 MB', () => {
  const files = [{ name: 'a.flac', size: 120e6, length: 1 }, { name: 'b.flac', size: 90e6, length: 1 }]
  assert.equal(R.pickTrack(files).name, 'b.flac')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/shaharyar/flac-player-wt-explorer && node --test test/rip-check.test.js`
Expected: FAIL, `Cannot find module '../src/rip-check'`.

- [ ] **Step 3: Write the implementation**

```js
'use strict'
// Rip verification: turns ffprobe/ffmpeg text into one honest verdict about a
// file the peer claims is lossless. Pure — nothing here spawns anything, so
// every verdict rule is testable without audio. main.js owns the download,
// the ffmpeg calls and the cleanup (slsk-verify-rip).

const AUDIO_RE = /\.(flac|wav|aiff?|aif|ape|wv|alac|dsf|dff|mp3|m4a|aac|ogg|opus)$/i
const MAX_SAMPLE_BYTES = 80 * 1024 * 1024
// Bands the ceiling probe measures (Hz). main runs one highpass+volumedetect
// per band; parseCeiling reads the highest band still carrying real signal.
const BANDS = [16000, 18000, 20000, 22000, 24000, 30000, 40000]
// Below this the band is silence as far as a rip is concerned.
const FLOOR_DB = -85

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null }

function parseProbe(text) {
  const s = String(text || '')
  const get = k => { const m = s.match(new RegExp('^' + k + '=(.+)$', 'm')); return m ? m[1].trim() : null }
  return {
    sampleRate: num(get('sample_rate')),
    bitDepth: num(get('bits_per_raw_sample')) || num(get('bits_per_sample')),
    codec: get('codec_name'),
  }
}

// astats prints per-channel blocks BEFORE Overall; take the LAST match so the
// figure is the whole file, not channel 1.
function last(text, re) {
  let m, found = null
  const g = new RegExp(re.source, 'g')
  while ((m = g.exec(text)) !== null) found = m[1]
  return found
}

function parseAstats(text) {
  const s = String(text || '')
  const bits = last(s, /Bit depth: (\d+)\/\d+/)
  const dr = last(s, /Dynamic range: ([\d.]+)/)
  return { measuredBits: num(bits), dynamicRange: num(dr) }
}

function parseCeiling(text) {
  const s = String(text || '')
  let ceiling = null
  const re = /band=(\d+)[^\n]*mean_volume: (-?[\d.]+) dB/g
  let m
  while ((m = re.exec(s)) !== null) {
    const band = Number(m[1]), db = Number(m[2])
    if (db > FLOOR_DB && (ceiling === null || band > ceiling)) ceiling = band
  }
  return ceiling
}

function fmt(bits, rate) {
  return (bits || '?') + '/' + (rate ? Math.round(rate / 1000) : '?')
}

function verdict({ declaredRate, declaredBits, measuredBits, ceilingHz, ext }) {
  const lossless = /^(flac|wav|aiff?|aif|ape|wv|alac|dsf|dff)$/i.test(String(ext || ''))
  const rate = num(declaredRate), bits = num(declaredBits), mbits = num(measuredBits), ceil = num(ceilingHz)
  if (ceil === null || rate === null) return { kind: 'unknown', text: 'could not measure this file' }
  // Declared hi-res but nothing above the CD band: an upsample.
  if (rate >= 88200 && ceil <= 22000) {
    return { kind: 'upsampled', text: 'upsampled, really ~' + fmt(mbits && mbits <= 16 ? 16 : bits, 44100) }
  }
  if (bits !== null && bits >= 24 && mbits !== null && mbits <= 16) {
    return { kind: 'padded', text: 'padded 16-bit, labelled ' + bits + '-bit' }
  }
  if (lossless && ceil <= 16000) {
    return { kind: 'transcoded', text: 'likely transcoded from lossy (nothing above ' + Math.round(ceil / 1000) + ' kHz)' }
  }
  return { kind: 'genuine', text: 'genuine ' + fmt(bits, rate) }
}

function pickTrack(files) {
  const audio = (files || []).filter(f => AUDIO_RE.test(f.name || f.filename || ''))
  if (!audio.length) return null
  const small = audio.filter(f => (Number(f.size) || 0) <= MAX_SAMPLE_BYTES)
  if (small.length) return small.slice().sort((a, b) => (Number(b.length) || 0) - (Number(a.length) || 0))[0]
  return audio.slice().sort((a, b) => (Number(a.size) || 0) - (Number(b.size) || 0))[0]
}

module.exports = { parseProbe, parseAstats, parseCeiling, verdict, pickTrack, BANDS, FLOOR_DB, MAX_SAMPLE_BYTES }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/rip-check.test.js`
Expected: 9 pass.

- [ ] **Step 5: Mutation check, then commit**

Change `rate >= 88200 && ceil <= 22000` to `ceil <= 2000`, run, confirm the upsampled test fails, restore.

```bash
git add src/rip-check.js test/rip-check.test.js
git commit -m "Rip check: the verdict rules for upsampled, padded and transcoded rips, pure and tested"
```

---

### Task 2: Hunt ledger model (pure)

**Files:**
- Create: `src/slsk-hunt.js`
- Test: `test/slsk-hunt.test.js`

**Interfaces:**
- Consumes: shelves object from `buildShelves`, `state.library`, `PapaSlskShelves.qualityString(album)`.
- Produces: `window.PapaSlskHunt` = `{ buildRows(shelves, library) → rows[], verdictText(row) → string, sortRows(rows, key, dir) → rows[], filterRows(rows, query) → rows[], tiles(shelves, freshCount) → [{ id, n, label }] }`. Row: `{ album, key, theirs, yours, verdictKind, verdictText, size, year, title, artist, tier }`. `tier` ∈ `'hires'|'surround'|'lossless'|'lossy'`.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test')
const assert = require('node:assert')
const H = require('../src/slsk-hunt')

const mk = (o) => ({ artist: 'A', album: 'X', year: 1975, folderPath: 'A\\X', trackCount: 5, totalSize: 1e9,
  lossless: true, isHiRes: true, maxBitDepth: 24, maxSampleRate: 96000, surround: false, files: [], ...o })
const lib = [{ id: 'l1', name: 'X', artist: 'A', tracks: [{ bitsPerSample: 16, sampleRate: 44100 }] }]

test('an upgrade row says how many tracks are better and what yours is', () => {
  const shelves = { upgrades: [{ ...mk(), upgrade: { kind: 'bitdepth', yours: 'FLAC 16/44', theirs: 'FLAC 24/96', better: 4, of: 5 }, matchedLibId: 'l1' }],
    missing: [], surround: [], hires: [], everything: [mk()], stats: {} }
  const rows = H.buildRows(shelves, lib)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].verdictKind, 'upgrade')
  assert.equal(rows[0].verdictText, 'upgrade · 4/5 tracks')
  assert.equal(rows[0].yours, 'FLAC 16/44')
  assert.equal(rows[0].tier, 'hires')
})

test('surround you lack beats a plain upgrade in the words', () => {
  const a = { ...mk({ surround: true }), upgrade: { kind: 'surround', yours: 'FLAC 16/44 stereo', theirs: 'FLAC 24/96 5.1' }, matchedLibId: 'l1' }
  const rows = H.buildRows({ upgrades: [a], missing: [], surround: [a], hires: [], everything: [a], stats: {} }, lib)
  assert.equal(rows[0].verdictText, 'surround you lack')
  assert.equal(rows[0].tier, 'surround')
})

test('missing rows say not in library; matched non-upgrades say same or yours is better', () => {
  const missing = mk({ album: 'Y' })
  const same = mk({ album: 'X', maxBitDepth: 16, maxSampleRate: 44100, isHiRes: false })
  const worse = mk({ album: 'X', lossless: false, isHiRes: false, maxBitDepth: 0, maxSampleRate: 44100, topExt: 'mp3' })
  const rows = H.buildRows({ upgrades: [], missing: [missing], surround: [], hires: [], everything: [missing, same, worse], stats: {} }, lib)
  const byT = Object.fromEntries(rows.map(r => [r.album.album + r.album.lossless, r.verdictText]))
  assert.equal(byT['Ytrue'], 'not in library')
  assert.equal(byT['Xtrue'], 'same as yours')
  assert.equal(byT['Xfalse'], 'yours is better')
})

test('sortRows by verdict puts upgrades first, then missing, then the rest', () => {
  const rows = [{ verdictKind: 'same', title: 'a' }, { verdictKind: 'upgrade', title: 'b' }, { verdictKind: 'missing', title: 'c' }]
  assert.deepEqual(H.sortRows(rows, 'verdict', 'asc').map(r => r.title), ['b', 'c', 'a'])
})

test('filterRows matches artist or title, case-insensitively', () => {
  const rows = [{ title: 'Wish You Were Here', artist: 'Pink Floyd' }, { title: 'Aja', artist: 'Steely Dan' }]
  assert.equal(H.filterRows(rows, 'floyd').length, 1)
  assert.equal(H.filterRows(rows, '').length, 2)
})

test('tiles carry the four counts', () => {
  const t = H.tiles({ upgrades: [1, 2], missing: [1], surround: [], hires: [] }, 3)
  assert.deepEqual(t.map(x => [x.id, x.n]), [['upgrades', 2], ['missing', 1], ['surround', 0], ['new', 3]])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/slsk-hunt.test.js` — Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

```js
// Hunt mode's ledger: one row per peer album with a plain-words verdict. Pure —
// takes the shelves object buildShelves already made and the library, returns
// rows. The renderer in slsk-room-ui.js only paints these.
;(function () {
  const SH = () => (typeof window !== 'undefined' && window.PapaSlskShelves) ||
    (typeof require === 'function' ? require('./slsk-shelves.js') : null)

  const VERDICT_ORDER = { upgrade: 0, surround: 0, missing: 1, same: 2, worse: 3 }

  function tierOf(a) {
    if (a.surround) return 'surround'
    if (a.isHiRes) return 'hires'
    if (a.lossless) return 'lossless'
    return 'lossy'
  }

  function keyOf(a) { return String(a.folderPath || a.folderName || '').toLowerCase() }

  function qualityOf(a) {
    const s = SH()
    return s && s.qualityString ? s.qualityString(a) : ''
  }

  // The verdict for a matched, non-upgrade album: same quality or worse than mine.
  function sameOrWorse(a, lib) {
    const mine = lib || {}
    const mineLossless = (mine.tracks || []).some(t => /\.(flac|wav|aiff?|ape|wv|alac|dsf|dff)$/i.test(t.filePath || t.path || ''))
    if (a.lossless && !mineLossless) return 'upgrade'
    if (!a.lossless && mineLossless) return 'worse'
    return 'same'
  }

  function verdictText(row) {
    switch (row.verdictKind) {
      case 'surround': return 'surround you lack'
      case 'upgrade': {
        const u = row.album.upgrade || {}
        if (u.better != null && u.of != null) return 'upgrade · ' + u.better + '/' + u.of + ' tracks'
        return 'upgrade · all tracks'
      }
      case 'missing': return 'not in library'
      case 'worse': return 'yours is better'
      default: return 'same as yours'
    }
  }

  function buildRows(shelves, library) {
    const libById = new Map((library || []).map(l => [l.id, l]))
    const upgradeKeys = new Map((shelves.upgrades || []).map(a => [keyOf(a), a]))
    const missingKeys = new Set((shelves.missing || []).map(keyOf))
    const s = SH()
    const rows = []
    for (const a of shelves.everything || []) {
      const key = keyOf(a)
      const up = upgradeKeys.get(key)
      let verdictKind, yours = '—', lib = null
      if (up) {
        lib = libById.get(up.matchedLibId) || null
        verdictKind = (up.upgrade && up.upgrade.kind === 'surround') ? 'surround' : 'upgrade'
        yours = (up.upgrade && up.upgrade.yours) || (lib && s ? s.qualityString(s.libAlbumToComparable(lib)) : '—')
      } else if (missingKeys.has(key)) {
        verdictKind = 'missing'
      } else {
        // Matched but not an upgrade: find my copy the same way the shelves did.
        const idx = s && s.buildLibraryIndex ? s.buildLibraryIndex(library || []) : null
        const m = idx ? idx.findMatch(s.albumComparable(a)) : null
        lib = m && m.ref ? m.ref : null
        verdictKind = sameOrWorse(a, lib)
        yours = lib && s ? s.qualityString(s.libAlbumToComparable(lib)) : '—'
      }
      const row = { album: up || a, key, theirs: qualityOf(a), yours, verdictKind, size: a.totalSize || 0,
        year: a.year || null, title: a.album || a.folderName || '', artist: a.artist || '', tier: tierOf(a), lib }
      row.verdictText = verdictText(row)
      rows.push(row)
    }
    return rows
  }

  function sortRows(rows, key, dir) {
    const sign = dir === 'desc' ? -1 : 1
    const cmp = {
      verdict: (a, b) => (VERDICT_ORDER[a.verdictKind] ?? 9) - (VERDICT_ORDER[b.verdictKind] ?? 9),
      title:   (a, b) => String(a.title).localeCompare(String(b.title)),
      artist:  (a, b) => String(a.artist).localeCompare(String(b.artist)),
      year:    (a, b) => (a.year || 0) - (b.year || 0),
      size:    (a, b) => (a.size || 0) - (b.size || 0),
      theirs:  (a, b) => String(a.theirs).localeCompare(String(b.theirs)),
    }[key] || ((a, b) => 0)
    return rows.slice().sort((a, b) => sign * cmp(a, b) || String(a.title).localeCompare(String(b.title)))
  }

  function filterRows(rows, query) {
    const q = String(query || '').trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r => (r.title + ' ' + r.artist).toLowerCase().includes(q))
  }

  function tiles(shelves, freshCount) {
    return [
      { id: 'upgrades', n: (shelves.upgrades || []).length, label: 'upgrades over your copies' },
      { id: 'missing',  n: (shelves.missing || []).length,  label: 'albums you don\'t have' },
      { id: 'surround', n: (shelves.surround || []).length, label: 'surround mixes' },
      { id: 'new',      n: Number(freshCount) || 0,          label: 'new since last visit' },
    ]
  }

  const api = { buildRows, verdictText, sortRows, filterRows, tiles, tierOf, keyOf }
  if (typeof window !== 'undefined') window.PapaSlskHunt = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})()
```

Note: `buildLibraryIndex` is rebuilt per non-upgrade row above; that is O(n·lib). Build it ONCE before the loop: hoist `const idx = ...` above `for` and reuse. Do that in this step, not later.

- [ ] **Step 4: Run tests**

Run: `node --test test/slsk-hunt.test.js` — Expected: 6 pass. If `upgradeReason` in `slsk-shelves.js` does not emit `better`/`of`, the first test still passes because the test builds the upgrade object itself; the renderer falls back to "all tracks" when they are absent.

- [ ] **Step 5: Mutation check and commit**

Swap `'not in library'` for `'missing'`, run, confirm red, restore.

```bash
git add src/slsk-hunt.js test/slsk-hunt.test.js
git commit -m "Hunt ledger: rows with plain-words verdicts, sort and filter, pure and tested"
```

---

### Task 3: Wander shelves model (pure)

**Files:**
- Create: `src/slsk-wander.js`
- Test: `test/slsk-wander.test.js`

**Interfaces:**
- Produces: `window.PapaSlskWander` = `{ goDeep(albums, libraryIndexFind) → [{ artist, count, lacking, albums }], decadeShelf(albums) → { decade, share, albums }|null, onlyHere(albums, otherPeersAlbums[][]) → { albums, peersChecked }|null, becauseYouOwn(albums, seeds, tagsByArtist) → [{ seed, albums }], characterLine(tree, albums) → string, albumKey(a) → string }`.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test')
const assert = require('node:assert')
const W = require('../src/slsk-wander')

const A = (artist, album, year, extra) => ({ artist, album, year, folderPath: artist + '\\' + album, lossless: true, files: [], ...extra })

test('goDeep lists artists with 8+ albums, most first, with how many I lack', () => {
  const albums = []
  for (let i = 0; i < 9; i++) albums.push(A('Pink Floyd', 'PF' + i, 1970 + i))
  for (let i = 0; i < 8; i++) albums.push(A('Miles Davis', 'MD' + i, 1959))
  albums.push(A('Solo', 'One', 2000))
  const own = new Set(['pink floyd::pf0', 'pink floyd::pf1'])
  const out = W.goDeep(albums, a => own.has(W.albumKey(a)))
  assert.deepEqual(out.map(x => [x.artist, x.count, x.lacking]), [['Pink Floyd', 9, 7], ['Miles Davis', 8, 8]])
})

test('decadeShelf picks the decade with the most albums and reports its share', () => {
  const albums = [A('a', '1', 1971), A('b', '2', 1975), A('c', '3', 1999), A('d', '4', null)]
  const d = W.decadeShelf(albums)
  assert.equal(d.decade, 1970)
  assert.equal(d.albums.length, 2)
  assert.equal(d.share, 67)   // of the 3 with a year
})

test('decadeShelf is null when fewer than 5 albums carry a year', () => {
  assert.equal(W.decadeShelf([A('a', '1', 1971)]), null)
})

test('onlyHere keeps albums no other cached peer holds, and needs 3 peers', () => {
  const mine = [A('Can', 'Ege Bamyasi', 1972), A('Pink Floyd', 'Meddle', 1971)]
  const others = [[A('x', 'Meddle', 1971, { artist: 'Pink Floyd' })], [], []]
  const out = W.onlyHere(mine, others)
  assert.equal(out.peersChecked, 3)
  assert.deepEqual(out.albums.map(a => a.album), ['Ege Bamyasi'])
  assert.equal(W.onlyHere(mine, others.slice(0, 2)), null)
})

test('becauseYouOwn groups peer albums whose artist shares 2+ tags with a seed', () => {
  const albums = [A('Massive Attack', 'Mezzanine', 1998), A('Tricky', 'Maxinquaye', 1995), A('Yes', 'Fragile', 1971)]
  const tags = { 'portishead': ['trip hop', 'electronic', 'bristol'], 'massive attack': ['trip hop', 'electronic'],
    'tricky': ['trip hop', 'bristol'], 'yes': ['progressive rock'] }
  const out = W.becauseYouOwn(albums, [{ artist: 'Portishead', album: 'Dummy' }], tags)
  assert.equal(out.length, 1)
  assert.equal(out[0].seed.album, 'Dummy')
  assert.deepEqual(out[0].albums.map(a => a.artist).sort(), ['Massive Attack', 'Tricky'])
})

test('characterLine names genre-looking top folders and the dominant decade', () => {
  const tree = { dirs: new Map([['rock', { name: 'Rock', fileCount: 900 }], ['jazz', { name: 'Jazz', fileCount: 400 }], ['misc', { name: 'Misc', fileCount: 10 }]]) }
  const albums = [A('a', '1', 1971), A('b', '2', 1975), A('c', '3', 1977), A('d', '4', 1999), A('e', '5', 1972)]
  assert.equal(W.characterLine(tree, albums), 'A 70s rock and jazz collector')
})

test('characterLine falls back to counts when nothing looks like a genre', () => {
  const tree = { dirs: new Map([['music', { name: 'Music', fileCount: 5 }]]) }
  assert.equal(W.characterLine(tree, [A('a', '1', null)]), '1 album')
})
```

- [ ] **Step 2: Run to verify it fails**

`node --test test/slsk-wander.test.js` — FAIL, module not found.

- [ ] **Step 3: Write the implementation**

```js
// Wander mode's shelves: the collection as music, not as file quality. Pure.
;(function () {
  const GENRES = ['rock', 'jazz', 'electronic', 'classical', 'hip hop', 'hip-hop', 'rap', 'metal', 'folk',
    'soul', 'funk', 'blues', 'pop', 'punk', 'reggae', 'country', 'ambient', 'techno', 'house', 'soundtrack',
    'ost', 'indie', 'world', 'latin', 'r&b', 'rnb', 'prog', 'psychedelic', 'disco', 'dance', 'experimental']

  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() }
  function albumKey(a) { return norm(a.artist) + '::' + norm(a.album) }

  function goDeep(albums, ownsFn, min) {
    const by = new Map()
    for (const a of albums || []) {
      const k = norm(a.artist)
      if (!k) continue
      if (!by.has(k)) by.set(k, { artist: a.artist, count: 0, lacking: 0, albums: [] })
      const e = by.get(k)
      e.count++; e.albums.push(a)
      if (!ownsFn || !ownsFn(a)) e.lacking++
    }
    return [...by.values()].filter(e => e.count >= (min || 8)).sort((x, y) => y.count - x.count)
  }

  function decadeShelf(albums) {
    const dated = (albums || []).filter(a => Number(a.year) >= 1900)
    if (dated.length < 5) return null
    const by = new Map()
    for (const a of dated) { const d = Math.floor(a.year / 10) * 10; by.set(d, (by.get(d) || []).concat(a)) }
    let best = null
    for (const [decade, list] of by) if (!best || list.length > best.albums.length) best = { decade, albums: list }
    best.share = Math.round(best.albums.length / dated.length * 100)
    return best
  }

  function onlyHere(albums, otherPeersAlbums) {
    const peers = (otherPeersAlbums || []).filter(Array.isArray)
    if (peers.length < 3) return null
    const seen = new Set()
    for (const list of peers) for (const a of list) seen.add(albumKey(a))
    return { peersChecked: peers.length, albums: (albums || []).filter(a => !seen.has(albumKey(a))) }
  }

  function becauseYouOwn(albums, seeds, tagsByArtist) {
    const tags = k => new Set((tagsByArtist && tagsByArtist[norm(k)]) || [])
    const out = []
    for (const seed of seeds || []) {
      const st = tags(seed.artist)
      if (st.size < 2) continue
      const members = (albums || []).filter(a => {
        if (norm(a.artist) === norm(seed.artist)) return false
        let shared = 0
        for (const t of tags(a.artist)) if (st.has(t)) shared++
        return shared >= 2
      })
      if (members.length) out.push({ seed, albums: members })
    }
    return out
  }

  function characterLine(tree, albums) {
    const dirs = tree && tree.dirs && typeof tree.dirs.values === 'function' ? [...tree.dirs.values()] : []
    const genres = dirs
      .map(d => ({ name: norm(d.name), files: d.fileCount || 0 }))
      .filter(d => GENRES.includes(d.name))
      .sort((a, b) => b.files - a.files)
      .slice(0, 2)
      .map(d => d.name)
    const dec = decadeShelf(albums)
    const decWord = dec ? String(dec.decade).slice(2) + 's ' : ''
    if (genres.length) {
      const g = genres.length === 2 ? genres[0] + ' and ' + genres[1] : genres[0]
      return 'A ' + decWord + g + ' collector'
    }
    const n = (albums || []).length
    return n + ' album' + (n === 1 ? '' : 's')
  }

  const api = { goDeep, decadeShelf, onlyHere, becauseYouOwn, characterLine, albumKey, norm }
  if (typeof window !== 'undefined') window.PapaSlskWander = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})()
```

- [ ] **Step 4: Run tests** — `node --test test/slsk-wander.test.js` — 7 pass.

- [ ] **Step 5: Mutation check and commit**

Change `peers.length < 3` to `< 2`; the onlyHere test must go red. Restore.

```bash
git add src/slsk-wander.js test/slsk-wander.test.js
git commit -m "Wander shelves: go-deep, decade, only-here and because-you-own, pure and tested"
```

---

### Task 4: MusicBrainz artist tags and Discogs reception handlers

**Files:**
- Modify: `main.js` (after the `musicbrainz-check-album` handler, around line 7743)
- Modify: `preload.js` (next to `musicbrainzCheckAlbum`, line 512)
- Test: `test/peer-enrich-ipc.test.js`

**Interfaces:**
- Produces IPC: `musicbrainz-artist-tags { artist } → { ok, tags: string[] }`; `discogs-album { artist, album } → { ok, rating, count, genres, styles, url } | { ok: false, reason }`; `discogs-token-get () → { token }`; `discogs-token-set { token } → { ok }`.
- Preload: `window.api.musicbrainzArtistTags`, `window.api.discogsAlbum`, `window.api.discogsTokenGet`, `window.api.discogsTokenSet`.
- Pure helpers exported for tests in a new `src/peer-enrich.js`: `pickArtistTags(mbSearchJson) → string[]`, `pickDiscogsMaster(searchJson) → { id, url }|null`, `discogsSummary(masterJson) → { rating, count, genres, styles }`.

- [ ] **Step 1: Write the failing test for the pure helpers**

```js
const test = require('node:test')
const assert = require('node:assert')
const E = require('../src/peer-enrich')

test('pickArtistTags takes the top-scored artist and its tags by count, max 8', () => {
  const j = { artists: [{ score: 100, tags: [{ name: 'trip hop', count: 9 }, { name: 'electronic', count: 4 }, { name: 'x', count: 0 }] }, { score: 50, tags: [{ name: 'wrong', count: 99 }] }] }
  assert.deepEqual(E.pickArtistTags(j), ['trip hop', 'electronic'])
})

test('pickArtistTags is empty on no artists', () => {
  assert.deepEqual(E.pickArtistTags({}), [])
})

test('pickDiscogsMaster takes the first master result', () => {
  const j = { results: [{ id: 5, type: 'master', resource_url: 'https://api.discogs.com/masters/5', uri: '/master/5-x' }] }
  assert.deepEqual(E.pickDiscogsMaster(j), { id: 5, url: 'https://www.discogs.com/master/5-x' })
  assert.equal(E.pickDiscogsMaster({ results: [] }), null)
})

test('discogsSummary reads rating, count, genres and styles', () => {
  const j = { community: { rating: { average: 4.62, count: 41000 } }, genres: ['Rock'], styles: ['Prog Rock', 'Art Rock'] }
  assert.deepEqual(E.discogsSummary(j), { rating: 4.6, count: 41000, genres: ['Rock'], styles: ['Prog Rock', 'Art Rock'] })
})
```

- [ ] **Step 2: Run** — `node --test test/peer-enrich-ipc.test.js` — FAIL, module not found.

- [ ] **Step 3: Write `src/peer-enrich.js`**

```js
'use strict'
// Pure shaping of MusicBrainz and Discogs replies for the peer library. main.js
// does the HTTP; these functions decide what the UI gets to see.

function pickArtistTags(json) {
  const list = Array.isArray(json && json.artists) ? json.artists : []
  if (!list.length) return []
  const top = list.slice().sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))[0]
  return (top.tags || [])
    .filter(t => t && t.name && (Number(t.count) || 0) > 0)
    .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
    .slice(0, 8)
    .map(t => String(t.name).toLowerCase())
}

function pickDiscogsMaster(json) {
  const r = (Array.isArray(json && json.results) ? json.results : []).find(x => x && x.type === 'master' && x.id)
  if (!r) return null
  return { id: r.id, url: 'https://www.discogs.com' + String(r.uri || ('/master/' + r.id)) }
}

function discogsSummary(json) {
  const c = (json && json.community && json.community.rating) || {}
  return {
    rating: c.average != null ? Math.round(Number(c.average) * 10) / 10 : null,
    count: Number(c.count) || 0,
    genres: Array.isArray(json && json.genres) ? json.genres : [],
    styles: Array.isArray(json && json.styles) ? json.styles : [],
  }
}

module.exports = { pickArtistTags, pickDiscogsMaster, discogsSummary }
```

- [ ] **Step 4: Run** — 4 pass.

- [ ] **Step 5: Add the handlers to `main.js`**

Insert immediately after the `musicbrainz-check-album` handler's closing `})`:

```js
// ── Peer library enrichment (Wander shelves + album dossier) ────────────────
const peerEnrich = require('./src/peer-enrich')
const ENRICH_TTL_MS = 30 * 24 * 3600 * 1000
// One SideStore for both sources, keyed 'mbtags:<artist>' / 'discogs:<artist>::<album>'.
sideStores.peerEnrich = new SideStore({ dir: USER_DATA, name: 'peer-enrich', fallback: {}, debounceMs: 1000, onError: _sideErr })
function _enrichGet(key) {
  try { const m = sideStores.peerEnrich.get(); const e = m && m[key]; return e && (Date.now() - e.at) < ENRICH_TTL_MS ? e.value : null }
  catch (_) { return null }
}
function _enrichSet(key, value) {
  try { const m = sideStores.peerEnrich.get() || {}; m[key] = { at: Date.now(), value }; sideStores.peerEnrich.set(m) } catch (_) {}
}

ipcMain.handle('musicbrainz-artist-tags', async (_, { artist } = {}) => {
  const name = String(artist || '').trim()
  if (!name) return { ok: false, reason: 'No artist name to look up.' }
  const key = 'mbtags:' + name.toLowerCase()
  const hit = _enrichGet(key)
  if (hit) return { ok: true, tags: hit, fromCache: true }
  try {
    const j = await _mbThrottle(() => _mbGetJson(`/artist?query=${encodeURIComponent('artist:"' + name + '"')}&limit=3&inc=tags`))
    const tags = peerEnrich.pickArtistTags(j)
    _enrichSet(key, tags)
    return { ok: true, tags }
  } catch (e) {
    return { ok: false, reason: 'MusicBrainz did not answer: ' + e.message }
  }
})

ipcMain.handle('discogs-token-get', () => ({ token: store.get('discogsToken', '') }))
ipcMain.handle('discogs-token-set', (_, { token } = {}) => { store.set('discogsToken', String(token || '').trim()); return { ok: true } })

let _discogsLastAt = 0
async function _discogsGetJson(pathAndQuery, token) {
  const wait = 1000 - (Date.now() - _discogsLastAt)
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  _discogsLastAt = Date.now()
  const sep = pathAndQuery.includes('?') ? '&' : '?'
  const raw = await httpsGet(`https://api.discogs.com${pathAndQuery}${sep}token=${encodeURIComponent(token)}`)
  return JSON.parse(raw)
}

ipcMain.handle('discogs-album', async (_, { artist, album } = {}) => {
  const token = store.get('discogsToken', '')
  if (!token) return { ok: false, reason: 'no-token' }
  const a = String(artist || '').trim(), b = String(album || '').trim()
  if (!b) return { ok: false, reason: 'No album name to look up.' }
  const key = 'discogs:' + (a + '::' + b).toLowerCase()
  const hit = _enrichGet(key)
  if (hit) return { ok: true, ...hit, fromCache: true }
  try {
    const search = await _discogsGetJson(`/database/search?type=master&artist=${encodeURIComponent(a)}&release_title=${encodeURIComponent(b)}&per_page=5`, token)
    const master = peerEnrich.pickDiscogsMaster(search)
    if (!master) return { ok: false, reason: 'Discogs has no entry for this album.' }
    const detail = await _discogsGetJson(`/masters/${master.id}`, token)
    const value = { ...peerEnrich.discogsSummary(detail), url: master.url }
    _enrichSet(key, value)
    return { ok: true, ...value }
  } catch (e) {
    return { ok: false, reason: 'Discogs did not answer: ' + e.message }
  }
})
```

Check `httpsGet` at `main.js:7524` sends a `User-Agent`; Discogs rejects requests without one. If it does not, add `{ headers: { 'User-Agent': 'PapaAudio/1.0' } }` support to it or use `https.get` directly in `_discogsGetJson` with that header.

- [ ] **Step 6: Expose in `preload.js`** next to line 512:

```js
  musicbrainzArtistTags: (p) => ipcRenderer.invoke('musicbrainz-artist-tags', p),
  discogsAlbum:          (p) => ipcRenderer.invoke('discogs-album', p),
  discogsTokenGet:       ()  => ipcRenderer.invoke('discogs-token-get'),
  discogsTokenSet:       (p) => ipcRenderer.invoke('discogs-token-set', p),
```

- [ ] **Step 7: Add a wiring test** to `test/peer-enrich-ipc.test.js`:

```js
const fs = require('fs'), path = require('path')
test('the four handlers exist in main and are exposed in preload', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
  for (const h of ['musicbrainz-artist-tags', 'discogs-album', 'discogs-token-get', 'discogs-token-set']) {
    assert.ok(main.includes(`ipcMain.handle('${h}'`), h + ' handler')
    assert.ok(pre.includes(`'${h}'`), h + ' exposed')
  }
})
test('discogs-album never calls out without a token', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const body = main.slice(main.indexOf("ipcMain.handle('discogs-album'"))
  const guard = body.indexOf("reason: 'no-token'"), call = body.indexOf('_discogsGetJson(')
  assert.ok(guard > 0 && guard < call, 'the no-token return comes before the first request')
})
```

- [ ] **Step 8: Run the full suite** — `node --test 'test/**/*.test.js'` — green.

- [ ] **Step 9: Commit**

```bash
git add src/peer-enrich.js test/peer-enrich-ipc.test.js main.js preload.js
git commit -m "Peer library: MusicBrainz artist tags and Discogs reception handlers, cached 30 days, no key means no call"
```

---

### Task 5: `slsk-verify-rip` handler

**Files:**
- Modify: `main.js` (after the `slsk-verify-file` handler, line ~10984)
- Modify: `preload.js` (next to `slskVerifyFile`, line 342)
- Test: `test/rip-check-ipc.test.js`

**Interfaces:**
- IPC: `slsk-verify-rip { username, folderPath, files } → { ok: true, verdict: { kind, text }, ceilingHz, measuredBits, dynamicRange, declaredBits, declaredRate, track, at } | { ok: false, reason }`.
- Preload: `window.api.slskVerifyRip`.
- Push: none. The renderer awaits the invoke.

Spec deviation, recorded here: slskd decides where a download lands (the configured download dir), so the sample cannot be pulled into a scratch folder. It lands in the normal download dir under the peer's folder, is analysed there, and then the file and any now-empty folders it created are deleted. No library rescan is scheduled by this path, so the scanner never lists it.

- [ ] **Step 1: Write the failing test** (wiring + behaviour of the extracted helper)

```js
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), path = require('path')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

test('slsk-verify-rip exists, is exposed, and cleans up on every exit', () => {
  assert.ok(MAIN.includes("ipcMain.handle('slsk-verify-rip'"))
  const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
  assert.ok(pre.includes("'slsk-verify-rip'"))
  const body = MAIN.slice(MAIN.indexOf("ipcMain.handle('slsk-verify-rip'"), MAIN.indexOf("ipcMain.handle('slsk-verify-rip'") + 6000)
  assert.ok(body.includes('finally {'), 'cleanup runs in finally')
  assert.ok(body.includes('_ripCleanup('), 'cleanup helper is called')
})

test('the ceiling probe builds one highpass+volumedetect pass per band', () => {
  const R = require('../src/rip-check')
  const args = require('../src/rip-check').ceilingArgs('/x/a.flac', 20000)
  assert.deepEqual(args.slice(0, 2), ['-hide_banner', '-nostats'])
  assert.ok(args.join(' ').includes('highpass=f=20000'))
  assert.ok(args.join(' ').includes('volumedetect'))
})
```

- [ ] **Step 2: Run** — FAIL (`ceilingArgs` not a function; handler missing).

- [ ] **Step 3: Add `ceilingArgs` and `astatsArgs` to `src/rip-check.js`**

```js
// ffmpeg argv for one ceiling band: everything below `hz` removed, then how
// loud what is left is. main runs one per BANDS entry and tags the stderr with
// "band=<hz>" so parseCeiling can read them all from one string.
function ceilingArgs(file, hz) {
  return ['-hide_banner', '-nostats', '-t', '60', '-i', file,
    '-af', `highpass=f=${hz}:poles=2,volumedetect`, '-f', 'null', '-']
}
function astatsArgs(file) {
  return ['-hide_banner', '-nostats', '-t', '60', '-i', file, '-af', 'astats=measure_perchannel=none', '-f', 'null', '-']
}
function probeArgs(file) {
  return ['-v', 'error', '-select_streams', 'a:0', '-show_entries',
    'stream=codec_name,sample_rate,bits_per_raw_sample,bits_per_sample', '-of', 'default=noprint_wrappers=1', file]
}
```

Add them to `module.exports`.

- [ ] **Step 4: Add the handler to `main.js`** after `slsk-verify-file`:

```js
// ── Rip verification (album dossier → "Verify this rip") ────────────────────
// Pulls ONE track through slskd, measures it with ffprobe/ffmpeg, deletes it.
// It lands wherever slskd puts downloads (we do not control that), so the
// cleanup removes the file and the empty folders it left, and this path never
// schedules a library rescan.
const ripCheck = require('./src/rip-check')
const RIP_WAIT_MS = 3 * 60 * 1000

function _run(cmd, args, timeoutMs) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }))
  })
}

async function _ripWaitForFile(username, filename) {
  const deadline = Date.now() + RIP_WAIT_MS
  while (Date.now() < deadline) {
    const found = slskCandidatePaths(filename, username, _downloadDir()).find(c => fs.existsSync(c))
    if (found) {
      // slskd writes in place; treat a file whose size stopped changing for 2 s as done.
      const s1 = fs.statSync(found).size
      await new Promise(r => setTimeout(r, 2000))
      const s2 = fs.existsSync(found) ? fs.statSync(found).size : -1
      if (s1 === s2 && s1 > 0) return found
      continue
    }
    await new Promise(r => setTimeout(r, 1500))
  }
  return null
}

function _ripCleanup(filePath) {
  if (!filePath) return
  try { fs.unlinkSync(filePath) } catch (_) {}
  // Remove the folders the sample created, up to (not including) the download dir.
  let dir = path.dirname(filePath)
  const root = path.resolve(_downloadDir())
  for (let i = 0; i < 6; i++) {
    if (path.resolve(dir) === root) break
    try { if (fs.readdirSync(dir).length) break; fs.rmdirSync(dir) } catch (_) { break }
    dir = path.dirname(dir)
  }
}

ipcMain.handle('slsk-verify-rip', async (_, { username, folderPath, files } = {}) => {
  if (DRY_RUN) return _dryRunRefusal('downloading a track to verify a rip')
  const track = ripCheck.pickTrack(files || [])
  if (!track) return { ok: false, reason: 'No audio file in this folder to test.' }
  const filename = track.fullPath || track.filename || track.name
  let local = null
  try {
    try {
      await slskdFetch('POST', `/transfers/downloads/${encodeURIComponent(username)}`, [{ filename, size: track.size || 0 }])
    } catch (e) {
      return { ok: false, reason: 'The peer did not accept the download: ' + e.message }
    }
    local = await _ripWaitForFile(username, filename)
    if (!local) return { ok: false, reason: 'The track did not arrive within 3 minutes. The peer may be busy or offline.' }
    const probe = await _run('ffprobe', ripCheck.probeArgs(local), 15000)
    if (probe.err) return { ok: false, reason: 'ffprobe is missing or could not read the file.' }
    const declared = ripCheck.parseProbe(probe.stdout)
    const stats = await _run('ffmpeg', ripCheck.astatsArgs(local), 60000)
    const measured = ripCheck.parseAstats(stats.stderr)
    let bandText = ''
    for (const hz of ripCheck.BANDS) {
      if (declared.sampleRate && hz >= declared.sampleRate / 2) break
      const r = await _run('ffmpeg', ripCheck.ceilingArgs(local, hz), 60000)
      const m = r.stderr.match(/mean_volume: (-?[\d.]+) dB/)
      bandText += `band=${hz} mean_volume: ${m ? m[1] : '-999'} dB\n`
    }
    const ceilingHz = ripCheck.parseCeiling(bandText)
    const ext = (String(filename).split('.').pop() || '').toLowerCase()
    const verdict = ripCheck.verdict({ declaredRate: declared.sampleRate, declaredBits: declared.bitDepth,
      measuredBits: measured.measuredBits, ceilingHz, ext })
    return { ok: true, verdict, ceilingHz, measuredBits: measured.measuredBits, dynamicRange: measured.dynamicRange,
      declaredBits: declared.bitDepth, declaredRate: declared.sampleRate, track: path.basename(filename), at: Date.now() }
  } finally {
    _ripCleanup(local)
  }
})
```

- [ ] **Step 5: Expose in `preload.js`**: `slskVerifyRip: (p) => ipcRenderer.invoke('slsk-verify-rip', p),`

- [ ] **Step 6: Run the new test and the full suite** — green. Also run one real probe by hand on any FLAC you have to confirm the argv works: `ffprobe <probeArgs>` and `ffmpeg <astatsArgs>` print `Bit depth:` and `Dynamic range:` lines under `Overall`.

- [ ] **Step 7: Commit**

```bash
git add src/rip-check.js test/rip-check-ipc.test.js main.js preload.js
git commit -m "Verify this rip: one track through slskd, measured with ffmpeg, deleted after, 3-minute cap"
```

---

### Task 6: Album dossier renderer

**Files:**
- Create: `src/slsk-dossier.js`
- Test: `test/slsk-dossier.test.js`

**Interfaces:**
- Consumes: `PapaSlskAlbumView.compareDrawerHtml`, `findMyCopy`, `normalizeAlbum`, `trackQuality` (existing); `PapaSlskShelves.qualityString`, `fmtSize`; `window.api.slskVerifyRip`, `discogsAlbum`, `artistInfo`, `fetchAlbumArt`.
- Produces: `window.PapaSlskDossier = { open({ album, username, host, deps, siblings }) → { close }, sectionsHtml(model, esc) }`. `siblings` = the peer's other albums by the same artist. Pure `model(album, username, mine)` returns `{ title, artist, year, editionNote, quality, tier, tracks, length, size, extras: { log, cue, art }, verdict }` and is exported for tests.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test')
const assert = require('node:assert')
const D = require('../src/slsk-dossier')

const album = { artist: 'Pink Floyd', album: 'Wish You Were Here', year: 1975, folderName: 'Pink Floyd - 1975 - Wish You Were Here [2016 Remaster] [24-96]',
  folderPath: 'Music\\Pink Floyd\\WYWH', lossless: true, isHiRes: true, maxBitDepth: 24, maxSampleRate: 96000, totalSize: 1.1e9, trackCount: 5,
  files: [{ name: '01 Shine On.flac', size: 4.6e8, bitDepth: 24, sampleRate: 96000, length: 810 }, { name: 'cover.jpg', size: 1e5 },
    { name: 'rip.log', size: 1e3 }, { name: 'album.cue', size: 1e3 }] }

test('model reads edition note, extras, length and tier', () => {
  const m = D.model(album, 'vinylhoarder', null)
  assert.equal(m.editionNote, '2016 Remaster')
  assert.deepEqual(m.extras, { log: true, cue: true, art: true })
  assert.equal(m.length, '13:30')
  assert.equal(m.tier, 'hires')
  assert.equal(m.tracks.length, 1)
})

test('sectionsHtml shows the Discogs prompt when there is no token', () => {
  const html = D.sectionsHtml({ ...D.model(album, 'u', null), reception: { ok: false, reason: 'no-token' } }, s => s)
  assert.ok(html.includes('Add a Discogs token in Settings'))
})

test('sectionsHtml renders a rip verdict and the measured facts', () => {
  const rip = { ok: true, verdict: { kind: 'genuine', text: 'genuine 24/96' }, ceilingHz: 46000, dynamicRange: 13.4, track: '04.flac', at: Date.now() - 120000 }
  const html = D.sectionsHtml({ ...D.model(album, 'u', null), rip }, s => s)
  assert.ok(html.includes('genuine 24/96'))
  assert.ok(html.includes('46 kHz'))
  assert.ok(html.includes('verified from 04.flac'))
})

test('sectionsHtml lists sibling albums as chips', () => {
  const html = D.sectionsHtml({ ...D.model(album, 'u', null), siblings: [{ album: 'Animals', folderPath: 'p' }] }, s => s)
  assert.ok(html.includes('data-sibling="p"'))
  assert.ok(html.includes('Animals'))
})
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Write `src/slsk-dossier.js`**

```js
// The album dossier: everything the app can know about one remote album, in
// one panel, opened from Hunt, Wander, Folders or search. Replaces the
// slide-over in slsk-album-view.js for the new page; reuses its comparison
// table and my-copy lookup so the two never disagree.
;(function () {
  const AV = () => (typeof window !== 'undefined' && window.PapaSlskAlbumView) ||
    (typeof require === 'function' ? require('./slsk-album-view.js') : null)
  const SH = () => (typeof window !== 'undefined' && window.PapaSlskShelves) ||
    (typeof require === 'function' ? require('./slsk-shelves.js') : null)
  const AUDIO_RE = /\.(flac|mp3|wav|aiff?|aif|m4a|aac|ogg|opus|ape|wv|alac|dsf|dff)$/i

  function fmtDur(sec) {
    const n = Math.round(Number(sec) || 0)
    const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = n % 60
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0')
  }
  function fmtSize(n) { const s = SH(); return s && s.fmtSize ? s.fmtSize(n) : Math.round(n / 1e6) + ' MB' }
  function ago(ts) {
    const d = Date.now() - ts
    if (d < 90e3) return 'just now'
    if (d < 3600e3) return Math.round(d / 60e3) + ' min ago'
    if (d < 86400e3) return Math.round(d / 3600e3) + ' h ago'
    return Math.round(d / 86400e3) + ' d ago'
  }
  function tierOf(a) { return a.surround ? 'surround' : a.isHiRes ? 'hires' : a.lossless ? 'lossless' : 'lossy' }

  // "[2016 Remaster]", "(Deluxe Edition)", "{Vinyl}" out of the folder name.
  function editionOf(folderName) {
    const m = String(folderName || '').match(/[\[({]([^\])}]*(remaster|deluxe|edition|vinyl|mono|anniversary|expanded|japan|sacd|mfsl|dcc)[^\])}]*)[\])}]/i)
    return m ? m[1].trim() : ''
  }

  function model(album, username, mine) {
    const files = album.files || []
    const tracks = files.filter(f => AUDIO_RE.test(f.name || f.filename || ''))
    const total = tracks.reduce((s, f) => s + (Number(f.length) || 0), 0)
    const names = files.map(f => String(f.name || f.filename || '').toLowerCase())
    const s = SH()
    return {
      album, username, mine,
      title: album.album || album.folderName || '', artist: album.artist || '', year: album.year || null,
      editionNote: editionOf(album.folderName),
      quality: s && s.qualityString ? s.qualityString(album) : '',
      tier: tierOf(album),
      tracks, length: total ? fmtDur(total) : '', size: fmtSize(album.totalSize || 0),
      extras: {
        log: names.some(n => n.endsWith('.log')),
        cue: names.some(n => n.endsWith('.cue')),
        art: names.some(n => /\.(jpe?g|png|webp)$/.test(n)),
      },
      verdict: album.upgrade ? 'Upgrade over yours' : (mine ? 'You have this' : 'Not yours'),
      rip: null, reception: null, about: null, siblings: [],
    }
  }

  function labelDot(tier) { return `<i class="slr-lbl slr-lbl-${tier}"></i>` }

  function ripHtml(m, esc) {
    const r = m.rip
    if (!r) return `<div class="slr-rip slr-rip-idle"><button class="slr-btn" data-act="verify">Verify this rip</button>
      <span>Pulls one track, measures it, deletes it. Takes a minute or two.</span></div>`
    if (r.running) return `<div class="slr-rip slr-rip-busy"><span class="slr-spin"></span>Pulling ${esc(r.track || 'a track')}…</div>`
    if (!r.ok) return `<div class="slr-rip slr-rip-fail">${esc(r.reason || 'Could not verify.')} <button class="slr-btn slr-btn-quiet" data-act="verify">Try again</button></div>`
    const facts = []
    if (r.ceilingHz) facts.push('reaches ' + Math.round(r.ceilingHz / 1000) + ' kHz')
    if (r.dynamicRange != null) facts.push('dynamic range ' + r.dynamicRange)
    if (r.measuredBits) facts.push(r.measuredBits + ' bits used')
    return `<div class="slr-rip slr-rip-${esc(r.verdict.kind)}"><b class="slr-rip-verdict">${r.verdict.kind === 'genuine' ? '✓' : '⚠'} ${esc(r.verdict.text)}</b>
      <span>${esc(facts.join(' · '))} · verified from ${esc(r.track || '')}, ${esc(ago(r.at || Date.now()))}</span></div>`
  }

  function receptionHtml(m, esc) {
    const r = m.reception
    if (!r) return `<div class="slr-muted">Looking up…</div>`
    if (!r.ok) return r.reason === 'no-token'
      ? `<div class="slr-muted">Add a Discogs token in Settings to see ratings and tags.</div>`
      : `<div class="slr-muted">${esc(r.reason || 'Nothing found.')}</div>`
    const stars = r.rating ? '★'.repeat(Math.round(r.rating)) + '☆'.repeat(5 - Math.round(r.rating)) : ''
    const chips = [...(r.genres || []), ...(r.styles || [])].map(t => `<span class="slr-chip">${esc(t)}</span>`).join('')
    return `<div><span class="slr-stars">${stars}</span> <span class="slr-mono slr-muted">${r.rating != null ? r.rating : '—'} · ${Number(r.count || 0).toLocaleString()} ratings on Discogs</span></div>
      <div class="slr-chips">${chips}</div>`
  }

  function sectionsHtml(m, esc) {
    const facts = [
      `<span class="slr-pill">${labelDot(m.tier)}${esc(m.quality)}</span>`,
      `<span class="slr-pill">${m.tracks.length} track${m.tracks.length === 1 ? '' : 's'}${m.length ? ' · ' + esc(m.length) : ''}</span>`,
      `<span class="slr-pill">${esc(m.size)}</span>`,
      (m.extras.log || m.extras.cue) ? `<span class="slr-pill">${[m.extras.log && 'log', m.extras.cue && 'cue'].filter(Boolean).join(' + ')}</span>` : '',
      `<span class="slr-pill slr-pill-verdict">${esc(m.verdict)}</span>`,
    ].filter(Boolean).join('')
    const sibs = (m.siblings || []).map(s => `<button class="slr-chip slr-chip-btn" data-sibling="${esc(s.folderPath)}">${esc(s.album)}${s.isHiRes ? ' · hi-res' : ''}${s.surround ? ' · surround' : ''}</button>`).join('')
    const about = m.about && m.about.bio ? `<div class="slr-muted">${esc(String(m.about.bio).slice(0, 420))}${m.about.bio.length > 420 ? '…' : ''}</div>` : `<div class="slr-muted">Nothing written about this artist yet.</div>`
    const tracks = m.tracks.map((t, i) => {
      const n = (String(t.name).match(/^\s*(\d{1,3})/) || [])[1] || (i + 1)
      const q = [t.bitDepth && t.bitDepth + '/' + Math.round((t.sampleRate || 0) / 1000), !t.bitDepth && t.bitRate && t.bitRate + ' kbps'].filter(Boolean).join('')
      return `<div class="slr-track" data-fi="${i}"><span class="slr-n slr-mono">${esc(String(n))}</span><span class="slr-t">${esc(String(t.name).replace(/^\s*\d{1,3}\s*[-._)]*\s*/, '').replace(/\.[a-z0-9]+$/i, ''))}</span>
        <span class="slr-q slr-mono">${t.length ? esc(fmtDur(t.length)) + ' · ' : ''}${esc(q)}</span>
        <span class="slr-track-acts"><button class="slr-mini" data-act="preview" data-fi="${i}" title="Preview">⚡</button><button class="slr-mini" data-act="dl" data-fi="${i}" title="Download">↓</button></span></div>`
    }).join('')
    return `
      <div class="slr-facts">${facts}</div>
      <div class="slr-sec"><b>Rip check</b>${ripHtml(m, esc)}</div>
      <div class="slr-sec"><b>Reception</b>${receptionHtml(m, esc)}</div>
      <div class="slr-sec"><b>About ${esc(m.artist || 'this artist')}</b>${about}</div>
      ${sibs ? `<div class="slr-sec"><b>Also by ${esc(m.artist)} here</b><div class="slr-chips">${sibs}</div></div>` : ''}
      <div class="slr-sec"><b>Tracks</b><div class="slr-tracks">${tracks}</div></div>
      <div class="slr-sec" id="slr-compare"><b>Tracks vs yours</b>${m.compareHtml || '<div class="slr-muted">You don\'t have this album.</div>'}</div>`
  }

  function open({ album, username, host, deps, siblings }) {
    const esc = deps.esc
    const av = AV()
    const mine = av && av.findMyCopy ? av.findMyCopy(album, deps.state) : null
    const m = model(album, username, mine)
    m.siblings = siblings || []
    if (mine && av && av.compareDrawerHtml) { try { m.compareHtml = av.compareDrawerHtml(album, mine, esc) } catch (_) {} }

    const root = document.createElement('div')
    root.className = 'slr-dossier'
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-label', m.title)
    const mount = host || document.body
    mount.appendChild(root)

    function paint() {
      root.innerHTML = `
        <div class="slr-dossier-scrim" data-act="close"></div>
        <div class="slr-dossier-panel">
          <button class="slr-x" data-act="close" aria-label="Close">×</button>
          <div class="slr-dossier-head">
            <div class="slr-dossier-cover" id="slr-cover"></div>
            <div>
              <h2 class="slr-dossier-title">${esc(m.title)}</h2>
              <div class="slr-muted">${esc([m.artist, m.year, m.editionNote, 'from ' + username].filter(Boolean).join(' · '))}</div>
              <div class="slr-acts">
                <button class="slr-btn slr-btn-pri" data-act="download">Download album</button>
                <button class="slr-btn" data-act="preview" data-fi="0">Preview a track</button>
                <button class="slr-btn" data-act="wishlist">Add to wishlist</button>
                ${deps.openSlskChat ? `<button class="slr-btn" data-act="chat">Message ${esc(username)}</button>` : ''}
              </div>
            </div>
          </div>
          <div class="slr-dossier-body">${sectionsHtml(m, esc)}</div>
        </div>`
      paintCover()
    }

    function paintCover() {
      const el = root.querySelector('#slr-cover')
      if (!el) return
      const lib = mine && mine.artPath ? mine.artPath : null
      if (lib) { el.innerHTML = `<img src="file://${esc(lib)}" alt="">`; return }
      const hue = Math.abs([...m.title].reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0)) % 360
      el.style.background = `linear-gradient(135deg,hsl(${hue},45%,20%),hsl(${(hue + 40) % 360},35%,12%))`
      if (window.api && window.api.fetchAlbumArt && m.artist) {
        window.api.fetchAlbumArt({ albumId: 'slsk-' + (m.artist + '-' + m.title).replace(/[^a-z0-9]+/gi, '-').toLowerCase(), artist: m.artist, album: m.title })
          .then(p => { if (p && root.isConnected) el.innerHTML = `<img src="${/^https?:/.test(p) ? esc(p) : 'file://' + esc(p)}" alt="">` }).catch(() => {})
      }
    }

    async function verify() {
      m.rip = { running: true, track: '' }
      repaintBody()
      const res = await window.api.slskVerifyRip({ username, folderPath: album.folderPath, files: album.files }).catch(e => ({ ok: false, reason: e.message }))
      m.rip = res
      try { localStorage.setItem('slr_rip:' + username + ':' + album.folderPath, JSON.stringify(res)) } catch (_) {}
      repaintBody()
    }

    function repaintBody() {
      const b = root.querySelector('.slr-dossier-body')
      if (b) b.innerHTML = sectionsHtml(m, esc)
    }

    root.addEventListener('click', async e => {
      const t = e.target.closest('[data-act],[data-sibling]')
      if (!t) return
      if (t.dataset.sibling) { const s = m.siblings.find(x => x.folderPath === t.dataset.sibling); close(); if (s && deps.openDossier) deps.openDossier(s); return }
      const fi = Number(t.dataset.fi)
      const f = m.tracks[fi]
      switch (t.dataset.act) {
        case 'close': close(); break
        case 'verify': verify(); break
        case 'download': {
          const items = m.tracks.map(x => ({ username, filename: x.fullPath || x.filename || x.name, size: x.size || 0 }))
          const r = await deps._slskEnqueue(items)
          deps.showSnackbar(r && r.ok ? 'Downloading ' + m.title : (r && r.reason) || 'Could not start the download')
          if (r && r.ok && deps._scheduleLibRescan) deps._scheduleLibRescan()
          break
        }
        case 'preview': if (f) deps.startPreview({ username, filename: f.fullPath || f.filename || f.name, title: m.title }); break
        case 'dl': if (f) { const r = await deps._slskEnqueue([{ username, filename: f.fullPath || f.filename || f.name, size: f.size || 0 }]); deps.showSnackbar(r && r.ok ? 'Downloading' : 'Could not start the download') } break
        case 'wishlist': if (deps.wishlistAdd) deps.wishlistAdd(m.artist + ' ' + m.title); break
        case 'chat': if (deps.openSlskChat) deps.openSlskChat(username); break
      }
    })
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close() } }
    document.addEventListener('keydown', onKey, true)
    function close() { document.removeEventListener('keydown', onKey, true); root.remove() }

    paint()
    // Async sections: cached rip verdict, reception, about. Each paints when it lands.
    try { const c = localStorage.getItem('slr_rip:' + username + ':' + album.folderPath); if (c) { const r = JSON.parse(c); if (r && r.at && Date.now() - r.at < 30 * 86400e3) { m.rip = r; repaintBody() } } } catch (_) {}
    if (window.api && window.api.discogsAlbum) window.api.discogsAlbum({ artist: m.artist, album: m.title }).then(r => { m.reception = r; if (root.isConnected) repaintBody() }).catch(() => {})
    if (window.api && window.api.artistInfo && m.artist) window.api.artistInfo({ artist: m.artist }).then(r => { m.about = r; if (root.isConnected) repaintBody() }).catch(() => {})
    requestAnimationFrame(() => root.classList.add('is-open'))
    return { close }
  }

  const api = { open, model, sectionsHtml, editionOf, fmtDur }
  if (typeof window !== 'undefined') window.PapaSlskDossier = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})()
```

Check `findMyCopy(album, state)` and `compareDrawerHtml(album, mine, esc)` signatures in `src/slsk-album-view.js` before relying on them; adapt the two call lines to the real signatures (read lines 140-200 there).

- [ ] **Step 4: Run** — 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/slsk-dossier.js test/slsk-dossier.test.js
git commit -m "Album dossier: one panel with rip check, reception, story, siblings and the track comparison"
```

---

### Task 7: Folders column browser

**Files:**
- Create: `src/slsk-columns.js`
- Test: `test/slsk-columns.test.js`

**Interfaces:**
- Consumes: `PapaSlskTree` (`listDir`, `getNode`, `breadcrumbs`, `AUDIO_RE`), `deps._slskDirQuality`, `PapaSlskShelves.extractAlbums` (to recognise an album folder: a node with ≥ 2 audio files and no audio-bearing subfolders except disc folders).
- Produces: `window.PapaSlskColumns = { mount({ host, tree, username, deps, albumsByPath, openDossier }) → { navTo(path), destroy(), setFilters({ audioOnly, surroundOnly }), search(q) } , columnsFor(tree, path, opts) → [{ path, rows }] , inspectorModel(node, albumsByPath) → { kind: 'album'|'folder'|'file', ... } }`.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test')
const assert = require('node:assert')
const T = require('../src/slsk-tree')
const C = require('../src/slsk-columns')

const dirs = [
  { name: 'Music\\Rock\\Pink Floyd\\1975 WYWH', files: [{ filename: 'Music\\Rock\\Pink Floyd\\1975 WYWH\\01.flac', size: 4e8, bitDepth: 24, sampleRate: 96000 }, { filename: 'Music\\Rock\\Pink Floyd\\1975 WYWH\\02.flac', size: 3e8, bitDepth: 24, sampleRate: 96000 }, { filename: 'Music\\Rock\\Pink Floyd\\1975 WYWH\\rip.log', size: 100 }] },
  { name: 'Music\\Jazz\\Miles', files: [{ filename: 'Music\\Jazz\\Miles\\a.flac', size: 1e8 }] },
]
const tree = T.buildTree(dirs)

test('columnsFor gives one column per path level plus the root', () => {
  const cols = C.columnsFor(tree, 'Music\\Rock\\Pink Floyd', {})
  assert.deepEqual(cols.map(c => c.path), ['', 'Music', 'Music\\Rock', 'Music\\Rock\\Pink Floyd'])
  assert.deepEqual(cols[3].rows.map(r => r.name), ['1975 WYWH'])
})

test('inspectorModel calls a leaf with 2+ audio files an album and lists extras', () => {
  const node = T.getNode(tree, 'Music\\Rock\\Pink Floyd\\1975 WYWH')
  const m = C.inspectorModel(node, new Map())
  assert.equal(m.kind, 'album')
  assert.equal(m.tracks.length, 2)
  assert.equal(m.extras.log, true)
})

test('inspectorModel calls a folder with subfolders a folder with a roll-up', () => {
  const m = C.inspectorModel(T.getNode(tree, 'Music'), new Map())
  assert.equal(m.kind, 'folder')
  assert.equal(m.fileCount, 4)
})

test('inspectorModel for a file carries exact figures', () => {
  const node = T.getNode(tree, 'Music\\Rock\\Pink Floyd\\1975 WYWH')
  const m = C.inspectorModel(node.files[0], new Map())
  assert.equal(m.kind, 'file')
  assert.equal(m.bitDepth, 24)
})
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Write `src/slsk-columns.js`**

```js
// Folders mode: a Finder-style column browser with a live inspector. Pure
// helpers (columnsFor, inspectorModel) are tested in node; mount() paints.
;(function () {
  const T = () => (typeof window !== 'undefined' && window.PapaSlskTree) || (typeof require === 'function' ? require('./slsk-tree.js') : null)
  const SEP = '\\'
  const AUDIO_RE = /\.(flac|mp3|wav|aiff?|aif|m4a|aac|ogg|opus|ape|wv|alac|dsf|dff)$/i

  function columnsFor(tree, path, opts) {
    const t = T()
    const parts = String(path || '').split(SEP).filter(Boolean)
    const out = []
    let acc = []
    for (let i = 0; i <= parts.length; i++) {
      const p = acc.join(SEP)
      const l = t.listDir(tree, p, { sort: (opts && opts.sort) || 'name', audioOnly: !!(opts && opts.audioOnly) })
      if (!l) break
      const selected = parts[i] || null
      out.push({ path: p, selected, node: l.node, rows: l.dirs.map(d => ({ ...d, kind: 'dir' })).concat(l.files.map((f, idx) => ({ name: f.name, kind: 'file', idx, file: f }))) })
      if (selected) acc.push(selected)
    }
    return out
  }

  function inspectorModel(item, albumsByPath) {
    if (!item) return { kind: 'none' }
    if (item.dirs === undefined) {
      return { kind: 'file', name: item.name, size: Number(item.size) || 0, bitDepth: Number(item.bitDepth) || 0,
        sampleRate: Number(item.sampleRate) || 0, bitRate: Number(item.bitRate) || 0, length: Number(item.length) || 0,
        audio: AUDIO_RE.test(item.name || ''), file: item }
    }
    const node = item
    const audio = (node.files || []).filter(f => AUDIO_RE.test(f.name || ''))
    const names = (node.files || []).map(f => String(f.name || '').toLowerCase())
    const subAudio = [...(node.dirs ? node.dirs.values() : [])].some(d => (d.files || []).some(f => AUDIO_RE.test(f.name || '')))
    const album = albumsByPath && albumsByPath.get(String(node.path || '').toLowerCase())
    if (audio.length >= 2 && (!subAudio || album)) {
      return { kind: 'album', node, album: album || null, name: node.name, path: node.path, tracks: audio,
        size: node.totalSize || 0, extras: { log: names.some(n => n.endsWith('.log')), cue: names.some(n => n.endsWith('.cue')), art: names.some(n => /\.(jpe?g|png|webp)$/.test(n)) } }
    }
    return { kind: 'folder', node, name: node.name, path: node.path, fileCount: node.fileCount || 0, size: node.totalSize || 0, subdirCount: node.dirs ? node.dirs.size : 0, audioHere: audio.length }
  }

  function mount({ host, tree, username, deps, albumsByPath, openDossier }) {
    const esc = deps.esc
    let path = '', sel = null, filters = { audioOnly: true, surroundOnly: false }, query = ''
    host.innerHTML = `<div class="slr-crumbs" id="slr-crumbs"></div><div class="slr-cols" id="slr-cols"></div>`
    const colsEl = host.querySelector('#slr-cols'), crumbsEl = host.querySelector('#slr-crumbs')

    function fmtSize(n) { return (window.PapaSlskShelves && window.PapaSlskShelves.fmtSize) ? window.PapaSlskShelves.fmtSize(n) : Math.round(n / 1e6) + ' MB' }

    function rowHtml(r, colPath, isSel) {
      if (r.kind === 'dir') {
        const node = T().getNode(tree, r.path)
        const q = node && deps._slskDirQuality ? deps._slskDirQuality(node) : ''
        return `<div class="slr-row slr-row-dir${isSel ? ' is-sel' : ''}" data-path="${esc(r.path)}" role="option" tabindex="-1"><span class="slr-row-name">${esc(r.name)}</span><span class="slr-row-meta slr-mono">${q ? esc(q) + ' · ' : ''}${r.fileCount}</span><span class="slr-row-arrow">›</span></div>`
      }
      const f = r.file
      const audio = AUDIO_RE.test(f.name)
      return `<div class="slr-row slr-row-file${audio ? '' : ' is-dim'}${isSel ? ' is-sel' : ''}" data-file="${r.idx}" data-col="${esc(colPath)}" role="option" tabindex="-1"><span class="slr-row-name">${esc(f.name)}</span><span class="slr-row-meta slr-mono">${f.bitDepth ? f.bitDepth + '/' + Math.round(f.sampleRate / 1000) : ''}</span></div>`
    }

    function inspectorHtml(m) {
      if (m.kind === 'none') return `<div class="slr-insp slr-muted">Pick a folder or a file.</div>`
      if (m.kind === 'file') {
        const rows = [['Size', fmtSize(m.size)], m.bitDepth && ['Bit depth', m.bitDepth + '-bit'], m.sampleRate && ['Sample rate', (m.sampleRate / 1000).toFixed(1) + ' kHz'], m.bitRate && ['Bitrate', m.bitRate + ' kbps'], m.length && ['Length', Math.floor(m.length / 60) + ':' + String(m.length % 60).padStart(2, '0')]].filter(Boolean)
        return `<div class="slr-insp"><h4>${esc(m.name)}</h4><dl class="slr-kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd class="slr-mono">${esc(String(v))}</dd>`).join('')}</dl>
          <div class="slr-acts">${m.audio ? `<button class="slr-btn slr-btn-pri" data-act="play">Download &amp; play</button><button class="slr-btn" data-act="preview">Preview</button>` : ''}<button class="slr-btn" data-act="dl">Download</button></div></div>`
      }
      if (m.kind === 'folder') {
        return `<div class="slr-insp"><h4>${esc(m.name)}</h4><div class="slr-muted">${m.subdirCount} folder${m.subdirCount === 1 ? '' : 's'} · ${m.fileCount} file${m.fileCount === 1 ? '' : 's'} · ${esc(fmtSize(m.size))}</div>
          <div class="slr-acts"><button class="slr-btn" data-act="dl-tree">Download everything below</button></div></div>`
      }
      const a = m.album
      const q = deps._slskDirQuality ? deps._slskDirQuality(m.node) : ''
      const tracks = m.tracks.map((t, i) => `<div class="slr-track" data-fi="${i}"><span class="slr-n slr-mono">${i + 1}</span><span class="slr-t">${esc(t.name.replace(/\.[a-z0-9]+$/i, ''))}</span><span class="slr-q slr-mono">${t.bitDepth ? t.bitDepth + '/' + Math.round(t.sampleRate / 1000) : ''}</span></div>`).join('')
      const ex = [m.extras.log && 'log', m.extras.cue && 'cue', m.extras.art && 'artwork'].filter(Boolean).join(' · ')
      return `<div class="slr-insp"><div class="slr-insp-cover" data-cover="${esc(m.path)}"></div><h4>${esc(a ? a.album : m.name)}</h4>
        <div class="slr-muted">${esc([a && a.artist, a && a.year, q].filter(Boolean).join(' · '))}</div>
        <dl class="slr-kv"><dt>Tracks</dt><dd class="slr-mono">${m.tracks.length}</dd><dt>Size</dt><dd class="slr-mono">${esc(fmtSize(m.size))}</dd>${ex ? `<dt>Extras</dt><dd>${esc(ex)}</dd>` : ''}${a && a.upgrade ? `<dt>Yours</dt><dd class="slr-mono">${esc(a.upgrade.yours || '')}</dd><dt>Verdict</dt><dd class="slr-v-up">upgrade</dd>` : ''}</dl>
        <div class="slr-tracks">${tracks}</div>
        <div class="slr-acts"><button class="slr-btn slr-btn-pri" data-act="dl-album">Download album</button><button class="slr-btn" data-act="preview-first">Preview</button><button class="slr-btn" data-act="dossier">Open dossier</button></div></div>`
    }

    function render() {
      const cols = columnsFor(tree, path, { audioOnly: filters.audioOnly })
      const bc = T().breadcrumbs(path)
      crumbsEl.innerHTML = bc.map((b, i) => `<button class="slr-crumb${i === bc.length - 1 ? ' is-current' : ''}" data-path="${esc(b.path)}">${esc(b.name)}</button>`).join('<span class="slr-crumb-sep">›</span>')
      let selItem = null
      const html = cols.map(c => `<div class="slr-col" data-col="${esc(c.path)}" role="listbox">${c.rows.map(r => {
        const isSel = (r.kind === 'dir' && r.name === c.selected) || (sel && sel.col === c.path && sel.file === r.idx)
        if (sel && sel.col === c.path && r.kind === 'file' && sel.file === r.idx) selItem = r.file
        return rowHtml(r, c.path, isSel)
      }).join('') || '<div class="slr-muted slr-col-empty">Empty</div>'}</div>`).join('')
      const node = selItem ? null : T().getNode(tree, path)
      const m = inspectorModel(selItem || (path ? node : null), albumsByPath)
      colsEl.innerHTML = html + `<div class="slr-col slr-col-insp">${inspectorHtml(m)}</div>`
      colsEl.scrollLeft = colsEl.scrollWidth
      colsEl._model = m
    }

    colsEl.addEventListener('click', async e => {
      const row = e.target.closest('.slr-row')
      const act = e.target.closest('[data-act]')
      if (row && row.dataset.path !== undefined) { path = row.dataset.path; sel = null; render(); return }
      if (row && row.dataset.file !== undefined) { sel = { col: row.dataset.col, file: Number(row.dataset.file) }; render(); return }
      if (!act) return
      const m = colsEl._model
      const enq = files => deps._slskEnqueue(files.map(f => ({ username, filename: f.fullPath || f.name, size: f.size || 0 })))
      switch (act.dataset.act) {
        case 'dl': case 'play': case 'preview': {
          const f = m.file
          if (act.dataset.act === 'preview') deps.startPreview({ username, filename: f.fullPath || f.name, title: f.name })
          else { const r = await enq([f]); deps.showSnackbar(r.ok ? 'Downloading' : 'Could not start the download'); if (r.ok && deps._scheduleLibRescan) deps._scheduleLibRescan() }
          break
        }
        case 'dl-album': { const r = await enq(m.tracks); deps.showSnackbar(r.ok ? 'Downloading ' + m.name : 'Could not start the download'); if (r.ok && deps._scheduleLibRescan) deps._scheduleLibRescan(); break }
        case 'preview-first': deps.startPreview({ username, filename: m.tracks[0].fullPath || m.tracks[0].name, title: m.name }); break
        case 'dossier': if (openDossier) openDossier(m.album || { artist: '', album: m.name, folderName: m.name, folderPath: m.path, files: m.node.files, totalSize: m.size, lossless: m.tracks.every(t => /\.(flac|wav|ape|wv|alac|aiff?|dsf|dff)$/i.test(t.name)) }); break
        case 'dl-tree': {
          const all = []; (function walk(n) { for (const f of n.files || []) if (AUDIO_RE.test(f.name)) all.push(f); for (const c of n.dirs.values()) walk(c) })(m.node)
          const go = async () => { const r = await enq(all); deps.showSnackbar(r.ok ? 'Downloading ' + all.length + ' files' : 'Could not start the download'); if (r.ok && deps._scheduleLibRescan) deps._scheduleLibRescan() }
          if (deps._mgConfirm) deps._mgConfirm({ title: 'Download ' + all.length + ' files?', body: fmtSize(all.reduce((s, f) => s + (f.size || 0), 0)), ok: 'Download' }).then(yes => yes && go())
          else go()
          break
        }
      }
    })
    crumbsEl.addEventListener('click', e => { const b = e.target.closest('[data-path]'); if (b) { path = b.dataset.path; sel = null; render() } })

    function onKey(e) {
      if (!host.isConnected) return
      const cols = [...colsEl.querySelectorAll('.slr-col:not(.slr-col-insp)')]
      const active = cols.findIndex(c => c.querySelector('.is-sel'))
      const col = cols[active >= 0 ? active : cols.length - 1]
      const rows = col ? [...col.querySelectorAll('.slr-row')] : []
      const i = rows.findIndex(r => r.classList.contains('is-sel'))
      const pick = r => { if (!r) return; if (r.dataset.path !== undefined) { path = r.dataset.path; sel = null } else sel = { col: r.dataset.col, file: Number(r.dataset.file) }; render() }
      if (e.key === 'ArrowDown') { e.preventDefault(); pick(rows[Math.min(rows.length - 1, i + 1)]) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); pick(rows[Math.max(0, i - 1)]) }
      else if (e.key === 'ArrowLeft' || e.key === 'Backspace') { e.preventDefault(); path = T().parentPath ? T().parentPath(path) : path.split(SEP).slice(0, -1).join(SEP); sel = null; render() }
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); const next = cols[cols.length - 1]; const first = next && next.querySelector('.slr-row'); if (first && !first.classList.contains('is-sel')) pick(first) }
    }
    document.addEventListener('keydown', onKey)

    render()
    return {
      navTo(p) { path = p || ''; sel = null; render() },
      setFilters(f) { Object.assign(filters, f); render() },
      search(q) { query = q; render() },
      destroy() { document.removeEventListener('keydown', onKey); host.innerHTML = '' },
    }
  }

  const api = { mount, columnsFor, inspectorModel }
  if (typeof window !== 'undefined') window.PapaSlskColumns = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})()
```

Search inside Folders (`search(q)`): when `q` is non-empty, `render()` must replace the first column with `T().searchTree(tree, q)` results (rows of kind `dir`/`file` with their full paths) and hide deeper columns. Implement that branch at the top of `render()`: `if (query) { ...paint one column of results...; return }`. `searchTree`'s return shape is in `src/slsk-tree.js` around line 170; read it and map to `{ name, path, kind }`.

- [ ] **Step 4: Run** — 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/slsk-columns.js test/slsk-columns.test.js
git commit -m "Folders mode: column browser with a live inspector, keyboard walkable"
```

---

### Task 8: The page shell with Hunt and Wander renderers

**Files:**
- Create: `src/slsk-room-ui.js`
- Test: `test/slsk-room-ui.test.js`

**Interfaces:**
- Consumes: everything above; `window.api.slskBrowseUser`, `slskUserStatuses`, `slskSavedUsers`; `PapaSlskShelves.extractAlbumsChunked`, `buildShelvesChunked`, `buildTree`; `PapaSlskFilters.detectSurround`; `PapaTasteModel`? No — affinity seeds come from `deps.state.playCounts` / `deps.state.history` through `window.PapaTasteModel.buildAffinity` if present on window, else from the library's most-played artists (`state.library` sorted by `playCount`). Read `src/taste-model.js` line 10 for the input shape and check whether it is a page script (`grep taste-model src/index.html`); if not, use the library fallback only.
- Produces: `window.PapaSlskRoomUI = { show(username, deps) }` with the same contract as `PapaSlskShopUI.show`. Exports for tests: `headerModel(stats, characterLine, status)`, `modeKey(username)`.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test')
const assert = require('node:assert')
const R = require('../src/slsk-room-ui')

test('headerModel turns stats into ring slices that sum to 100', () => {
  const h = R.headerModel({ albums: 100, hiRes: 18, surround: 8, losslessPct: 71, tracks: 1000, size: 1e12 }, 'A 70s rock collector', { online: true, queue: 2 })
  const sum = h.ring.reduce((s, x) => s + x.pct, 0)
  assert.equal(sum, 100)
  assert.equal(h.ring[0].tier, 'hires')
  assert.equal(h.status, 'online now · 2 in their queue')
  assert.equal(h.line, 'A 70s rock collector')
})

test('modeKey is per peer and seeds from the old global key', () => {
  assert.equal(R.modeKey('Some User'), 'slsk_lib_mode:some user')
})

test('wander shelf order is fixed and empty shelves are dropped', () => {
  const shelves = R.wanderShelves({ goDeep: [], fresh: [1], because: [], onlyHere: null, decade: { decade: 1970, share: 40, albums: [1] }, surround: [], hires: [1] })
  assert.deepEqual(shelves.map(s => s.id), ['fresh', 'decade', 'hires'])
})
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Write `src/slsk-room-ui.js`**

```js
// The Listening Room: one page for a peer's library with three modes (Hunt,
// Wander, Folders) and one album dossier. Same show(username, deps) contract
// as slsk-shop-ui.js so renderer.js only swaps which module it calls.
;(function () {
  const W = () => window.PapaSlskWander, H = () => window.PapaSlskHunt, SH = () => window.PapaSlskShelves
  const T = () => window.PapaSlskTree, SF = () => window.PapaSlskFilters

  function modeKey(username) { return 'slsk_lib_mode:' + String(username || '').toLowerCase() }

  function headerModel(stats, line, status) {
    const st = stats || { albums: 0, hiRes: 0, surround: 0, losslessPct: 0, tracks: 0, size: 0 }
    const n = Math.max(1, st.albums || 0)
    const hires = Math.round((st.hiRes || 0) / n * 100)
    const surround = Math.round((st.surround || 0) / n * 100)
    let lossless = Math.max(0, (st.losslessPct || 0) - hires - surround)
    let lossy = Math.max(0, 100 - hires - surround - lossless)
    const ring = [{ tier: 'hires', pct: hires }, { tier: 'surround', pct: surround }, { tier: 'lossless', pct: lossless }, { tier: 'lossy', pct: lossy }]
    const drift = 100 - ring.reduce((s, x) => s + x.pct, 0)
    ring[3].pct += drift
    const bits = []
    if (status && status.online) bits.push('online now'); else if (status) bits.push('offline')
    if (status && status.queue != null) bits.push(status.queue + ' in their queue')
    return { ring, line: line || '', status: bits.join(' · '), losslessPct: st.losslessPct || 0, stats: st }
  }

  function wanderShelves(parts) {
    const out = []
    for (const e of parts.goDeep || []) if (e.albums.length) { out.push({ id: 'deep:' + e.artist, title: e.artist, sub: e.count + ' albums · ' + e.lacking + ' you lack', albums: e.albums }); if (out.length >= 3) break }
    if ((parts.fresh || []).length) out.push({ id: 'fresh', title: 'Fresh arrivals', sub: parts.fresh.length + ' added since you were last here', albums: parts.fresh })
    for (const b of parts.because || []) out.push({ id: 'because:' + b.seed.album, title: 'Because you own ' + b.seed.album, sub: 'same scene as ' + b.seed.artist, albums: b.albums })
    if (parts.onlyHere && parts.onlyHere.albums.length) out.push({ id: 'only', title: 'Only here', sub: 'in none of the ' + parts.onlyHere.peersChecked + ' other peers you\'ve browsed', albums: parts.onlyHere.albums })
    if (parts.decade && parts.decade.albums.length) out.push({ id: 'decade', title: 'The ' + String(parts.decade.decade).slice(2) + 's, a decade they love', sub: parts.decade.share + '% of their dated albums', albums: parts.decade.albums })
    if ((parts.surround || []).length) out.push({ id: 'surround', title: 'Their surround room', sub: parts.surround.length + ' multichannel', albums: parts.surround })
    if ((parts.hires || []).length) out.push({ id: 'hires', title: 'Hi-res', sub: parts.hires.length + ' at 24-bit or 88.2 kHz+', albums: parts.hires })
    return out
  }

  async function show(username, deps) {
    const esc = deps.esc, state = deps.state, host = deps.host
    let mode = 'hunt'
    try { mode = localStorage.getItem(modeKey(username)) || localStorage.getItem('slsk_lib_mode') || 'hunt'; if (mode === 'shelves') mode = 'hunt' } catch (_) {}
    if (!['hunt', 'wander', 'folders'].includes(mode)) mode = 'hunt'

    host.innerHTML = `<div class="slsk-room" id="slsk-room">
      <div class="slr-head" id="slr-head"><div class="slr-skel"></div></div>
      <div class="slr-body" id="slr-body"><div class="slr-loading">Reading ${esc(username)}'s library…</div></div>
    </div>`
    const root = host.querySelector('#slsk-room'), headEl = host.querySelector('#slr-head'), bodyEl = host.querySelector('#slr-body')
    let tree = null, albums = [], shelves = null, fresh = [], columns = null, dead = false
    let hunt = { sort: 'verdict', dir: 'asc', filter: null, query: '' }
    const albumsByPath = new Map()

    function paintHead(hm) {
      const grad = 'conic-gradient(' + hm.ring.reduce((acc, x) => { const from = acc.at; acc.at += x.pct; acc.s.push(`var(--slr-${x.tier}) ${from}% ${acc.at}%`); return acc }, { at: 0, s: [] }).s.join(',') + ')'
      headEl.innerHTML = `
        <div class="slr-ring" style="background:${grad}" title="${hm.ring.map(x => x.tier + ' ' + x.pct + '%').join(', ')}"><b>${hm.losslessPct}%</b></div>
        <div class="slr-head-text">
          <h1 class="slr-name">${esc(username)}</h1>
          <div class="slr-muted">${esc([hm.line, hm.stats.albums.toLocaleString() + ' albums', hm.status].filter(Boolean).join(' · '))}<span id="slr-cache" class="slr-cache"></span></div>
          <div class="slr-modes" role="tablist">${['hunt', 'wander', 'folders'].map(m => `<button role="tab" class="slr-mode${m === mode ? ' is-on' : ''}" data-mode="${m}" aria-selected="${m === mode}">${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}</div>
        </div>
        <div class="slr-head-tools"><input class="slr-search" id="slr-search" placeholder="Search ${esc(username)}'s library…" autocomplete="off"><button class="slr-btn slr-btn-quiet" id="slr-close" aria-label="Back">←</button></div>`
      headEl.querySelector('#slr-close').addEventListener('click', () => deps.onClose && deps.onClose())
      headEl.querySelectorAll('.slr-mode').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)))
      const search = headEl.querySelector('#slr-search')
      let t = null
      search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { hunt.query = search.value; if (mode === 'folders' && columns) columns.search(search.value); else paintBody() }, 160) })
    }

    function setMode(m) {
      if (m === mode) return
      mode = m
      try { localStorage.setItem(modeKey(username), m) } catch (_) {}
      headEl.querySelectorAll('.slr-mode').forEach(b => { b.classList.toggle('is-on', b.dataset.mode === m); b.setAttribute('aria-selected', String(b.dataset.mode === m)) })
      paintBody()
    }

    function openDossier(album) {
      const D = window.PapaSlskDossier
      if (!D) return
      const sibs = albums.filter(a => a !== album && a.artist && album.artist && W().norm(a.artist) === W().norm(album.artist))
      D.open({ album, username, host: root, deps: { ...deps, openDossier, wishlistAdd: deps.wishlistAdd }, siblings: sibs })
    }

    function cardHtml(a) {
      const tier = H().tierOf(a)
      const hint = a.upgrade ? 'upgrade' : (shelves && shelves.missing.includes(a) ? 'not yours' : 'you have it')
      return `<button class="slr-card" data-path="${esc(a.folderPath)}"><span class="slr-card-cover" data-art="${esc(a.artist)}|${esc(a.album)}"><i class="slr-lbl slr-lbl-${tier}"></i></span>
        <span class="slr-card-t">${esc(a.album || a.folderName)}</span><span class="slr-card-a">${esc([a.artist, a.year].filter(Boolean).join(' · '))}</span><span class="slr-card-hint slr-hint-${hint.replace(/\s/g, '-')}">${hint}${a.isHiRes ? ' · ' + a.maxBitDepth + '/' + Math.round(a.maxSampleRate / 1000) : ''}</span></button>`
    }

    function paintHunt() {
      const Hm = H()
      const tiles = Hm.tiles(shelves, fresh.length)
      let rows = Hm.buildRows(shelves, state.library)
      if (hunt.filter === 'upgrades') rows = rows.filter(r => r.verdictKind === 'upgrade' || r.verdictKind === 'surround')
      else if (hunt.filter === 'missing') rows = rows.filter(r => r.verdictKind === 'missing')
      else if (hunt.filter === 'surround') rows = rows.filter(r => r.album.surround)
      else if (hunt.filter === 'new') { const fp = new Set(fresh.map(a => a.folderPath)); rows = rows.filter(r => fp.has(r.album.folderPath)) }
      rows = Hm.sortRows(Hm.filterRows(rows, hunt.query), hunt.sort, hunt.dir)
      const upgrades = shelves.upgrades.length
      const head = ['', 'title:Album', 'theirs:Theirs', 'yours:Yours', 'verdict:Verdict', 'size:Size'].map(h => { const [k, l] = h.split(':'); return `<th${k ? ` data-sort="${k}" class="${hunt.sort === k ? 'is-sorted-' + hunt.dir : ''}"` : ''}>${l || ''}</th>` }).join('')
      const WINDOW = 300
      const rowHtml = r => `<tr class="slr-tr slr-tr-${r.verdictKind}" data-path="${esc(r.album.folderPath)}"><td><input type="checkbox" class="slr-pick" data-path="${esc(r.album.folderPath)}" aria-label="Select"></td>
        <td class="slr-td-title"><span class="slr-mini-cover" data-art="${esc(r.artist)}|${esc(r.title)}"></span><b>${esc(r.title)}</b><small>${esc([r.artist, r.year].filter(Boolean).join(' · '))}</small></td>
        <td class="slr-mono"><i class="slr-lbl slr-lbl-${r.tier}"></i>${esc(r.theirs)}</td><td class="slr-mono">${esc(r.yours)}</td><td class="slr-verdict slr-v-${r.verdictKind}">${esc(r.verdictText)}</td><td class="slr-mono">${esc(SH().fmtSize(r.size))}</td></tr>`
      bodyEl.innerHTML = `
        <div class="slr-tiles">${tiles.map(t => `<button class="slr-tile${hunt.filter === t.id ? ' is-on' : ''}${t.id === 'upgrades' && t.n ? ' is-hot' : ''}" data-tile="${t.id}"><b>${t.n.toLocaleString()}</b><span>${t.label}</span></button>`).join('')}</div>
        <div class="slr-ledger-tools"><span class="slr-muted" id="slr-count">${rows.length.toLocaleString()} album${rows.length === 1 ? '' : 's'}</span><span class="slr-grow"></span>
          <button class="slr-btn" id="slr-dl-picked" disabled>Download selected</button>${upgrades ? `<button class="slr-btn slr-btn-pri" id="slr-grab-all">Grab all ${upgrades} upgrade${upgrades === 1 ? '' : 's'}</button>` : ''}</div>
        <div class="slr-ledger-wrap"><table class="slr-ledger"><thead><tr>${head}</tr></thead><tbody id="slr-tbody">${rows.slice(0, WINDOW).map(rowHtml).join('')}</tbody></table>
        ${rows.length > WINDOW ? `<button class="slr-btn slr-more" id="slr-more">Show ${Math.min(WINDOW, rows.length - WINDOW)} more</button>` : ''}</div>`
      let shown = WINDOW
      const more = bodyEl.querySelector('#slr-more')
      if (more) more.addEventListener('click', () => { bodyEl.querySelector('#slr-tbody').insertAdjacentHTML('beforeend', rows.slice(shown, shown + WINDOW).map(rowHtml).join('')); shown += WINDOW; if (shown >= rows.length) more.remove(); else more.textContent = 'Show ' + Math.min(WINDOW, rows.length - shown) + ' more'; armArt() })
      bodyEl.querySelectorAll('[data-tile]').forEach(b => b.addEventListener('click', () => { hunt.filter = hunt.filter === b.dataset.tile ? null : b.dataset.tile; paintHunt() }))
      bodyEl.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => { const k = th.dataset.sort; hunt.dir = hunt.sort === k && hunt.dir === 'asc' ? 'desc' : 'asc'; hunt.sort = k; try { localStorage.setItem('slsk_hunt_sort:' + username, hunt.sort + ':' + hunt.dir) } catch (_) {} paintHunt() }))
      bodyEl.querySelector('#slr-tbody').addEventListener('click', e => { if (e.target.closest('.slr-pick')) { updatePicked(); return } const tr = e.target.closest('tr[data-path]'); if (tr) { const a = albumsByPath.get(tr.dataset.path.toLowerCase()); if (a) openDossier(a) } })
      function updatePicked() { const n = bodyEl.querySelectorAll('.slr-pick:checked').length; const b = bodyEl.querySelector('#slr-dl-picked'); b.disabled = !n; b.textContent = n ? 'Download ' + n + ' selected' : 'Download selected' }
      bodyEl.querySelector('#slr-dl-picked').addEventListener('click', async () => {
        const picked = [...bodyEl.querySelectorAll('.slr-pick:checked')].map(cb => albumsByPath.get(cb.dataset.path.toLowerCase())).filter(Boolean)
        const items = picked.flatMap(a => a.files.filter(f => T().AUDIO_RE.test(f.name)).map(f => ({ username, filename: f.fullPath, size: f.size || 0 })))
        const r = await deps._slskEnqueue(items); deps.showSnackbar(r.ok ? 'Downloading ' + picked.length + ' albums' : 'Could not start the download'); if (r.ok && deps._scheduleLibRescan) deps._scheduleLibRescan()
      })
      const grab = bodyEl.querySelector('#slr-grab-all')
      if (grab) grab.addEventListener('click', async () => {
        const go = async () => { const items = shelves.upgrades.flatMap(a => a.files.filter(f => T().AUDIO_RE.test(f.name)).map(f => ({ username, filename: f.fullPath, size: f.size || 0 }))); const r = await deps._slskEnqueue(items); deps.showSnackbar(r.ok ? 'Downloading ' + shelves.upgrades.length + ' upgrades' : 'Could not start the download'); if (r.ok && deps._scheduleLibRescan) deps._scheduleLibRescan() }
        if (deps._mgConfirm) deps._mgConfirm({ title: 'Download all ' + shelves.upgrades.length + ' upgrades?', body: shelves.upgrades.slice(0, 12).map(a => a.artist + ' – ' + a.album).join('\n') + (shelves.upgrades.length > 12 ? '\n…' : ''), ok: 'Download' }).then(y => y && go()); else go()
      })
      armArt()
    }

    let wander = { tags: {}, tagsDone: false }
    function paintWander() {
      const Wm = W()
      const owns = a => shelves && !shelves.missing.includes(a)
      const parts = {
        goDeep: Wm.goDeep(albums, owns), fresh,
        because: Wm.becauseYouOwn(albums, wander.seeds || [], wander.tags),
        onlyHere: Wm.onlyHere(albums, wander.otherPeers || []),
        decade: Wm.decadeShelf(albums), surround: shelves.surround, hires: shelves.hires,
      }
      const list = wanderShelves(parts)
      const q = hunt.query.trim().toLowerCase()
      const filt = l => q ? l.filter(a => (a.album + ' ' + a.artist).toLowerCase().includes(q)) : l
      bodyEl.innerHTML = list.map(s => { const al = filt(s.albums); return al.length ? `<section class="slr-shelf" data-shelf="${esc(s.id)}"><div class="slr-shelf-h"><b>${esc(s.title)}</b><small>${esc(s.sub)}</small></div><div class="slr-strip">${al.slice(0, 40).map(cardHtml).join('')}${al.length > 40 ? `<button class="slr-card slr-card-more" data-seeall="${esc(s.id)}">+${al.length - 40} more</button>` : ''}</div></section>` : '' }).join('') +
        (list.length ? '' : '<div class="slr-muted slr-empty">Nothing to wander through yet.</div>') +
        `<div class="slr-story" id="slr-story"></div>` +
        (wander.tagsDone ? '' : `<div class="slr-muted slr-note">Working out what else you'd like… (${Object.keys(wander.tags).length} artists checked)</div>`)
      bodyEl.querySelectorAll('.slr-card[data-path]').forEach(c => c.addEventListener('click', () => { const a = albumsByPath.get(c.dataset.path.toLowerCase()); if (a) openDossier(a) }))
      bodyEl.querySelectorAll('[data-seeall]').forEach(b => b.addEventListener('click', () => { hunt.filter = null; hunt.query = ''; setMode('hunt') }))
      const top = parts.goDeep[0]
      if (top && window.api && window.api.artistInfo) window.api.artistInfo({ artist: top.artist }).then(r => { const el = bodyEl.querySelector('#slr-story'); if (el && r && r.bio) el.innerHTML = `<b>${esc(top.artist)}</b> — ${esc(String(r.bio).slice(0, 300))}… This peer holds ${top.count} of their albums.` }).catch(() => {})
      armArt()
    }

    // Lazy cover art for any [data-art="artist|album"] in view, via the existing handler.
    let artObs = null
    function armArt() {
      if (artObs) artObs.disconnect()
      artObs = new IntersectionObserver(entries => { for (const en of entries) if (en.isIntersecting) { artObs.unobserve(en.target); fetchArt(en.target) } }, { root: bodyEl, rootMargin: '200px' })
      bodyEl.querySelectorAll('[data-art]').forEach(el => artObs.observe(el))
    }
    function fetchArt(el) {
      const [artist, album] = String(el.dataset.art).split('|')
      const lib = (state.library || []).find(l => l.artPath && SH().tokenScore(album, l.name) >= 0.6 && (!artist || !l.artist || SH().tokenScore(artist, l.artist) >= 0.34))
      const put = p => { if (p && el.isConnected) el.style.backgroundImage = `url("${/^https?:/.test(p) ? p : 'file://' + p}")` }
      if (lib) return put(lib.artPath)
      if (window.api && window.api.fetchAlbumArt && artist) window.api.fetchAlbumArt({ albumId: 'slsk-' + (artist + '-' + album).replace(/[^a-z0-9]+/gi, '-').toLowerCase(), artist, album }).then(put).catch(() => {})
    }

    function paintFolders() {
      bodyEl.innerHTML = ''
      columns = window.PapaSlskColumns.mount({ host: bodyEl, tree, username, deps, albumsByPath, openDossier })
    }

    function paintBody() {
      if (columns) { columns.destroy(); columns = null }
      if (!shelves) { bodyEl.innerHTML = `<div class="slr-loading">Reading ${esc(username)}'s library…</div>`; return }
      if (mode === 'hunt') paintHunt(); else if (mode === 'wander') paintWander(); else paintFolders()
    }

    // ── Load ─────────────────────────────────────────────────────────────────
    const res = await window.api.slskBrowseUser({ username }).catch(e => ({ error: e.message }))
    if (dead || !host.isConnected) return
    if (!res || res.error || !Array.isArray(res.directories)) { bodyEl.innerHTML = `<div class="slr-empty">Could not read this library. ${esc((res && res.error) || '')}</div>`; return }
    tree = T().buildTree(res.directories)
    albums = SH().extractAlbumsChunked ? await SH().extractAlbumsChunked(tree, { minTracks: 2, shouldAbort: () => dead }) : SH().extractAlbums(tree, { minTracks: 2 })
    for (const a of albums) albumsByPath.set(String(a.folderPath).toLowerCase(), a)
    const detect = SF() ? SF().detectSurround : null
    shelves = SH().buildShelvesChunked ? await SH().buildShelvesChunked(albums, state.library, { detectSurround: detect, shouldAbort: () => dead }) : SH().buildShelves(albums, state.library, { detectSurround: detect })
    for (const u of shelves.upgrades) albumsByPath.set(String(u.folderPath).toLowerCase(), u)
    const nd = new Set((res.newDirs || []).map(s => String(s).toLowerCase()))
    fresh = nd.size ? albums.filter(a => nd.has(String(a.folderPath).toLowerCase())) : []
    try { const s = localStorage.getItem('slsk_hunt_sort:' + username); if (s) { const [k, d] = s.split(':'); hunt.sort = k; hunt.dir = d } } catch (_) {}
    const statuses = window.api.slskUserStatuses ? await window.api.slskUserStatuses().catch(() => null) : null
    const st = statuses && (statuses[username] || (Array.isArray(statuses) && statuses.find(x => x.username === username)))
    paintHead(headerModel(shelves.stats, W().characterLine(tree, albums), st ? { online: !!(st.online || st.isOnline || st.status === 'online'), queue: st.queueLength != null ? st.queueLength : st.queue } : null))
    const cache = headEl.querySelector('#slr-cache')
    if (cache && res.fromCache) cache.textContent = ' · from cache' + (res.cachedAt ? ', ' + Math.round((Date.now() - res.cachedAt) / 60000) + ' min old' : '')
    paintBody()

    // Background: seeds and tags for "Because you own", other peers for "Only here".
    ;(async () => {
      const lib = state.library || []
      const byArtist = new Map()
      for (const l of lib) if (l.artist) byArtist.set(l.artist, (byArtist.get(l.artist) || 0) + (Number(l.playCount) || 1))
      const peerArtists = new Set(albums.map(a => W().norm(a.artist)))
      wander.seeds = [...byArtist.entries()].sort((a, b) => b[1] - a[1]).map(([artist]) => lib.find(l => l.artist === artist)).filter(l => l && !peerArtists.has(W().norm(l.artist))).slice(0, 3).map(l => ({ artist: l.artist, album: l.name }))
      const want = [...new Set([...wander.seeds.map(s => s.artist), ...W().goDeep(albums, null, 1).slice(0, 40).map(e => e.artist)])]
      for (const artist of want) {
        if (dead) return
        const r = window.api.musicbrainzArtistTags ? await window.api.musicbrainzArtistTags({ artist }).catch(() => null) : null
        if (r && r.ok) wander.tags[W().norm(artist)] = r.tags
      }
      wander.tagsDone = true
      if (window.api.slskCachedPeerAlbums) wander.otherPeers = await window.api.slskCachedPeerAlbums({ except: username }).catch(() => [])
      if (mode === 'wander' && !dead) paintWander()
    })()

    return { close() { dead = true; if (columns) columns.destroy(); host.innerHTML = '' } }
  }

  const api = { show, headerModel, modeKey, wanderShelves }
  if (typeof window !== 'undefined') window.PapaSlskRoomUI = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})()
```

`window.api.slskCachedPeerAlbums` does not exist yet: add it in Task 9 (main handler reading `sideStores.browseCache`, returning `[[{ artist, album }]]` per other cached peer via `extractAlbums` on a `buildTree` of each; cap at 12 peers, run through `setImmediate` between peers). Until then `wander.otherPeers` stays empty and "Only here" is hidden, which is correct behaviour.

- [ ] **Step 4: Run** — 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/slsk-room-ui.js test/slsk-room-ui.test.js
git commit -m "The Listening Room: page shell with Hunt ledger and Wander shelves"
```

---

### Task 9: `slsk-cached-peer-albums` handler

**Files:**
- Modify: `main.js` (next to `_browseCacheRead`, line ~12257)
- Modify: `preload.js`
- Test: append to `test/peer-enrich-ipc.test.js`

- [ ] **Step 1: Test**

```js
test('slsk-cached-peer-albums exists, is exposed, and skips the asking peer', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
  assert.ok(main.includes("ipcMain.handle('slsk-cached-peer-albums'"))
  assert.ok(pre.includes("'slsk-cached-peer-albums'"))
  const body = main.slice(main.indexOf("ipcMain.handle('slsk-cached-peer-albums'"), main.indexOf("ipcMain.handle('slsk-cached-peer-albums'") + 2500)
  assert.ok(/except/.test(body) && /continue/.test(body))
})
```

- [ ] **Step 2: Handler**

```js
// Every OTHER cached peer's albums as light {artist, album} pairs, for the
// "Only here" shelf. Capped and yielded between peers so a fat cache cannot
// stall mpv's IPC on this thread.
ipcMain.handle('slsk-cached-peer-albums', async (_, { except } = {}) => {
  const SHm = require('./src/slsk-shelves')
  const Tm = require('./src/slsk-tree')
  let map
  try { map = sideStores.browseCache.get() || {} } catch (_) { return [] }
  const out = []
  const skip = String(except || '').toLowerCase()
  for (const k of Object.keys(map)) {
    if (!k.startsWith('browse:')) continue
    if (k.slice(7).toLowerCase() === skip) continue
    const dirs = map[k] && map[k].directories
    if (!Array.isArray(dirs)) continue
    try {
      const albums = SHm.extractAlbums(Tm.buildTree(dirs), { minTracks: 2 })
      out.push(albums.map(a => ({ artist: a.artist, album: a.album })))
    } catch (_) { continue }
    if (out.length >= 12) break
    await new Promise(r => setImmediate(r))
  }
  return out
})
```

Preload: `slskCachedPeerAlbums: (p) => ipcRenderer.invoke('slsk-cached-peer-albums', p),`

- [ ] **Step 3: Run suite, commit**

```bash
git add main.js preload.js test/peer-enrich-ipc.test.js
git commit -m "Only here: hand the renderer every other cached peer's albums, capped and yielding"
```

---

### Task 10: Stylesheet

**Files:**
- Create: `src/slsk-room.css`
- Modify: `src/index.html` (add `<link rel="stylesheet" href="slsk-room.css">` after the `slsk-explorer.css` link on line 8)

- [ ] **Step 1: Write the stylesheet.** Everything under `.slsk-room`. Tokens first, then the head, modes, tiles, ledger, shelves/cards, columns, dossier, states. Use the app's `--bg`, `--text`, `--text-2`, `--accent`, `--hairline`, `--r`, `--ease` where they exist (check `src/styles.css` lines 80-130 for the exact names; `--text-2`-style muted tokens may be `--text-dim` — grep and use the real one).

```css
/* THE LISTENING ROOM — a peer's library as one page with three moods.
   Scoped: .slsk-room / slr-*. Reads the app tokens; defines its own label
   colours so it does not depend on slsk-explorer.css. */
.slsk-room{
  --slr-hires:#e0b04a; --slr-surround:#b57bdc; --slr-lossless:#3ddc7a; --slr-lossy:#8b8a86;
  --slr-mono:var(--font-mono, ui-monospace, monospace);
  --slr-muted:var(--text-2, var(--text-dim, #a9a7a1));
  display:flex; flex-direction:column; height:100%; min-height:0; color:var(--text);
}
[data-theme="light"] .slsk-room, .light .slsk-room{ --slr-hires:#9a6d00; --slr-surround:#6a3aa0; --slr-lossless:#137a3a; --slr-lossy:#6b6a66 }

/* Head */
.slr-head{display:grid;grid-template-columns:auto 1fr auto;gap:18px;align-items:center;padding:18px 24px 12px;border-bottom:1px solid var(--hairline)}
.slr-ring{width:84px;height:84px;border-radius:50%;position:relative;flex:none}
.slr-ring::after{content:"";position:absolute;inset:12px;border-radius:50%;background:var(--bg)}
.slr-ring b{position:absolute;inset:0;display:grid;place-items:center;font-size:17px;z-index:1;font-variant-numeric:tabular-nums}
.slr-name{font-size:22px;font-weight:600;margin:0 0 2px;letter-spacing:-.01em}
.slr-muted{color:var(--slr-muted);font-size:12.5px}
.slr-modes{display:inline-flex;border:1px solid var(--hairline);border-radius:100px;padding:3px;margin-top:8px}
.slr-mode{background:none;border:0;color:var(--slr-muted);padding:5px 14px;border-radius:100px;font-size:12.5px;cursor:pointer;transition:background .18s var(--ease),color .18s var(--ease)}
.slr-mode.is-on{background:var(--text);color:var(--bg)}
.slr-mode:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.slr-head-tools{display:flex;gap:8px;align-items:center}
.slr-search{width:260px;max-width:40vw;background:var(--glass, rgba(255,255,255,.05));border:1px solid var(--hairline);color:var(--text);padding:8px 12px;border-radius:8px;font-size:13px}
.slr-body{flex:1;min-height:0;overflow:auto;padding:16px 24px 40px}

/* Shared bits */
.slr-lbl{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:-1px}
.slr-lbl-hires{background:var(--slr-hires)}.slr-lbl-surround{background:var(--slr-surround)}.slr-lbl-lossless{background:var(--slr-lossless)}.slr-lbl-lossy{background:var(--slr-lossy)}
.slr-mono{font-family:var(--slr-mono);font-variant-numeric:tabular-nums}
.slr-btn{font-size:12.5px;padding:6px 12px;border-radius:7px;background:var(--glass, rgba(255,255,255,.06));border:1px solid var(--hairline);color:var(--text);cursor:pointer;white-space:nowrap}
.slr-btn:hover{background:var(--glass-hi, rgba(255,255,255,.1))}
.slr-btn:disabled{opacity:.45;cursor:default}
.slr-btn-pri{background:var(--accent);color:#04120a;border-color:transparent;font-weight:600}
.slr-btn-quiet{background:none}
.slr-btn:focus-visible,.slr-card:focus-visible,.slr-tile:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.slr-pill{font-size:11px;padding:3px 9px;border-radius:100px;border:1px solid var(--hairline);color:var(--slr-muted);white-space:nowrap}
.slr-pill-verdict{border-color:var(--slr-hires);color:var(--slr-hires)}
.slr-chip{font-size:11px;padding:2px 8px;border-radius:100px;background:var(--glass, rgba(255,255,255,.06));color:var(--slr-muted);border:0}
.slr-chip-btn{cursor:pointer;color:var(--text)}
.slr-chips{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}
.slr-grow{flex:1}
.slr-v-upgrade,.slr-v-surround,.slr-v-up{color:var(--slr-hires)}.slr-v-missing{color:var(--slr-lossless)}.slr-v-same,.slr-v-worse{color:var(--slr-muted)}
.slr-loading,.slr-empty{padding:48px;text-align:center;color:var(--slr-muted)}

/* Hunt */
.slr-tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
.slr-tile{text-align:left;background:var(--glass, rgba(255,255,255,.05));border:1px solid transparent;border-radius:8px;padding:10px 12px;color:var(--text);cursor:pointer;display:flex;flex-direction:column;gap:3px}
.slr-tile b{font-size:24px;line-height:1;font-weight:600;font-variant-numeric:tabular-nums}
.slr-tile span{font-size:11.5px;color:var(--slr-muted)}
.slr-tile.is-hot{box-shadow:inset 3px 0 var(--slr-hires)}
.slr-tile.is-on{border-color:var(--accent)}
.slr-ledger-tools{display:flex;gap:8px;align-items:center;margin-bottom:8px}
.slr-ledger-wrap{overflow-x:auto}
.slr-ledger{width:100%;border-collapse:collapse;font-size:12.5px}
.slr-ledger th{text-align:left;font-weight:500;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--slr-muted);padding:6px 8px;border-bottom:1px solid var(--hairline);font-family:var(--slr-mono);cursor:pointer;user-select:none;white-space:nowrap}
.slr-ledger th.is-sorted-asc::after{content:" ↑"}.slr-ledger th.is-sorted-desc::after{content:" ↓"}
.slr-ledger td{padding:6px 8px;border-bottom:1px solid var(--hairline);white-space:nowrap;vertical-align:middle}
.slr-tr{cursor:pointer}.slr-tr:hover td{background:var(--glass, rgba(255,255,255,.04))}
.slr-tr-upgrade td:first-child,.slr-tr-surround td:first-child{box-shadow:inset 3px 0 var(--slr-hires)}
.slr-td-title{white-space:normal!important;min-width:220px}
.slr-td-title b{font-weight:600;display:block}.slr-td-title small{color:var(--slr-muted)}
.slr-mini-cover{width:28px;height:28px;border-radius:3px;background:var(--glass-hi, #222) center/cover;display:inline-block;vertical-align:middle;margin-right:10px;float:left}
.slr-more{display:block;margin:12px auto}

/* Wander */
.slr-shelf{margin-bottom:18px}
.slr-shelf-h{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px}
.slr-shelf-h b{font-size:14px;font-weight:600}.slr-shelf-h small{color:var(--slr-muted);font-family:var(--slr-mono);font-size:10.5px}
.slr-strip{display:flex;gap:10px;overflow-x:auto;padding-bottom:6px;scroll-snap-type:x proximity}
.slr-card{width:128px;flex:none;background:none;border:0;padding:0;text-align:left;color:var(--text);cursor:pointer;scroll-snap-align:start;display:flex;flex-direction:column;gap:3px}
.slr-card-cover{display:block;aspect-ratio:1;border-radius:5px;background:var(--glass-hi, #222) center/cover;position:relative;transition:transform .2s var(--ease)}
.slr-card:hover .slr-card-cover{transform:translateY(-2px)}
.slr-card-cover .slr-lbl{position:absolute;top:6px;left:6px;margin:0;box-shadow:0 0 0 2px rgba(0,0,0,.5)}
.slr-card-t{font-size:12px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.slr-card-a{font-size:10.5px;color:var(--slr-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.slr-card-hint{font-family:var(--slr-mono);font-size:10px}
.slr-hint-not-yours{color:var(--slr-lossless)}.slr-hint-upgrade{color:var(--slr-hires)}.slr-hint-you-have-it{color:var(--slr-muted)}
.slr-card-more{align-items:center;justify-content:center;color:var(--slr-muted);border:1px dashed var(--hairline);border-radius:5px;aspect-ratio:1}
.slr-story{border-top:1px solid var(--hairline);padding-top:12px;margin-top:6px;font-size:13px;color:var(--slr-muted);max-width:70ch}
.slr-story b{color:var(--text)}
.slr-note{margin-top:10px}

/* Folders */
.slr-crumbs{display:flex;gap:4px;align-items:center;overflow-x:auto;margin-bottom:8px;font-size:12.5px}
.slr-crumb{background:none;border:0;color:var(--slr-muted);cursor:pointer;padding:2px 4px;border-radius:4px}
.slr-crumb.is-current{color:var(--text)}.slr-crumb-sep{color:var(--slr-muted)}
.slr-cols{display:flex;height:calc(100% - 32px);min-height:380px;border:1px solid var(--hairline);border-radius:8px;overflow-x:auto;overflow-y:hidden}
.slr-col{flex:none;width:220px;border-right:1px solid var(--hairline);overflow-y:auto;font-size:12.5px}
.slr-col-insp{width:320px;border-right:0;background:var(--glass, rgba(255,255,255,.03))}
.slr-row{display:flex;align-items:center;gap:6px;padding:6px 10px;cursor:pointer;white-space:nowrap}
.slr-row:hover{background:var(--glass, rgba(255,255,255,.04))}
.slr-row.is-sel{background:color-mix(in srgb, var(--accent) 18%, transparent)}
.slr-row.is-dim{color:var(--slr-muted)}
.slr-row-name{flex:1;overflow:hidden;text-overflow:ellipsis}
.slr-row-meta{font-size:10.5px;color:var(--slr-muted)}
.slr-row-arrow{color:var(--slr-muted)}
.slr-col-empty{padding:12px}
.slr-insp{padding:14px;font-size:12.5px}
.slr-insp h4{margin:0 0 2px;font-size:14px;font-weight:600}
.slr-insp-cover{aspect-ratio:1;border-radius:6px;background:var(--glass-hi, #222) center/cover;margin-bottom:10px}
.slr-kv{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;font-size:12px;margin:8px 0}
.slr-kv dt{color:var(--slr-muted)}.slr-kv dd{margin:0}
.slr-tracks{margin-top:8px;font-size:12px}
.slr-track{display:flex;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid var(--hairline)}
.slr-n{color:var(--slr-muted);width:18px;text-align:right}
.slr-t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.slr-q{color:var(--slr-muted);font-size:11px}
.slr-track-acts{display:flex;gap:2px;opacity:.85}
.slr-mini{background:none;border:0;color:var(--text);cursor:pointer;padding:2px 5px;border-radius:4px}
.slr-mini:hover{background:var(--glass-hi, rgba(255,255,255,.1))}
.slr-acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}

/* Dossier */
.slr-dossier{position:absolute;inset:0;z-index:40}
.slr-dossier-scrim{position:absolute;inset:0;background:rgba(0,0,0,.45);opacity:0;transition:opacity .2s var(--ease)}
.slr-dossier-panel{position:absolute;top:0;right:0;bottom:0;width:min(560px,92%);background:var(--bg);border-left:1px solid var(--hairline);overflow-y:auto;padding:20px 22px 40px;transform:translateX(24px);opacity:0;transition:transform .22s var(--ease-out),opacity .22s var(--ease-out)}
.slr-dossier.is-open .slr-dossier-scrim{opacity:1}.slr-dossier.is-open .slr-dossier-panel{transform:none;opacity:1}
.slr-x{position:absolute;top:12px;right:14px;background:none;border:0;color:var(--slr-muted);font-size:22px;cursor:pointer}
.slr-dossier-head{display:grid;grid-template-columns:130px 1fr;gap:14px;margin-bottom:12px}
.slr-dossier-cover{aspect-ratio:1;border-radius:6px;overflow:hidden;background:var(--glass-hi, #222)}
.slr-dossier-cover img{width:100%;height:100%;object-fit:cover;display:block}
.slr-dossier-title{font-size:19px;font-weight:600;margin:0;line-height:1.2;text-wrap:balance}
.slr-facts{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 6px}
.slr-sec{margin-top:14px;font-size:12.5px}
.slr-sec>b{display:block;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--slr-muted);font-family:var(--slr-mono);margin-bottom:5px;font-weight:500}
.slr-rip{display:flex;gap:10px;align-items:center;padding:8px 10px;background:var(--glass, rgba(255,255,255,.05));border-radius:7px;font-size:12px;flex-wrap:wrap}
.slr-rip-verdict{font-family:var(--slr-mono)}
.slr-rip-genuine .slr-rip-verdict{color:var(--slr-lossless)}
.slr-rip-upsampled .slr-rip-verdict,.slr-rip-padded .slr-rip-verdict,.slr-rip-transcoded .slr-rip-verdict{color:var(--slr-hires)}
.slr-rip-fail{color:var(--error-ink, #f58080)}
.slr-spin{width:12px;height:12px;border:2px solid var(--hairline);border-top-color:var(--accent);border-radius:50%;animation:slr-spin .8s linear infinite}
@keyframes slr-spin{to{transform:rotate(360deg)}}
.slr-stars{color:var(--slr-hires);letter-spacing:1px}
.slr-skel{height:84px;border-radius:8px;background:var(--glass, rgba(255,255,255,.05))}

@media (prefers-reduced-motion: reduce){.slsk-room *{transition:none!important;animation:none!important}}
@media (max-width:900px){.slr-tiles{grid-template-columns:repeat(2,1fr)}.slr-head{grid-template-columns:auto 1fr}.slr-head-tools{grid-column:1/-1}}
```

- [ ] **Step 2: Add the link to `index.html`** after line 8. Commit.

```bash
git add src/slsk-room.css src/index.html
git commit -m "The Listening Room stylesheet: label colours, ring, ledger, shelves, columns, dossier"
```

---

### Task 11: Wire it in — scripts, renderer switch, settings, scope test, docs

**Files:**
- Modify: `src/index.html` (script tags after `slsk-shop-ui.js`, line 1383)
- Modify: `src/renderer.js` (`renderSoulseekExplore`, line ~31760; Settings paint for the Discogs token and the legacy switch near the Soulseek share-mode block at line 27162)
- Modify: `test/slsk-renderer-scope.test.js`
- Create: `docs/peer-library.md`
- Test: `test/slsk-room-wiring.test.js`

- [ ] **Step 1: Wiring test**

```js
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), path = require('path'), vm = require('vm')
const SRC = path.join(__dirname, '..', 'src')
const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8')
const renderer = fs.readFileSync(path.join(SRC, 'renderer.js'), 'utf8')

test('every room script is a page script, after its dependencies', () => {
  const order = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1])
  const at = f => order.indexOf(f)
  for (const f of ['slsk-hunt.js', 'slsk-wander.js', 'slsk-columns.js', 'slsk-dossier.js', 'slsk-room-ui.js']) assert.ok(at(f) >= 0, f + ' is loaded')
  assert.ok(at('slsk-shelves.js') < at('slsk-hunt.js'))
  assert.ok(at('slsk-album-view.js') < at('slsk-dossier.js'))
  assert.ok(at('slsk-dossier.js') < at('slsk-room-ui.js') && at('slsk-columns.js') < at('slsk-room-ui.js'))
  assert.ok(html.includes('href="slsk-room.css"'))
})

test('the six slsk page scripts share one scope without a name collision', () => {
  const files = ['slsk-tree.js', 'slsk-shelves.js', 'slsk-hunt.js', 'slsk-wander.js', 'slsk-columns.js', 'slsk-dossier.js', 'slsk-room-ui.js']
  const src = files.map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n;\n')
  new vm.Script(src, { filename: 'slsk-all.js' })
})

test('renderSoulseekExplore prefers the room and honours the legacy switch', () => {
  const body = renderer.slice(renderer.indexOf('async function renderSoulseekExplore'), renderer.indexOf('async function renderSoulseekExplore') + 2500)
  assert.ok(body.includes('PapaSlskRoomUI'))
  assert.ok(body.includes('slskLegacyShop'))
})
```

- [ ] **Step 2: Add the script tags** to `index.html` right after `<script src="slsk-shop-ui.js"></script>`:

```html
<script src="slsk-hunt.js"></script>
<script src="slsk-wander.js"></script>
<script src="slsk-columns.js"></script>
<script src="slsk-dossier.js"></script>
<script src="slsk-room-ui.js"></script>
```

- [ ] **Step 3: Switch in `renderSoulseekExplore`.** Replace its first two lines with:

```js
async function renderSoulseekExplore(username) {
  // The Listening Room is the default; the old shop stays one setting away
  // ("Use the old library view" in Settings → Soulseek) for one release.
  let legacy = false
  try { legacy = localStorage.getItem('slskLegacyShop') === '1' } catch (_) {}
  const Room = (typeof window !== 'undefined' && window.PapaSlskRoomUI) || null
  const S = (!legacy && Room && Room.show) ? Room : ((typeof window !== 'undefined' && window.PapaSlskShopUI) || null)
```

Leave the rest of the function (the deps object) as is. Add `wishlistAdd` to that deps object if a renderer-level wishlist function exists (`grep -n "function wishlistAdd\|function _wishlistAdd" src/renderer.js`); otherwise omit and the dossier hides the button because `deps.wishlistAdd` is undefined — make the dossier's `open()` skip rendering that button when the dep is absent (one-line change in Task 6's template: wrap the wishlist button in `${deps.wishlistAdd ? ... : ''}`).

- [ ] **Step 4: Settings.** In the Soulseek settings block (near line 27162, where `#slsk-share-mode` is painted), add two controls to the settings HTML template in `index.html` (find the share-mode `<select id="slsk-share-mode">` and add directly after it):

```html
<label class="setting-row"><span>Use the old library view</span><input type="checkbox" id="slsk-legacy-shop"></label>
<label class="setting-row"><span>Discogs token <small>for album ratings and tags</small></span><input type="password" id="slsk-discogs-token" placeholder="paste a personal token" autocomplete="off"></label>
```

Match the surrounding markup's class names exactly (read the lines around the share-mode select and copy its row structure). In the renderer function that paints the share mode, add:

```js
  const legacy = document.getElementById('slsk-legacy-shop')
  if (legacy) { try { legacy.checked = localStorage.getItem('slskLegacyShop') === '1' } catch (_) {} legacy.onchange = () => { try { localStorage.setItem('slskLegacyShop', legacy.checked ? '1' : '0') } catch (_) {} } }
  const tok = document.getElementById('slsk-discogs-token')
  if (tok && window.api && window.api.discogsTokenGet) {
    window.api.discogsTokenGet().then(r => { tok.value = (r && r.token) || '' }).catch(() => {})
    tok.onchange = () => window.api.discogsTokenSet({ token: tok.value }).then(() => showSnackbar(tok.value ? 'Discogs connected' : 'Discogs token removed')).catch(() => {})
  }
```

- [ ] **Step 5: Scope test.** In `test/slsk-renderer-scope.test.js` line 98, extend the file list to include the five new files so the existing "no top-level leak" check covers them.

- [ ] **Step 6: Docs.** Create `docs/peer-library.md`:

```markdown
# The peer library page

Opening a Soulseek user's library shows one page with three modes.

- **Hunt** — a ledger of every album with a verdict against your own copy
  (upgrade, not in library, same as yours, yours is better, surround you
  lack). Tiles at the top filter it. Sort by any column, tick rows to
  download in bulk, or grab every upgrade at once.
- **Wander** — shelves about the music: artists they go deep on, fresh
  arrivals, "because you own …" (MusicBrainz tags, loads in the background),
  "only here" (checked against the other peers you have browsed), the decade
  they love, surround, hi-res.
- **Folders** — a column browser. Click a folder and its contents open to the
  right; the last column always describes what you are on. Arrow keys walk it.

Every album opens the same dossier: quality facts, **Verify this rip** (one
track is downloaded, measured with ffmpeg, then deleted; nothing runs until
you press it), Discogs reception (needs a token in Settings → Soulseek),
a Wikipedia line about the artist, other albums by them here, and the
track-by-track comparison with your copy.

"Use the old library view" in Settings brings back the previous shop.
```

- [ ] **Step 7: Run the full suite.** `node --test 'test/**/*.test.js'` green. Commit.

```bash
git add src/index.html src/renderer.js test/slsk-renderer-scope.test.js test/slsk-room-wiring.test.js docs/peer-library.md
git commit -m "Wire the Listening Room in as the default peer library view, with the old shop one setting away"
```

---

### Task 12: Live verification in a credential-stripped twin

**Files:** none committed (screenshots go in the PR). Uses `tools/twin-profile.js` (see commit 669149d) and the memory rules: one twin, strip the debrid token and any API keys, kill the process group and print the 0 count afterwards.

- [ ] **Step 1:** Build a twin profile: `node tools/twin-profile.js --out /tmp/claude-1000/papa-twin` (read the script header for the exact flags; it must strip credentials). Confirm `grep -c token /tmp/claude-1000/papa-twin/config.json` reports none.
- [ ] **Step 2:** Launch: `PAPA_USER_DATA=/tmp/claude-1000/papa-twin PAPA_DRY_RUN=1 npm start` with `--remote-debugging-port=9333` (check `main.js` for the dry-run env name: `grep -n "DRY_RUN =" main.js`).
- [ ] **Step 3:** Through CDP (Chrome DevTools Protocol at port 9333): navigate to Soulseek, open a cached peer (one from `browse-cache`), and for each mode: screenshot, run `document.querySelectorAll('.slr-tr, .slr-card, .slr-row').length > 0`, open a dossier, press Escape. In Folders, send ArrowDown ×3, ArrowRight, ArrowLeft and confirm the selection moved. Read the console with `Runtime.consoleAPICalled`/`Runtime.exceptionThrown`; any uncaught exception is a failure to fix before Task 12 is done.
- [ ] **Step 4:** Toggle "Use the old library view" in Settings, reopen the peer, confirm the old shop paints. Toggle back.
- [ ] **Step 5:** Kill the twin's process group and print the survivor count (`pgrep -f papa-twin | wc -l` must print 0).
- [ ] **Step 6:** Write the plain-English account for the user (no-bullshit style), attach the screenshots.

---

## Self-review

**Spec coverage.** Page shell/header/mode switch/search → Task 8. Hunt tiles, ledger, sort, filter, multi-select, grab-all → Tasks 2, 8. Wander shelves, background tags, only-here, decade, story → Tasks 3, 4, 8, 9. Folders columns, inspector, keyboard, filters, breadcrumbs, subtree download → Task 7 (surround-only filter: `setFilters({ surroundOnly })` is accepted but not painted — add to Task 7's `render()`: when `filters.surroundOnly`, the first column lists every node whose path `SF().detectSurround` matches, like today's `renderSurroundFolders`; implement it in Task 7 Step 3, not later). Dossier sections → Task 6. Rip check handler → Task 5 (with the recorded scratch-folder deviation). Discogs + token in Settings → Tasks 4, 11. Legacy switch → Task 11. Tests, scope test, live twin → Tasks 1-12. Docs → Task 11.

**Placeholders.** None remaining; the two "check the real signature" notes (album-view `findMyCopy`/`compareDrawerHtml`, `searchTree` shape) are reading instructions with the file and line to read, not deferred work.

**Type consistency.** `openDossier(album)` is the same function object threaded from Task 8 into Tasks 6 and 7. `albumsByPath` is a `Map<lowercased folderPath, album>` everywhere. `deps` keeps the shop's shape plus `openDossier` and optional `wishlistAdd`. IPC names match between main, preload and the wiring tests.
