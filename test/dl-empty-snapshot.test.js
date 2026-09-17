'use strict'
// An empty answer from slskd is not the same as "everything was cancelled".
//
// dlSnapshot returns null only when the fetch THROWS. A 204 or an empty body
// iterates nothing and hands back an empty Map — which is truthy, so it sailed
// past `if (!snap) return`. Every in-flight file then looked removed, and 30
// seconds later the loop called recordAbandoned on all of them.
//
// recordAbandoned is terminal AND persisted, and it writes a band-independent
// song key, so the same song was blocked from every peer and in every format,
// forever, across restarts. slskd answers this way while restarting — which is
// exactly what changing the download folder, the share mode or the Soulseek
// password does.
//
// The real scheduler is used here, not a stand-in: the point is what actually
// happens to the state.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const dlSched = require('../src/download-scheduler.js')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

// The guard as it is shipped, lifted out of dlTick and run for real.
function liftGuard() {
  const at = MAIN.indexOf('if (snap.size === 0 && Object.keys(dlState.inflight).length > 0) {')
  assert.ok(at > -1, 'the empty-snapshot guard must still exist in dlTick')
  const end = MAIN.indexOf('\n    }', MAIN.indexOf('} else {', at)) + '\n    }'.length
  return MAIN.slice(at, end)
}
const GUARD = liftGuard()

function runTick({ snap, dlState, empties }) {
  // Returns { returned, empties } — `returned` true means the tick bailed out
  // before the abandon loop.
  const fn = new Function('snap', 'dlState', '_state', 'console', `
    let _dlEmptySnapshots = _state.empties
    let _returned = false
    ;(function () {
      ${GUARD}
    })()
    return { returned: _returned, empties: _dlEmptySnapshots }
  `.replace(/\breturn\b(?![^\n]*\{)/g, '_returned = true; return'))
  return fn(snap, dlState, { empties: empties }, { warn() {} })
}

function stateWithInflight() {
  return {
    inflight: { 'k1': { filename: 'Artist/Album/01.flac', size: 30e6, since: 0 } },
    pending: [],
    done: {},
    abandonedIds: {},
    peerFailures: {},
  }
}

test('recordAbandoned really is terminal and really does block the song everywhere', () => {
  // The premise. If this ever stops being true the guard matters less, and
  // this file should be revisited rather than quietly kept.
  const st = stateWithInflight()
  dlSched.recordAbandoned(st, 'k1')
  assert.strictEqual(st.done.k1, 'abandoned')
  assert.strictEqual(Object.keys(st.inflight).length, 0)
  assert.ok(Object.keys(st.abandonedIds).length >= 1,
    'the identity is written down, which is what makes it survive a restart')
})

test('one empty snapshot does not abandon anything', () => {
  const dlState = stateWithInflight()
  const r = runTick({ snap: new Map(), dlState, empties: 0 })
  assert.strictEqual(r.returned, true, 'the tick must bail out before the abandon loop')
  assert.strictEqual(r.empties, 1, 'and remember that it saw one')
  assert.deepStrictEqual(dlState.done, {}, 'nothing abandoned')
  assert.strictEqual(Object.keys(dlState.inflight).length, 1, 'the file is still in flight')
})

test('a second consecutive empty snapshot is believed', () => {
  const dlState = stateWithInflight()
  const r = runTick({ snap: new Map(), dlState, empties: 1 })
  assert.strictEqual(r.returned, false,
    'a daemon that is genuinely empty twice running must still be believed, ' +
    'or a real cancel would never take effect')
})

test('an empty snapshot with nothing in flight is ordinary, and resets the streak', () => {
  const dlState = { inflight: {}, pending: [], done: {}, abandonedIds: {} }
  const r = runTick({ snap: new Map(), dlState, empties: 1 })
  assert.strictEqual(r.returned, false)
  assert.strictEqual(r.empties, 0, 'the streak only counts contradictions')
})

test('a normal non-empty snapshot resets the streak', () => {
  const dlState = stateWithInflight()
  const snap = new Map([['Artist/Album/01.flac', { state: 'InProgress' }]])
  const r = runTick({ snap, dlState, empties: 1 })
  assert.strictEqual(r.returned, false)
  assert.strictEqual(r.empties, 0)
})
