'use strict'
// "when i hover over the sources listed on the anime page, it shows actual
// season name and source that it should actually play, but when i press play,
// plays completely different one, sometimes debrid one, which is certainly the
// wrong one" (2026-09-21).
//
// Pressing Play on a row handed main that row's release AND two other things:
// `debridCandidates`, so main could play whichever release RealDebrid already
// holds, and `alternates`, so the first torrent to connect wins. Neither
// checked whether the viewer had chosen deliberately.
//
// So clicking a first-season release while RealDebrid held a third-season pack
// played the third season. That is the reported bug, and it is also where most
// of the wrong-episode reports came from: a different release is a different
// numbering. Both features make a DEFAULT play faster. Neither is the app's
// decision to make once he has chosen.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function fn(name) {
  const start = R.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found')
  let depth = 0
  for (let j = R.indexOf('{', start); j < R.length; j++) {
    if (R[j] === '{') depth++
    else if (R[j] === '}') { depth--; if (!depth) return R.slice(start, j + 1) }
  }
  throw new Error('unbalanced ' + name)
}

test('a deliberate pick is recognised as one', () => {
  const body = fn('_videoPlayResult')
  assert.match(body, /const chosenByHand = !!\(opts && opts\.manual === true\)/)
})

test('a deliberate pick carries no other releases for main to prefer', () => {
  const body = fn('_videoPlayResult')
  const at = body.indexOf("if (result.kind === 'torrent' && !chosenByHand) {")
  assert.ok(at > 0, 'the block must be gated on the pick not being deliberate')
  // Both helpers live inside that one gate.
  const block = body.slice(at, body.indexOf('\n  }\n', at))
  assert.match(block, /debridCandidates: debridCandidates/, 'the debrid list is inside the gate')
  assert.match(block, /alternates: alts/, 'and so is the torrent race')
})

test('neither is attached anywhere outside that gate', () => {
  const body = fn('_videoPlayResult')
  assert.strictEqual((body.match(/debridCandidates: debridCandidates/g) || []).length, 1,
    'one attach site only, or a deliberate pick leaks other releases again')
  assert.strictEqual((body.match(/alternates: alts/g) || []).length, 1)
})

test('main still plays any candidate it is given — which is why sending none matters', () => {
  // The renderer is the only thing standing between a deliberate choice and
  // main's "whichever of these RealDebrid holds" behaviour.
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const at = MAIN.indexOf('async function _debridPlayableAny(result)')
  const body = MAIN.slice(at, at + 700)
  assert.match(body, /push\(result && result\.magnet\)/)
  assert.match(body, /result\.debridCandidates/,
    'main prefers whichever of these it can serve, in order — so the list must be empty for a deliberate pick')
})

test('a default play keeps both, because that is where the speed belongs', () => {
  const body = fn('_videoPlayResult')
  // The gate is on `!chosenByHand`, not on removing the feature.
  assert.match(body, /if \(result\.kind === 'torrent' && !chosenByHand\)/)
  assert.doesNotMatch(body, /if \(result\.kind === 'torrent'\) \{[\s\S]{0,200}debridCandidates/,
    'the ungated form is the bug')
})
