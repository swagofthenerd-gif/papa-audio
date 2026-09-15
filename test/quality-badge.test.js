'use strict'
const test = require('node:test')
const assert = require('node:assert')
const Q = require('../src/quality-badge')

const pure = { outputMode: 'exclusive', replaygain: 'no', mode: 'gapless', eq: { enabled: false } }
const flac = { filePath: '/m/a.flac', codec: 'FLAC', sampleRate: 44100, bitsPerSample: 16 }

// Roadmap 093: the badge must not label arbitrary non-HTTP files LOSSLESS.
test('a lossy file is never LOSSLESS, whatever the output mode', () => {
  for (const t of [
    { filePath: '/m/a.mp3' },
    { filePath: '/m/a.m4a', codec: 'AAC' },
    { filePath: '/m/a.flac', codec: 'MPEG 1 Layer 3' },   // codec beats extension
    { filePath: '/m/a.opus' },
  ]) {
    const v = Q.classify({ track: t, settings: pure, speed: 1, volume: 100 })
    assert.strictEqual(v.label, null, JSON.stringify(t))
    assert.strictEqual(v.codecClass, 'lossy')
  }
})

test('an unidentifiable container gets no badge rather than a guess', () => {
  const v = Q.classify({ track: { filePath: '/m/a.m4a' }, settings: pure, speed: 1, volume: 100 })
  assert.strictEqual(v.label, null)
  assert.strictEqual(v.codecClass, 'unknown')
})

test('a stream gets no badge here; the format badge already says Stream', () => {
  assert.strictEqual(Q.classify({ track: { filePath: 'https://x/y.flac', codec: 'FLAC' }, settings: pure }).codecClass, 'stream')
})

test('BIT-PERFECT needs a lossless codec, exclusive output and nothing touching samples', () => {
  const v = Q.classify({ track: flac, settings: pure, speed: 1, volume: 100 })
  assert.strictEqual(v.label, 'BIT-PERFECT')
  assert.deepStrictEqual(v.processing, [])
  assert.match(v.reason, /not measured/, 'the tooltip does not claim the device was verified')
  // The app's own bit-perfect toggle implies exclusive output.
  assert.strictEqual(Q.classify({ track: flac, settings: { bitPerfect: true }, speed: 1, volume: 100 }).label, 'BIT-PERFECT')
})

test('ReplayGain "no" is off — the old badge compared against "off" and could never say BIT-PERFECT', () => {
  assert.strictEqual(Q.classify({ track: flac, settings: { ...pure, replaygain: 'no' }, speed: 1, volume: 100 }).label, 'BIT-PERFECT')
  assert.strictEqual(Q.classify({ track: flac, settings: { ...pure, replaygain: undefined }, speed: 1, volume: 100 }).label, 'BIT-PERFECT')
})

test('each kind of processing downgrades BIT-PERFECT to LOSSLESS and is named in the reason', () => {
  const cases = [
    [{ ...pure, eq: { enabled: true, gains: [0, 0] } }, 1, 100, /EQ/],
    [{ ...pure, replaygain: 'album' }, 1, 100, /ReplayGain \(album\)/],
    [pure, 1.25, 100, /Speed 1\.25/],
    [{ ...pure, mode: 'crossfade' }, 1, 100, /Crossfade/],
    [pure, 1, 80, /Volume 80%/],
    [pure, 1, 130, /Volume 130%/],
  ]
  for (const [settings, speed, volume, re] of cases) {
    const v = Q.classify({ track: flac, settings, speed, volume })
    assert.strictEqual(v.label, 'LOSSLESS', String(re))
    assert.match(v.reason, re)
    assert.match(v.reason, /processed by/)
  }
})

test('lossless on a shared output is LOSSLESS with a pointer to the setting', () => {
  const v = Q.classify({ track: flac, settings: { outputMode: 'shared' }, speed: 1, volume: 100 })
  assert.strictEqual(v.label, 'LOSSLESS')
  assert.match(v.reason, /Shared output/)
})

test('an unknown volume does not count as processing', () => {
  assert.strictEqual(Q.classify({ track: flac, settings: pure, speed: 1, volume: null }).label, 'BIT-PERFECT')
})

test('codec strings from both music-metadata and ffprobe are understood', () => {
  for (const c of ['FLAC', 'ALAC', 'PCM', 'pcm_s24le', 'flac', 'alac', 'truehd', "Monkey's Audio", 'WavPack']) {
    assert.strictEqual(Q.codecClass({ filePath: '/m/x.bin', codec: c }), 'lossless', c)
  }
  for (const c of ['MPEG 1 Layer 3', 'mp3', 'aac', 'AAC', 'eac3', 'Vorbis', 'opus', 'dts']) {
    assert.strictEqual(Q.codecClass({ filePath: '/m/x.bin', codec: c }), 'lossy', c)
  }
})
