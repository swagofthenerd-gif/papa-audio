'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { BANDS, BAND_COUNT, buildAfGraph, normalize, defaultSettings } = require('../eq')

test('disabled EQ produces no filter chain', () => {
  assert.strictEqual(buildAfGraph({ enabled: false, preamp: 6, gains: [9, 9, 9] }), '')
})

test('enabled but flat produces no filter chain', () => {
  assert.strictEqual(buildAfGraph({ enabled: true, preamp: 0, gains: new Array(BAND_COUNT).fill(0) }), '')
})

test('only non-zero bands are emitted, in ascending frequency order', () => {
  const gains = new Array(BAND_COUNT).fill(0)
  gains[0] = 6
  gains[9] = -4
  const g = buildAfGraph({ enabled: true, preamp: 0, gains })
  assert.strictEqual(g, 'lavfi=[equalizer=f=31:t=q:w=1:g=6,equalizer=f=16000:t=q:w=1:g=-4]')
})

test('preamp is emitted first so it attenuates before the boosts', () => {
  const gains = new Array(BAND_COUNT).fill(0)
  gains[5] = 3
  const g = buildAfGraph({ enabled: true, preamp: -3, gains })
  assert.match(g, /^lavfi=\[volume=volume=-3dB,equalizer=f=1000:/)
})

test('preamp alone is enough to produce a chain', () => {
  const g = buildAfGraph({ enabled: true, preamp: -6, gains: new Array(BAND_COUNT).fill(0) })
  assert.strictEqual(g, 'lavfi=[volume=volume=-6dB]')
})

test('gains and preamp clamp to the supported range', () => {
  const n = normalize({ enabled: true, preamp: 99, gains: [99, -99] })
  assert.strictEqual(n.preamp, 12)
  assert.strictEqual(n.gains[0], 12)
  assert.strictEqual(n.gains[1], -12)
})

test('missing, short, or garbage gain arrays normalize to flat', () => {
  for (const gains of [undefined, null, [], 'nope', [null, NaN, 'x']]) {
    const n = normalize({ enabled: true, gains })
    assert.strictEqual(n.gains.length, BAND_COUNT)
    assert.ok(n.gains.every(g => g === 0), `expected flat for ${JSON.stringify(gains)}`)
  }
})

test('normalize never returns a value mpv cannot parse', () => {
  const g = buildAfGraph({ enabled: true, preamp: 1 / 3, gains: [2 / 3] })
  assert.ok(!/e[+-]/i.test(g), `exponential notation in ${g}`)
  assert.ok(!/NaN|Infinity|undefined/.test(g), `unparseable token in ${g}`)
})

test('band list is the documented ten-band ISO layout', () => {
  assert.deepStrictEqual(BANDS, [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000])
})

test('default settings are off and flat', () => {
  const d = defaultSettings()
  assert.strictEqual(d.enabled, false)
  assert.strictEqual(buildAfGraph(d), '')
})

const { PRESETS, presetSettings, suggestedPreamp } = require('../eq')

test('every preset covers exactly the ten bands and stays in range', () => {
  for (const [name, gains] of Object.entries(PRESETS)) {
    assert.strictEqual(gains.length, BAND_COUNT, `${name} has wrong band count`)
    assert.ok(gains.every(g => g >= -12 && g <= 12), `${name} out of range`)
  }
})

test('preset preamp cancels the peak boost to protect headroom', () => {
  const s = presetSettings('bass-boost')
  assert.strictEqual(s.preamp, -Math.max(...PRESETS['bass-boost']))
  assert.strictEqual(s.enabled, true)
})

test('a cut-only curve needs no preamp attenuation', () => {
  assert.strictEqual(suggestedPreamp([-4, -2, 0, 0, 0, 0, 0, 0, 0, 0]), 0)
})

test('flat preset yields an empty chain despite being enabled', () => {
  assert.strictEqual(buildAfGraph(presetSettings('flat')), '')
})

test('unknown preset names return null instead of a broken curve', () => {
  assert.strictEqual(presetSettings('does-not-exist'), null)
})

test('presets do not mutate when the returned gains are edited', () => {
  const s = presetSettings('rock')
  s.gains[0] = 99
  assert.notStrictEqual(PRESETS.rock[0], 99)
})
