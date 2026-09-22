'use strict'
// Wrong bytes are worse than no bytes.
//
// The relay asked upstream for `bytes=START-END`, accepted ANY 200 or 206 in
// reply, and had already written its own `Content-Range: bytes START-END/TOTAL`
// before the body arrived. So an origin that ignored the Range header — which
// these servers do, intermittently, and which is the documented reason this
// relay exists at all — handed back byte zero onwards and the player was told
// it was receiving the offset it had asked for. Seek to the middle of a film,
// watch the opening titles, with nothing anywhere reporting a fault.
//
// Every test here compares the bytes the client received against the fixture,
// through a real socket. "It responded 206" is not the property under test.

const test = require('node:test')
const assert = require('node:assert')
const { createDebridProxy, _rangeAnswerFault } = require('../src/debrid-proxy')

// Past the head cache (4 MiB) with room to spare, so a read from MIDDLE is a
// genuine upstream fetch and has space to run for a full kilobyte without being
// clamped against the end of the file.
const TOTAL = 4 * 1024 * 1024 + 256 * 1024
const FIXTURE = Buffer.alloc(TOTAL)
for (let i = 0; i < TOTAL; i++) FIXTURE[i] = (i * 31 + 7) % 251

// An origin under test control. `mode` decides how it misbehaves.
function origin(mode, log) {
  return async (url, init) => {
    if (init && init.method === 'HEAD') {
      return { ok: true, status: 200, headers: { get: k => (k === 'content-length' ? String(TOTAL) : null) } }
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec((init && init.headers && init.headers.Range) || '')
    if (!m) return { ok: false, status: 400, headers: { get: () => null } }
    const start = Number(m[1]); const end = Number(m[2])
    if (log) log.push([start, end])
    const ok206 = (from, to) => ({
      ok: true, status: 206, body: null,
      arrayBuffer: async () => FIXTURE.subarray(from, to + 1),
      headers: { get: k => (k === 'content-range' ? `bytes ${from}-${to}/${TOTAL}` : null) },
    })
    if (mode === 'honest') return ok206(start, end)
    if (mode === 'ignores-range') {
      // The whole representation, from byte zero, under a 200 — exactly what a
      // server that does not implement Range does.
      return {
        ok: true, status: 200, body: null,
        arrayBuffer: async () => FIXTURE,
        headers: { get: k => (k === 'content-length' ? String(TOTAL) : null) },
      }
    }
    if (mode === 'overlong-206') {
      // Honours where the range STARTS — so it is accepted, correctly — but then
      // streams to the end of the file instead of stopping at the end that was
      // asked for. A real and common origin behaviour, and the one that actually
      // reaches the relay's streaming path.
      let off = start
      return {
        ok: true, status: 206,
        headers: { get: k => (k === 'content-range' ? `bytes ${start}-${end}/${TOTAL}` : null) },
        body: {
          getReader: () => ({
            read: async () => {
              if (off >= TOTAL) return { done: true, value: undefined }
              const next = Math.min(TOTAL, off + 64 * 1024)
              const chunk = FIXTURE.subarray(off, next)
              off = next
              if (log) log.pulled = (log.pulled || 0) + chunk.length
              return { done: false, value: chunk }
            },
            cancel: async () => {},
          }),
        },
      }
    }
    if (mode === 'streams-whole-file') {
      // A STREAMED full body, so the relay takes its reader path rather than the
      // arrayBuffer one. Both have to stop at the length they promised.
      let off = 0
      return {
        ok: true, status: 200,
        headers: { get: k => (k === 'content-length' ? String(TOTAL) : null) },
        body: {
          getReader: () => ({
            read: async () => {
              if (off >= TOTAL) return { done: true, value: undefined }
              const next = Math.min(TOTAL, off + 64 * 1024)
              const chunk = FIXTURE.subarray(off, next)
              off = next
              return { done: false, value: chunk }
            },
            cancel: async () => {},
          }),
        },
      }
    }
    if (mode === 'lies-in-content-range') {
      // A 206, but the bytes (and the header) are from byte zero regardless of
      // what was asked. The subtler half of the same defect.
      return ok206(0, end - start)
    }
    throw new Error('unknown origin mode ' + mode)
  }
}

async function withRelay(mode, fn) {
  const log = []
  const proxy = createDebridProxy({ fetchFn: origin(mode, log) })
  try {
    const local = await proxy.serve('https://rd.example/film.mkv')
    return await fn(local, proxy, log)
  } finally { proxy.stop() }
}

const MIDDLE = 4 * 1024 * 1024 + 100    // past the head cache
const SPAN = 512

test('an honest origin still delivers exactly the requested bytes', async () => {
  await withRelay('honest', async local => {
    const res = await fetch(local, { headers: { Range: `bytes=${MIDDLE}-${MIDDLE + SPAN - 1}` } })
    assert.strictEqual(res.status, 206)
    assert.strictEqual(res.headers.get('content-range'), `bytes ${MIDDLE}-${MIDDLE + SPAN - 1}/${TOTAL}`)
    const got = Buffer.from(await res.arrayBuffer())
    assert.ok(got.equals(FIXTURE.subarray(MIDDLE, MIDDLE + SPAN)), 'byte-for-byte')
  })
})

// Three answers are acceptable when the origin will not honour a range: a
// refusal status, a destroyed connection (which is how this relay reports a
// failure that arrives after its headers are already out — mpv sees the error at
// once instead of hanging on a Content-Length that will never be reached), or a
// 206 that really does carry the bytes it names. What is NOT acceptable is a 206
// carrying different bytes from the ones its Content-Range claims.
async function assertNeverMislabelled(local, from, span) {
  let res
  try {
    res = await fetch(local, { headers: { Range: `bytes=${from}-${from + span - 1}` } })
  } catch (e) {
    return 'connection-destroyed'          // a refusal, and a legitimate one
  }
  if (res.status !== 206) {
    try { await res.arrayBuffer() } catch (_) {}
    return 'status-' + res.status
  }
  let got
  try { got = Buffer.from(await res.arrayBuffer()) } catch (_) { return 'body-destroyed' }
  assert.ok(!got.equals(FIXTURE.subarray(0, span)),
    'the relay served the START of the file under a Content-Range naming byte ' + from)
  assert.ok(got.equals(FIXTURE.subarray(from, from + span)),
    'a 206 must carry the bytes its Content-Range names')
  return 'honest-206'
}

test('an origin that ignores Range cannot have byte zero relabelled as a seek', async () => {
  await withRelay('ignores-range', async local => {
    const how = await assertNeverMislabelled(local, MIDDLE, SPAN)
    assert.notStrictEqual(how, 'honest-206', 'this origin cannot honestly answer a mid-file range')
  })
})

test('a 206 whose Content-Range disagrees with the request is refused', async () => {
  await withRelay('lies-in-content-range', async local => {
    const how = await assertNeverMislabelled(local, MIDDLE, SPAN)
    assert.notStrictEqual(how, 'honest-206')
  })
})

// The head/tail warm-up reads a bounded window. It used to read it with
// arrayBuffer(), which reads whatever the origin decides to send — so the same
// range-ignoring origin above would have had the relay hold the entire file in
// memory. At 12 GB that is not a slow cache, it is a dead process.
test('the cache never holds more than the window it asked for', async () => {
  await withRelay('ignores-range', async (local, proxy) => {
    const cached = proxy._cached()
    assert.ok(cached.head <= 4 * 1024 * 1024, 'head window exceeded: ' + cached.head)
    assert.ok(cached.tail <= 8 * 1024 * 1024, 'tail window exceeded: ' + cached.tail)
    assert.ok(cached.head + cached.tail <= TOTAL, 'more was held than the file contains')
  })
})

// Node's own http server truncates a body at the Content-Length it was given, so
// the CLIENT is never sent too much either way. What the relay's own limit buys
// is upstream: without it the reader keeps pulling the rest of the file — every
// byte of it paid for, then thrown away — and the request is left in a
// content-length mismatch. That is the property measured here.
test('a STREAMED body longer than asked for is not pulled from upstream', async () => {
  await withRelay('overlong-206', async (local, _proxy, log) => {
    // Past the head cache, so this genuinely goes upstream and takes the reader
    // path. The origin answers from the right offset but keeps going to the end
    // of the file.
    // Everything the head/tail warm-up already pulled is not this request's.
    const before = log.pulled || 0
    const res = await fetch(local, { headers: { Range: `bytes=${MIDDLE}-${MIDDLE + 1023}` } })
    assert.strictEqual(res.status, 206)
    assert.strictEqual(res.headers.get('content-length'), '1024')
    const got = Buffer.from(await res.arrayBuffer())
    assert.strictEqual(got.length, 1024, 'the client gets exactly what was promised')
    assert.ok(got.equals(FIXTURE.subarray(MIDDLE, MIDDLE + 1024)), 'and the right bytes')
    const pulled = (log.pulled || 0) - before
    // One 64 KiB chunk is the smallest this origin can deliver, so that is the
    // floor. Reading the whole remainder of the file would mean the limit is gone.
    assert.ok(pulled <= 64 * 1024, 'pulled ' + pulled + ' bytes upstream to serve 1024')
  })
})

test('a body longer than the declared length does not overrun it', async () => {
  await withRelay('ignores-range', async local => {
    // Asked from byte zero, so the origin's full-body answer IS honest here —
    // the bytes are right — but it is far longer than the declared length.
    const res = await fetch(local, { headers: { Range: 'bytes=0-1023' } })
    assert.strictEqual(res.headers.get('content-length'), '1024')
    const got = Buffer.from(await res.arrayBuffer())
    assert.strictEqual(got.length, 1024, 'the body must match the Content-Length it promised')
    assert.ok(got.equals(FIXTURE.subarray(0, 1024)))
  })
})

// The pure rule, stated directly.
test('the range-answer check names each way an answer can be wrong', () => {
  const h = v => ({ get: k => (v[k] === undefined ? null : v[k]) })
  assert.strictEqual(_rangeAnswerFault({ status: 200, headers: h({}) }, 0), null,
    'a full body IS the representation from byte zero')
  assert.ok(_rangeAnswerFault({ status: 200, headers: h({}) }, 500),
    'a full body is not a range starting at 500')
  assert.strictEqual(
    _rangeAnswerFault({ status: 206, headers: h({ 'content-range': 'bytes 500-999/100000' }) }, 500), null)
  assert.ok(_rangeAnswerFault({ status: 206, headers: h({ 'content-range': 'bytes 0-499/100000' }) }, 500),
    'a 206 that starts somewhere else is the whole defect')
  assert.ok(_rangeAnswerFault({ status: 206, headers: h({}) }, 500),
    'an unverifiable 206 at a nonzero offset cannot be trusted')
  assert.strictEqual(_rangeAnswerFault({ status: 206, headers: h({}) }, 0), null,
    'at byte zero there is nothing it could be wrong about')
})
