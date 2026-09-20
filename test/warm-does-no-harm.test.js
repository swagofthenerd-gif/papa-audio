'use strict'
// The "get it ready early" path was doing three kinds of harm (2026-09-20
// audit; two findings survived 3/3 adversarial verification):
//
//  1. It built a debrid RELAY, and building one stops the previous one — which
//     can be the relay serving the episode playing RIGHT NOW. A background
//     head start could cut off the foreground video.
//  2. It was ungated: it fired during a two-minute 429 back-off and for
//     magnets already answered 451/404, adding to the rate-limiting that then
//     blocked the very play it exists to make instant.
//  3. It did not know which episode was on screen, so it warmed the pack's
//     LARGEST file and asked RealDebrid for a link to that same wrong file.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { createDebrid } = require('../src/debrid')
const { runHandler } = require('./helpers/lift-ipc')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const MAGNET = 'magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&dn=Pack'

// A pack holding three episodes, so a link is only right for one of them.
function packFetch(record) {
  return async (url) => {
    record.urls.push(String(url))
    if (String(url).startsWith('http://alive/')) {
      return { ok: true, status: 206, headers: { get: () => null }, body: { cancel: async () => {} }, text: async () => '' }
    }
    const body = String(url).includes('/torrents/info/')
      ? {
        status: 'downloaded',
        files: [
          { id: 1, path: '/Pack/Show - 05.mkv', bytes: 10, selected: 1 },
          { id: 2, path: '/Pack/Show - 06.mkv', bytes: 99, selected: 1 },
        ],
        links: ['https://rd/d/L5', 'https://rd/d/L6'],
      }
      : String(url).includes('/unrestrict/link') ? { download: 'http://alive/ep.mkv' } : { id: 'T1' }
    return { ok: true, status: String(url).includes('selectFiles') ? 204 : 200, text: async () => JSON.stringify(body) }
  }
}
const client = (record) => createDebrid({ token: 'tok', fetchFn: packFetch(record), sleep: async () => {}, pollIntervalMs: 1 })

test('a head start for episode 5 is not reused as the answer for episode 6', async () => {
  const record = { urls: [] }
  const d = client(record)
  await d.prewarm(MAGNET, { episode: 5 })
  const before = record.urls.length
  const five = await d.cachedLink(MAGNET, { episode: 5 })
  assert.ok(five, 'episode 5 is cached after its own prewarm')
  assert.equal(d.cachedLink(MAGNET, { episode: 6 }), null,
    'episode 6 was never resolved, so it must not claim a cached link')
  assert.equal(record.urls.length, before, 'asking the cache must cost no requests')
})

test('two head starts for the SAME episode share one attempt', async () => {
  const record = { urls: [] }
  const d = client(record)
  await Promise.all([d.prewarm(MAGNET, { episode: 5 }), d.prewarm(MAGNET, { episode: 5 })])
  const once = record.urls.length
  const solo = client({ urls: [] })
  await solo.prewarm(MAGNET, { episode: 5 })
  await d.prewarm(MAGNET, { episode: 5 })
  assert.equal(record.urls.length, once,
    'a third call after the answer is cached must cost nothing at all')
})

test('prewarm never throws, whatever RealDebrid says', async () => {
  const d = createDebrid({ token: 'tok', sleep: async () => {}, pollIntervalMs: 1,
    fetchFn: async () => ({ ok: false, status: 429, text: async () => '{"error":"too_many_requests"}' }) })
  const out = await d.prewarm(MAGNET, { episode: 5 })
  assert.equal(out, null, 'a head start that fails is simply no head start')
})

// ── the handler's gates ────────────────────────────────────────────────────
function warmRig(over = {}) {
  const seen = { prewarms: [], relays: [], marks: [], backoffs: [] }
  const globals = Object.assign({
    // A live streamer makes the handler return right after the debrid block,
    // which isolates exactly what these tests are about.
    // A live streamer makes the handler return right after the debrid block.
    // `debrid` here is what the SESSION is being served by — set it to make a
    // debrid stream "currently playing".
    _videoSession: { streamer: {}, debrid: null },
    _warm: { magnet: null },
    _wantOf: (o) => (o && o.episode != null ? { season: o.season, episode: o.episode } : null),
    debrid: () => ({ prewarm: async (m, w) => { seen.prewarms.push({ magnet: m, want: w }); return 'http://rd/link' } }),
    _debridConfigured: () => true,
    _debridRateLimited: () => false,
    _debridRefusedHas: () => false,
    _debridBackOff: () => { seen.backoffs.push(1) },
    _debridRefusedMark: () => {},
    _instantMark: (k, v) => { seen.marks.push([k, v]) },
    _debridPlayable: async (m, w) => { seen.relays.push({ magnet: m, want: w }); return 'http://rd/relay' },
  }, over)
  return { seen, globals }
}

const warmArgs = { magnet: MAGNET, titleKey: 'anime:21', season: null, episode: 9, absoluteEpisode: null }

test('with nothing playing, the WHOLE path is prepared — link and relay', async () => {
  // Load-bearing and measured: building the relay at play time lost the race
  // to the swarm every time (the budget expired at 5,166 ms).
  const { seen, globals } = warmRig()
  await runHandler('video-warm', { args: warmArgs, globals, timeoutMs: 300 })
  await new Promise(r => setTimeout(r, 40))
  assert.equal(seen.relays.length, 1, 'the relay must be built ahead of Play')
  assert.equal(seen.prewarms.length, 0)
  assert.deepEqual(seen.relays[0].want, { season: null, episode: 9 },
    'for the episode on screen, not for whatever the pack resolves to by default')
  assert.deepEqual(seen.marks[0], ['anime:21', 'debrid'])
})

test('while a debrid stream is playing, the head start must NOT build a relay', async () => {
  // Building one stops the previous one, and that one is serving the episode
  // on screen. A background head start cutting off the foreground video is
  // the worst thing this feature could possibly do.
  const { seen, globals } = warmRig()
  globals._videoSession = { streamer: {}, debrid: { magnet: 'other', want: null } }
  await runHandler('video-warm', { args: warmArgs, globals, timeoutMs: 300 })
  await new Promise(r => setTimeout(r, 40))
  assert.equal(seen.relays.length, 0, 'the live relay must be left alone')
  assert.equal(seen.prewarms.length, 1, 'the link is still worth preparing')
  assert.deepEqual(seen.prewarms[0].want, { season: null, episode: 9 })
})

test('a rate-limited account is left alone', async () => {
  const { seen, globals } = warmRig({ _debridRateLimited: () => true })
  await runHandler('video-warm', { args: warmArgs, globals, timeoutMs: 300 })
  await new Promise(r => setTimeout(r, 40))
  assert.equal(seen.prewarms.length + seen.relays.length, 0,
    'warming during a back-off is what caused the back-off to keep renewing')
})

test('a source RealDebrid has already refused is not asked about again', async () => {
  const { seen, globals } = warmRig({ _debridRefusedHas: () => true })
  await runHandler('video-warm', { args: warmArgs, globals, timeoutMs: 300 })
  await new Promise(r => setTimeout(r, 40))
  assert.equal(seen.prewarms.length + seen.relays.length, 0)
})

test('no debrid account means no debrid traffic', async () => {
  const { seen, globals } = warmRig({ _debridConfigured: () => false })
  await runHandler('video-warm', { args: warmArgs, globals, timeoutMs: 300 })
  await new Promise(r => setTimeout(r, 40))
  assert.equal(seen.prewarms.length + seen.relays.length, 0)
})

test('a 429 from the head start is recorded, not shrugged off', async () => {
  const err = Object.assign(new Error('too many'), { code: 'HTTP_429' })
  const { seen, globals } = warmRig({
    _debridPlayable: async () => { throw err },
    debrid: () => ({ prewarm: async () => { throw err } }),
  })
  await runHandler('video-warm', { args: warmArgs, globals, timeoutMs: 300 })
  await new Promise(r => setTimeout(r, 40))
  assert.equal(seen.backoffs.length, 1,
    'without this the next warm walks straight back into the rate limit')
})

// ── the swarm half, and the renderer ───────────────────────────────────────
test('the swarm head start pulls the wanted episode, not the biggest file', () => {
  const at = MAIN.indexOf("ipcMain.handle('video-warm'")
  const body = MAIN.slice(at, MAIN.indexOf('\n})', at))
  assert.match(body, /matchesWantedEpisode\(f\.name, warmWant\)/,
    'same matcher the streamer uses, or the warm and the play disagree')
  assert.match(body, /const file = \(wanted\.length \? wanted : pool\)/,
    'largest-file remains the fallback when the episode cannot be identified')
  assert.match(MAIN, /matchesWantedEpisode \} = require\('\.\/torrent-stream'\)/)
})

test('the warm is told which episode the page is on', () => {
  const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const at = R.indexOf('window.api.videoWarm({')
  assert.ok(at > 0)
  const call = R.slice(at, at + 520)
  assert.match(call, /season:/)
  assert.match(call, /episode:/)
  assert.match(call, /absoluteEpisode:/)
})

test('an in-flight pick does not outlive the page that asked for it', () => {
  const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const at = R.indexOf('function _resetDetailPageChoices()')
  const body = R.slice(at, R.indexOf('\n}\n', at))
  assert.match(body, /_debridPickPending = null/,
    'a Play on the new page could otherwise wait on a lookup for the old one')
})
