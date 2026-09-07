// Unit tests for the shared album view (slsk-album-view.js). The DOM-driven
// open() path can't run in Node, so these lock in the pure data layer — the
// normalisation that feeds every surface and the track-name/quality/number
// parsing the list renders — plus a source-file guard that the wiring across the
// three surfaces stays intact (mirrors slsk-shop-ui-wiring's read-the-source
// approach for the parts that touch window/DOM).
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const AV = require('../src/slsk-album-view')

// ── Track-number parsing ──────────────────────────────────────────────────────
test('trackNumOf reads a leading track number in many separators', () => {
  assert.equal(AV.trackNumOf('07 - Song.flac'), 7)
  assert.equal(AV.trackNumOf('07. Song.flac'), 7)
  assert.equal(AV.trackNumOf('07_Song.flac'), 7)
  assert.equal(AV.trackNumOf('7 Song.flac'), 7)
  assert.equal(AV.trackNumOf('X\\Album\\03 Track.flac'), 3)
  assert.equal(AV.trackNumOf('Song.flac'), null)
  assert.equal(AV.trackNumOf(''), null)
})

// ── Track-title cleaning ──────────────────────────────────────────────────────
test('cleanTrackTitle strips extension, leading number and repeated album prefix', () => {
  assert.equal(AV.cleanTrackTitle('05 Weird Fishes.flac', { album: 'In Rainbows' }), 'Weird Fishes')
  assert.equal(AV.cleanTrackTitle('03. In Rainbows - 15 Step.flac', { album: 'In Rainbows' }), '15 Step')
  // No album prefix to strip: just number + extension go.
  assert.equal(AV.cleanTrackTitle('01 - Airbag.flac', { album: 'OK Computer' }), 'Airbag')
  // Never eat the whole title: a bare album-named file keeps something.
  assert.ok(AV.cleanTrackTitle('OK Computer.flac', { album: 'OK Computer' }).length > 0)
})

// ── Per-track quality label ───────────────────────────────────────────────────
test('trackQuality reads ext + depth/rate from the file entry', () => {
  assert.equal(AV.trackQuality({ name: 'a.flac', bitDepth: 24, sampleRate: 96000 }), 'FLAC 24/96')
  assert.equal(AV.trackQuality({ name: 'a.flac', sampleRate: 44100 }), 'FLAC 44kHz')
  assert.equal(AV.trackQuality({ name: 'a.flac' }), 'FLAC')
  assert.equal(AV.trackQuality({ name: 'a.mp3', bitRate: 320 }), 'MP3 320')
  assert.equal(AV.trackQuality({ name: 'a.mp3' }), 'MP3')
})

// ── Album normalisation across the three input shapes ─────────────────────────
test('normalizeAlbum reads a shelf album (files carry fullPath)', () => {
  const a = AV.normalizeAlbum({
    artist: 'Radiohead', album: 'In Rainbows', year: 2007,
    folderName: 'In Rainbows', folderPath: 'X\\In Rainbows',
    files: [
      { fullPath: 'X\\In Rainbows\\01.flac', name: '01.flac', size: 1000, isFlac: true },
      { fullPath: 'X\\In Rainbows\\02.mp3', name: '02.mp3', size: 500 },
    ],
    username: 'peer',
  })
  assert.equal(a.username, 'peer')
  assert.equal(a.files.length, 2)
  assert.equal(a.files[0].filename, 'X\\In Rainbows\\01.flac', 'fullPath is what slskd needs')
  assert.equal(a.totalSize, 1500)
  assert.equal(a.lossless, true)
})

test('normalizeAlbum on a merged album uses the best source, or a chosen index', () => {
  const merged = {
    artist: 'A', album: 'B',
    sources: [
      { username: 'u1', folderName: 'B', files: [{ filename: 'a.flac', size: 1, isFlac: true }] },
      { username: 'u2', folderName: 'B', files: [{ filename: 'a.flac', size: 1 }, { filename: 'b.flac', size: 1 }] },
    ],
  }
  merged.best = merged.sources[0]
  const best = AV.normalizeAlbum(merged)
  assert.equal(best.username, 'u1')
  assert.equal(best.files.length, 1)
  const picked = AV.normalizeAlbum(merged, 1)
  assert.equal(picked.username, 'u2')
  assert.equal(picked.files.length, 2)
  assert.ok(Array.isArray(picked.sources), 'sources kept for the chooser')
})

test('normalizeAlbum on a raw folder-group (search uploader mode)', () => {
  const a = AV.normalizeAlbum({
    username: 'sharer', folderName: 'Some Album',
    files: [{ filename: 'Some Album\\1.flac', size: 10, isFlac: true }],
  })
  assert.equal(a.username, 'sharer')
  assert.equal(a.album, 'Some Album')
  assert.equal(a.files.length, 1)
})

test('normalizeAlbum returns null on empty input', () => {
  assert.equal(AV.normalizeAlbum(null), null)
})

// ── Wiring guards (source-level; open() touches the DOM) ───────────────────────
const VIEW = fs.readFileSync(path.join(__dirname, '../src/slsk-album-view.js'), 'utf8')
const SHOP = fs.readFileSync(path.join(__dirname, '../src/slsk-shop-ui.js'), 'utf8')
const CODE = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8')

test('the album view is ONE component published for both surfaces', () => {
  assert.match(VIEW, /window\.PapaSlskAlbumView = api/, 'published for the renderer')
  assert.match(VIEW, /module\.exports = api/, 'and for tests')
  assert.match(VIEW, /function open\(spec\)/, 'the single entry point')
})

test('every per-track and per-album action is present in the view', () => {
  // Per-track: preview / play / download + a checkbox for selection.
  assert.match(VIEW, /data-act="preview"/)
  assert.match(VIEW, /data-act="play"/)
  assert.match(VIEW, /data-act="dl"/)
  assert.match(VIEW, /slav-track-cb/, 'per-track checkbox')
  assert.match(VIEW, /e\.shiftKey && lastClickedIndex/, 'shift-click range select')
  // Per-album: download album / download selected / wishlist / other sources.
  assert.match(VIEW, /slav-dl-album/)
  assert.match(VIEW, /slav-dl-selected/)
  assert.match(VIEW, /slav-wish/)
  assert.match(VIEW, /slav-find/, 'other-sources search')
  // All downloads route through the shared enqueue door.
  assert.match(VIEW, /_slskEnqueue\(/, 'batch downloads use the collapsing addItems door')
})

test('the view keyboard is Esc-close + arrow track nav + Enter-play', () => {
  assert.match(VIEW, /e\.key === 'Escape'.*close\(\)/s)
  assert.match(VIEW, /e\.key === 'ArrowDown'/)
  assert.match(VIEW, /e\.key === 'ArrowUp'/)
  assert.match(VIEW, /keydown', onKey, true\)/, 'captured so it layers above the shop Esc')
})

test('the shop opens the album view on card-body click and Enter', () => {
  assert.match(SHOP, /function openAlbumView\(album, sourceIndex\)/)
  assert.match(SHOP, /openAlbumView\(a\)/, 'card body click opens it')
  // The shop Esc chain defers to an open panel.
  assert.match(SHOP, /if \(_slavPanel\) return/)
})

test('the folder view gains checkboxes and a download-selected batch', () => {
  assert.match(SHOP, /slskx-file-cb/, 'per-file checkbox in folders mode')
  assert.match(SHOP, /slskx-dl-selected/, 'download-selected button')
  assert.match(SHOP, /const folderSel = new Set\(\)/)
})

test('search merged cards open the SAME album view (body click and per-source)', () => {
  assert.match(CODE, /function _openSlskAlbumView\(album, sourceIndex\)/)
  assert.match(CODE, /window\.PapaSlskAlbumView/, 'search uses the same component')
  assert.match(CODE, /slsk-card-merged'\)\.forEach/, 'merged card body click wired')
  assert.match(CODE, /_openSlskAlbumView\(alb, si\)/, 'a source row opens fed by THAT source')
})

test('the album view script is loaded before the shop in index.html', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8')
  const av = html.indexOf('slsk-album-view.js')
  const shop = html.indexOf('slsk-shop-ui.js')
  assert.ok(av > -1 && shop > -1 && av < shop, 'album view loads before the shop uses it')
})
