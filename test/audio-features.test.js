'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const {
  parseAnalysis, rawToVector, buildNormaliser, normalise, distance, DEFAULT_WEIGHTS, FEATURE_KEYS,
} = require('../src/audio-features')

const SAMPLE = `
[Parsed_ebur128_2 @ 0x1] Summary:
  Integrated loudness:
    I:         -14.2 LUFS
    Threshold: -24.6 LUFS
  Loudness range:
    LRA:        11.4 LU
  True peak:
    Peak:        -0.3 dBFS
[Parsed_astats_3 @ 0x2] Overall
[Parsed_astats_3 @ 0x2] RMS level dB: -18.372
[Parsed_astats_3 @ 0x2] Crest factor: 6.221
[Parsed_astats_3 @ 0x2] Zero crossings rate: 0.041270
[Parsed_astats_3 @ 0x2] Flat factor: 0.000000
[Parsed_aspectralstats_4 @ 0x3] Overall
[Parsed_aspectralstats_4 @ 0x3] mean centroid: 1842.310
[Parsed_aspectralstats_4 @ 0x3] mean spread: 2210.775
[Parsed_aspectralstats_4 @ 0x3] mean flatness: 0.128
[Parsed_aspectralstats_4 @ 0x3] mean rolloff: 4820.500
[Parsed_aspectralstats_4 @ 0x3] mean entropy: 0.712
`

test('parseAnalysis pulls every measurement out of ffmpeg stderr', () => {
  const r = parseAnalysis(SAMPLE)
  assert.strictEqual(r.integratedLufs, -14.2)
  assert.strictEqual(r.lra, 11.4)
  assert.strictEqual(r.truePeak, -0.3)
  assert.strictEqual(r.rms, -18.372)
  assert.strictEqual(r.crest, 6.221)
  assert.strictEqual(r.zcr, 0.04127)
  assert.strictEqual(r.centroid, 1842.31)
  assert.strictEqual(r.flatness, 0.128)
  assert.strictEqual(r.rolloff, 4820.5)
  assert.strictEqual(r.entropy, 0.712)
})

test('parseAnalysis returns null for anything missing, never NaN', () => {
  const r = parseAnalysis('nothing useful here')
  for (const k of Object.keys(r)) {
    assert.strictEqual(r[k], null, `${k} should be null`)
  }
})

test('parseAnalysis ignores per-channel blocks and takes Overall', () => {
  const txt = `
[Parsed_astats_3 @ 0x2] Channel: 1
[Parsed_astats_3 @ 0x2] RMS level dB: -99.000
[Parsed_astats_3 @ 0x2] Overall
[Parsed_astats_3 @ 0x2] RMS level dB: -18.372
`
  assert.strictEqual(parseAnalysis(txt).rms, -18.372)
})

const RAW = {
  integratedLufs: -14.2, lra: 11.4, truePeak: -0.3, rms: -18.372, crest: 6.221,
  zcr: 0.04127, flatFactor: 0, centroid: 1842.31, spread: 2210.775,
  flatness: 0.128, rolloff: 4820.5, entropy: 0.712,
}

test('rawToVector produces exactly the five keys, all finite', () => {
  const v = rawToVector(RAW)
  assert.deepStrictEqual(Object.keys(v).sort(), [...FEATURE_KEYS].sort())
  for (const k of FEATURE_KEYS) assert.ok(Number.isFinite(v[k]), `${k} not finite`)
})

test('rawToVector returns null when a required measurement is missing', () => {
  assert.strictEqual(rawToVector({ ...RAW, rms: null }), null)
  assert.strictEqual(rawToVector({ ...RAW, centroid: null }), null)
})

test('a louder, brighter track scores higher on energy and brightness', () => {
  const quiet = rawToVector({ ...RAW, rms: -30, centroid: 900 })
  const loud  = rawToVector({ ...RAW, rms: -8,  centroid: 5200 })
  assert.ok(loud.energy > quiet.energy)
  assert.ok(loud.brightness > quiet.brightness)
})

test('a wide loudness range scores higher on dynamics', () => {
  const squashed = rawToVector({ ...RAW, lra: 2, crest: 3 })
  const open     = rawToVector({ ...RAW, lra: 18, crest: 12 })
  assert.ok(open.dynamics > squashed.dynamics)
})

test('normalise z-scores against the library, so identical input is all zeros', () => {
  const vs = [rawToVector(RAW), rawToVector(RAW), rawToVector(RAW)]
  const n = buildNormaliser(vs)
  const z = normalise(vs[0], n)
  for (const k of FEATURE_KEYS) assert.strictEqual(z[k], 0, `${k} should be 0`)
})

test('buildNormaliser never divides by zero on a constant dimension', () => {
  const n = buildNormaliser([rawToVector(RAW), rawToVector(RAW)])
  for (const k of FEATURE_KEYS) assert.ok(Number.isFinite(n.sd[k]) && n.sd[k] > 0)
})

test('distance is zero to itself and grows with difference', () => {
  const a = { energy: 0, brightness: 0, dynamics: 0, density: 0, punch: 0 }
  const b = { energy: 1, brightness: 0, dynamics: 0, density: 0, punch: 0 }
  const c = { energy: 3, brightness: 0, dynamics: 0, density: 0, punch: 0 }
  assert.strictEqual(distance(a, a), 0)
  assert.ok(distance(a, b) < distance(a, c))
})

test('dynamics is weighted above punch, because this library is prog', () => {
  assert.ok(DEFAULT_WEIGHTS.dynamics > DEFAULT_WEIGHTS.punch)
})
