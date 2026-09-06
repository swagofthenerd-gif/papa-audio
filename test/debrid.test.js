'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { createDebrid, infoHashOf, DebridError } = require('../src/debrid')

// A fake fetch that answers a scripted sequence of {ok,status,body} by matching
// the request URL against a route table. Records every call so a test can assert
// the flow order. Each route may be a function (dynamic) or a fixed response.
function makeFetch(routes) {
  const calls = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, method: (init && init.method) || 'GET', body: init && init.body })
      for (const [pattern, resp] of routes) {
        if (url.includes(pattern)) {
          const r = typeof resp === 'function' ? resp(url, init, calls) : resp
          return {
            ok: r.ok !== false,
            status: r.status || (r.ok === false ? 500 : 200),
            text: async () => (r.body == null ? '' : (typeof r.body === 'string' ? r.body : JSON.stringify(r.body))),
          }
        }
      }
      throw new Error('no route for ' + url)
    },
  }
}

const MAGNET = 'magnet:?xt=urn:btih:ABCDEF0123456789&dn=Some.Movie.1080p'

test('infoHashOf pulls the lower-cased btih out of a magnet', () => {
  assert.strictEqual(infoHashOf(MAGNET), 'abcdef0123456789')
  assert.strictEqual(infoHashOf('not a magnet'), '')
  assert.strictEqual(infoHashOf(null), '')
})

test('resolveMagnet walks add → select → poll → unrestrict to a direct URL', async () => {
  let polls = 0
  const { fetch, calls } = makeFetch([
    ['/torrents/addMagnet', { body: { id: 'T1' } }],
    ['/torrents/selectFiles/', { status: 204 }],
    ['/torrents/info/', () => {
      polls++
      // First poll is still downloading; the second is done. This proves the
      // poll loop actually loops rather than accepting the first status.
      if (polls < 2) return { body: { status: 'downloading', files: [], links: [] } }
      return {
        body: {
          status: 'downloaded',
          files: [
            { id: 1, path: '/Some.Movie.1080p.mkv', bytes: 2_000_000_000, selected: 1 },
            { id: 2, path: '/sample.mkv', bytes: 10_000_000, selected: 1 },
          ],
          links: ['https://rd/d/BIG', 'https://rd/d/SAMPLE'],
        },
      }
    }],
    ['/unrestrict/link', { body: { download: 'https://cdn.real-debrid.com/d/direct.mkv' } }],
  ])
  const d = createDebrid({ token: 'tok', fetchFn: fetch, sleep: async () => {}, pollIntervalMs: 1 })
  const url = await d.resolveMagnet(MAGNET)
  assert.strictEqual(url, 'https://cdn.real-debrid.com/d/direct.mkv')
  // The largest video file (the movie, not the sample) drove the link choice.
  const unrestrict = calls.find(c => c.url.includes('/unrestrict/link'))
  assert.match(String(unrestrict.body), /BIG/)
  assert.ok(polls >= 2, 'the info endpoint must have been polled until downloaded')
})

test('a resolved magnet is cached for the session', async () => {
  let adds = 0
  const { fetch } = makeFetch([
    ['/torrents/addMagnet', () => { adds++; return { body: { id: 'T1' } } }],
    ['/torrents/selectFiles/', { status: 204 }],
    ['/torrents/info/', { body: { status: 'downloaded', files: [{ id: 1, path: '/m.mkv', bytes: 1, selected: 1 }], links: ['https://rd/d/L'] } }],
    ['/unrestrict/link', { body: { download: 'https://cdn/x.mkv' } }],
  ])
  const d = createDebrid({ token: 'tok', fetchFn: fetch, sleep: async () => {} })
  await d.resolveMagnet(MAGNET)
  await d.resolveMagnet(MAGNET)
  assert.strictEqual(adds, 1, 'the second resolve must be served from the session cache')
  assert.strictEqual(d._cacheSize(), 1)
})

test('a terminal RD status fails fast rather than polling to the timeout', async () => {
  let polls = 0
  const { fetch } = makeFetch([
    ['/torrents/addMagnet', { body: { id: 'T1' } }],
    ['/torrents/selectFiles/', { status: 204 }],
    ['/torrents/info/', () => { polls++; return { body: { status: 'magnet_error', files: [], links: [] } } }],
  ])
  const d = createDebrid({ token: 'tok', fetchFn: fetch, sleep: async () => {}, pollIntervalMs: 1 })
  await assert.rejects(() => d.resolveMagnet(MAGNET), /could not fetch this magnet/)
  assert.strictEqual(polls, 1, 'a terminal status must not be polled again')
})

test('the poll gives up at the timeout — the caller falls back to P2P on this', async () => {
  // Never-downloaded status, and a clock the test advances past the deadline so
  // the timeout branch is exercised deterministically without real waiting.
  let t = 1000
  const { fetch } = makeFetch([
    ['/torrents/addMagnet', { body: { id: 'T1' } }],
    ['/torrents/selectFiles/', { status: 204 }],
    ['/torrents/info/', { body: { status: 'downloading', files: [], links: [] } }],
  ])
  const d = createDebrid({
    token: 'tok', fetchFn: fetch,
    now: () => t,
    sleep: async () => { t += 2000 }, // each poll wait advances the clock
    pollTimeoutMs: 3000, pollIntervalMs: 1,
  })
  await assert.rejects(() => d.resolveMagnet(MAGNET), e => e instanceof DebridError && e.code === 'TIMEOUT')
})

test('a magnet with no video file is a clean failure, not a wrong pick', async () => {
  const { fetch } = makeFetch([
    ['/torrents/addMagnet', { body: { id: 'T1' } }],
    ['/torrents/selectFiles/', { status: 204 }],
    ['/torrents/info/', { body: { status: 'downloaded', files: [{ id: 1, path: '/readme.txt', bytes: 100, selected: 1 }], links: ['https://rd/d/L'] } }],
  ])
  const d = createDebrid({ token: 'tok', fetchFn: fetch, sleep: async () => {} })
  await assert.rejects(() => d.resolveMagnet(MAGNET), /no video file/)
})

test('a 401 is reported as a bad token, distinct from RD being down', async () => {
  const { fetch } = makeFetch([
    ['/torrents/addMagnet', { ok: false, status: 401, body: 'bad token' }],
  ])
  const d = createDebrid({ token: 'nope', fetchFn: fetch, sleep: async () => {} })
  await assert.rejects(() => d.resolveMagnet(MAGNET), e => e instanceof DebridError && e.code === 'BAD_TOKEN')
})

test('no token throws before any request goes out', async () => {
  const { fetch, calls } = makeFetch([])
  const d = createDebrid({ token: '', fetchFn: fetch })
  await assert.rejects(() => d.resolveMagnet(MAGNET), e => e.code === 'NO_TOKEN')
  assert.strictEqual(calls.length, 0)
})

test('check() reports premium status and expiry, and never throws', async () => {
  const { fetch } = makeFetch([
    ['/user', { body: { type: 'premium', premium: 1, expiration: '2027-01-01T00:00:00.000Z' } }],
  ])
  const d = createDebrid({ token: 'tok', fetchFn: fetch })
  const r = await d.check()
  assert.deepStrictEqual(r, { configured: true, ok: true, premiumUntil: '2027-01-01T00:00:00.000Z' })

  const down = createDebrid({ token: 'tok', fetchFn: makeFetch([['/user', { ok: false, status: 503 }]]).fetch })
  const r2 = await down.check()
  assert.strictEqual(r2.ok, false)
  assert.strictEqual(r2.configured, true)

  const bare = createDebrid({ token: '', fetchFn: fetch })
  assert.deepStrictEqual(await bare.check(), { configured: false, ok: false })
})

test('pickVideoFile prefers the largest selected video', () => {
  const d = createDebrid({ token: 't' })
  const pick = d._pickVideoFile([
    { id: 1, path: '/a.mkv', bytes: 100, selected: 1 },
    { id: 2, path: '/b.mkv', bytes: 900, selected: 1 },
    { id: 3, path: '/c.mkv', bytes: 9000, selected: 0 }, // bigger but not selected
    { id: 4, path: '/notes.txt', bytes: 99999, selected: 1 },
  ])
  assert.strictEqual(pick.id, 2)
})
