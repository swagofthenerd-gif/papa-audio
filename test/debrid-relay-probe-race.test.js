'use strict'
// The size probe asks the same question two ways ON PURPOSE, because RealDebrid's
// download servers refuse about two requests in five: a HEAD and a one-byte range,
// at the same time, so a refusal of one costs nothing. The comment above it said
// "whichever answers first wins."
//
// It used Promise.allSettled, which waits for BOTH to settle. So a range probe
// that came back in 200 ms sat behind a HEAD that had not answered at all — and
// a HEAD that never answers does not settle until the fetch itself times out.
// The point of asking twice is being able to ignore the slow one.

const test = require('node:test')
const assert = require('node:assert')
const { createDebridProxy } = require('../src/debrid-proxy')

const TOTAL = 9_000_000

function hdrs(map) { return { get: k => (map[k] === undefined ? null : map[k]) } }

// `head` and `range` each describe how that probe behaves.
function probeOrigin({ head, range }, seen) {
  return async (url, init) => {
    const isHead = !!(init && init.method === 'HEAD')
    const spec = isHead ? head : range
    if (seen) seen.push(isHead ? 'HEAD' : 'RANGE')
    const signal = init && init.signal
    if (spec.afterMs) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, spec.afterMs)
        if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) })
      })
    }
    if (spec.never) {
      // Answers only when aborted — a hung request, which is the case that used
      // to hold the whole probe up.
      await new Promise((_r, reject) => {
        if (signal) signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }
    if (spec.fail) return { ok: false, status: spec.fail, headers: hdrs({}) }
    if (isHead) return { ok: true, status: 200, headers: hdrs({ 'content-length': String(TOTAL) }) }
    return {
      ok: true, status: 206, body: null, arrayBuffer: async () => Buffer.alloc(1),
      headers: hdrs({ 'content-range': `bytes 0-0/${TOTAL}` }),
    }
  }
}

async function probed(spec, seen) {
  const proxy = createDebridProxy({ fetchFn: probeOrigin(spec, seen) })
  try {
    const t0 = Date.now()
    await proxy.serve('https://rd.example/film.mkv')
    return { total: proxy._total(), ms: Date.now() - t0 }
  } finally { proxy.stop() }
}

test('a fast range probe is not held up by a HEAD that never answers', async () => {
  const seen = []
  const { total, ms } = await probed({ head: { never: true }, range: { afterMs: 50 } }, seen)
  assert.strictEqual(total, TOTAL, 'the size came from the probe that answered')
  assert.ok(seen.includes('HEAD') && seen.includes('RANGE'), 'both were asked: ' + seen)
  // A hung HEAD settles only when the fetch times out, which is many seconds.
  assert.ok(ms < 2000, 'the probe took ' + ms + 'ms waiting for an answer nobody needed')
})

test('a fast HEAD is not held up by a range probe that never answers', async () => {
  const { total, ms } = await probed({ head: { afterMs: 50 }, range: { never: true } })
  assert.strictEqual(total, TOTAL)
  assert.ok(ms < 2000, 'took ' + ms + 'ms')
})

test('a fast FAILURE does not beat a slower real answer', async () => {
  // This is why it cannot simply be Promise.any-on-first-settle: the HEAD refuses
  // instantly, and an instant refusal must not be allowed to end the probe.
  const { total } = await probed({ head: { fail: 503 }, range: { afterMs: 120 } })
  assert.strictEqual(total, TOTAL, 'the slower probe that actually answered is the answer')
})

test('a HEAD that succeeds with no length is not a usable answer', async () => {
  // 200 with no Content-Length is a "success" carrying nothing. It must lose to
  // the range probe rather than ending the race.
  const proxy = createDebridProxy({
    fetchFn: async (url, init) => {
      if (init && init.method === 'HEAD') return { ok: true, status: 200, headers: hdrs({}) }
      await new Promise(r => setTimeout(r, 80))
      return {
        ok: true, status: 206, body: null, arrayBuffer: async () => Buffer.alloc(1),
        headers: hdrs({ 'content-range': `bytes 0-0/${TOTAL}` }),
      }
    },
  })
  try {
    await proxy.serve('https://rd.example/film.mkv')
    assert.strictEqual(proxy._total(), TOTAL)
  } finally { proxy.stop() }
})

test('a probe that reports a size of zero is not a usable answer either', async () => {
  // A 206 whose Content-Range ends in "/0" parses cleanly and resolves — it is a
  // successful answer carrying a useless number, which is what an error page
  // served under a 206 looks like. Accepting it would set the file's length to
  // zero, and then every range the player asks for is unsatisfiable. It has to
  // lose to the HEAD that knows the real length.
  const proxy = createDebridProxy({
    fetchFn: async (url, init) => {
      if (init && init.method === 'HEAD') {
        await new Promise(r => setTimeout(r, 80))
        return { ok: true, status: 200, headers: hdrs({ 'content-length': String(TOTAL) }) }
      }
      return {
        ok: true, status: 206, body: null, arrayBuffer: async () => Buffer.alloc(1),
        headers: hdrs({ 'content-range': 'bytes 0-0/0' }),
      }
    },
  })
  try {
    await proxy.serve('https://rd.example/film.mkv')
    assert.strictEqual(proxy._total(), TOTAL, 'a size of zero won the race')
  } finally { proxy.stop() }
})

test('when neither probe can answer, the relay says so rather than guessing', async () => {
  const proxy = createDebridProxy({ fetchFn: probeOrigin({ head: { fail: 503 }, range: { fail: 503 } }) })
  try {
    await assert.rejects(
      () => proxy.serve('https://rd.example/film.mkv'),
      /would not report the file size/)
  } finally { proxy.stop() }
})

test('the losing probe is abandoned, not left holding a connection', async () => {
  let aborted = false
  const proxy = createDebridProxy({
    fetchFn: async (url, init) => {
      if (init && init.method === 'HEAD') {
        const signal = init.signal
        await new Promise((_r, reject) => {
          if (!signal) return
          signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })
        })
      }
      return {
        ok: true, status: 206, body: null, arrayBuffer: async () => Buffer.alloc(1),
        headers: hdrs({ 'content-range': `bytes 0-0/${TOTAL}` }),
      }
    },
  })
  try {
    await proxy.serve('https://rd.example/film.mkv')
    await new Promise(r => setImmediate(r))
    assert.ok(aborted, 'a probe nobody is waiting for must be cancelled — leaked ' +
      'connections are what make these servers start refusing everything')
  } finally { proxy.stop() }
})
