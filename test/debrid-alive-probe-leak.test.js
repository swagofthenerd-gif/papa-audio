'use strict'
// _alive() probes a link with `Range: bytes=0-0` and reads only the status. A
// server that ignores the range answers 200 and starts sending the whole film
// — and nothing here ever read or cancelled that body, so the socket stayed
// open until the fetch shim's own deadline killed it twenty seconds later. One
// held connection per candidate probed, against servers that start refusing
// everything once connections pile up.
const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const { createDebrid } = require('../src/debrid')

const MAGNET = 'magnet:?xt=urn:btih:ABCDEF0123456789&dn=Film'

function probeFetch(record) {
  return async (url, init) => {
    if (String(url).startsWith('http://alive/')) {
      record.probes++
      return {
        ok: true,
        status: record.status,
        headers: { get: () => null },
        body: {
          cancel: async () => { record.cancelled++ },
        },
        text: async () => { record.drained++; return '' },
      }
    }
    // The resolve flow, minimal.
    const body = url.includes('/torrents/info/')
      ? { status: 'downloaded', files: [{ id: 1, path: '/Film.mkv', bytes: 9, selected: 1 }], links: ['https://rd/d/L'] }
      : url.includes('/unrestrict/link') ? { download: 'http://alive/film.mkv' } : { id: 'T1' }
    return { ok: true, status: url.includes('selectFiles') ? 204 : 200, text: async () => JSON.stringify(body) }
  }
}

for (const status of [200, 206]) {
  test(`a ${status} to the liveness probe has its body let go`, async () => {
    const record = { probes: 0, cancelled: 0, drained: 0, status }
    const d = createDebrid({ token: 'tok', fetchFn: probeFetch(record), sleep: async () => {}, pollIntervalMs: 1 })
    const url = await d.linkFor(MAGNET)
    assert.strictEqual(url, 'http://alive/film.mkv')
    assert.ok(record.probes >= 1, 'the probe ran')
    assert.strictEqual(record.cancelled, record.probes,
      'every probed body must be released, or the socket is held for 20 s')
  })
}

test('a refused probe releases its body too', async () => {
  const record = { probes: 0, cancelled: 0, drained: 0, status: 404 }
  const d = createDebrid({ token: 'tok', fetchFn: probeFetch(record), sleep: async () => {}, pollIntervalMs: 1 })
  await assert.rejects(() => d.linkFor(MAGNET))
  assert.ok(record.probes >= 1)
  assert.strictEqual(record.cancelled, record.probes, 'an error body is a held socket as well')
})

// Against a real socket: the server counts connections and how many close.
test('the probe does not hold a real connection open', async () => {
  let open = 0
  let closed = 0
  const server = http.createServer((req, res) => {
    open++
    res.socket.once('close', () => { closed++ })
    // Ignores the range and starts sending a large body, as these servers do.
    res.writeHead(200, { 'Content-Type': 'video/x-matroska' })
    res.write(Buffer.alloc(64 * 1024, 1))
    // Deliberately never ends.
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const { nodeFetch } = require('../src/node-fetch-shim')
  try {
    const d = createDebrid({
      token: 'tok', sleep: async () => {}, pollIntervalMs: 1,
      fetchFn: async (url, init) => {
        if (String(url).includes('127.0.0.1')) return nodeFetch(url, Object.assign({ timeoutMs: 20000 }, init))
        const body = url.includes('/torrents/info/')
          ? { status: 'downloaded', files: [{ id: 1, path: '/Film.mkv', bytes: 9, selected: 1 }], links: ['https://rd/d/L'] }
          : url.includes('/unrestrict/link') ? { download: `http://127.0.0.1:${port}/film.mkv` } : { id: 'T1' }
        return { ok: true, status: url.includes('selectFiles') ? 204 : 200, text: async () => JSON.stringify(body) }
      },
    })
    await d.linkFor(MAGNET)
    for (let i = 0; i < 100 && closed < open; i++) await new Promise(r => setTimeout(r, 10))
    assert.ok(open >= 1, 'the probe reached the server')
    assert.strictEqual(closed, open,
      'the probe connection must be released at once, not held to the 20 s deadline')
  } finally {
    server.close()
  }
})
