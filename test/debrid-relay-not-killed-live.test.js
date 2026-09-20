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
    // Two requests name the same file only when they name the same episode.
    _sameWant: (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null),
    DEBRID_RELAY_TTL_MS: 10 * 60 * 1000,
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

// ── switching BACK ("when i switch back to instant, it still doesnt play
// instant") ────────────────────────────────────────────────────────────────
const { createDebridProxy } = require('../src/debrid-proxy')

// A relay that really listens, so alive() is measured rather than assumed.
async function realRelay() {
  const proxy = createDebridProxy({
    fetchFn: async (url, init) => {
      if (init && init.method === 'HEAD') {
        return { ok: true, status: 200, headers: { get: k => (k === 'content-length' ? '1024' : null) } }
      }
      return {
        ok: true, status: 206,
        headers: { get: k => (k === 'content-range' ? 'bytes 0-0/1024' : null) },
        body: { cancel: async () => {} },
        arrayBuffer: async () => new ArrayBuffer(1),
      }
    },
  })
  const url = await proxy.serve('https://rd.example/file.mkv')
  return { proxy, url }
}

test('a relay reports honestly whether it is still listening', async () => {
  const { proxy } = await realRelay()
  assert.strictEqual(proxy.alive(), true, 'it is serving')
  proxy.stop()
  assert.strictEqual(proxy.alive(), false, 'and it knows when it is not')
})

test('switching back revives the relay instead of resolving all over again', async () => {
  const ctx = lift()
  const { proxy, url } = await realRelay()
  ctx._debridReady = { magnet: 'was-playing', proxy, url, want: null, at: Date.now() }
  ctx._debridProxyRetire()
  assert.strictEqual(ctx._debridProxyRevive('was-playing', null), url,
    'the standing relay is handed straight back')
  assert.strictEqual(ctx.__retiring(), 0, 'it is current again')
  assert.strictEqual(proxy.alive(), true, 'and it was never stopped to do it')
  proxy.stop()
})

test('a relay that has been STOPPED is never handed back', async () => {
  // This is the black screen. A stopped relay is indistinguishable from a
  // running one by inspection — same object, same well-formed URL, nothing
  // listening — so reusing one gives mpv an address that never answers.
  const ctx = lift()
  const { proxy, url } = await realRelay()
  ctx._debridReady = { magnet: 'dead', proxy, url, want: null, at: Date.now() }
  ctx._debridProxyRetire()
  proxy.stop()
  assert.strictEqual(ctx._debridProxyRevive('dead', null), null,
    'a dead relay must be re-minted, never reused')
})

test('reviving retires whatever is current rather than killing it', async () => {
  const stopped = []
  const ctx = lift()
  const first = await realRelay()
  ctx._debridReady = { magnet: 'first', proxy: first.proxy, url: first.url, want: null, at: Date.now() }
  ctx._debridProxyRetire()
  ctx._debridReady = relay('second-live', stopped)
  ctx._debridReady.at = Date.now()
  assert.strictEqual(ctx._debridProxyRevive('first', null), first.url)
  assert.deepEqual(stopped, [], 'the one feeding the picture must not be stopped')
  assert.strictEqual(ctx.__retiring(), 1, 'it stepped aside instead')
  first.proxy.stop()
})

test('a different source, a different episode, or an expired link is not revived', async () => {
  const ctx = lift()
  const { proxy, url } = await realRelay()
  ctx._debridReady = { magnet: 'mine', proxy, url, want: { season: null, episode: 5 }, at: Date.now() }
  ctx._debridProxyRetire()
  assert.strictEqual(ctx._debridProxyRevive('other', { season: null, episode: 5 }), null)
  assert.strictEqual(ctx._debridProxyRevive('mine', { season: null, episode: 6 }), null,
    'episode 5 must never be handed back for episode 6')
  assert.strictEqual(ctx.__retiring(), 1, 'a refused revive leaves it retired')
  proxy.stop()
})

test('an expired link is re-minted however recently it was retired', async () => {
  const ctx = lift()
  const { proxy, url } = await realRelay()
  ctx._debridReady = { magnet: 'old', proxy, url, want: null, at: Date.now() - (11 * 60 * 1000) }
  ctx._debridProxyRetire()
  assert.strictEqual(ctx._debridProxyRevive('old', null), null,
    'an unrestricted RealDebrid link does not last')
  proxy.stop()
})

test('the resolve path consults the revive before paying for a new link', () => {
  const at = MAIN.indexOf('async function _debridPlayable(magnet, want)')
  assert.ok(at > 0)
  const body = MAIN.slice(at, at + 1200)
  assert.match(body, /const revived = _debridProxyRevive\(magnet, want\)/)
  assert.match(body, /if \(revived\) return revived/)
  // And the guard that makes it safe is in the revive itself.
  const rev = MAIN.slice(MAIN.indexOf('function _debridProxyRevive('), MAIN.indexOf('\n}\n', MAIN.indexOf('function _debridProxyRevive(')))
  assert.match(rev, /e\.proxy\.alive\(\)/, 'a relay is only reused while it is genuinely listening')
})
