'use strict'
// The quality contract that gates alternate-source substitution.
//
// The headline test — "a 5.1 original never accepts a stereo substitute" — is
// the exact field failure this module exists to prevent, named so it can never
// be quietly deleted. The rest fence off the axes around it.
const test = require('node:test')
const assert = require('node:assert')
const FP = require('../src/source-fingerprint')

// Handy builders. A "group" is what the results grid and browse tree pass
// around; a "file" is a single track. fingerprint() takes either.
function flacFile(name, extra) {
  return Object.assign({ filename: name }, extra || {})
}
function group(folderName, files, extra) {
  return Object.assign({ folderName, folderPath: folderName, files }, extra || {})
}

// ── The field failure, named exactly as required ─────────────────────────────

test('a 5.1 original never accepts a stereo substitute', () => {
  // The original the user actually asked for: a 5.1 FLAC.
  const original = FP.fingerprint(group('Dark Side of the Moon 5.1 FLAC', [
    flacFile('08 - Time.flac'),
  ]))
  // A candidate from another peer with the SAME track name, no surround label —
  // i.e. a plain stereo rip. This is precisely (a) from the field: same name,
  // different channel layout.
  const candidate = FP.fingerprint(group('Dark Side of the Moon', [
    flacFile('08 - Time.flac'),
  ]))
  assert.strictEqual(original.surroundLabel, '5.1', 'the original must read as 5.1')
  assert.strictEqual(candidate.surroundLabel, null, 'the stereo candidate has no surround label')
  assert.strictEqual(FP.compatible(original, candidate), false,
    'a 5.1 want must never be satisfied by a stereo source')
})

test('a 5.1 original DOES accept another 5.1 source of equal quality', () => {
  const original = FP.fingerprint(group('Album 5.1 FLAC', [flacFile('01 - Song.flac')]))
  const candidate = FP.fingerprint(group('Album (5.1) [FLAC]', [flacFile('01 - Song.flac')]))
  assert.strictEqual(FP.compatible(original, candidate), true)
})

test('surround labels must match exactly: 5.1 != 7.1 != ATMOS', () => {
  const five = FP.fingerprint(group('Album 5.1', [flacFile('a.flac')]))
  const seven = FP.fingerprint(group('Album 7.1', [flacFile('a.flac')]))
  const atmos = FP.fingerprint(group('Album Atmos', [flacFile('a.flac')]))
  assert.strictEqual(five.surroundLabel, '5.1')
  assert.strictEqual(seven.surroundLabel, '7.1')
  assert.strictEqual(atmos.surroundLabel, 'ATMOS')
  assert.strictEqual(FP.compatible(five, seven), false, '5.1 must not accept 7.1')
  assert.strictEqual(FP.compatible(seven, five), false, '7.1 must not accept 5.1')
  assert.strictEqual(FP.compatible(five, atmos), false, '5.1 must not accept ATMOS')
  assert.strictEqual(FP.compatible(atmos, five), false, 'ATMOS must not accept 5.1')
})

test('a surround original never accepts a stereo (null) substitute, any label', () => {
  const stereo = FP.fingerprint(group('Album', [flacFile('a.flac')]))
  for (const label of ['5.1', '7.1', 'Atmos', 'multichannel']) {
    const surround = FP.fingerprint(group('Album ' + label, [flacFile('a.flac')]))
    assert.notStrictEqual(surround.surroundLabel, null, label + ' should read as surround')
    assert.strictEqual(FP.compatible(surround, stereo), false,
      label + ' must never accept a stereo substitute')
  }
})

test('null == null: a stereo original accepts a stereo substitute', () => {
  const a = FP.fingerprint(group('Album A', [flacFile('01.flac')]))
  const b = FP.fingerprint(group('Album B', [flacFile('01.flac')]))
  assert.strictEqual(a.surroundLabel, null)
  assert.strictEqual(b.surroundLabel, null)
  assert.strictEqual(FP.compatible(a, b), true)
})

test('a stereo original never accepts a surround substitute either', () => {
  // Not a "bonus": the scheduler is filling a specific want, and a 5.1 file is a
  // different (much larger) release than the stereo track it would replace.
  const stereo = FP.fingerprint(group('Album', [flacFile('a.flac')]))
  const surround = FP.fingerprint(group('Album 5.1', [flacFile('a.flac')]))
  assert.strictEqual(FP.compatible(stereo, surround), false)
})

// ── Lossless axis ────────────────────────────────────────────────────────────

test('a lossless original never accepts a lossy substitute', () => {
  const lossless = FP.fingerprint(group('Album', [flacFile('01 - Song.flac')]))
  const lossy = FP.fingerprint(group('Album', [flacFile('01 - Song.mp3')]))
  assert.strictEqual(lossless.lossless, true)
  assert.strictEqual(lossy.lossless, false)
  assert.strictEqual(FP.compatible(lossless, lossy), false)
})

test('a lossy original never accepts a lossless one (different want)', () => {
  const lossy = FP.fingerprint(group('Album', [flacFile('01.mp3')]))
  const lossless = FP.fingerprint(group('Album', [flacFile('01.flac')]))
  assert.strictEqual(FP.compatible(lossy, lossless), false)
})

test('lossless is detected across a range of extensions', () => {
  for (const ext of ['flac', 'wav', 'alac', 'ape', 'wv', 'aiff', 'aif']) {
    assert.strictEqual(FP.losslessOf(flacFile('track.' + ext)), true, ext + ' is lossless')
  }
  for (const ext of ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'wma']) {
    assert.strictEqual(FP.losslessOf(flacFile('track.' + ext)), false, ext + ' is lossy')
  }
})

// ── Bit-depth axis: equal-or-better ─────────────────────────────────────────

test('a 24-bit original never accepts a 16-bit substitute', () => {
  const hi = FP.fingerprint(flacFile('a.flac', { bitDepth: 24 }))
  const cd = FP.fingerprint(flacFile('a.flac', { bitDepth: 16 }))
  assert.strictEqual(hi.bitDepthClass, '24')
  assert.strictEqual(cd.bitDepthClass, '16')
  assert.strictEqual(FP.compatible(hi, cd), false)
})

test('a 16-bit original DOES accept a 24-bit substitute (an upgrade)', () => {
  const cd = FP.fingerprint(flacFile('a.flac', { bitDepth: 16 }))
  const hi = FP.fingerprint(flacFile('a.flac', { bitDepth: 24 }))
  assert.strictEqual(FP.compatible(cd, hi), true)
})

test('a known-depth original never accepts an unknown-depth substitute', () => {
  const known = FP.fingerprint(flacFile('a.flac', { bitDepth: 24 }))
  const unknown = FP.fingerprint(flacFile('a.flac'))
  assert.strictEqual(unknown.bitDepthClass, null)
  assert.strictEqual(FP.compatible(known, unknown), false,
    'guessing that an unlabelled file is good enough is exactly the disaster')
})

test('an unknown-depth original does not constrain the substitute depth', () => {
  const unknown = FP.fingerprint(flacFile('a.flac'))
  const cd = FP.fingerprint(flacFile('a.flac', { bitDepth: 16 }))
  assert.strictEqual(FP.compatible(unknown, cd), true)
})

// ── Sample-rate axis: equal-or-better ───────────────────────────────────────

test('a hi-res sample-rate original never accepts a lower-rate substitute', () => {
  const hires = FP.fingerprint(flacFile('a.flac', { sampleRate: 96000 }))
  const cd = FP.fingerprint(flacFile('a.flac', { sampleRate: 44100 }))
  assert.strictEqual(hires.sampleRateClass, '88+')
  assert.strictEqual(cd.sampleRateClass, '44')
  assert.strictEqual(FP.compatible(hires, cd), false)
})

test('a 44.1kHz original accepts a 48kHz-or-higher substitute', () => {
  const cd = FP.fingerprint(flacFile('a.flac', { sampleRate: 44100 }))
  const dat = FP.fingerprint(flacFile('a.flac', { sampleRate: 48000 }))
  assert.strictEqual(FP.compatible(cd, dat), true)
})

test('sample-rate classes band correctly', () => {
  assert.strictEqual(FP.sampleRateClassOf(flacFile('a.flac', { sampleRate: 44100 })), '44')
  assert.strictEqual(FP.sampleRateClassOf(flacFile('a.flac', { sampleRate: 48000 })), '48')
  assert.strictEqual(FP.sampleRateClassOf(flacFile('a.flac', { sampleRate: 88200 })), '88+')
  assert.strictEqual(FP.sampleRateClassOf(flacFile('a.flac', { sampleRate: 192000 })), '88+')
  assert.strictEqual(FP.sampleRateClassOf(flacFile('a.flac')), null)
})

// ── Guards ──────────────────────────────────────────────────────────────────

test('compatible is false when either fingerprint is missing', () => {
  const fp = FP.fingerprint(flacFile('a.flac'))
  assert.strictEqual(FP.compatible(null, fp), false)
  assert.strictEqual(FP.compatible(fp, null), false)
  assert.strictEqual(FP.compatible(null, null), false)
})

test('a group reads surround from any of folder path, name or file names', () => {
  assert.strictEqual(FP.surroundLabelOf(group('Some Album', [flacFile('Time 5.1.flac')])), '5.1',
    'a file name carrying the label counts')
  assert.strictEqual(FP.surroundLabelOf({ folderPath: 'Music/DSOTM 5.1/', folderName: 'DSOTM 5.1', files: [] }), '5.1',
    'a folder path carrying the label counts')
})

test('the surround detector is the shared one, so "Album 51" is not surround', () => {
  // If this module re-derived its own regex it could drift from slsk-filters and
  // reintroduce the "Album 51" false positive. Requiring the shared detector is
  // what keeps them in lockstep.
  assert.strictEqual(FP.surroundLabelOf(group('Album 51 Greatest Hits', [flacFile('a.flac')])), null)
  assert.strictEqual(FP.surroundLabelOf(group('Symphony 5 1st Movement', [flacFile('a.flac')])), null)
})

// A full realistic pairing: same album, same track, but the candidate is the
// stereo remaster — the exact substitution that corrupted the collection.
test('end to end: the 5.1 curated track rejects the stereo remaster by every gate', () => {
  const curated = FP.fingerprint(group('Aja 5.1 SACD FLAC 24-96', [
    flacFile('01 - Black Cow.flac', { bitDepth: 24, sampleRate: 96000 }),
  ]))
  const remaster = FP.fingerprint(group('Aja Remaster FLAC', [
    flacFile('01 - Black Cow.flac', { bitDepth: 16, sampleRate: 44100 }),
  ]))
  assert.strictEqual(curated.surroundLabel, '5.1')
  assert.strictEqual(remaster.surroundLabel, null)
  assert.strictEqual(FP.compatible(curated, remaster), false)
})
