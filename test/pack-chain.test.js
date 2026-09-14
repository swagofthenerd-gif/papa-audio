'use strict'
// Season packs cache chronologically (2026-09-14): once the playing episode is
// complete on disk, the next incomplete episode after it is pulled in full at
// the lowest priority — then the one after, in pack order. A user's own
// whole-file download is never overridden while it runs.
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')
const fs = require('fs')
const path = require('path')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

function harness({ files, infos, pd = null }) {
  const calls = []
  const streamer = {
    files: () => files,
    fileInfo: i => infos[i] || null,
    predownloadFile: i => { calls.push(i); return true },
    predownloadProgress: () => pd,
    prefetchFile: () => true,
  }
  // The chain tick also nudges the rewatch cache (2026-09-14); that path has
  // its own tests, so here it is a no-op spy — without it the call throws into
  // the tick's catch and every chain assertion silently passes on empty.
  const cached = []
  const ctx = { _videoSession: { streamer }, _maybeCacheCurrentFile: s => cached.push(s) }
  vm.createContext(ctx)
  const start = MAIN.indexOf('const PACK_CHAIN_TICK_MS')
  const end = MAIN.indexOf('\n}', MAIN.indexOf('function _maybeChainPackDownloads()')) + 2
  vm.runInContext(MAIN.slice(start, end), ctx)
  return { ctx, calls, cached }
}

const F = (index, current) => ({ index, current: !!current })
const complete = { total: 100, downloaded: 100 }
const partial = { total: 100, downloaded: 40 }

test('a complete current episode chains the next incomplete one, in pack order', () => {
  const { ctx, calls } = harness({
    files: [F(0), F(1, true), F(2), F(3)],
    infos: { 1: complete, 2: complete, 3: partial },
  })
  ctx._maybeChainPackDownloads()
  assert.deepStrictEqual(calls, [3], 'episode 2 is already done, so episode 3 is pulled')
})

test('nothing chains while the playing episode is still arriving', () => {
  const { ctx, calls } = harness({ files: [F(0, true), F(1)], infos: { 0: partial, 1: partial } })
  ctx._maybeChainPackDownloads()
  assert.deepStrictEqual(calls, [])
})

test('a running user download is respected; a finished one is chained past', () => {
  const files = [F(0, true), F(1)]
  const infos = { 0: complete, 1: partial }
  const busy = harness({ files, infos, pd: { index: 5, bytes: 10, total: 100 } })
  busy.ctx._maybeChainPackDownloads()
  assert.deepStrictEqual(busy.calls, [], 'his own download keeps the bandwidth')
  const done = harness({ files, infos, pd: { index: 5, bytes: 100, total: 100 } })
  done.ctx._maybeChainPackDownloads()
  assert.deepStrictEqual(done.calls, [1])
})

test('earlier episodes and single files never chain; the timer lives with the streamer', () => {
  const back = harness({ files: [F(0), F(1, true)], infos: { 0: partial, 1: complete } })
  back.ctx._maybeChainPackDownloads()
  assert.deepStrictEqual(back.calls, [], 'only forward, in watch order')
  const single = harness({ files: [F(0, true)], infos: { 0: complete } })
  single.ctx._maybeChainPackDownloads()
  assert.deepStrictEqual(single.calls, [])
  assert.ok(/packChainTimer = setInterval\(_maybeChainPackDownloads, PACK_CHAIN_TICK_MS\)/.test(MAIN))
  // The timer is cleared inside teardown (the cache/warm sweeps sit above it).
  const td = MAIN.slice(MAIN.indexOf('function _videoTeardown()'), MAIN.indexOf('function _wireVideoEngine'))
  assert.ok(/clearInterval\(_videoSession\.packChainTimer\)/.test(td))
})

// The tick is also where a completed file reaches the rewatch cache, before
// the pack-only guard — a single-file film must get there too.
test('the chain tick offers the current file to the rewatch cache, packs and films alike', () => {
  const pack = harness({ files: [F(0), F(1, true), F(2)], infos: { 1: complete, 2: partial } })
  pack.ctx._maybeChainPackDownloads()
  assert.strictEqual(pack.cached.length, 1, 'offered once per tick')
  const film = harness({ files: [F(0, true)], infos: { 0: complete } })
  film.ctx._maybeChainPackDownloads()
  assert.strictEqual(film.cached.length, 1, 'a single-file torrent is still cached')
  assert.deepStrictEqual(film.calls, [], 'but nothing to chain')
})
