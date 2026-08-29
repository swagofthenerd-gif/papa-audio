'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { parseQuality, parseAudioLayout, parseDub, parseSub, magnetFromHash } = require('../providers/quality')

test('parseQuality reads the resolution out of a scene title', () => {
  assert.strictEqual(parseQuality('Show.S01E02.2160p.WEB-DL'), '2160p')
  assert.strictEqual(parseQuality('Show.S01E02.1080p.BluRay'), '1080p')
  assert.strictEqual(parseQuality('[Group] Anime - 09 (720p)'), '720p')
  assert.strictEqual(parseQuality('Old.Film.480p.DVDRip'), '480p')
  assert.strictEqual(parseQuality('4K.Remux'), '2160p')
  assert.strictEqual(parseQuality('no resolution here'), 'unknown')
  assert.strictEqual(parseQuality(null), 'unknown')
})

// Release names glue the codec to the layout, so a word boundary before the
// digit never fires. These are the exact forms that used to parse as null.
test('parseAudioLayout handles codec-glued layouts', () => {
  assert.strictEqual(parseAudioLayout('Show.1080p.DDP5.1'), '5.1')
  assert.strictEqual(parseAudioLayout('Show.720p.AAC2.0'), 'stereo')
  assert.strictEqual(parseAudioLayout('Film.2160p.TrueHD7.1.Atmos'), '7.1')
  assert.strictEqual(parseAudioLayout('Film.1080p.DTS-HD'), '5.1')
})

// An unmeasured layout must stay null. Guessing '5.1' is what made the
// surround-preferring ranker sort on a value nobody had verified.
test('parseAudioLayout returns null rather than guessing', () => {
  assert.strictEqual(parseAudioLayout('Show.1080p.x264'), null)
  assert.strictEqual(parseAudioLayout(''), null)
  assert.strictEqual(parseAudioLayout(undefined), null)
})

test('7.1 is checked before 5.1 so a mixed title cannot mis-sort', () => {
  assert.strictEqual(parseAudioLayout('Film.TrueHD7.1.and.DDP5.1'), '7.1')
})

test('parseDub and parseSub read the anime language tags', () => {
  assert.strictEqual(parseDub('[Judas] Show - 01 Dual Audio'), true)
  assert.strictEqual(parseDub('[SubsPlease] Show - 01'), false)
  assert.strictEqual(parseSub('[Erai] Show - 01 [Multi-Sub]'), true)
})

test('magnetFromHash builds a usable magnet with public trackers', () => {
  const magnet = magnetFromHash('abc123', 'My Show')
  assert.ok(magnet.startsWith('magnet:?xt=urn:btih:abc123'))
  assert.ok(magnet.includes('dn=My%20Show'))
  // A hash-only magnet has no way to find peers; the trackers are not optional.
  assert.ok(magnet.includes('tr=udp%3A%2F%2Ftracker.opentrackr.org'))
})

test('magnetFromHash refuses a missing hash instead of building a broken magnet', () => {
  assert.strictEqual(magnetFromHash(null, 'x'), null)
  assert.strictEqual(magnetFromHash('', 'x'), null)
})
