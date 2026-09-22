'use strict'
// The player used to be given no URL at all until 12 MiB had been downloaded.
//
// serve() fetched the film's first 4 MiB and last 8 MiB and AWAITED both before
// returning the address to play. The caching itself is worth having — three of
// the four requests mpv makes when opening or seeking touch those two regions —
// but paying for it before the picture can start means paying it on every single
// play, and a slow start is the thing being complained about.
//
// Two properties are tested, and the second is the reason the first is safe:
//   * serve() returns without waiting for the warm-up;
//   * a request landing in a region still being fetched JOINS that fetch rather
//     than asking the origin for the same bytes a second time. Without this,
//     handing the URL over early would simply have doubled the request count
//     against servers that start refusing everything when their connections
//     pile up.

const test = require('node:test')
const assert = require('node:assert')
const { createDebridProxy } = require('../src/debrid-proxy')

const TOTAL = 32 * 1024 * 1024
const FIXTURE = Buffer.alloc(TOTAL)
for (let i = 0; i < TOTAL; i += 5) FIXTURE[i] = (i / 5) % 251

// An origin whose every body takes `delayMs` to arrive, so "did this wait?" is
// a question about measured time rather than about promise scheduling.
function slowOrigin(delayMs, log) {
  return async (url, init) => {
    if (init && init.method === 'HEAD') {
      return { ok: true, status: 200, headers: { get: k => (k === 'content-length' ? String(TOTAL) : null) } }
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec((init && init.headers && init.headers.Range) || '')
    if (!m) return { ok: false, status: 400, headers: { get: () => null } }
    const start = Number(m[1]); const end = Number(m[2])
    log.push([start, end])
    await new Promise(r => setTimeout(r, delayMs))
    return {
      ok: true, status: 206, body: null,
      arrayBuffer: async () => FIXTURE.subarray(start, end + 1),
      headers: { get: k => (k === 'content-range' ? `bytes ${start}-${end}/${TOTAL}` : null) },
    }
  }
}

const DELAY = 400

test('serve() returns the address without waiting for the warm-up', async () => {
  const log = []
  const proxy = createDebridProxy({ fetchFn: slowOrigin(DELAY, log) })
  try {
    const t0 = Date.now()
    const local = await proxy.serve('https://rd.example/film.mkv')
    const took = Date.now() - t0
    assert.ok(/^http:\/\/127\.0\.0\.1:\d+\/stream$/.test(local), local)
    // The warm-up is two bodies at DELAY each. Awaiting either would put this
    // over DELAY; the generous bound is so a loaded machine cannot fail it
    // spuriously while still being nowhere near "waited for a body".
    assert.ok(took < DELAY, 'serve() took ' + took + 'ms; a single body takes ' + DELAY + 'ms')
    await proxy._warmed()
  } finally { proxy.stop() }
})

test('the warm-up still fills the cache, just not on the critical path', async () => {
  const log = []
  const proxy = createDebridProxy({ fetchFn: slowOrigin(50, log) })
  try {
    await proxy.serve('https://rd.example/film.mkv')
    await proxy._warmed()
    const cached = proxy._cached()
    assert.ok(cached.head > 0 && cached.tail > 0, 'both ends held: ' + JSON.stringify(cached))
  } finally { proxy.stop() }
})

test('a read inside a region being fetched joins it instead of asking twice', async () => {
  const log = []
  const proxy = createDebridProxy({ fetchFn: slowOrigin(300, log) })
  try {
    const local = await proxy.serve('https://rd.example/film.mkv')
    const afterWarmStarted = log.length
    assert.ok(afterWarmStarted >= 1, 'the warm-up has asked for something')

    // The opening of the file, which is exactly what the head fill is fetching
    // and exactly what mpv reads first. Deliberately NOT awaiting _warmed first:
    // the whole point is what happens while the fill is still in flight.
    const res = await fetch(local, { headers: { Range: 'bytes=0-4095' } })
    assert.strictEqual(res.status, 206)
    const got = Buffer.from(await res.arrayBuffer())
    assert.ok(got.equals(FIXTURE.subarray(0, 4096)), 'the right bytes, from the joined fetch')
    assert.strictEqual(log.length, afterWarmStarted,
      'asked the origin again for bytes it was already fetching: ' + JSON.stringify(log))
    await proxy._warmed()
  } finally { proxy.stop() }
})

test('a read outside every pending region is not made to wait for the warm-up', async () => {
  const log = []
  const proxy = createDebridProxy({ fetchFn: slowOrigin(250, log) })
  try {
    const local = await proxy.serve('https://rd.example/film.mkv')
    // Between the head (first 4 MiB) and the tail (last 8 MiB): its own fetch,
    // concurrent with theirs, not queued behind them.
    const MID = 12 * 1024 * 1024
    const t0 = Date.now()
    const res = await fetch(local, { headers: { Range: `bytes=${MID}-${MID + 1023}` } })
    const got = Buffer.from(await res.arrayBuffer())
    const took = Date.now() - t0
    assert.ok(got.equals(FIXTURE.subarray(MID, MID + 1024)))
    assert.ok(took < 250 * 2, 'waited ' + took + 'ms, which is more than its own fetch should cost')
    await proxy._warmed()
  } finally { proxy.stop() }
})

test('a warm-up still in flight cannot repopulate a relay that has stopped', async () => {
  const log = []
  const proxy = createDebridProxy({ fetchFn: slowOrigin(200, log) })
  const warmed = (async () => {
    await proxy.serve('https://rd.example/film.mkv')
    const p = proxy._warmed()
    proxy.stop()                       // torn down mid-fill, as a new play does
    await p
  })()
  await warmed
  assert.deepStrictEqual(proxy._cached(), { head: 0, tail: 0 },
    'a fill that landed after stop() wrote into a dead relay')
})
