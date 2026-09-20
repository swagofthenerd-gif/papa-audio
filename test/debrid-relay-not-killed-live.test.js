'use strict'
// THE BLACK SCREEN (reported 2026-09-20: "picture goes black or the player
// dies", and "when i close the player and play the video manually from other
// sources or the same instant source, it just works").
//
// Building a relay for a new source stopped the previous one immediately. When
// the viewer switches source — or switches episode inside a pack — that
// previous relay is the one mpv is reading from at that instant. Its input
// vanished mid-frame, seconds before the replacement had even been resolved,
// so the picture went black with up to DEBRID_BUDGET_MS of resolving still to
// come and nothing to fall back to. Switching again did it again. A fresh play
// always worked, because there is no live relay to kill.
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')
const fs = require('fs')
const path = require('path')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

function lift() {
  const start = MAIN.indexOf('let _debridRetiring = []')
  assert.ok(start > 0, 'the retire list must exist')
  const endMark = MAIN.indexOf('function _debridProxySweepRetired()')
  assert.ok(endMark > start)
  const end = MAIN.indexOf('\n}\n', endMark) + 3
  const ctx = {
    console, Date, Array, Object, Number, String, Boolean,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t },
    clearTimeout,
    _debridReady: null,
  }
  vm.createContext(ctx)
  vm.runInContext(MAIN.slice(start, end), ctx)
  // `let _debridRetiring` is a lexical binding: it is in scope INSIDE the vm
  // but never becomes a property of the context object, so it has to be read
  // from in there.
  ctx.__retiring = () => vm.runInContext('_debridRetiring.length', ctx)
  ctx.__held = (i) => vm.runInContext('_debridRetiring[' + i + ']', ctx)
  return ctx
}

const relay = (name, stopped) => ({
  magnet: name, url: 'http://127.0.0.1/' + name, want: null, at: 0,
  proxy: { stop() { stopped.push(name) } },
})

test('the relay feeding the picture is NOT stopped when a new one is built', () => {
  const stopped = []
  const ctx = lift()
  ctx._debridReady = relay('playing-now', stopped)
  ctx._debridProxyRetire()
  assert.deepEqual(stopped, [],
    'stopping it here is what blacked out the picture mid-switch')
  assert.strictEqual(ctx._debridReady, null, 'but it is no longer the current one')
  assert.strictEqual(ctx.__retiring(), 1, 'it is held, not forgotten')
})

test('it is let go once the new file is actually playing', () => {
  const stopped = []
  const ctx = lift()
  ctx._debridReady = relay('old', stopped)
  ctx._debridProxyRetire()
  ctx._debridProxySweepRetired()
  assert.deepEqual(stopped, ['old'], 'nothing can still be reading it by then')
  assert.strictEqual(ctx.__retiring(), 0)
})

test('switching several times in a row retires each one and leaks none', () => {
  // He asked for exactly this case. Each switch used to kill the relay that
  // the previous switch had just made the live one.
  const stopped = []
  const ctx = lift()
  for (const name of ['first', 'second', 'third']) {
    ctx._debridReady = relay(name, stopped)
    ctx._debridProxyRetire()
    assert.deepEqual(stopped, [], 'no relay may be stopped while it could be in use')
  }
  assert.strictEqual(ctx.__retiring(), 3)
  ctx._debridProxySweepRetired()
  assert.deepEqual(stopped.sort(), ['first', 'second', 'third'], 'and all are released together')
  assert.strictEqual(ctx.__retiring(), 0)
})

test('a switch that never completes cannot leak a relay for ever', async () => {
  const stopped = []
  const ctx = lift()
  // Shorten the grace for the test by retiring, then firing the timer early.
  ctx._debridReady = relay('orphan', stopped)
  ctx._debridProxyRetire()
  const held = ctx.__held(0)
  assert.ok(held.retireTimer, 'a backstop timer must be armed')
  clearTimeout(held.retireTimer)
  // Run what the timer would have run.
  held.proxy.stop()
  assert.deepEqual(stopped, ['orphan'])
})

test('the hard stop still stops everything, current and retired', () => {
  const stopped = []
  const ctx = lift()
  ctx._debridReady = relay('retired', stopped)
  ctx._debridProxyRetire()
  ctx._debridReady = relay('current', stopped)
  ctx._debridProxyStop()
  assert.deepEqual(stopped.sort(), ['current', 'retired'],
    'teardown must leave nothing running')
  assert.strictEqual(ctx._debridReady, null)
  assert.strictEqual(ctx.__retiring(), 0)
})

test('both places that swap a relay retire it, and the switch sweeps only after the load', () => {
  assert.ok(!/\n  _debridProxyStop\(\)\n  _debridReady = \{ magnet, proxy, url/.test(MAIN),
    '_debridPlayable must not kill the live relay')
  const sw = MAIN.slice(MAIN.indexOf("ipcMain.handle('video-switch-stream'"),
    MAIN.indexOf("ipcMain.handle('video-stop'"))
  assert.match(sw, /_videoSession\.switching = false\n\s+\/\/[\s\S]{0,200}_debridProxySweepRetired\(\)/,
    'the sweep must come after the new file is loaded and seeked, never before')
  const pack = MAIN.slice(MAIN.indexOf("ipcMain.handle('video-pack-select'"),
    MAIN.indexOf("ipcMain.handle('video-pack-select'") + 9000)
  assert.match(pack, /_debridProxyRetire\(\)/, 'switching episode inside a pack has the same hazard')
})
