'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EXCLUSIVITY_NOTE, isOn, forcesGapless, resolveEngineConfig } =
  require('../src/bit-perfect')

test('isOn is strict: only true counts as on', () => {
  assert.strictEqual(isOn(true), true)
  assert.strictEqual(isOn(false), false)
  assert.strictEqual(isOn(undefined), false)
  assert.strictEqual(isOn('yes'), false)
  assert.strictEqual(isOn(1), false)
})

test('forcesGapless mirrors the mode: on forces gapless, off leaves it alone', () => {
  assert.strictEqual(forcesGapless(true), true)
  assert.strictEqual(forcesGapless(false), false)
})

// ── resolveEngineConfig: OFF is a straight pass-through ─────────────────────
test('bit-perfect off passes the audio config through untouched', () => {
  const cfg = {
    bitPerfect: false, outputMode: 'default', alsaDevice: null,
    replaygain: 'album', mode: 'crossfade', channels: '5.1',
    eq: { enabled: true, gains: [3, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  }
  const eng = resolveEngineConfig(cfg)
  assert.strictEqual(eng.outputMode, 'default')
  assert.strictEqual(eng.replaygain, 'album')
  assert.strictEqual(eng.gapless, false)         // mode was crossfade
  assert.strictEqual(eng.audioChannels, '5.1')
  assert.deepStrictEqual(eng.eq, cfg.eq)
  assert.strictEqual(eng.bitPerfect, false)
})

// ── resolveEngineConfig: ON strips every sample-altering path ───────────────
test('bit-perfect on: exclusive device, no ReplayGain, no EQ, forced gapless', () => {
  const cfg = {
    bitPerfect: true, outputMode: 'default', alsaDevice: 'hw:2,0',
    replaygain: 'album', mode: 'crossfade', channels: 'auto',
    eq: { enabled: true, gains: [6, 6, 6, 6, 6, 6, 6, 6, 6, 6] },
  }
  const eng = resolveEngineConfig(cfg)
  assert.strictEqual(eng.outputMode, 'exclusive', 'exclusive device access')
  assert.strictEqual(eng.alsaDevice, 'hw:2,0', 'the chosen device is opened exclusively, not dropped')
  assert.strictEqual(eng.replaygain, 'no', 'ReplayGain scales samples — off')
  assert.strictEqual(eng.eq, null, 'a null EQ makes buildAfGraph emit no --af chain')
  assert.strictEqual(eng.gapless, true, 'crossfade is downgraded to gapless')
  assert.strictEqual(eng.bitPerfect, true, 'the flag rides through so the engine caps volume-max at 100')
})

test('bit-perfect on keeps gapless when gapless was already requested', () => {
  const eng = resolveEngineConfig({ bitPerfect: true, mode: 'gapless' })
  assert.strictEqual(eng.gapless, true)
})

test('the exclusivity note names the disabled comforts', () => {
  assert.match(EXCLUSIVITY_NOTE, /EQ/)
  assert.match(EXCLUSIVITY_NOTE, /ReplayGain/)
  assert.match(EXCLUSIVITY_NOTE, /crossfade/)
  assert.match(EXCLUSIVITY_NOTE, /exclusive/)
})
