'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { parseAnalysis } = require('../src/audio-features')

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
