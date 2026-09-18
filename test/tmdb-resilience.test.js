'use strict'
// The film catalogue used to give up on the first bad reply.
//
// catalog/tmdb.js threw on any non-OK status — a 429, a 502, a 10 s timeout —
// with no retry, no Retry-After handling and no circuit breaker, while
// catalog/anilist.js had all three. main.js's `video-search` then swallowed the
// throw with `.catch(() => [])` and reported success, so a rate-limited TMDB
// looked exactly like "no such film": searching Oppenheimer returned nothing
// and the app said "check the spelling".
//
// These drive the REAL catalog with an injected fetch. Nothing reaches the
// network.
const test = require('node:test')
const assert = require('node:assert')
const { createTmdbCatalog, _isTransient, _retryWaitMs } = require('../catalog/tmdb')

const PAGE = { results: [{ id: 1, media_type: 'movie', title: 'Oppenheimer', release_date: '2023-07-19' }] }

function reply(status, body, retryAfter) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: h => (h === 'retry-after' && retryAfter != null ? String(retryAfter) : null) },
    json: async () => body || {},
  }
}

// A fetcher that plays a scripted list of replies, then repeats the last one.
function scripted(steps) {
  const at = []
  const fetchFn = async () => {
    const step = steps[Math.min(at.length, steps.length - 1)]
    at.push(Date.now())
    if (typeof step === 'function') return step()
    return step
  }
  return { fetchFn, calls: () => at.length, at }
}

test('a 429 with Retry-After waits the time it asks for and then succeeds', async () => {
  const s = scripted([reply(429, {}, 0.05), reply(200, PAGE)])
  const cat = createTmdbCatalog({ apiKey: 'k', fetchFn: s.fetchFn, rateLimitWaitCapMs: 8000 })
  const started = Date.now()
  const out = await cat.search('Oppenheimer')
  const waited = Date.now() - started
  assert.equal(s.calls(), 2, 'it tried again after the wait')
  assert.equal(out.length, 1)
  assert.equal(out[0].title, 'Oppenheimer')
  assert.ok(waited >= 40, 'it actually waited for the window, not just retried instantly: ' + waited)
  assert.equal(cat.breaker().open, false, 'a success leaves the breaker closed')
})

test('a Retry-After longer than the cap is a failure, not a wait', async () => {
  // Nobody holds a search box open for half a minute. Past the cap the honest
  // answer is "the catalogue did not answer", delivered now.
  const s = scripted([reply(429, {}, 30)])
  const cat = createTmdbCatalog({ apiKey: 'k', fetchFn: s.fetchFn, rateLimitWaitCapMs: 8000 })
  await assert.rejects(() => cat.search('Dune: Part Two'), /429/)
  assert.equal(s.calls(), 1, 'it did not sit out a 30 s window')
})

test('a 500 followed by a 200 succeeds', async () => {
  const s = scripted([reply(500), reply(200, PAGE)])
  const cat = createTmdbCatalog({ apiKey: 'k', fetchFn: s.fetchFn, retryDelayMs: 1 })
  const out = await cat.search('The Dark Knight')
  assert.equal(s.calls(), 2)
  assert.equal(out.length, 1)
})

test('a timeout fails once, then the breaker answers instantly without touching the network', async () => {
  // The whole point: a dead TMDB must not add its timeout to every keystroke's
  // search. The first call pays for the outage; the rest fail fast.
  let calls = 0
  const fetchFn = (_url, opts) => new Promise((_resolve, reject) => {
    calls++
    const signal = opts && opts.signal
    if (signal) signal.addEventListener('abort', () => reject(new Error('aborted')))
  })
  const cat = createTmdbCatalog({ apiKey: 'k', fetchFn, timeoutMs: 20, retryDelayMs: 1 })

  const firstStart = Date.now()
  await assert.rejects(() => cat.search('Spider-Man: No Way Home'))
  const firstMs = Date.now() - firstStart
  const afterFirst = calls
  assert.ok(afterFirst >= 1, 'the first search really tried')
  assert.ok(cat.breaker().open, 'the outage is recorded')

  const secondStart = Date.now()
  await assert.rejects(() => cat.search('Spider-Man: No Way Home'), /not answering/)
  const secondMs = Date.now() - secondStart
  assert.equal(calls, afterFirst, 'the second search did not reach the network at all')
  assert.ok(secondMs < firstMs, 'and it failed faster than the timeout: ' + secondMs + ' vs ' + firstMs)
})

test('a 401 is an answer, not an outage: no retry and no breaker', async () => {
  // A bad API key is not TMDB being down. Retrying it wastes a round trip and
  // tripping the breaker would take every other lookup down with it.
  const s = scripted([reply(401)])
  const cat = createTmdbCatalog({ apiKey: 'bad', fetchFn: s.fetchFn, retryDelayMs: 1 })
  await assert.rejects(() => cat.detail('movie', 27205), /401/)
  assert.equal(s.calls(), 1, 'a bad key is not retried')
  assert.equal(cat.breaker().open, false, 'and does not pause the whole catalog')
})

test('a success after an outage closes the breaker again', async () => {
  const s = scripted([reply(503), reply(503), reply(200, PAGE)])
  const cat = createTmdbCatalog({ apiKey: 'k', fetchFn: s.fetchFn, retryDelayMs: 1 })
  await assert.rejects(() => cat.search('Oppenheimer'))
  assert.ok(cat.breaker().open)
  cat._resetBreaker()
  const out = await cat.search('Oppenheimer')
  assert.equal(out.length, 1)
  assert.equal(cat.breaker().strikes, 0, 'the strike count resets on a healthy answer')
})

test('the retry policy itself', () => {
  assert.equal(_isTransient(429), true)
  assert.equal(_isTransient(503), true)
  assert.equal(_isTransient('unknown'), true)
  assert.equal(_isTransient(401), false)
  assert.equal(_isTransient(404), false)
  // 429 honours Retry-After up to the cap; past it there is no wait worth doing.
  assert.equal(_retryWaitMs({ status: 429, retryAfter: '2' }, 500, 8000), 2000)
  assert.equal(_retryWaitMs({ status: 429, retryAfter: '30' }, 500, 8000), null)
  // A 5xx has no Retry-After, so it gets the flat back-off.
  assert.equal(_retryWaitMs({ status: 502 }, 500, 8000), 500)
})
