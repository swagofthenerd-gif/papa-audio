'use strict'
// debrid.isCached() — the fast "is RealDebrid already holding this?" check.
//
// It opened with `for (const [k, v] of linkCache)`, but makeCache() returns a
// plain object with get/set/has/keys — not a Map — so the loop threw
// "linkCache is not iterable" on the FIRST line of every call. The user's own
// main log carries ten `[papa][debrid] no candidate held: linkCache is not
// iterable` lines: the held-link shortcut, the whole reason a debrid play can
// start instantly, had never once run.
//
// Every existing debrid test stubs isCached, which is exactly why nothing went
// red. These use the REAL module and the REAL cache, populated through the
// public API, and the pick handler is run out of main.js on top of it.

const test = require('node:test')
const assert = require('node:assert')
const { runHandler } = require('./helpers/lift-ipc')
const { createDebrid, infoHashOf } = require('../src/debrid')

const MAGNET = 'magnet:?xt=urn:btih:ABCDEF0123456789&dn=Show.S01E03'
const OTHER = 'magnet:?xt=urn:btih:99998888777766665555&dn=Nobody.Holds.This'
const DIRECT = 'https://cdn.real-debrid.com/d/direct.mkv'

// A scripted RealDebrid. Records every request so a test can assert that the
// held-link shortcut answered without touching the network at all.
function makeRd() {
  const calls = []
  const fetchFn = async (url, init) => {
    const method = (init && init.method) || 'GET'
    calls.push(method + ' ' + url)
    const reply = (status, body) => ({
      ok: status < 400, status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body || {})),
    })
    if (url === DIRECT) return reply(206, '')
    if (url.includes('/torrents/addMagnet')) {
      return reply(200, { id: url.includes('9999') || (init && init.body || '').includes('9999') ? 'T2' : 'T1' })
    }
    if (url.includes('/torrents/selectFiles/')) return reply(204, '')
    if (url.includes('/torrents/info/T2')) return reply(200, { status: 'queued', files: [], links: [] })
    if (url.includes('/torrents/info/')) {
      return reply(200, {
        status: 'downloaded',
        files: [{ id: 1, path: '/Show.S01E03.1080p.mkv', bytes: 4e9, selected: 1 }],
        links: ['https://rd/d/RESTRICTED'],
      })
    }
    if (url.includes('/unrestrict/link')) return reply(200, { download: DIRECT })
    if (url.includes('/torrents/delete/')) return reply(204, '')
    throw new Error('no route for ' + url)
  }
  return { calls, fetchFn }
}

function debridFor(rd) {
  return createDebrid({ token: 'test-token', fetchFn: rd.fetchFn, sleep: async () => {} })
}

test('isCached answers from the link cache without throwing or calling out', async () => {
  const rd = makeRd()
  const d = debridFor(rd)

  // Populate the REAL cache the way the play path does: resolve a link for one
  // episode. That stores it under the per-episode key (hash#1e3), which is the
  // shape the bug's scan was written for and never reached.
  const url = await d.linkFor(MAGNET, { season: 1, episode: 3 })
  assert.strictEqual(url, DIRECT)

  rd.calls.length = 0
  const held = await d.isCached(MAGNET)
  assert.strictEqual(held, true, 'a hash with a proved link must read as held')
  assert.deepStrictEqual(rd.calls, [],
    'the held-link shortcut must answer with no RealDebrid request at all')
})

test('isCached says no for a hash nothing is holding, and still does not throw', async () => {
  const rd = makeRd()
  const d = debridFor(rd)
  await d.linkFor(MAGNET, { season: 1, episode: 3 })

  const held = await d.isCached(OTHER)
  assert.strictEqual(held, false)
  // It had to ask, since nothing was cached for that hash — and it cleaned up
  // after itself rather than leaving a download queued on the account.
  assert.ok(rd.calls.some(c => c.includes('/torrents/addMagnet')))
  assert.ok(rd.calls.some(c => c.startsWith('DELETE ')),
    'a magnet RealDebrid is not holding must be removed again')
})

test('isCached matches a bare-hash entry as well as a per-episode one', async () => {
  const rd = makeRd()
  const d = debridFor(rd)
  // No want → the bare hash key.
  await d.linkFor(MAGNET)
  rd.calls.length = 0
  assert.strictEqual(await d.isCached(MAGNET), true)
  assert.deepStrictEqual(rd.calls, [])
})

test('video-debrid-pick actually picks the magnet RealDebrid is holding', async () => {
  // The consequence of the bug at the call site: isCached threw for every
  // candidate, so `checks` was all errors, `held` was empty, and the handler
  // logged "no candidate held: linkCache is not iterable" and returned null —
  // which is what sent every play back to the peer swarm.
  const rd = makeRd()
  const d = debridFor(rd)
  await d.linkFor(MAGNET, { season: 1, episode: 3 })

  const warnings = []
  const { result, error } = await runHandler('video-debrid-pick', {
    args: { magnets: [MAGNET, OTHER], titleKey: 'tt1', season: 1, episode: 3 },
    timeoutMs: 2000,
    globals: {
      DRY_RUN: false,
      console: { log() {}, warn: (...a) => warnings.push(a.join(' ')), error() {} },
      DEBRID_PICK_DEADLINE_MS: 25000,
      DEBRID_STAGGER_MS: 0,
      debrid: () => d,
      _debridConfigured: () => true,
      _debridRefusedHas: () => false,
      _debridRefusedMark: () => {},
      _debridRateLimited: () => false,
      _debridBackOff: () => {},
      _wantOf: ({ season, episode }) => ({ season, episode }),
      _debridPlayable: async () => DIRECT,
      _instantMark: () => {},
    },
  })

  assert.strictEqual(error, null)
  assert.ok(result, 'the pick must answer')
  assert.strictEqual(result.magnet, MAGNET, 'the held candidate must be the pick')
  // `held` is built inside the vm sandbox, so it is a cross-realm Array —
  // compare its contents, not its identity.
  assert.strictEqual(result.held.length, 1)
  assert.strictEqual(result.held[0], MAGNET)
  assert.ok(!result.noneHeld)
  assert.deepStrictEqual(warnings, [], 'nothing should have been logged as unheld')
})

test('infoHashOf still lower-cases the key the pick and the cache agree on', () => {
  // The scan compares cache keys against infoHashOf(magnet); if either side
  // stopped normalising, the shortcut would silently never match again.
  assert.strictEqual(infoHashOf(MAGNET), 'abcdef0123456789')
})
