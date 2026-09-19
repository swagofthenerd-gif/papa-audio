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
