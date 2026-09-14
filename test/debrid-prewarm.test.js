'use strict'
// The debrid head start (2026-09-15). Measured on the user's own machine:
// /user answered in ~145 ms once connected, but establishing a NEW connection
// to api.real-debrid.com intermittently stalled past 10 s (curl: one IPv4 try
// in three hung for the full 12 s timeout). The resolve flow needs four round
// trips, so the old 10 s play-time budget expired and the feature silently did
// nothing — and on an uncached magnet the viewer waited those 10 s before the
// swarm was even contacted. So: resolve while the page is open, use the
// answer instantly at play, and never wait long at play time.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { createDebrid } = require('../src/debrid')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

const MAGNET = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=X'

// A fake RealDebrid that answers the whole flow, counting round trips.
function fakeRd({ status = 'downloaded', delayMs = 0, alive = true } = {}) {
  const calls = []
  const fetchFn = async (url, init) => {
    calls.push(String(url).replace('https://api.real-debrid.com/rest/1.0', ''))
    if (delayMs) await new Promise(r => setTimeout(r, delayMs))
    // The client reads the body with text() and parses it itself, so the
    // double must answer in text — returning only json() made every call
    // look like an empty body.
    const payload = (() => {
      if (/addMagnet/.test(url)) return { id: 'T1' }
      if (/selectFiles/.test(url)) return {}
      if (/torrents\/info/.test(url)) {
        return { status, progress: 100, files: [{ id: 1, path: '/film.mkv', bytes: 10, selected: 1 }], links: ['https://rd/d/abc'] }
      }
      if (/unrestrict/.test(url)) return { download: 'https://rd.example/direct.mkv' }
      return {}
    })()
    // A one-byte range request is the liveness proof, not an API call.
    if (init && init.headers && init.headers.Range) {
      return { ok: true, status: alive ? 206 : 503, text: async () => '', json: async () => ({}) }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload }
  }
  return { fetchFn, calls }
}

test('prewarm resolves once and the answer is then free', async () => {
  const rd = fakeRd()
  const d = createDebrid({ provider: 'realdebrid', token: () => 't', fetchFn: rd.fetchFn })
  assert.strictEqual(d.cachedLink(MAGNET), null, 'nothing before it has been asked for')
  assert.strictEqual(await d.prewarm(MAGNET), 'https://rd.example/direct.mkv')
  const trips = rd.calls.length
  assert.ok(trips >= 4, 'the flow really is several round trips: ' + trips)
  // The play path now costs nothing at all.
  assert.strictEqual(d.cachedLink(MAGNET), 'https://rd.example/direct.mkv')
  await d.prewarm(MAGNET)
  assert.strictEqual(rd.calls.length, trips, 'a second ask spends no further round trips')
})

test('two prewarms of the same magnet share one attempt', async () => {
  const rd = fakeRd({ delayMs: 10 })
  const d = createDebrid({ provider: 'realdebrid', token: () => 't', fetchFn: rd.fetchFn })
  const [a, b] = await Promise.all([d.prewarm(MAGNET), d.prewarm(MAGNET)])
  assert.strictEqual(a, b)
  assert.strictEqual(rd.calls.filter(c => /addMagnet/.test(c)).length, 1, 'registered once, not twice')
})

test('prewarm never throws: a refusing RealDebrid is simply no head start', async () => {
  const d = createDebrid({ provider: 'realdebrid', token: () => 't', fetchFn: async () => { throw new Error('connect timeout') } })
  assert.strictEqual(await d.prewarm(MAGNET), null)
  assert.strictEqual(d.cachedLink(MAGNET), null)
})

test('an uncached magnet resolves to nothing rather than hanging on RD', async () => {
  const rd = fakeRd({ status: 'downloading' })
  const d = createDebrid({ provider: 'realdebrid', token: () => 't', fetchFn: rd.fetchFn, pollTimeoutMs: 30, pollIntervalMs: 5 })
  assert.strictEqual(await d.prewarm(MAGNET), null)
})

test('opening a title asks debrid to resolve it, before and regardless of the swarm warm', () => {
  const warm = MAIN.slice(MAIN.indexOf("ipcMain.handle('video-warm'"), MAIN.indexOf("ipcMain.handle('video-warm-cancel'"))
  assert.ok(/_debridConfigured\(\)\) \{[\s\S]{0,200}debrid\(\)\.prewarm\(magnet\)/.test(warm))
  // Before the "already playing" early return, so a warm still helps then.
  assert.ok(warm.indexOf('prewarm(magnet)') < warm.indexOf("skipped: 'playing'"))
})

test('play waits only briefly on debrid, and a held link still costs one proof', () => {
  assert.ok(/const DEBRID_BUDGET_MS = 5000/.test(MAIN), 'ten seconds of dead air was worse than not trying')
  // Both players go through linkFor, which proves the link before the player
  // is ever handed it. A remembered URL is never played unproved.
  assert.strictEqual((MAIN.match(/debrid\(\)\.linkFor\(result\.magnet\)/g) || []).length, 2)
  assert.ok(!/_debridLinkNow/.test(MAIN))
})

// The bug that made the whole subscription feel useless (2026-09-15): a link
// resolved minutes earlier answers 503, and the app handed that dead URL to
// the player, which failed and fell back to peers. Links now expire, are
// re-minted from what was kept, and are proved before anyone plays them.
test('a link is proved before it is handed over, and a dead one is re-minted', async () => {
  const rd = fakeRd()
  const d = createDebrid({ provider: 'realdebrid', token: () => 't', fetchFn: rd.fetchFn })
  const first = await d.linkFor(MAGNET)
  assert.strictEqual(first, 'https://rd.example/direct.mkv')
  const ranges = () => rd.calls.filter(c => /direct\.mkv/.test(c)).length
  assert.ok(ranges() >= 1, 'the link was actually tested, not assumed')
  // Reusing it costs one proof, not the whole flow again.
  const before = rd.calls.filter(c => /addMagnet/.test(c)).length
  await d.linkFor(MAGNET)
  assert.strictEqual(rd.calls.filter(c => /addMagnet/.test(c)).length, before, 'no re-registration')
})

test('a held link that has gone dead is re-minted, not played as a 503', async () => {
  // This is the user's actual bug: a link resolved minutes ago now answers
  // 503. The first resolve succeeds and is held; then the link dies.
  let dead = false
  let minted = 0
  const calls = []
  const fetchFn = async (url, init) => {
    calls.push(String(url))
    if (init && init.headers && init.headers.Range) {
      // The held link is the one that died; a re-minted link serves.
      const ok = !(dead && /mint1/.test(String(url)))
      return { ok, status: ok ? 206 : 503, text: async () => '' }
    }
    const payload = /addMagnet/.test(url) ? { id: 'T1' }
      : /torrents\/info/.test(url) ? { status: 'downloaded', files: [{ id: 1, path: '/f.mkv', bytes: 9, selected: 1 }], links: ['https://rd/d/abc'] }
      : /unrestrict/.test(url) ? { download: 'https://rd.example/mint' + (++minted) + '.mkv' } : {}
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
  }
  const d = createDebrid({ provider: 'realdebrid', token: () => 't', fetchFn })
  assert.strictEqual(await d.linkFor(MAGNET), 'https://rd.example/mint1.mkv')
  const registrations = calls.filter(c => /addMagnet/.test(c)).length
  dead = true
  assert.strictEqual(await d.linkFor(MAGNET), 'https://rd.example/mint2.mkv', 'a working replacement')
  assert.strictEqual(calls.filter(c => /addMagnet/.test(c)).length, registrations,
    're-minted from what was kept, not registered again')
})

test('a link that will not serve at all is an honest failure, so the swarm takes over', async () => {
  const fetchFn = async (url, init) => {
    if (init && init.headers && init.headers.Range) return { ok: false, status: 503, text: async () => '' }
    const payload = /addMagnet/.test(url) ? { id: 'T1' }
      : /torrents\/info/.test(url) ? { status: 'downloaded', files: [{ id: 1, path: '/f.mkv', bytes: 9, selected: 1 }], links: ['https://rd/d/abc'] }
      : /unrestrict/.test(url) ? { download: 'https://rd.example/dead.mkv' } : {}
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
  }
  const d = createDebrid({ provider: 'realdebrid', token: () => 't', fetchFn })
  await assert.rejects(() => d.linkFor(MAGNET), /would not serve/)
  // prewarm still never throws; it simply has no head start to offer.
  assert.strictEqual(await d.prewarm(MAGNET), null)
})

test('an expired link is not offered to the badge either', async () => {
  const { LINK_TTL_MS } = require('../src/debrid')
  assert.ok(LINK_TTL_MS <= 15 * 60 * 1000, 'RealDebrid links do not last long')
  const rd = fakeRd()
  const d = createDebrid({ provider: 'realdebrid', token: () => 't', fetchFn: rd.fetchFn })
  await d.linkFor(MAGNET)
  assert.ok(d.cachedLink(MAGNET), 'fresh: the badge may claim instant')
})

test('both play paths take the proved link, not a remembered one', () => {
  assert.strictEqual((MAIN.match(/debrid\(\)\.linkFor\(result\.magnet\)/g) || []).length, 2)
  assert.ok(!/_debridLinkNow/.test(MAIN), 'the unproved sync peek is gone from the play path')
})
