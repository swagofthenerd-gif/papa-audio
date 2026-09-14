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
function fakeRd({ status = 'downloaded', delayMs = 0 } = {}) {
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

test('play uses a link resolved during the page visit at once, and waits only briefly otherwise', () => {
  assert.ok(/const DEBRID_BUDGET_MS = 5000/.test(MAIN), 'ten seconds of dead air was worse than not trying')
  assert.ok(/function _debridLinkNow\(magnet\)/.test(MAIN))
  // Both players: the ready link short-circuits the budget entirely.
  assert.strictEqual((MAIN.match(/const readyLink = _debridLinkNow\(result\.magnet\)/g) || []).length, 2)
  assert.ok(/if \(readyLink\) \{\n\s*\/\/ Resolved while the page was open/.test(MAIN), 'smooth path')
  assert.ok(/const attempt = readyLink\n\s*\? Promise\.resolve\(readyLink\)/.test(MAIN), 'purist path')
  // A miss must reject so the swarm starts, never resolve to undefined.
  assert.ok((MAIN.match(/if \(!u\) throw new Error\('debrid miss'\); return u/g) || []).length === 2)
})
