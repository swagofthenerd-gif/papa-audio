'use strict'
// The season-chain hardening: a failed hop is retried once after a backoff
// (429s honour Retry-After), and a walk that still loses a hop says so with
// `truncated: true` instead of passing off a partial chain as complete.
const test = require('node:test')
const assert = require('node:assert')
const { createAnilistCatalog, _retryDelayMs } = require('../catalog/anilist')

const node = (id, title, year, over = {}) => Object.assign({
  id, type: 'ANIME', format: 'TV', status: 'FINISHED', seasonYear: year,
  episodes: 12, title: { romaji: title }, coverImage: { large: null },
}, over)

// graph: { id: { relations: [[type, node]], self: {...} } }. `failures` maps
// an id to how many times its relations request should fail first, so a
// retry can be told apart from a fresh request.
function chainFetch(graph, { failures = {}, failWith = {} } = {}) {
  const relationCalls = []
  const fetchFn = async (_url, opts) => {
    const body = JSON.parse(opts.body)
    const id = body.variables.id
    const entry = graph[id] || {}
    if (/relations \{/.test(body.query)) {
      relationCalls.push(id)
      if ((failures[id] || 0) > 0) {
        failures[id]--
        return failWith[id] || { ok: false, status: 500 }
      }
      return { ok: true, json: async () => ({ data: { Media: { id, relations: {
        edges: (entry.relations || []).map(([relationType, n]) => ({ relationType, node: n })),
      } } } }) }
    }
    return { ok: true, json: async () => ({ data: { Media: entry.self || null } }) }
  }
  fetchFn.relationCalls = relationCalls
  return fetchFn
}

const TWO_SEASONS = {
  1: { self: node(1, 'S1', 2015), relations: [['SEQUEL', node(2, 'S2', 2018)]] },
  2: { self: node(2, 'S2', 2018), relations: [['PREQUEL', node(1, 'S1', 2015)]] },
}

test('a healthy walk reports truncated: false', async () => {
  const cat = createAnilistCatalog({ fetchFn: chainFetch(TWO_SEASONS), retryDelayMs: 1 })
  const out = await cat.seasonChain(1)
  assert.deepStrictEqual(out.seasons.map(s => s.title), ['S1', 'S2'])
  assert.strictEqual(out.truncated, false)
})

test('a failed hop is retried once and a transient blip stays invisible', async () => {
  // The relations request for id 1 fails once, then works.
  const fetchFn = chainFetch(TWO_SEASONS, { failures: { 1: 1 } })
  const cat = createAnilistCatalog({ fetchFn, retryDelayMs: 1 })
  const out = await cat.seasonChain(1)
  assert.deepStrictEqual(out.seasons.map(s => s.title), ['S1', 'S2'],
    'the retry must rescue the hop, not truncate the chain')
  assert.strictEqual(out.truncated, false)
  assert.ok(fetchFn.relationCalls.filter(id => id === 1).length >= 2, 'the hop was retried')
})

test('a hop that fails twice truncates the walk and says so', async () => {
  // Every relations request for id 2 fails, so the sequel walk past S2 is
  // impossible even with the retry.
  const graph = {
    1: { self: node(1, 'S1', 2015), relations: [['SEQUEL', node(2, 'S2', 2018)]] },
    2: { self: node(2, 'S2', 2018), relations: [['SEQUEL', node(3, 'S3', 2020)]] },
    3: { self: node(3, 'S3', 2020), relations: [] },
  }
  const cat = createAnilistCatalog({
    fetchFn: chainFetch(graph, { failures: { 2: 99 } }),
    retryDelayMs: 1,
  })
  const out = await cat.seasonChain(1)
  assert.strictEqual(out.truncated, true, 'a lost hop must be flagged')
  assert.deepStrictEqual(out.seasons.map(s => s.title), ['S1', 'S2'],
    'what was already walked is kept')
})

test('a start entry that never loads flags the chain truncated', async () => {
  const cat = createAnilistCatalog({
    fetchFn: async () => ({ ok: false, status: 500 }),
    retryDelayMs: 1,
  })
  const out = await cat.seasonChain(1)
  assert.deepStrictEqual(out.seasons, [])
  assert.strictEqual(out.truncated, true)
})

test('a missing id keeps the pre-walk shape: no truncated key at all', async () => {
  const cat = createAnilistCatalog({ fetchFn: async () => { throw new Error('never called') } })
  assert.deepStrictEqual(await cat.seasonChain(null), { seasons: [], related: [] })
})

// The backoff policy is pure so it can be tested without timers.
test('the retry delay is the base, except a 429 honours Retry-After up to 3x', () => {
  assert.strictEqual(_retryDelayMs(new Error('boom'), 1000), 1000)
  assert.strictEqual(_retryDelayMs(Object.assign(new Error(), { status: 500 }), 1000), 1000)
  // 429 with a sane Retry-After: wait what the server asked.
  assert.strictEqual(_retryDelayMs(Object.assign(new Error(), { status: 429, retryAfter: '2' }), 1000), 2000)
  // 429 asking for more than 3s: capped, a stream lookup cannot wait a minute.
  assert.strictEqual(_retryDelayMs(Object.assign(new Error(), { status: 429, retryAfter: '60' }), 1000), 3000)
  // 429 with no header falls back to the base delay.
  assert.strictEqual(_retryDelayMs(Object.assign(new Error(), { status: 429 }), 1000), 1000)
})

test('the 429 Retry-After header rides along on the thrown _post error', async () => {
  // The browse/detail entry points now degrade quietly (they no longer reject),
  // so the internal `_post` — which season-chain's retry relies on to throw — is
  // exercised through a season-chain hop instead. A relations hop that answers
  // 429 must produce an Error carrying status:429 and the Retry-After header, or
  // _retryDelayMs cannot honour the backoff. The hop then succeeds, so the retry
  // observably rescued the walk.
  const fetchFn = chainFetch(TWO_SEASONS, {
    failures: { 1: 1 },
    failWith: {
      1: {
        ok: false,
        status: 429,
        headers: { get: name => (name.toLowerCase() === 'retry-after' ? '2' : null) },
      },
    },
  })
  // With base 50ms, a 429 carrying Retry-After:2 resolves to min(2000, 150) =
  // 150ms; a 429 with NO header (or a non-429) would fall back to the 50ms base.
  // Measuring that the retry waited ~150ms proves _post attached BOTH status:429
  // and retryAfter:'2' to the thrown error — the plumbing _retryDelayMs needs.
  const cat = createAnilistCatalog({ fetchFn, retryDelayMs: 50 })
  const started = Date.now()
  const out = await cat.seasonChain(1)
  const elapsed = Date.now() - started
  assert.deepStrictEqual(out.seasons.map(s => s.title), ['S1', 'S2'],
    'the 429 hop was retried and the walk completed')
  assert.strictEqual(out.truncated, false)
  assert.ok(fetchFn.relationCalls.filter(id => id === 1).length >= 2,
    'the 429 hop was retried, which only happens if _post threw with the 429')
  assert.ok(elapsed >= 140,
    `the retry honoured Retry-After (waited ${elapsed}ms, expected ~150ms) — ` +
    'only possible if the thrown error carried status:429 and retryAfter')
})
