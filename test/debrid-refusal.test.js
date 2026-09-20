'use strict'
// RealDebrid refuses a great deal of content (2026-09-15). Measured against
// the user's own account: all three One Piece sources returned HTTP 451,
// "unavailable for legal reasons", and other magnets return 404. Its bulk
// availability endpoint is disabled, so there is no way to ask in advance.
// Without remembering a refusal, EVERY play of an affected title pays the
// debrid wait again before falling back to peers — which is what "it still
// falls right back to hunting for peers, slowly" actually was.
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')
const fs = require('fs')
const path = require('path')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

function harness(initial) {
  let stored = initial || {}
  const ctx = {
    sideStores: {
      debridRefusedIndex: {
        get: () => stored,
        update(fn) { stored = fn(stored) },
      },
    },
    _debridConfigured: () => true,
    Date, Object, Math, String, RegExp,
  }
  vm.createContext(ctx)
  vm.runInContext(MAIN.slice(MAIN.indexOf('const DEBRID_REFUSAL_TTL_MS'), MAIN.indexOf('const DEBRID_RELAY_TTL_MS')), ctx)
  return { ctx, seen: () => stored }
}
const MAG = h => 'magnet:?xt=urn:btih:' + h
const H1 = 'DBA54823E4E702BA125D098C206CF51DB7A079AA'

test('a refused source is remembered and not asked about again', () => {
  const { ctx } = harness()
  assert.strictEqual(ctx._debridRefusedHas(MAG(H1)), false)
  ctx._debridRefusedMark(MAG(H1), 'HTTP_451')
  assert.strictEqual(ctx._debridRefusedHas(MAG(H1)), true)
  assert.strictEqual(ctx._debridWorthTrying(MAG(H1)), false, 'straight to peers, no wait')
  assert.strictEqual(ctx._debridWorthTrying(MAG('AABBE4A1E322C72FFF0FEEC48382EC0A8AE8E371')), true)
})

test('the memory is case-insensitive about the hash and ignores junk', () => {
  const { ctx } = harness()
  ctx._debridRefusedMark(MAG(H1), 'HTTP_451')
  assert.strictEqual(ctx._debridRefusedHas(MAG(H1.toLowerCase())), true, 'same source, either case')
  assert.strictEqual(ctx._debridRefusedHas('not-a-magnet'), false)
  assert.strictEqual(ctx._debridWorthTrying(''), false, 'no magnet, nothing to try')
})

test('a refusal ages out, because a 404 may not be permanent', () => {
  const stale = {}
  stale[H1.toLowerCase()] = { at: Date.now() - (8 * 24 * 60 * 60 * 1000), code: 'HTTP_404' }
  const { ctx } = harness(stale)
  assert.strictEqual(ctx._debridRefusedHas(MAG(H1)), false, 'older than a week: worth one more try')
})

test('the memory is capped so it cannot grow for ever', () => {
  const { ctx, seen } = harness()
  for (let i = 0; i < 1700; i++) {
    ctx._debridRefusedMark(MAG(String(i).padStart(40, '0')), 'HTTP_451')
  }
  assert.ok(Object.keys(seen()).length <= 1500, 'capped, got ' + Object.keys(seen()).length)
})

test('only settled answers are remembered, never a transient failure', () => {
  const fn = MAIN.slice(MAIN.indexOf('async function _debridPlayable('), MAIN.indexOf('const DEBRID_BUDGET_MS'))
  assert.ok(/HTTP_\(451\|404\)/.test(fn), '451 and 404 are answers about the source')
  assert.ok(/_debridRefusedMark\(magnet, code\)/.test(fn))
  assert.ok(/throw e/.test(fn), 'the failure still reaches the caller so peers take over')
})

test('both play paths skip the wait entirely for a refused source', () => {
  assert.ok(/if \(_debridAnyWorthTrying\(result\)\) \{/.test(MAIN), 'both play paths guard on it')
  // Three paths start a source now, not two: video-play's smooth and purist
  // halves, and video-switch-stream. The switch used to go straight to the
  // swarm, so choosing a row the list had marked INSTANT started a cold peer
  // download — the slowest path, entered on purpose (2026-09-20). Every path
  // that starts a source has to consult this, so the count IS the rule.
  assert.strictEqual((MAIN.match(/if \(_debridAnyWorthTrying\(result\)\) \{/g) || []).length, 3)
  assert.ok(/ipcMain\.handle\('video-switch-stream'[\s\S]*?_debridAnyWorthTrying\(result\)/.test(MAIN),
    'the switch is one of them')
  // And the candidate search never re-offers one already refused.
  const pick = MAIN.slice(MAIN.indexOf("ipcMain.handle('video-debrid-pick'"), MAIN.indexOf("ipcMain.handle('video-warm-cancel'"))
  assert.ok(/!_debridRefusedHas\(m\)/.test(pick))
  assert.ok(/allRefused: true/.test(pick), 'says so rather than silently finding nothing')
})

// Falling back to peers in SILENCE is what made a working subscription look
// broken for days: there was no way to tell "RealDebrid does not carry this
// title" from "the app is ignoring what I paid for" (2026-09-16).
test('a debrid miss is explained to the viewer, with the reason', () => {
  const fs = require('fs'); const path = require('path')
  const MAINSRC = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  // Main classifies the failure rather than reporting a bare error.
  const fn = MAINSRC.slice(MAINSRC.indexOf('function _debridReasonFrom('), MAINSRC.indexOf('async function _debridPlayableAny('))
  for (const r of ['busy', 'blocked', 'notHeld', 'slow']) {
    assert.ok(new RegExp("'" + r + "'").test(fn), 'classifies ' + r)
  }
  // Both play paths report the miss before the swarm takes over.
  // Four. Three paths START a source (video-play's two halves and
  // video-switch-stream), and the switch reports a miss twice: once for the
  // look-up race, and once in the final catch — a race that resolved with no
  // link, or a link mpv could not open, threw PAST the first one and fell to
  // peers with nothing said at all.
  assert.strictEqual((MAINSRC.match(/_sendDebridMiss\(current, e\)/g) || []).length, 4)
  // And the renderer turns each reason into words a person can act on.
  const handler = R.slice(R.indexOf("if (payload.kind === 'debrid')"), R.indexOf("if (payload.kind === 'pack')"))
  assert.ok(/does not carry this title/.test(handler), 'blocked reads as coverage, not breakage')
  assert.ok(/rate-limiting this account/.test(handler))
  assert.ok(/showToast\(why\)/.test(handler), 'the viewer is actually told')
})
