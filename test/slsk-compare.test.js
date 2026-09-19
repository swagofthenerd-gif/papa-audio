'use strict'
// The compare drawer's brain. Pairs by number, then title, then position;
// verdicts never come from a missing tag; Replace is only "safe" when whole,
// equal in count and better somewhere, worse nowhere.
const test = require('node:test')
const assert = require('node:assert')
const C = require('../src/slsk-compare.js')

const peer = (n, ext, extra = {}) => ({ filename: `A\\B\\${String(n).padStart(2, '0')} - Song ${n}.${ext}`, size: 3e7, ...extra })
const mine = (n, extra = {}) => ({ filePath: `/m/${String(n).padStart(2, '0')} - Song ${n}.flac`, title: `Song ${n}`, trackNumber: n, codec: 'flac', bitsPerSample: 16, sampleRate: 44100, duration: 200, fileSize: 2.5e7, ...extra })

test('a 24/96 rip over a 16/44 copy: better on every track, replace ok', () => {
  const r = C.compareAlbums([1, 2, 3].map(n => peer(n, 'flac', { bitDepth: 24, sampleRate: 96000 })), [1, 2, 3].map(n => mine(n)))
  assert.strictEqual(r.rows.length, 3)
  assert.ok(r.rows.every(x => x.verdict === 'better'))
  assert.strictEqual(r.summary.replaceOk, true)
  assert.match(r.summary.line, /better on all 3/)
})

test('a lossy peer over a lossless copy is worse on every row and never replace-ok', () => {
  const r = C.compareAlbums([1, 2].map(n => peer(n, 'mp3', { bitRate: 320 })), [1, 2].map(n => mine(n)))
  assert.ok(r.rows.every(x => x.verdict === 'worse'))
  assert.strictEqual(r.summary.replaceOk, false)
})

test('more tracks on their side: the extra is only-theirs, counts differ, not a straight swap', () => {
  const r = C.compareAlbums([1, 2, 3, 4].map(n => peer(n, 'flac', { bitDepth: 24, sampleRate: 96000 })), [1, 2, 3].map(n => mine(n)))
  assert.strictEqual(r.summary.onlyTheirs, 1)
  assert.strictEqual(r.summary.countsMatch, false)
  assert.strictEqual(r.summary.replaceOk, false)
  assert.match(r.summary.line, /4 tracks vs your 3/)
})

test('a missing closer on their side shows as only-mine', () => {
  const r = C.compareAlbums([1, 2].map(n => peer(n, 'flac', { bitDepth: 24, sampleRate: 96000 })), [1, 2, 3].map(n => mine(n)))
  assert.strictEqual(r.rows.filter(x => x.verdict === 'only-mine').length, 1)
  assert.strictEqual(r.summary.replaceOk, false)
})

test('unknown depth/rate never manufactures a verdict — same, not better', () => {
  const r = C.compareAlbums([peer(1, 'flac')], [mine(1)])
  assert.strictEqual(r.rows[0].verdict, 'same')
  assert.strictEqual(r.summary.replaceOk, false)
})

test('un-numbered files pair by cleaned title', () => {
  const r = C.compareAlbums([{ filename: 'A\\B\\Song 2 (Remaster).flac', size: 1, bitDepth: 24, sampleRate: 88200 }], [mine(2)])
  assert.strictEqual(r.rows[0].verdict, 'better')
  assert.strictEqual(r.rows[0].mine.n, 2)
})

test('artwork and cue files are not tracks', () => {
  const r = C.compareAlbums([peer(1, 'flac', { bitDepth: 24, sampleRate: 96000 }), { filename: 'A\\B\\cover.jpg', size: 1 }, { filename: 'A\\B\\album.cue', size: 1 }], [mine(1)])
  assert.strictEqual(r.summary.theirsCount, 1)
})
