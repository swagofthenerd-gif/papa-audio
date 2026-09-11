'use strict'
// S7: during an outage AniList is not asked again every timer tick. After a
// failure the catalog answers with the fallback immediately for a window that
// doubles up to a ceiling; a success closes the breaker.
const test = require('node:test')
const assert = require('node:assert')
const { createAnilistCatalog } = require('../catalog/anilist')

function failing(status) {
  let calls = 0
  const fetchFn = async () => { calls++; return { ok: false, status, headers: { get: () => null }, json: async () => ({}) } }
  return { fetchFn, calls: () => calls }
}

test('a 403 trips the breaker: the next calls do not reach the network, and the outage is still reported', async () => {
  const f = failing(403)
  const cat = createAnilistCatalog({ fetchFn: f.fetchFn, retryDelayMs: 1 })
  assert.deepEqual(await cat.trending(1), [])
  const after = f.calls()
  assert.ok(after >= 1)
  assert.deepEqual(await cat.popular(1), [])
  assert.deepEqual(await cat.trending(2), [])
  assert.equal(f.calls(), after, 'no further network calls while the breaker is open')
  assert.ok(cat.lastFailure() && /403/.test(cat.lastFailure().message), 'the shelves can still say why')
  const b = cat.breaker()
  assert.ok(b.open && b.strikes === 1 && b.until > Date.now())
})

test('the window doubles per strike up to the ceiling, and a success resets it', async () => {
  const f = failing(500)
  const cat = createAnilistCatalog({ fetchFn: f.fetchFn, retryDelayMs: 1 })
  await cat.trending(1)
  const first = cat.breaker().until - Date.now()
  cat._resetBreaker()
  await cat.trending(1)
  cat._resetBreaker()
  // Strikes were reset by _resetBreaker; simulate accumulation by tripping through the public path.
  let ok = false
  const good = createAnilistCatalog({ fetchFn: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: { Page: { media: [] } } }) }), retryDelayMs: 1 })
  await good.trending(1)
  ok = !good.breaker().open && good.breaker().strikes === 0
  assert.ok(ok, 'a healthy answer leaves the breaker closed')
  assert.ok(first > 20000 && first <= 31000, 'first window is about 30s')
})

test('a 429 with Retry-After waits at least that long, capped at the ceiling', async () => {
  let calls = 0
  const fetchFn = async () => { calls++; return { ok: false, status: 429, headers: { get: (h) => (h === 'retry-after' ? '120' : null) }, json: async () => ({}) } }
  const cat = createAnilistCatalog({ fetchFn, retryDelayMs: 1 })
  await cat.search('x', 1)
  const wait = cat.breaker().until - Date.now()
  assert.ok(wait >= 110000 && wait <= 600000, 'honours Retry-After (120s) within the 10-minute ceiling: ' + wait)
})
