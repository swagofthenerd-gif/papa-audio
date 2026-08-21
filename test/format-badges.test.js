const test = require('node:test')
const assert = require('node:assert')
const { surroundLabel, isHiRes, isLossless, formatBadges } = require('../src/format-badges')

test('surroundLabel maps channel counts', () => {
  assert.equal(surroundLabel(2), '')
  assert.equal(surroundLabel(6), '5.1')
  assert.equal(surroundLabel(8), '7.1')
})

test('hi-res is anything better than CD', () => {
  assert.equal(isHiRes({ bitsPerSample: 16, sampleRate: 44100 }), false)
  assert.equal(isHiRes({ bitsPerSample: 24, sampleRate: 48000 }), true)
  assert.equal(isHiRes({ bitsPerSample: 16, sampleRate: 96000 }), true)
})

test('lossless detection covers the codecs we index', () => {
  for (const c of ['flac', 'ALAC', 'truehd', 'dsf']) assert.ok(isLossless(c), c)
  for (const c of ['mp3', 'aac', 'eac3']) assert.ok(!isLossless(c), c)
})

test('the Eagles Atmos case: eac3 6ch tagged Atmos', () => {
  const b = formatBadges({ codec: 'eac3', channels: 6, atmos: true, sampleRate: 48000, bitsPerSample: 16 })
  const labels = b.map(x => x.label)
  assert.deepEqual(labels, ['ATMOS', '5.1'])
  // Atmos is lossy eac3, but calling it LOSSY next to ATMOS is noise.
  assert.ok(!labels.includes('LOSSY'))
})

test('the SACD FLAC case: lossless 5.1 hi-res, no Atmos', () => {
  const labels = formatBadges({ codec: 'FLAC', channels: 6, sampleRate: 88200, bitsPerSample: 24 })
    .map(x => x.label)
  assert.deepEqual(labels, ['5.1', 'HI-RES'])
})

test('plain CD-quality stereo gets no badges at all', () => {
  assert.deepEqual(formatBadges({ codec: 'FLAC', channels: 2, sampleRate: 44100, bitsPerSample: 16 }), [])
})

test('an mp3 is marked lossy', () => {
  assert.deepEqual(formatBadges({ codec: 'mp3', channels: 2, sampleRate: 44100 }).map(x => x.label), ['LOSSY'])
})

test('DSD wins over hi-res rather than showing both', () => {
  const labels = formatBadges({ codec: 'dsf', channels: 2, sampleRate: 2822400 }).map(x => x.label)
  assert.deepEqual(labels, ['DSD'])
})

test('album-level aggregate keys work as well as track keys', () => {
  const album = { atmos: true, maxChannels: 6, codec: 'eac3', maxSampleRate: 48000, maxBitsPerSample: 16 }
  assert.deepEqual(formatBadges(album).map(b => b.label), ['ATMOS', '5.1'])

  const sacd = { maxChannels: 6, codec: 'FLAC', maxSampleRate: 88200, maxBitsPerSample: 24 }
  assert.deepEqual(formatBadges(sacd).map(b => b.label), ['5.1', 'HI-RES'])
})

test('the module exposes itself for the renderer too', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/format-badges.js'), 'utf8')
  assert.ok(src.includes('window.PapaFormat'), 'renderer global must exist — it cannot require()')
  const html = require('fs').readFileSync(require('path').join(__dirname, '../src/index.html'), 'utf8')
  assert.ok(html.indexOf('format-badges.js') < html.indexOf('renderer.js'),
    'format-badges.js must load before renderer.js')
})
