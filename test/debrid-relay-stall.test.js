'use strict'
// Two ways the debrid relay left mpv staring at a frozen picture.
//
// 1. A body that failed after the headers were out ended the response short of
//    the Content-Length it had already promised. The player has no way to know
//    the rest is not coming, so it waited — up to thirty seconds.
// 2. The Node fetch shim's deadline is a SOCKET IDLE timeout and stayed armed
//    through the body. mpv fills its cache and stops reading, TCP back-pressure
//    stops the bytes, and a pause longer than the deadline looked exactly like
//    a dead socket — so the shim killed the upstream and the resume froze.
const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const { Readable } = require('node:stream')

const { createDebridProxy } = require('../src/debrid-proxy')
const { nodeFetch } = require('../src/node-fetch-shim')

const TOTAL = 64 * 1024

// A proxy whose upstream body yields one chunk and then errors.
function brokenUpstream(body) {
  return async (url, init) => {
    if (init && init.method === 'HEAD') {
      return { ok: true, status: 200, headers: { get: k => (k === 'content-length' ? String(TOTAL) : null) } }
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec((init && init.headers && init.headers.Range) || '')
    const start = Number(m[1]); const end = Number(m[2])
    // The warm-up slurps use arrayBuffer(); only the streamed read gets the
    // half-broken body, so the failure lands mid-response, after headers.
    if (init && init.stream !== true) {
      return { ok: true, status: 206, body: null,
        arrayBuffer: async () => body.subarray(start, end + 1), headers: { get: () => null } }
    }
    let sent = false
    return {
      ok: true, status: 206, headers: { get: () => null },
      body: {
        getReader() {
          return {
            async read() {
              if (!sent) { sent = true; return { done: false, value: body.subarray(start, start + 1024) } }
              throw new Error('upstream went away mid-body')
            },
            async cancel() {},
          }
        },
      },
    }
  }
}

test('a body that breaks after the headers fails the client at once', async () => {
  const body = Buffer.alloc(TOTAL, 7)
  // No cache warm-up in the way: a small file makes head+tail cover it, so
  // ask for a region past what the cache can hold by disabling the ends.
  const proxy = createDebridProxy({ fetchFn: brokenUpstream(body) })
  const local = await proxy.serve('https://rd.example/film.mkv')
  try {
    const started = Date.now()
    let failed = null
    try {
      const res = await fetch(local, { headers: { Range: `bytes=0-${TOTAL - 1}` } })
      await res.arrayBuffer()
    } catch (e) { failed = e }
    const took = Date.now() - started
    assert.ok(failed, 'the client must see an error, not a response that simply stops')
    assert.ok(took < 2000,
      'the failure must be immediate, not a wait for bytes that are not coming (took ' + took + 'ms)')
  } finally {
    proxy.stop()
  }
})

// The idle-timeout half, against a real socket. The server sends its headers,
// then one chunk, then says nothing at all for longer than the deadline —
// which is precisely a paused player with a full cache.
test('a long pause mid-body does not kill the upstream connection', async () => {
  let hold = null
  const server = http.createServer((req, res) => {
    res.writeHead(206, {
      'Content-Length': '2048',
      'Content-Range': 'bytes 0-2047/2048',
      'Content-Type': 'video/x-matroska',
    })
    res.write(Buffer.alloc(1024, 3))
    hold = res
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    // A deadline short enough to test in reasonable time; the production one
    // is 20 s and the mechanism is identical.
    const res = await nodeFetch(`http://127.0.0.1:${port}/stream`, {
      stream: true, timeoutMs: 300, headers: { Range: 'bytes=0-2047' },
    })
    assert.strictEqual(res.status, 206)
    const reader = res.body.getReader()
    const first = await reader.read()
    assert.strictEqual(first.value.length, 1024, 'the first chunk arrives')

    // Now stall for several times the deadline, as a paused player does.
    await new Promise(r => setTimeout(r, 1200))
    hold.end(Buffer.alloc(1024, 4))

    const second = await reader.read()
    assert.strictEqual(second.done, false,
      'the rest of the body must still arrive — the idle deadline belongs to the request, not the stream')
    assert.strictEqual(second.value.length, 1024)
    await reader.cancel()
  } finally {
    server.close()
  }
})

// The deadline must still apply while waiting for the response itself: a
// server that never answers cannot be allowed to hang the main process.
test('a request that never gets a response still times out', async () => {
  const server = http.createServer(() => { /* never answers */ })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    await assert.rejects(
      nodeFetch(`http://127.0.0.1:${port}/x`, { stream: true, timeoutMs: 250 }),
      /timed out|socket hang up|aborted/i)
  } finally {
    server.close()
  }
})
