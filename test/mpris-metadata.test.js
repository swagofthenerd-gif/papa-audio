'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { artUrl, buildMetadata, capabilities, isSeek } = require('../src/mpris-metadata')

// ── artUrl ────────────────────────────────────────────────────────────────────
test('artUrl: no cover is an empty string, not a broken file:// path', () => {
  assert.strictEqual(artUrl(''), '')
  assert.strictEqual(artUrl(null), '')
  assert.strictEqual(artUrl(undefined), '')
})

test('artUrl: an http(s) cover passes through unchanged', () => {
  assert.strictEqual(artUrl('http://x/y.jpg'), 'http://x/y.jpg')
  assert.strictEqual(artUrl('https://x/y.jpg'), 'https://x/y.jpg')
})

test('artUrl: a local path gets file:// and URI-encoding, including #', () => {
  assert.strictEqual(artUrl('/a/b c.jpg'), 'file:///a/b%20c.jpg')
  assert.strictEqual(artUrl('/a/track#1.jpg'), 'file:///a/track%231.jpg')
})

// ── buildMetadata ───────────────────────────────────────────────────────────
test('buildMetadata: full xesam/mpris shape with length in microseconds', () => {
  const m = buildMetadata(
    { title: 'T', album: 'Al', artist: 'Ar', artPath: '/a.jpg', duration: 200, queueIndex: 3 },
    { objectPath: (p) => '/org/mpris/MediaPlayer2/' + p })
  assert.strictEqual(m['mpris:trackid'], '/org/mpris/MediaPlayer2/track/3')
  assert.strictEqual(m['mpris:length'], 200 * 1e6)
  assert.strictEqual(m['mpris:artUrl'], 'file:///a.jpg')
  assert.strictEqual(m['xesam:title'], 'T')
  assert.strictEqual(m['xesam:album'], 'Al')
  assert.deepStrictEqual(m['xesam:artist'], ['Ar'])
})

test('buildMetadata: missing fields degrade to empty, length to 0, index to 0', () => {
  const m = buildMetadata({}, {})
  assert.strictEqual(m['mpris:length'], 0)
  assert.strictEqual(m['mpris:artUrl'], '')
  assert.strictEqual(m['xesam:title'], '')
  assert.deepStrictEqual(m['xesam:artist'], [''])
  assert.match(m['mpris:trackid'], /track\/0$/)
})

test('buildMetadata: an explicit trackId wins over objectPath', () => {
  const m = buildMetadata({ title: 'T', queueIndex: 5 }, { trackId: '/custom/id' })
  assert.strictEqual(m['mpris:trackid'], '/custom/id')
})

// ── capabilities ────────────────────────────────────────────────────────────
const q = (n) => Array.from({ length: n }, (_, i) => ({ title: 't' + i }))

test('capabilities: mid-queue track can go next and previous and seek', () => {
  const c = capabilities({ title: 't', queue: q(5), queueIndex: 2, duration: 100 })
  assert.deepStrictEqual(c, { canSeek: true, canGoNext: true, canGoPrevious: true })
})

test('capabilities: last track cannot go next unless repeat/shuffle says so', () => {
  const base = { title: 't', queue: q(3), queueIndex: 2, duration: 100 }
  assert.strictEqual(capabilities(base).canGoNext, false)
  assert.strictEqual(capabilities({ ...base, repeat: 'all' }).canGoNext, true)
  assert.strictEqual(capabilities({ ...base, repeat: 'one' }).canGoNext, true)
  assert.strictEqual(capabilities({ ...base, shuffle: true }).canGoNext, true)
})

test('capabilities: previous is available whenever a track is loaded (restart)', () => {
  assert.strictEqual(capabilities({ title: 't', queue: q(1), queueIndex: 0, duration: 10 }).canGoPrevious, true)
  assert.strictEqual(capabilities({ title: '', queueIndex: -1 }).canGoPrevious, false)
})

test('capabilities: a stream with unknown duration is not seekable', () => {
  assert.strictEqual(capabilities({ title: 't', queue: q(2), queueIndex: 0, duration: 0 }).canSeek, false)
  assert.strictEqual(capabilities({ title: 't', queue: q(2), queueIndex: 0, duration: 180 }).canSeek, true)
})

test('capabilities: nothing loaded means every control is off', () => {
  assert.deepStrictEqual(capabilities({}), { canSeek: false, canGoNext: false, canGoPrevious: false })
})

// ── isSeek ──────────────────────────────────────────────────────────────────
test('isSeek: normal forward playback drift is not a seek', () => {
  // 1 second of wall time, position advanced ~1s while playing → not a seek.
  assert.strictEqual(isSeek(
    { position: 10, at: 1000, playing: true },
    { position: 11, at: 2000 }), false)
})

test('isSeek: a forward jump well past elapsed time is a seek', () => {
  // 1 second of wall time but position jumped 30s → a seek.
  assert.strictEqual(isSeek(
    { position: 10, at: 1000, playing: true },
    { position: 40, at: 2000 }), true)
})

test('isSeek: a backward jump beyond tolerance is a seek', () => {
  assert.strictEqual(isSeek(
    { position: 100, at: 1000, playing: true },
    { position: 20, at: 1100 }), true)
})

test('isSeek: while paused, any advance beyond tolerance is a seek', () => {
  assert.strictEqual(isSeek(
    { position: 10, at: 1000, playing: false },
    { position: 25, at: 2000 }), true)
  // A tiny wobble under tolerance is not.
  assert.strictEqual(isSeek(
    { position: 10, at: 1000, playing: false },
    { position: 10.5, at: 2000 }), false)
})

test('isSeek: no previous sample is never a seek', () => {
  assert.strictEqual(isSeek(null, { position: 5, at: 1000 }), false)
})
