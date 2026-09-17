'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const L = require('../src/loudness')
const T = require('../src/music-tools')

// ═══════════════════════════════════════════════════════════════════════════
// App #59 — ReplayGain (non-destructive loudness scan)
// ═══════════════════════════════════════════════════════════════════════════

// A realistic ffmpeg ebur128 summary tail. The integrated line is what we parse.
const EBUR128_TAIL = `
[Parsed_ebur128_0 @ 0x55] Summary:

  Integrated loudness:
    I:         -14.2 LUFS
    Threshold: -24.7 LUFS

  Loudness range:
    LRA:         7.3 LU
    Threshold: -34.9 LUFS
    LRA low:   -18.6 LUFS
    LRA high:  -11.3 LUFS

  True peak:
    Peak:       -1.0 dBFS
`

test('parseIntegratedLufs pulls the integrated LUFS from ffmpeg stderr', () => {
  assert.strictEqual(L.parseIntegratedLufs(EBUR128_TAIL), -14.2)
})

test('parseIntegratedLufs takes the LAST integrated value in a multi-line run', () => {
  const two = 'I: -20.0 LUFS\nsome noise\nI: -13.5 LUFS\n'
  assert.strictEqual(L.parseIntegratedLufs(two), -13.5)
})

test('parseIntegratedLufs returns null when there is no measurement', () => {
  assert.strictEqual(L.parseIntegratedLufs(''), null)
  assert.strictEqual(L.parseIntegratedLufs('ffmpeg: no audio streams'), null)
  assert.strictEqual(L.parseIntegratedLufs(null), null)
})

test('parseIntegratedLufs rejects silence (implausibly negative)', () => {
  // ffmpeg reports a huge negative for pure silence — not a gain-correctable value.
  assert.strictEqual(L.parseIntegratedLufs('I: -120.7 LUFS'), null)
})

test('gainForLufs brings a quiet track up toward the -18 target', () => {
  // -23 LUFS is 5 dB below target → +5 dB of gain.
  assert.strictEqual(L.gainForLufs(-23), 5)
})

test('gainForLufs cuts a loud track', () => {
  // -14 LUFS is 4 dB above target → -4 dB.
  assert.strictEqual(L.gainForLufs(-14), -4)
})

test('gainForLufs clamps to the safe ±12 dB span', () => {
  assert.strictEqual(L.gainForLufs(-40), L.MAX_GAIN_DB)   // very quiet, capped
  assert.strictEqual(L.gainForLufs(-2), L.MIN_GAIN_DB)    // very loud, capped
})

test('gainForLufs honours a custom target', () => {
  assert.strictEqual(L.gainForLufs(-14, -14), 0)
})

test('gainForLufs returns null for unusable input', () => {
  assert.strictEqual(L.gainForLufs(null), null)
  assert.strictEqual(L.gainForLufs(NaN), null)
})

test('dbToLinear: 0 dB is unity, +6 dB ≈ 2x, -6 dB ≈ 0.5x', () => {
  assert.strictEqual(L.dbToLinear(0), 1)
  assert.ok(Math.abs(L.dbToLinear(6) - 1.995) < 0.01)
  assert.ok(Math.abs(L.dbToLinear(-6) - 0.501) < 0.01)
})

test('applyGainToMpvVolume is a no-op when there is no gain', () => {
  assert.strictEqual(L.applyGainToMpvVolume(100, null, 130), 100)
  assert.strictEqual(L.applyGainToMpvVolume(100, 0, 130), 100)
})

// Asserted in dB of ACTUAL LOUDNESS, not in mpv volume units. The old version
// of this test pinned the volume number itself, which hid the real defect: mpv's
// volume scale is cubic, so multiplying it by a linear amplitude ratio tripled
// every correction — a requested -6 dB delivered -18 dB. A test that checks the
// number the code happens to produce cannot catch that; one that checks the
// loudness the listener actually gets, can.
const amplitudeOf = mpvVolume => Math.pow(mpvVolume / 100, 3)
const deliveredDb = (base, gainDb) =>
  20 * Math.log10(amplitudeOf(L.applyGainToMpvVolume(base, gainDb, 130)) / amplitudeOf(base))

test('applyGainToMpvVolume delivers the dB it was asked for', () => {
  for (const asked of [-12, -6, -3, -1, 1, 3, 6]) {
    const got = deliveredDb(100, asked)
    assert.ok(Math.abs(got - asked) < 0.05,
      `asked ${asked} dB, delivered ${got.toFixed(2)} dB`)
  }
})

test('applyGainToMpvVolume delivers the same dB from any starting volume', () => {
  // The correction is a ratio, so where the slider happens to sit must not
  // change how much quieter or louder the track ends up.
  for (const base of [40, 60, 80, 100]) {
    const got = deliveredDb(base, -6)
    assert.ok(Math.abs(got - -6) < 0.05, `base ${base}: delivered ${got.toFixed(2)} dB`)
  }
})

test('applyGainToMpvVolume never exceeds the mpv ceiling', () => {
  // A big boost on an already-high base must clamp to MPV_MAX, not clip.
  assert.strictEqual(L.applyGainToMpvVolume(120, 12, 130), 130)
})

// Library fixture: two albums, one measured, one not.
const loLib = [
  { id: 'a1', name: 'Loud Album', artist: 'A', tracks: [
    { filePath: '/m/loud1.flac' }, { filePath: '/m/loud2.flac' }
  ] },
  { id: 'a2', name: 'Quiet Album', artist: 'B', tracks: [
    { filePath: '/m/quiet1.flac' }, { filePath: '/m/quiet2.flac' }
  ] },
  { id: 'a3', name: 'Streamed', artist: 'C', tracks: [
    { filePath: 'https://example.com/stream.mp3' }
  ] }
]
const loMap = {
  '/m/loud1.flac': { lufs: -9, gainDb: -9 },
  '/m/loud2.flac': { lufs: -11, gainDb: -7 },
  '/m/quiet1.flac': { lufs: -26, gainDb: 8 }
}

test('tracksNeedingScan lists only unmeasured local files, capped', () => {
  const need = L.tracksNeedingScan(loLib, loMap, 20)
  assert.deepStrictEqual(need, ['/m/quiet2.flac'])
  // The streamed http path is never offered for measurement.
  assert.ok(!need.includes('https://example.com/stream.mp3'))
})

test('tracksNeedingScan respects the limit', () => {
  const empty = L.tracksNeedingScan(loLib, {}, 2)
  assert.strictEqual(empty.length, 2)
})

test('scanCoverage counts measured of measurable local tracks', () => {
  const cov = L.scanCoverage(loLib, loMap)
  // 4 local tracks (the http one does not count); 3 measured.
  assert.deepStrictEqual(cov, { scanned: 3, total: 4 })
})

test('albumLoudness averages measured tracks and sorts loudest first', () => {
  const albums = L.albumLoudness(loLib, loMap)
  assert.strictEqual(albums.length, 2) // the streamed album has no measurement
  assert.strictEqual(albums[0].album.id, 'a1') // loudest first
  assert.strictEqual(albums[0].lufs, -10)       // mean of -9 and -11
  assert.strictEqual(albums[0].measuredTracks, 2)
  assert.strictEqual(albums[1].album.id, 'a2')
  assert.strictEqual(albums[1].lufs, -26)
})

test('loudnessSpread reports loudest, quietest and the span', () => {
  const s = L.loudnessSpread(loLib, loMap, 5)
  assert.strictEqual(s.albumCount, 2)
  assert.strictEqual(s.loudest[0].album.id, 'a1')
  assert.strictEqual(s.quietest[0].album.id, 'a2')
  assert.strictEqual(s.spanLu, 16) // -10 to -26 is 16 LU
})

test('loudnessSpread on an unscanned library is empty, not a crash', () => {
  const s = L.loudnessSpread(loLib, {}, 5)
  assert.deepStrictEqual(s, { loudest: [], quietest: [], spanLu: 0, albumCount: 0 })
})

// ═══════════════════════════════════════════════════════════════════════════
// App #60 — Tag fixer (MusicBrainz diff, propose-only)
// ═══════════════════════════════════════════════════════════════════════════

test('compareTrackTags flags a real title difference', () => {
  const c = T.compareTrackTags(
    { title: 'Thriler', trackNumber: 1 },
    { title: 'Thriller', position: 1 })
  assert.strictEqual(c.titleDiffers, true)
  assert.strictEqual(c.titleExact, false)
  assert.strictEqual(c.clean, false)
})

test('compareTrackTags treats a bracketed remaster tag as cosmetic, not a diff', () => {
  const c = T.compareTrackTags(
    { title: 'Billie Jean (Remastered)', trackNumber: 6 },
    { title: 'Billie Jean', position: 6 })
  assert.strictEqual(c.titleDiffers, false)   // core words agree
  assert.strictEqual(c.titleCosmetic, true)   // but the raw text differs
  assert.strictEqual(c.clean, false)
})

test('compareTrackTags reports a track-number mismatch', () => {
  const c = T.compareTrackTags(
    { title: 'Beat It', trackNumber: 5 },
    { title: 'Beat It', position: 6 })
  assert.strictEqual(c.numberDiffers, true)
  assert.strictEqual(c.titleExact, true)
  assert.strictEqual(c.clean, false)
})

test('compareTrackTags calls an identical pair clean', () => {
  const c = T.compareTrackTags(
    { title: 'Beat It', trackNumber: 5 },
    { title: 'Beat It', position: 5 })
  assert.strictEqual(c.clean, true)
  assert.strictEqual(c.titleExact, true)
  assert.strictEqual(c.numberDiffers, false)
})

test('buildTagDiff pairs by track number and summarises', () => {
  const local = [
    { title: 'Wanna Be Startin Somethin', trackNumber: 1 },
    { title: 'Baby Be Mine', trackNumber: 2 },
    { title: 'Thriler', trackNumber: 4 } // misspelled + wrong-ish
  ]
  const mb = [
    { title: "Wanna Be Startin' Somethin'", position: 1 },
    { title: 'Baby Be Mine', position: 2 },
    { title: 'The Girl Is Mine', position: 3 }, // present on release, missing locally
    { title: 'Thriller', position: 4 }
  ]
  const { rows, summary } = T.buildTagDiff(local, mb)
  // Track 1 pairs to position 1 (cosmetic — apostrophes), track 2 clean,
  // track 4 pairs to position 4 (real diff), position 3 is mb-only.
  const byLocalNo = {}
  rows.forEach(r => { if (r.kind === 'match') byLocalNo[r.localNo] = r })
  assert.strictEqual(byLocalNo[1].titleCosmetic, true)
  assert.strictEqual(byLocalNo[2].clean, true)
  assert.strictEqual(byLocalNo[4].titleDiffers, true)
  const mbOnly = rows.filter(r => r.kind === 'mb-only')
  assert.strictEqual(mbOnly.length, 1)
  assert.strictEqual(mbOnly[0].mbNo, 3)
  assert.strictEqual(summary.mbOnly, 1)
  assert.strictEqual(summary.differ, 1)
  assert.strictEqual(summary.cosmetic, 1)
  assert.strictEqual(summary.clean, 1)
})

test('buildTagDiff reports a local track with no MusicBrainz counterpart', () => {
  const local = [
    { title: 'Real Song', trackNumber: 1 },
    { title: 'Bonus Junk', trackNumber: 2 }
  ]
  const mb = [{ title: 'Real Song', position: 1 }]
  const { rows, summary } = T.buildTagDiff(local, mb)
  const localOnly = rows.filter(r => r.kind === 'local-only')
  assert.strictEqual(localOnly.length, 1)
  assert.strictEqual(localOnly[0].localTitle, 'Bonus Junk')
  assert.strictEqual(summary.localOnly, 1)
})

test('buildTagDiff falls back to positional pairing when numbers are absent', () => {
  const local = [{ title: 'One' }, { title: 'Too' }]
  const mb = [{ title: 'One' }, { title: 'Two' }]
  const { rows } = T.buildTagDiff(local, mb)
  const matches = rows.filter(r => r.kind === 'match')
  assert.strictEqual(matches.length, 2)
  assert.strictEqual(matches[0].clean, true)
  assert.strictEqual(matches[1].titleDiffers, true) // "Too" vs "Two"
})

test('buildTagDiff handles empty inputs without throwing', () => {
  const a = T.buildTagDiff([], [])
  assert.deepStrictEqual(a.rows, [])
  assert.strictEqual(a.summary.total, 0)
})
