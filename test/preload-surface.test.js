'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const root = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const PRELOAD = root('preload.js')
const MAIN = root('main.js')

const stripComments = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')

const MAIN_CODE = stripComments(MAIN)
const PRELOAD_CODE = stripComments(PRELOAD)

// The flat 164-endpoint surface has no validation of any kind, and the failure
// it allows is quiet: a preload method naming a channel main never registered
// throws "No handler registered for '...'" from deep inside Electron, at the
// moment the user clicks something, with nothing linking it back to the typo.
const invoked = new Set([...PRELOAD_CODE.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)].map(m => m[1]))
const sent = new Set([...PRELOAD_CODE.matchAll(/ipcRenderer\.send\(\s*'([^']+)'/g)].map(m => m[1])) 
const handled = new Set([...MAIN_CODE.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map(m => m[1]))
const onned = new Set([...MAIN_CODE.matchAll(/ipcMain\.on\(\s*'([^']+)'/g)].map(m => m[1]))

test('every channel preload invokes has a handler in main', () => {
  const missing = [...invoked].filter(c => !handled.has(c))
  assert.deepStrictEqual(missing, [],
    "invoke against an unregistered channel throws from inside Electron at click time")
})

test('every channel preload sends has a listener in main', () => {
  const missing = [...sent].filter(c => !onned.has(c))
  assert.deepStrictEqual(missing, [],
    'send to nothing is silent: the action simply does not happen')
})

test('no channel is registered with both handle and on', () => {
  // invoke() only reaches handle(), send() only reaches on(). A channel wired
  // both ways means one of the two callers is silently doing nothing.
  const both = [...handled].filter(c => onned.has(c))
  assert.deepStrictEqual(both, [])
})

test('the surface is big enough that this test is the only thing checking it', () => {
  // Not a style rule — a statement of why the checks above exist. If the surface
  // ever shrinks to something a person can hold in their head, these can go.
  assert.ok(invoked.size + sent.size > 100,
    `expected a large surface, found ${invoked.size + sent.size}`)
})

test('nothing in main is registered twice', () => {
  // The second registration of an ipcMain.handle throws at startup; a duplicate
  // ipcMain.on silently runs both listeners.
  for (const [label, src, re] of [
    ['handle', MAIN_CODE, /ipcMain\.handle\(\s*'([^']+)'/g],
    ['on', MAIN_CODE, /ipcMain\.on\(\s*'([^']+)'/g],
  ]) {
    const seen = new Map()
    const dupes = []
    for (const m of src.matchAll(re)) {
      if (seen.has(m[1])) dupes.push(m[1])
      else seen.set(m[1], true)
    }
    assert.deepStrictEqual([...new Set(dupes)], [], `duplicate ipcMain.${label} registrations`)
  }
})

// ── The reverse direction, which is what let 2.1-2.5 accumulate ────────────
//
// The forward tests above catch a preload method naming a channel main never
// registered. Nothing caught the opposite: a channel main registers that no
// preload method reaches. That failure is silent by construction -- the code
// looks finished, the handler is correct, and it can never run. Eighteen had
// piled up: the entire embedded-browser feature (eleven channels), the saved
// sites pair, cancel-download, show-notification, the general-settings pair,
// and a tray-tooltip handler left dead by an earlier fix.
//
// Anything genuinely main-only belongs in this map with a reason, so the next
// person sees a decision rather than an oversight.
const MAIN_ONLY = {
  // The overlay controls window (roadmap #26) speaks these on its OWN preload
  // (src/overlay-preload.js), not through the renderer's window.api, so they are
  // correctly absent from preload.js. Both are guarded in main to only accept
  // messages from the overlay's webContents.
  'overlay-control': 'spoken by src/overlay-preload.js (the overlay window), not the main renderer',
  'overlay-set-ignore': 'spoken by src/overlay-preload.js (the overlay window), not the main renderer',
}

test('every channel main registers is reachable from the renderer', () => {
  const reachable = new Set([...invoked, ...sent])
  const orphans = [...handled, ...onned]
    .filter(c => !reachable.has(c))
    .filter(c => !(c in MAIN_ONLY))
    .sort()
  assert.deepStrictEqual(orphans, [],
    'an unreachable handler is a feature that cannot run; wire it, delete it, ' +
    'or list it in MAIN_ONLY with a reason')
})

test('MAIN_ONLY does not name channels that no longer exist', () => {
  // Otherwise the exceptions map becomes its own graveyard.
  const registered = new Set([...handled, ...onned])
  const stale = Object.keys(MAIN_ONLY).filter(c => !registered.has(c)).sort()
  assert.deepStrictEqual(stale, [], 'remove these from MAIN_ONLY')
})

test('MAIN_ONLY entries each carry a reason', () => {
  for (const [chan, why] of Object.entries(MAIN_ONLY)) {
    assert.ok(typeof why === 'string' && why.length > 20,
      `${chan} needs a real reason, not "${why}"`)
  }
})

test('the receive allowlist has no channel main never sends', () => {
  // The mirror of the above for push channels. Five browser-* entries and
  // update-tray-tooltip sat in the allowlist after their senders were gone.
  const allow = PRELOAD_CODE.slice(PRELOAD_CODE.indexOf('  on: (channel, cb) =>'))
  const listEnd = allow.indexOf(']')
  const listed = [...allow.slice(0, listEnd).matchAll(/'([^']+)'/g)].map(m => m[1])
  assert.ok(listed.length > 20, 'found the allowlist')
  const sends = new Set([...MAIN.matchAll(/safeSend\(\s*'([^']+)'/g)].map(m => m[1]))
  // Channels pushed with a computed name, which the regex above cannot see.
  const DYNAMIC = new Set(['player-event'])
  const never = listed.filter(c => !sends.has(c) && !DYNAMIC.has(c)).sort()
  assert.deepStrictEqual(never, [],
    'a listener on a channel nothing sends is a feature waiting for an event ' +
    'that never arrives')
})
