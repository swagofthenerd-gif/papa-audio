'use strict'
// Two things the relay got wrong about ranges.
//
// 1. `bytes=150-` of a 100-byte file parsed to null, which _handle read as "no
//    range header at all" — so it answered 206 with `Content-Range: bytes
//    0-99/100`. The player is told it got the range it asked for, and it did
//    not.
// 2. An unsatisfiable or otherwise 4xx range was retried three times with
//    backoff. A 4xx is a settled answer about the request; the retries only
//    bought a second of frozen picture before the same refusal.
const test = require('node:test')
const assert = require('node:assert')
const { createDebridProxy, parseRange, UNSATISFIABLE, UPSTREAM_TRIES } = require('../src/debrid-proxy')

test('a range starting past the end of the file is unsatisfiable, not "no range"', () => {
  assert.strictEqual(parseRange('bytes=150-', 100), UNSATISFIABLE)
  assert.strictEqual(parseRange('bytes=100-', 100), UNSATISFIABLE, 'the first byte past the end')
  assert.strictEqual(parseRange('bytes=150-200', 100), UNSATISFIABLE)
  assert.notStrictEqual(parseRange('bytes=99-', 100), UNSATISFIABLE, 'the last byte is fine')
})

test('a range running past the end is clamped, the way every other server does', () => {
  assert.deepStrictEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 })
})

const TOTAL = 100

function proxyOver(body, onFetch) {
  return createDebridProxy({
    fetchFn: async (url, init) => {
      if (onFetch) onFetch(init)
      if (init && init.method === 'HEAD') {
        return { ok: true, status: 200, headers: { get: k => (k === 'content-length' ? String(TOTAL) : null) } }
      }
      const m = /^bytes=(\d+)-(\d+)$/.exec((init && init.headers && init.headers.Range) || '')
      if (!m) return { ok: false, status: 400, headers: { get: () => null } }
      const start = Number(m[1]); const end = Number(m[2])
      return { ok: true, status: 206, body: null,
        arrayBuffer: async () => body.subarray(start, end + 1), headers: { get: () => null } }
    },
  })
}

test('the relay answers 416 rather than mislabelling a 206', async () => {
  const body = Buffer.alloc(TOTAL, 9)
  const proxy = proxyOver(body)
  const local = await proxy.serve('https://rd.example/small.mkv')
  try {
    const res = await fetch(local, { headers: { Range: 'bytes=150-' } })
    assert.strictEqual(res.status, 416,
      'a range past the end of the file is 416, not a 206 for a different range')
    assert.strictEqual(res.headers.get('content-range'), 'bytes */' + TOTAL,
      'and the answer names the real length so the player can correct itself')
    await res.arrayBuffer()
  } finally {
    proxy.stop()
  }
})

test('a satisfiable range is still served', async () => {
  const body = Buffer.alloc(TOTAL)
  for (let i = 0; i < TOTAL; i++) body[i] = i
  const proxy = proxyOver(body)
  const local = await proxy.serve('https://rd.example/small.mkv')
  try {
    const res = await fetch(local, { headers: { Range: 'bytes=10-19' } })
    assert.strictEqual(res.status, 206)
    assert.strictEqual(res.headers.get('content-range'), 'bytes 10-19/100')
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(body.subarray(10, 20)))
  } finally {
    proxy.stop()
  }
})

test('a 4xx from upstream is final, not retried', async () => {
  let attempts = 0
  const proxy = createDebridProxy({
    fetchFn: async (url, init) => {
      if (init && init.method === 'HEAD') {
        return { ok: true, status: 200, headers: { get: k => (k === 'content-length' ? String(1e9) : null) } }
      }
      attempts++
      return { ok: false, status: 416, headers: { get: () => null } }
    },
  })
  const local = await proxy.serve('https://rd.example/big.mkv')
  try {
    attempts = 0
    // The relay destroys the socket once it has already sent headers, so the
    // client sees the failure immediately — which is the point of that fix and
    // shows up here as a thrown fetch.
    await fetch(local, { headers: { Range: 'bytes=500000000-500000999' } })
      .then(r => r.arrayBuffer()).catch(() => {})
    assert.strictEqual(attempts, 1,
      'a 4xx is a settled answer; ' + UPSTREAM_TRIES + ' tries only froze the picture longer')
  } finally {
    proxy.stop()
  }
})

test('a 5xx is still retried — these servers refuse good ranges intermittently', async () => {
  let attempts = 0
  const proxy = createDebridProxy({
    fetchFn: async (url, init) => {
      if (init && init.method === 'HEAD') {
        return { ok: true, status: 200, headers: { get: k => (k === 'content-length' ? String(1e9) : null) } }
      }
      attempts++
      return { ok: false, status: 503, headers: { get: () => null } }
    },
  })
  const local = await proxy.serve('https://rd.example/big.mkv')
  try {
    // serve() no longer waits for the head/tail warm-up — making the player wait
    // for 12 MiB before it got a URL was the startup cost. Its own retries must
    // finish before this test can start counting, or it counts theirs too.
    await proxy._warmed()
    attempts = 0
    await fetch(local, { headers: { Range: 'bytes=500000000-500000999' } })
      .then(r => r.arrayBuffer()).catch(() => {})
    assert.strictEqual(attempts, UPSTREAM_TRIES, 'a 503 gets every try it is allowed')
  } finally {
    proxy.stop()
  }
})
