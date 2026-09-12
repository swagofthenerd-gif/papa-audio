'use strict'
// V2.2: release names read for group, resolution and batch.
const test = require('node:test')
const assert = require('node:assert')
const RN = require('../src/release-name')

test('fansub names: the first real bracketed tag is the group', () => {
  assert.equal(RN.group('[SubsPlease] Frieren - 01 (1080p) [ABCD1234].mkv'), 'SubsPlease')
  assert.equal(RN.group('[Erai-raws] Frieren - 01 [1080p][Multiple Subtitle][ENG][JPN].mkv'), 'Erai-raws')
  assert.equal(RN.group('[1080p] Some Title - 03 [Judas]'), 'Judas', 'a leading resolution tag is skipped')
  assert.equal(RN.group('[x265][Dual Audio] Title 01'), '', 'codecs and languages are not groups')
})

test('scene names: the -GROUP tail is the group', () => {
  assert.equal(RN.group('Frieren.S01E01.1080p.WEB.H264-VARYG.mkv'), 'VARYG')
  assert.equal(RN.group('Dune.Part.Two.2024.2160p.UHD.BluRay.x265-FLUX'), 'FLUX')
  assert.equal(RN.group('Some.Film.2020.1080p.BluRay.x264-HEVC'), '', 'a codec tail is not a group')
  assert.equal(RN.group('Some.Film.2020.1080p-720p'), '', 'a resolution tail is not a group')
  assert.equal(RN.group(''), ''); assert.equal(RN.group(null), '')
})

test('resolution and batch', () => {
  assert.equal(RN.resolution('[SubsPlease] X - 01 (1080p)'), '1080p')
  assert.equal(RN.resolution('X.2024.2160p.UHD'), '2160p')
  assert.equal(RN.resolution('X.2024.4K.HDR'), '2160p')
  assert.equal(RN.resolution('X - 01'), '')
  assert.ok(RN.isBatch('[SubsPlease] X (01-12) (1080p) [Batch]'))
  assert.ok(RN.isBatch('X.S01.1080p.WEB-DL-GROUP'))
  assert.ok(!RN.isBatch('X.S01E03.1080p.WEB-DL-GROUP'))
  assert.deepEqual(RN.parse('[Judas] X - 01 [1080p]'), { group: 'Judas', resolution: '1080p', batch: false, title: '[Judas] X - 01 [1080p]' })
})

test('plausible: the release must carry the title; a one-letter title needs an episode marker', () => {
  const X = { type: 'tv', title: 'X', originalName: 'X -エックス-' }
  assert.ok(!RN.plausible(X, 'Logic Pro X 2023 23.01.2.2 MAS [TNT]'))
  assert.ok(!RN.plausible(X, 'iZotope Ozone Advanced 8.01 + Crack For Mac OS X'))
  assert.ok(!RN.plausible(X, '[SakuraCircle] Kateikyoushi x Saimin 2 The Animation - 01 (DVD 720x480 h264 AAC)'), 'x as a word inside another title, no')
  assert.ok(RN.plausible(X, '[Ohys-Raws] X (TV) - 01 (BS11 1280x720 x264 AAC).mp4'))
  assert.ok(RN.plausible(X, 'X.1999.S01E01.1080p.WEB.H264-GROUP'))
  assert.ok(RN.plausible({ type: 'movie', title: 'It' }, 'It.2017.1080p.BluRay.x264-SPARKS'))
  assert.ok(!RN.plausible({ type: 'movie', title: 'It' }, 'Make It Rain Tutorial'))
})

test('plausible: multi-word titles and known variants', () => {
  const dune = { type: 'movie', title: 'Dune: Part Two' }
  assert.ok(RN.plausible(dune, 'Dune.Part.Two.2024.2160p.UHD.BluRay.x265-FLUX'))
  assert.ok(RN.plausible(dune, 'Dune 2024 1080p WEB-DL'), 'the part before the colon is a title of its own')
  assert.ok(!RN.plausible({ type: 'movie', title: 'Dune Part Two' }, 'Dune.1984.1080p.BluRay-GROUP'))
  const frieren = { type: 'anime', title: "Frieren: Beyond Journey's End", titles: { romaji: 'Sousou no Frieren', native: '葬送のフリーレン' } }
  assert.ok(RN.plausible(frieren, '[SubsPlease] Sousou no Frieren - 01 (1080p) [ABCD1234].mkv'))
  assert.ok(RN.plausible(frieren, '[Erai-raws] 葬送のフリーレン - 01'))
  assert.ok(!RN.plausible(frieren, '[SubsPlease] Spy x Family - 01 (1080p).mkv'))
  assert.ok(RN.plausible(frieren, ''), 'no name, no judgement')
  assert.ok(RN.plausible(frieren, null))
})

// Sequel bleed (V2.5 "seen but not fixed"): Steins;Gate 0 sources listed for
// Steins;Gate, Dune: Part Two sources for Dune (2021).
test('plausible: a sequel token after the title, or another year on a film, is a different title', () => {
  const plausible = RN.plausible
  const sg = { type: 'anime', title: 'Steins;Gate', titles: { romaji: 'Steins;Gate', english: 'Steins;Gate' } }
  assert.equal(plausible(sg, '[Judas] Steins;Gate - 01 (1080p)'), true, 'the episode number after " - " is not a token')
  assert.equal(plausible(sg, '[Judas] Steins;Gate 0 - 01 (1080p)'), false, 'the 0 right after the title is Steins;Gate 0')
  assert.equal(plausible(sg, 'Steins.Gate.Zero.S01.1080p'), false)
  assert.equal(plausible(sg, 'Steins.Gate.S01.Complete.1080p'), true)
  const sg0 = { type: 'anime', title: 'Steins;Gate 0', titles: { romaji: 'Steins;Gate 0' } }
  assert.equal(plausible(sg0, '[Judas] Steins;Gate 0 - 01 (1080p)'), true, 'the request that carries the token keeps it')
  const dune = { type: 'movie', title: 'Dune', year: 2021 }
  assert.equal(plausible(dune, 'Dune.2021.2160p.UHD.BluRay.x265-GROUP'), true)
  assert.equal(plausible(dune, 'Dune.Part.One.2021.1080p.WEB'), true, 'Part One is the first film')
  assert.equal(plausible(dune, 'Dune.Part.Two.2024.2160p.WEB-DL'), false, 'another year and a sequel token')
  assert.equal(plausible(dune, 'Dune Part Two 1080p WEB'), false, 'the token alone is enough')
  assert.equal(plausible(dune, 'Dune.1984.1080p.BluRay'), false, 'the 1984 film')
  assert.equal(plausible({ type: 'movie', title: 'Dune: Part Two', year: 2024 }, 'Dune.Part.Two.2024.2160p.WEB-DL'), true)
  const fr = { type: 'anime', title: 'Frieren: Beyond Journey\'s End', titles: { romaji: 'Sousou no Frieren' } }
  assert.equal(plausible(fr, '[SubsPlease] Sousou no Frieren - 05 (1080p)'), true)
  assert.equal(plausible(fr, '[SubsPlease] Sousou no Frieren 2 - 05 (1080p)'), false, 'a second season sold as a sequel')
})
