'use strict'
// Setting Crossfade to 10 s must still be 10 s after a restart.
//
// It was not. Settings saved the transition with
// playerSetConfig({ mode, crossfadeSecs }) — but neither of those is a stored
// setting. main.js's getPlayerSettings() recomputes BOTH of them from
// playerSettings.crossfadeSeconds on every load:
//     const crossfadeSeconds = Number(saved.crossfadeSeconds) || 0
//     crossfadeAllowed       = crossfadeSeconds > 0 && !forcesGapless(bitPerfect)
//     mode                   = crossfadeAllowed ? 'crossfade' : 'gapless'
//     crossfadeSecs          = crossfadeSeconds > 0 ? crossfadeSeconds : 4
// The only writer of crossfadeSeconds is the player-set-crossfade IPC, exposed
// as preload playerSetCrossfade — and the renderer had ZERO call sites for it.
// So his config.json held crossfadeSecs: 8 beside crossfadeSeconds: 0, the
// dropdown reverted to Gapless/4s on every restart, and crossfade could never
// be switched on at all. Every crossfade fix this week was unreachable code.
//
// The real initPlaybackSettings is lifted and run against a recording api and a
// stub DOM, and the recorded calls are fed to the REAL getPlayerSettings
// derivation to prove the round trip.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const bitPerfect = require('../src/bit-perfect.js')

// Objects made inside the vm have the vm's own Object.prototype, which
// deepStrictEqual rejects. Compare their contents, not their realm.
const plain = o => JSON.parse(JSON.stringify(o))

function lift(name) {
  for (const kw of ['\nasync function ', '\nfunction ']) {
    const start = SRC.indexOf(kw + name + '(')
    if (start === -1) continue
    const a = SRC.indexOf('\nfunction ', start + 1)
    const b = SRC.indexOf('\nasync function ', start + 1)
    const stop = [a, b].filter(n => n > -1).sort((x, y) => x - y)[0]
    return SRC.slice(start, stop === undefined ? undefined : stop)
  }
  assert.fail(name + ' must still exist as a top-level function in renderer.js')
}

// main.js's getPlayerSettings(), reduced to the crossfade derivation it really
// does. Kept in step with main.js by the pin at the bottom of this file.
function loadFromStore(saved) {
  const crossfadeSeconds = Number(saved.crossfadeSeconds) || 0
  const allowed = crossfadeSeconds > 0 && !bitPerfect.forcesGapless(saved.bitPerfect === true)
  return {
    ...saved,
    crossfadeSeconds,
    mode: allowed ? 'crossfade' : 'gapless',
    crossfadeSecs: crossfadeSeconds > 0 ? crossfadeSeconds : 4,
  }
}

// A DOM just real enough for the settings panel: every id the function touches
// answers with an element that remembers value/checked/style/handlers.
function stubDom() {
  const els = new Map()
  const make = id => ({
    id, value: '', checked: false, textContent: '', innerHTML: '',
    style: {}, dataset: {},
    setAttribute() {}, removeAttribute() {},
    addEventListener() {}, querySelectorAll: () => [], querySelector: () => null,
  })
  return {
    els,
    getElementById(id) {
      if (!els.has(id)) els.set(id, make(id))
      return els.get(id)
    },
    querySelectorAll: () => [],
    querySelector: () => null,
  }
}

// Runs the real settings page against a fake main process whose store starts at
// `saved`, and returns a handle for driving the controls.
function openSettings(saved) {
  const store = { ...saved }
  const calls = { setCrossfade: [], setConfig: [] }
  const api = {
    async playerGetConfig() { return loadFromStore(store) },
    async playerSetCrossfade(arg) {
      calls.setCrossfade.push(arg)
      // What main.js's handler does: writes the AUTHORITATIVE key.
      store.crossfadeSeconds = Math.floor(Number(arg && arg.seconds)) || 0
      return { ok: true }
    },
    async playerSetConfig(partial) {
      calls.setConfig.push(partial)
      // What _applyPlayerConfig does: merges over the DERIVED view, so a
      // mode/crossfadeSecs write can never reach crossfadeSeconds.
      Object.assign(store, loadFromStore(store), partial)
      return { ok: true }
    },
    async playerListDevices() { return [] },
    playerSetBitPerfect() {},
    mpvReplaygainMode() {},
  }
  const document = stubDom()
  const state = {}
  const ctx = vm.createContext({
    state, document, console, Number, Math, isFinite, Object,
    window: { api },
    showSnackbar() {}, showToast() {},
    updateBitPerfectBadge() {}, updateCrossfadeBadge() {}, _paintActiveDevice() {},
    esc: s => String(s == null ? '' : s),
    async _initGeneralSettings() {}, async _initEqSettings() {}, async _initSharingSettings() {},
  })
  vm.runInContext(
    lift('_pbCrossfadeSeconds') + lift('_setGlobalCrossfade') +
    lift('_syncGlobalCrossfadeCache') + lift('initPlaybackSettings'), ctx)
  return {
    store, calls, state, document,
    open: () => vm.runInContext('initPlaybackSettings()', ctx),
    el: id => document.getElementById(id),
  }
}

test('choosing Crossfade at 10 s writes the key main.js actually reads', async () => {
  const s = openSettings({})
  await s.open()
  s.el('pb-cf-secs').value = 10
  s.el('pb-mode').value = 'crossfade'
  s.el('pb-mode').onchange({ target: { value: 'crossfade' } })

  assert.deepStrictEqual(plain(s.calls.setCrossfade), [{ seconds: 10 }],
    'the transition must go through playerSetCrossfade — playerSetConfig writes ' +
    'keys main.js recomputes on load, which is why the setting never stuck')
  assert.strictEqual(s.store.crossfadeSeconds, 10, 'and it reaches the store')
})

test('and it is still 10 s after a restart', async () => {
  const s = openSettings({})
  await s.open()
  s.el('pb-cf-secs').value = 10
  s.el('pb-mode').onchange({ target: { value: 'crossfade' } })

  // Restart: a fresh settings page reading the same store through the real
  // derivation. This is the exact step that used to show Gapless / 4s again.
  const after = openSettings(s.store)
  await after.open()
  assert.strictEqual(after.el('pb-mode').value, 'crossfade', 'the transition survived')
  assert.strictEqual(Number(after.el('pb-cf-secs').value), 10, 'and so did the length')
  assert.strictEqual(after.el('pb-cf-label').textContent, '10s')
  assert.strictEqual(after.el('pb-cf-row').style.display, '', 'with the length row visible')
})

test('dragging the length slider saves the new length, not a stale one', async () => {
  const s = openSettings({ crossfadeSeconds: 6 })
  await s.open()
  assert.strictEqual(Number(s.el('pb-cf-secs').value), 6, 'the saved length is read back')
  s.el('pb-mode').value = 'crossfade'
  s.el('pb-cf-secs').onchange({ target: { value: 12 } })
  assert.deepStrictEqual(plain(s.calls.setCrossfade.at(-1)), { seconds: 12 })
  assert.strictEqual(loadFromStore(s.store).crossfadeSecs, 12)
})

test('switching back to Gapless turns crossfade off, not down to 4', async () => {
  const s = openSettings({ crossfadeSeconds: 9 })
  await s.open()
  s.el('pb-cf-secs').value = 9
  s.el('pb-mode').onchange({ target: { value: 'gapless' } })
  assert.deepStrictEqual(plain(s.calls.setCrossfade.at(-1)), { seconds: 0 })
  assert.strictEqual(s.store.crossfadeSeconds, 0)
  assert.strictEqual(loadFromStore(s.store).mode, 'gapless')
  assert.strictEqual(s.el('pb-cf-row').style.display, 'none')
})

test('Settings no longer writes the derived pair at all', async () => {
  const s = openSettings({})
  await s.open()
  s.el('pb-cf-secs').value = 7
  s.el('pb-mode').onchange({ target: { value: 'crossfade' } })
  s.el('pb-cf-secs').onchange({ target: { value: 8 } })
  const dead = plain(s.calls.setConfig).filter(p => 'mode' in p || 'crossfadeSecs' in p)
  assert.deepStrictEqual(dead, [],
    'mode/crossfadeSecs are derived by main.js; writing them is a no-op that ' +
    'leaves the store self-contradictory')
})

test('the in-app crossfade cache tracks the real setting', async () => {
  const s = openSettings({})
  await s.open()
  s.el('pb-cf-secs').value = 5
  s.el('pb-mode').onchange({ target: { value: 'crossfade' } })
  assert.deepStrictEqual(plain(s.state._globalPlayerCfg), { mode: 'crossfade', crossfadeSecs: 5 })
  assert.strictEqual(s.state._playerSettings.crossfadeSeconds, 5,
    'so the CF badge and the quality badge read the same number')
})

test('bit-perfect still forces gapless no matter what is saved', () => {
  // Not the renderer's call — pinned here because the settings page shows
  // cfg.mode and must not claim crossfade while main has overruled it.
  assert.strictEqual(loadFromStore({ crossfadeSeconds: 10, bitPerfect: true }).mode, 'gapless')
  assert.strictEqual(loadFromStore({ crossfadeSeconds: 10, bitPerfect: false }).mode, 'crossfade')
})

test('main.js still derives mode and length from crossfadeSeconds', () => {
  // The fixture above is only honest while this is true of the real file.
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(MAIN, /const crossfadeSeconds = Number\(saved\.crossfadeSeconds\) \|\| 0/)
  assert.match(MAIN, /mode: crossfadeAllowed \? 'crossfade' : 'gapless'/)
  assert.match(MAIN, /crossfadeSecs: crossfadeSeconds > 0 \? crossfadeSeconds : 4/)
  assert.match(MAIN, /ipcMain\.handle\('player-set-crossfade'/)
})

test('preload still exposes the one IPC that can write it', () => {
  const PRE = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
  assert.match(PRE, /playerSetCrossfade\s*:/)
})
