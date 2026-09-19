'use strict'
// The compare drawer in the album view: renders one row per track from the real
// comparison, and its Replace button is enabled only when the swap is safe.
const test = require('node:test')
const assert = require('node:assert')
const AV = require('../src/slsk-album-view.js')
const C = require('../src/slsk-compare.js')
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const peer = (n, extra = {}) => ({ filename: `A\\B\\${String(n).padStart(2, '0')} - Song ${n}.flac`, name: `${String(n).padStart(2, '0')} - Song ${n}.flac`, size: 3e7, isFlac: true, lossless: true, fmt: 'FLAC', ...extra })
const mineTrack = n => ({ filePath: `/m/${n}.flac`, title: `Song ${n}`, trackNumber: n, codec: 'flac', bitsPerSample: 16, sampleRate: 44100, duration: 200, fileSize: 2.5e7 })
const myAlbum = { id: 'alb1', name: 'Mirage', artist: 'Camel', tracks: [1, 2, 3].map(mineTrack) }
const peerAlbum = { username: 'p', artist: 'Camel', album: 'Mirage', files: [1, 2, 3].map(n => peer(n, { bitDepth: 24, sampleRate: 96000 })), matchedLibId: 'alb1' }

test('one row per track, verdict glyph per row, Replace enabled on a clean upgrade', () => {
  const cmp = C.compareAlbums(peerAlbum.files, myAlbum.tracks)
  const html = AV.compareDrawerHtml(cmp, myAlbum, { ...peerAlbum, files: peerAlbum.files.map(f => ({ ...f, isFlac: true })) }, esc)
  assert.strictEqual((html.match(/class="slx-cmp-row/g) || []).length, 3)
  assert.strictEqual((html.match(/slx-v-better/g) || []).length, 3)
  assert.match(html, /<button class="slx-cmp-replace" /)
  assert.doesNotMatch(html, /slx-cmp-replace" disabled/)
  assert.match(html, /3:20/, 'my durations are printed')
  assert.match(html, /24\/96/, 'their quality is printed')
})

test('a count mismatch disables Replace and says why', () => {
  const cmp = C.compareAlbums(peerAlbum.files.slice(0, 2), myAlbum.tracks)
  const html = AV.compareDrawerHtml(cmp, myAlbum, peerAlbum, esc)
  assert.match(html, /slx-cmp-replace" disabled/)
  assert.match(html, /Track counts differ/)
  assert.strictEqual((html.match(/slx-v-only-mine/g) || []).length, 1)
})

test('findMyCopy prefers the shelf match id, then falls back to a fuzzy title match', () => {
  const state = { library: [{ id: 'x', name: 'Other', artist: 'Someone' }, myAlbum] }
  assert.strictEqual(AV.findMyCopy({ matchedLibId: 'alb1', album: 'zzz' }, state), myAlbum)
  assert.strictEqual(AV.findMyCopy({ album: 'Mirage', artist: 'Camel' }, state), myAlbum)
  assert.strictEqual(AV.findMyCopy({ album: 'Nothing Like It', artist: 'Nobody' }, state), null)
})
