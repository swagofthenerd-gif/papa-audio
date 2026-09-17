'use strict'
// Structural guards for the W7 UI wave: the anime absolute-numbering override
// (roadmap #44) and the bit-perfect output toggle (settings). The numbering
// *math* is exercised for real in anime-numbering.test.js; this file guards the
// renderer/HTML wiring that math hangs off, which cannot be required in Node.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const CODE = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8')
const HTML = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8')

function slice(from, toMarker) {
  const s = CODE.indexOf(from)
  assert.ok(s > -1, `expected to find: ${from}`)
  const e = CODE.indexOf(toMarker, s + from.length)
  return CODE.slice(s, e > -1 ? e : CODE.length)
}

// ── #44 numbering override ─────────────────────────────────────────────────────
test('the numbering module loads before renderer.js', () => {
  const a = HTML.indexOf('src="anime-numbering.js"')
  const r = HTML.indexOf('src="renderer.js"')
  assert.ok(a > -1 && r > -1 && a < r, 'anime-numbering.js loads before renderer.js')
})

test('the anime request is rewritten through the override, feature-detected', () => {
  const fn = slice('function _applyAnimeNumbering(', '\nfunction _numberingControl')
  assert.match(fn, /window\.PapaAnimeNumbering/, 'uses the storage module')
  assert.match(fn, /req\.type !== 'anime'/, 'only anime requests are touched')
  assert.match(fn, /N\.get\(window\.PapaLocal, req\.anilistId\)/, 'reads the per-id override from PapaLocal')
  assert.match(fn, /N\.applyToRequest\(req, startAbs\)/, 'and applies it')
  // And _videoStreamRequest actually routes the anime request through it.
  const req = slice('function _videoStreamRequest(', '\nfunction _applyAnimeNumbering')
  assert.match(req, /return _applyAnimeNumbering\(req\)/, 'the anime branch returns the rewritten request')
})

test('the affordance only appears for anime and opens the compact dialog', () => {
  const ctrl = slice('function _numberingControl(', '\nfunction _bindNumberingControl')
  assert.match(ctrl, /window\.PapaAnimeNumbering/, 'feature-detected on the module')
  assert.match(ctrl, /id="video-numbering-btn"/, 'renders a Numbering button')
  // It is placed in the anime controls row, next to Dub, inside _renderVideoControls.
  const anime = slice('_dubControl(_videoDetail.d) + _numberingControl', '_bindNumberingControl(_videoDetail.d)')
  assert.match(anime, /_numberingControl\(_videoDetail\.d\)/, 'the button is in the anime controls row')
  assert.ok(CODE.includes('_bindNumberingControl(_videoDetail.d)'), 'and bound')
})

test('the dialog persists per id and re-renders on Save and Clear', () => {
  const dlg = slice('function _openAnimeNumberingDialog(', '\n// Apply a show')
  assert.match(dlg, /id="anm-input"/, 'a single start-number input')
  assert.match(dlg, /id="anm-save"/, 'a Save button')
  assert.match(dlg, /id="anm-clear"/, 'and a Clear button')
  assert.match(dlg, /N\.set\(window\.PapaLocal, d\.id, input\.value\)/, 'Save persists per anilistId')
  assert.match(dlg, /N\.clear\(window\.PapaLocal, d\.id\)/, 'Clear removes the override')
  assert.match(dlg, /_loadVideoSources\(/, 'and the source list is reloaded so the change takes effect')
})

// ── bit-perfect toggle ─────────────────────────────────────────────────────────
test('the bit-perfect row exists with the honest sublabel', () => {
  const group = HTML.slice(HTML.indexOf('id="playback-settings"'), HTML.indexOf('id="video-settings"'))
  assert.match(group, /id="pb-bitperfect"/, 'a Bit-perfect output checkbox')
  assert.match(group, /Bit-perfect mode/, 'labelled Bit-perfect mode')
  // The sublabel has to name what it turns off AND admit what it does not.
  // The old copy said the samples "reach your DAC untouched", which is not
  // true for a queue that mixes sample rates: gapless holds the output open
  // and resamples at the handoff. Keeping it seamless is the deliberate
  // choice; hiding it was not.
  assert.match(group, /turns off EQ, ReplayGain, volume leveling/, 'names what it disables')
  assert.match(group, /resampled at the handoff/, 'and discloses the resampling it does NOT prevent')
  // The output dropdown must no longer call itself bit-perfect: it only opens
  // the device alone, and EQ, ReplayGain, boost and crossfade all keep running.
  assert.doesNotMatch(group, /Exclusive \(bit-perfect\)/,
    'two different controls must not both claim to be bit-perfect')
})

test('the toggle is feature-detected and goes through playerSetBitPerfect', () => {
  const fn = slice('async function initPlaybackSettings(', '\n// The interface-size setting')
  assert.match(fn, /typeof window\.api\.playerSetBitPerfect === 'function'/, 'feature-detected')
  assert.match(fn, /window\.api\.playerSetBitPerfect\(\{ on \}\)/, 'calls the dedicated IPC with { on }')
  // The row hides on a backend without the contract, rather than showing dead.
  assert.match(fn, /bpRow\.style\.display = bpSupported \? '' : 'none'/, 'no contract -> row hidden')
})
