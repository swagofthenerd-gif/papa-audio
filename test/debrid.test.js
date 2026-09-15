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

// ---------------------------------------------------------------------------
// Season packs served by RealDebrid (2026-09-16).
//
// Two bugs lived here. The debrid path picked "the largest video file, full
// stop", so a pack handed back an arbitrary episode while the torrent path —
// using the same release — picked the right one. And it never built a file
// list at all, so the episode strip that works for peer-served packs simply
// never appeared for anyone with a debrid account, and switching episodes
// answered "Nothing is streaming" while something was plainly streaming.
//
// These run the real functions against a fake RealDebrid rather than checking
// that the source mentions them.

const PACK_MAGNET = 'magnet:?xt=urn:btih:FEEDFACE0000AAAA&dn=Show.S01.1080p'

// A twelve-episode pack where episode 9 is NOT the largest file, so "largest
// wins" and "the episode asked for" give different answers.
function packFilesFixture() {
  const files = []
  for (let n = 1; n <= 12; n++) {
    files.push({
      id: n,
      path: '/Show S01/Show - ' + String(n).padStart(2, '0') + ' [1080p].mkv',
      bytes: n === 4 ? 9e9 : 1e9 + n,
      selected: 1,
    })
  }
  // The junk a real pack carries, which must never be offered as an episode.
  files.push({ id: 90, path: '/Show S01/Sample/sample.mkv', bytes: 5e6, selected: 1 })
  files.push({ id: 91, path: '/Show S01/Show - NCED1.mkv', bytes: 6e7, selected: 1 })
  files.push({ id: 92, path: '/Show S01/readme.nfo', bytes: 1e3, selected: 1 })
  return files
}

function packRoutes() {
  const files = packFilesFixture()
  // RD's links are in the order of the SELECTED files.
  const links = files.map(f => 'https://real-debrid.com/d/FILE' + f.id)
  return [
    ['/torrents/addMagnet', { body: { id: 'pack1' } }],
    ['/torrents/selectFiles/', { status: 204 }],
    ['/torrents/info/', { body: { status: 'downloaded', files, links } }],
    ['/unrestrict/link', (url, init) => {
      const link = decodeURIComponent(String(init.body).replace(/^link=/, ''))
      return { body: { download: link.replace('real-debrid.com/d/', 'cdn.example/') } }
    }],
    ['/torrents/delete/', { status: 204 }],
    // _alive() proves a link before it is handed over.
    ['cdn.example/', { status: 206 }],
  ]
}

test('a pack resolves the episode that was asked for, not the biggest file', async () => {
  const { fetch } = makeFetch(packRoutes())
  const d = createDebrid({ token: 't', fetchFn: fetch })
  // Episode 4 is the largest file; asking for 9 must still get 9.
  const url = await d.linkFor(PACK_MAGNET, { season: 1, episode: 9 })
  assert.strictEqual(url, 'https://cdn.example/FILE9')
})

test('the same pack serves a different episode without re-registering the magnet', async () => {
  const { fetch, calls } = makeFetch(packRoutes())
  const d = createDebrid({ token: 't', fetchFn: fetch })
  await d.linkFor(PACK_MAGNET, { season: 1, episode: 9 })
  const addsAfterFirst = calls.filter(c => c.url.includes('/torrents/addMagnet')).length
  const second = await d.linkFor(PACK_MAGNET, { season: 1, episode: 3 })
  assert.strictEqual(second, 'https://cdn.example/FILE3')
  // The whole add/select/poll flow must not run again: the file list from the
  // first resolve already answers this.
  assert.strictEqual(calls.filter(c => c.url.includes('/torrents/addMagnet')).length, addsAfterFirst)
})

test('one episode is never handed back for another (the cache is per file)', async () => {
  const { fetch } = makeFetch(packRoutes())
  const d = createDebrid({ token: 't', fetchFn: fetch })
  const nine = await d.linkFor(PACK_MAGNET, { season: 1, episode: 9 })
  const three = await d.linkFor(PACK_MAGNET, { season: 1, episode: 3 })
  assert.notStrictEqual(nine, three)
  // And asking again for 9 still gets 9, not whatever was resolved last.
  assert.strictEqual(await d.linkFor(PACK_MAGNET, { season: 1, episode: 9 }), nine)
})

test('packFiles lists every episode, in order, with the junk left out', async () => {
  const { fetch } = makeFetch(packRoutes())
  const d = createDebrid({ token: 't', fetchFn: fetch })
  const files = await d.packFiles(PACK_MAGNET, { season: 1, episode: 9 })
  assert.strictEqual(files.length, 12, 'twelve episodes, no sample, no NCED, no .nfo')
  assert.deepStrictEqual(files.map(f => f.episode), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  // The strip highlights what is playing, and takes `index` back as the handle.
  const current = files.filter(f => f.current)
  assert.strictEqual(current.length, 1)
  assert.strictEqual(current[0].episode, 9)
  assert.strictEqual(current[0].index, 9)
  // Every field the strip actually reads must be present.
  for (const f of files) {
    assert.ok(typeof f.index === 'number' && Number.isFinite(f.index))
    assert.ok(typeof f.name === 'string' && f.name)
    assert.ok(typeof f.group === 'string')
    assert.ok(f.episode == null || typeof f.episode === 'number')
  }
})

test('linkForFile resolves one named file of a pack, for the episode switch', async () => {
  const { fetch } = makeFetch(packRoutes())
  const d = createDebrid({ token: 't', fetchFn: fetch })
  await d.linkFor(PACK_MAGNET, { season: 1, episode: 1 })
  assert.strictEqual(await d.linkForFile(PACK_MAGNET, 7), 'https://cdn.example/FILE7')
  await assert.rejects(() => d.linkForFile(PACK_MAGNET, 9999), /no such file/i)
})

test('a single-file release is unaffected by the episode matcher', async () => {
  const files = [{ id: 1, path: '/Some.Movie.1080p.mkv', bytes: 8e9, selected: 1 }]
  const { fetch } = makeFetch([
    ['/torrents/addMagnet', { body: { id: 'm1' } }],
    ['/torrents/selectFiles/', { status: 204 }],
    ['/torrents/info/', { body: { status: 'downloaded', files, links: ['https://real-debrid.com/d/ONLY'] } }],
    ['/unrestrict/link', { body: { download: 'https://cdn.example/ONLY' } }],
    ['/torrents/delete/', { status: 204 }],
    ['cdn.example/', { status: 206 }],
  ])
  const d = createDebrid({ token: 't', fetchFn: fetch })
  // Asking for an episode of something that holds one file still plays it.
  assert.strictEqual(await d.linkFor(MAGNET, { season: 1, episode: 9 }), 'https://cdn.example/ONLY')
  // And a pack list of one is below the strip's threshold, so nothing is shown.
  assert.strictEqual((await d.packFiles(MAGNET)).length, 1)
})
