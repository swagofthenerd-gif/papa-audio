'use strict'
// The AniList request lane: one request at a time, spaced apart, identical
// requests in flight shared, a 429 retried after the wait AniList asks for,
// and the two-level relations query walked without a request per entry.
const test = require('node:test')
const assert = require('node:assert')
const { createAnilistCatalog, buildQuery, MIN_GAP_MS, GENRES_FALLBACK } = require('../catalog/anilist')

const okPage = media => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: { Page: { media } } }) })

test('requests are sent one at a time with the gap between them', async () => {
  const sentAt = []
  const fetchFn = async () => { sentAt.push(Date.now()); return okPage([]) }
  const cat = createAnilistCatalog({ fetchFn, minGapMs: 40 })
  await Promise.all([cat.trending(1), cat.popular(1), cat.trending(2)])
  assert.strictEqual(sentAt.length, 3)
  for (let i = 1; i < sentAt.length; i++) assert.ok(sentAt[i] - sentAt[i - 1] >= 35, 'gap kept: ' + (sentAt[i] - sentAt[i - 1]))
})

test('identical requests in flight share one round-trip', async () => {
  let calls = 0
  const fetchFn = async () => { calls++; await new Promise(r => setTimeout(r, 10)); return okPage([{ id: 1, title: { romaji: 'A' } }]) }
  const cat = createAnilistCatalog({ fetchFn })
  const [a, b] = await Promise.all([cat.trending(1), cat.trending(1)])
  assert.strictEqual(calls, 1)
  assert.deepStrictEqual(a.map(x => x.id), [1])
  assert.deepStrictEqual(b.map(x => x.id), [1])
  // Once settled, the next identical request is a fresh round-trip.
  await cat.trending(1)
  assert.strictEqual(calls, 2)
})

test('a 429 is retried once after the Retry-After wait, and the lane holds meanwhile', async () => {
  const log = []
  let first = true
  const fetchFn = async () => {
    log.push(Date.now())
    if (first) { first = false; return { ok: false, status: 429, headers: { get: n => (n === 'retry-after' ? '0.05' : null) } } }
    return okPage([{ id: 7, title: { romaji: 'B' } }])
  }
  const cat = createAnilistCatalog({ fetchFn, rateLimitWaitCapMs: 1000 })
  const out = await cat.trending(1)
  assert.deepStrictEqual(out.map(x => x.id), [7], 'the retry rescued the request')
  assert.strictEqual(log.length, 2)
  assert.ok(log[1] - log[0] >= 45, 'waited what the server asked')
  assert.strictEqual(cat.lastFailure(), null, 'a rescued request is not an outage')
})

test('a 429 asking for longer than the cap is an outage, not a wait', async () => {
  let calls = 0
  const fetchFn = async () => { calls++; return { ok: false, status: 429, headers: { get: n => (n === 'retry-after' ? '60' : null) } } }
  const cat = createAnilistCatalog({ fetchFn, rateLimitWaitCapMs: 1000 })
  const out = await cat.trending(1)
  assert.deepStrictEqual(out, [])
  assert.strictEqual(calls, 1, 'no retry when the wait would be longer than the cap')
  assert.strictEqual(cat.lastFailure().status, 429)
})

test('the production gap is set and the injected-fetcher default is none', () => {
  assert.ok(MIN_GAP_MS >= 600 && MIN_GAP_MS <= 1000, 'about 90 requests a minute')
  assert.ok(GENRES_FALLBACK.includes('Action') && !GENRES_FALLBACK.includes('Hentai'))
})

test('the relations query asks for two levels', () => {
  const q = buildQuery('relations')
  assert.strictEqual((q.match(/relations \{/g) || []).length, 2)
})

test('a nested second level is filed without a request of its own', async () => {
  const node = (id, t, year) => ({ id, type: 'ANIME', format: 'TV', status: 'FINISHED', seasonYear: year, episodes: 12, title: { romaji: t }, coverImage: { large: null } })
  const relationCalls = []
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body)
    const id = body.variables.id
    if (/Media\(id: \$id, type: ANIME\) \{\n    id\n    relations/.test(body.query)) {
      relationCalls.push(id)
      // 1 -> 2 (sequel), and 2 arrives with its own edge 2 -> 3.
      const edges = id === 1
        ? [{ relationType: 'SEQUEL', node: Object.assign(node(2, 'S2', 2018), { relations: { edges: [{ relationType: 'SEQUEL', node: node(3, 'S3', 2020) }, { relationType: 'PREQUEL', node: node(1, 'S1', 2015) }] } }) }]
        : id === 3 ? [{ relationType: 'PREQUEL', node: node(2, 'S2', 2018) }]
        : []
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: { Media: { id, relations: { edges } } } }) }
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: { Media: node(id, 'S' + id, 2015) } }) }
  }
  const cat = createAnilistCatalog({ fetchFn, retryDelayMs: 1 })
  const out = await cat.seasonChain(1)
  assert.deepStrictEqual(out.seasons.map(s => s.title), ['S1', 'S2', 'S3'])
  assert.ok(!relationCalls.includes(2), 'entry 2 came with its edges, so it was never requested: ' + relationCalls.join(','))
})

test('after a refusal the lane sends at a third of its pace for a minute', async () => {
  const sentAt = []
  let n = 0
  const fetchFn = async () => {
    sentAt.push(Date.now())
    n++
    if (n === 1) return { ok: false, status: 429, headers: { get: () => '0.01' } }
    return okPage([])
  }
  const cat = createAnilistCatalog({ fetchFn, minGapMs: 20, rateLimitWaitCapMs: 1000 })
  assert.strictEqual(cat._slowed(), false)
  await cat.trending(1)          // refused once, retried once
  assert.strictEqual(cat._slowed(), true)
  await cat.popular(1)
  assert.ok(sentAt[2] - sentAt[1] >= 55, 'three times the gap after a refusal: ' + (sentAt[2] - sentAt[1]))
})
