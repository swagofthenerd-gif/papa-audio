'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { createEnricher, distance } = require('../src/video-enrich')
const { makeCache } = require('../src/ttl-cache')

// A fake IntersectionObserver. Real scroll geometry is not available under
// node:test and is not what is being tested anyway -- what matters is the
// scheduler's reaction to visibility changes, so the test supplies those
// directly, plus plain numbers for the rectangles that decide ordering.
function fakeObserver() {
  let cb = null
  const watched = new Set()
  const api = {
    factory: function (callback) {
      cb = callback
      return {
        observe: function (el) { watched.add(el) },
        unobserve: function (el) { watched.delete(el) },
        disconnect: function () { watched.clear() },
      }
    },
    watched: watched,
    // top/bottom are viewport-relative pixels; the viewport is 0..1000.
    show: function (el, top) {
      cb([{ target: el, isIntersecting: true, boundingClientRect: rect(top), rootBounds: rect(0, 1000) }])
    },
    hide: function (el, top) {
      cb([{ target: el, isIntersecting: false, boundingClientRect: rect(top == null ? 5000 : top), rootBounds: rect(0, 1000) }])
    },
    showAll: function (pairs) {
      cb(pairs.map(function (p) {
        return { target: p[0], isIntersecting: true, boundingClientRect: rect(p[1]), rootBounds: rect(0, 1000) }
      }))
    },
  }
  return api
}

function rect(top, bottom) {
  return { top: top, bottom: bottom == null ? top + 300 : bottom }
}

// A fetcher whose promises are resolved by the test, so in-flight counts can be
// observed at a chosen moment instead of raced against.
function manualFetcher() {
  const calls = []
  const open = new Map()
  function fetchDetail(key) {
    calls.push(key)
    return new Promise(function (resolve, reject) { open.set(key, { resolve: resolve, reject: reject }) })
  }
  fetchDetail.calls = calls
  fetchDetail.open = open
  fetchDetail.settle = async function (key, value) {
    const h = open.get(key)
    assert.ok(h, 'no in-flight request for ' + key)
    open.delete(key)
    h.resolve(value === undefined ? { key: key } : value)
    await tick()
  }
  fetchDetail.fail = async function (key, err) {
    const h = open.get(key)
    assert.ok(h, 'no in-flight request for ' + key)
    open.delete(key)
    h.reject(err || new Error('boom'))
    await tick()
  }
  fetchDetail.settleAll = async function () {
    for (const key of Array.from(open.keys())) await fetchDetail.settle(key)
  }
  return fetchDetail
}

// Two turns is enough for the .then chain the scheduler uses (deliver, then
// the bookkeeping/pump link) plus the promise the test itself awaits.
async function tick() { for (let i = 0; i < 6; i++) await Promise.resolve() }

function cards(n) {
  const out = []
  for (let i = 0; i < n; i++) out.push({ id: i })
  return out
}

test('twenty visible cards never put more than the concurrency limit in flight', async () => {
  const obs = fakeObserver()
  const fetchDetail = manualFetcher()
  const e = createEnricher({ fetchDetail: fetchDetail, observerFactory: obs.factory, concurrency: 3 })

  const els = cards(20)
  els.forEach(function (el, i) { e.observe(el, 'movie:' + i, function () {}) })
  obs.showAll(els.map(function (el, i) { return [el, i * 10] }))
  await tick()

  // The whole point: twenty cards became visible in one shot, and three
  // requests went out.
  assert.strictEqual(fetchDetail.open.size, 3)
  assert.strictEqual(e._stats().maxInFlight, 3)

  // And it stays three as the queue drains, not three then a burst.
  for (let i = 0; i < 20; i++) {
    if (fetchDetail.open.size === 0) break
    await fetchDetail.settle(Array.from(fetchDetail.open.keys())[0])
    assert.ok(fetchDetail.open.size <= 3, 'in flight crept to ' + fetchDetail.open.size)
  }
  assert.strictEqual(e._stats().maxInFlight, 3, 'observed maximum never exceeded the limit')
  assert.strictEqual(fetchDetail.calls.length, 20, 'every card was eventually served')
})

test('a card scrolled out of view before its turn is never fetched', async () => {
  const obs = fakeObserver()
  const fetchDetail = manualFetcher()
  const e = createEnricher({ fetchDetail: fetchDetail, observerFactory: obs.factory, concurrency: 2 })

  const els = cards(6)
  els.forEach(function (el, i) { e.observe(el, 'movie:' + i, function () {}) })
  obs.showAll(els.map(function (el, i) { return [el, i * 100] }))
  await tick()

  // 0 and 1 are in flight; 2..5 are queued. The user keeps scrolling and 4 and
  // 5 leave before either of the two open slots frees up.
  assert.deepStrictEqual(fetchDetail.calls.slice().sort(), ['movie:0', 'movie:1'])
  obs.hide(els[4]); obs.hide(els[5])
  await fetchDetail.settleAll()

  assert.ok(!fetchDetail.calls.includes('movie:4'), 'movie:4 was fetched despite leaving the viewport')
  assert.ok(!fetchDetail.calls.includes('movie:5'), 'movie:5 was fetched despite leaving the viewport')
  assert.strictEqual(fetchDetail.calls.length, 4)

  // Scrolling back re-queues it -- dropping is not the same as tombstoning.
  obs.show(els[4], 50)
  await fetchDetail.settleAll()
  assert.ok(fetchDetail.calls.includes('movie:4'), 'movie:4 was not re-queued on return')
})

test('the same title on two shelves costs one request', async () => {
  const obs = fakeObserver()
  const fetchDetail = manualFetcher()
  const cache = makeCache({ cap: 50, ttlMs: 60000 })
  const e = createEnricher({ fetchDetail: fetchDetail, observerFactory: obs.factory, cache: cache, concurrency: 4 })

  const painted = []
  const trending = {}
  const popular = {}
  e.observe(trending, 'movie:27205', function (d) { painted.push(['trending', d]) })
  e.observe(popular, 'movie:27205', function (d) { painted.push(['popular', d]) })

  obs.show(trending, 10)
  await tick()
  assert.strictEqual(fetchDetail.calls.length, 1)
  await fetchDetail.settle('movie:27205', { director: 'Nolan' })

  // Both cards painted from the single response...
  assert.strictEqual(painted.length, 2)
  assert.deepStrictEqual(painted.map(function (p) { return p[0] }).sort(), ['popular', 'trending'])

  // ...and the third shelf, mounted later, costs nothing at all.
  const topRated = {}
  e.observe(topRated, 'movie:27205', function (d) { painted.push(['topRated', d]) })
  obs.show(topRated, 20)
  await tick()
  assert.strictEqual(fetchDetail.calls.length, 1, 'a cached title was refetched')
  assert.strictEqual(painted.length, 3)
  assert.strictEqual(painted[2][1].director, 'Nolan')
})

test('two simultaneous requests for one title share one in-flight promise', async () => {
  const obs = fakeObserver()
  const fetchDetail = manualFetcher()
  const e = createEnricher({ fetchDetail: fetchDetail, observerFactory: obs.factory, cache: makeCache({ cap: 9 }), concurrency: 4 })

  const a = {}, b = {}
  const seen = []
  e.observe(a, 'tv:1396', function (d) { seen.push('a' + d.n) })
  e.observe(b, 'tv:1396', function (d) { seen.push('b' + d.n) })

  // Both become visible in the same observer callback, before anything settles.
  obs.showAll([[a, 10], [b, 20]])
  await tick()
  assert.strictEqual(fetchDetail.calls.length, 1, 'the second card issued its own request')
  assert.deepStrictEqual(e._inflight(), ['tv:1396'])

  await fetchDetail.settle('tv:1396', { n: 1 })
  assert.deepStrictEqual(seen.sort(), ['a1', 'b1'], 'both cards resolved off the one promise')
  assert.strictEqual(e._stats().requests, 1)
})

test('nearest to the viewport is fetched first', async () => {
  const obs = fakeObserver()
  const fetchDetail = manualFetcher()
  const e = createEnricher({ fetchDetail: fetchDetail, observerFactory: obs.factory, concurrency: 1 })

  // far is 2000px below the fold, mid 1200, near is on screen. They arrive in
  // the worst possible order -- farthest first -- which is what a shelf
  // rendering top-to-bottom actually produces.
  const far = {}, mid = {}, near = {}
  e.observe(far, 'movie:far', function () {})
  e.observe(mid, 'movie:mid', function () {})
  e.observe(near, 'movie:near', function () {})
  obs.showAll([[far, 3000], [mid, 2200], [near, 100]])
  await tick()

  assert.deepStrictEqual(fetchDetail.calls, ['movie:near'])
  await fetchDetail.settle('movie:near')
  assert.deepStrictEqual(fetchDetail.calls, ['movie:near', 'movie:mid'])
  await fetchDetail.settle('movie:mid')
  assert.deepStrictEqual(fetchDetail.calls, ['movie:near', 'movie:mid', 'movie:far'])
})

test('a card that scrolls closer jumps ahead of one that was queued first', async () => {
  const obs = fakeObserver()
  const fetchDetail = manualFetcher()
  const e = createEnricher({ fetchDetail: fetchDetail, observerFactory: obs.factory, concurrency: 1 })

  const first = {}, later = {}, blocker = {}
  e.observe(blocker, 'movie:blocker', function () {})
  e.observe(first, 'movie:first', function () {})
  e.observe(later, 'movie:later', function () {})

  obs.show(blocker, 0)          // takes the single slot
  obs.show(first, 2500)         // queued, far away
  await tick()
  obs.show(later, 1100)         // queued afterwards but much nearer
  await tick()

  await fetchDetail.settle('movie:blocker')
  assert.deepStrictEqual(fetchDetail.calls, ['movie:blocker', 'movie:later'],
    'the queue served insertion order rather than distance')
})

test('a failing title does not spin, and backs off before it is retried', async () => {
  const obs = fakeObserver()
  const fetchDetail = manualFetcher()
  const clock = { t: 0 }
  const errors = []
  const e = createEnricher({
    fetchDetail: fetchDetail,
    observerFactory: obs.factory,
    concurrency: 2,
    now: function () { return clock.t },
    retryBaseMs: 1000,
    retryMaxAttempts: 2,
    onError: function (k, err) { errors.push(k) },
  })

  const el = {}
  e.observe(el, 'movie:bad', function () {})
  obs.show(el, 10)
  await tick()
  await fetchDetail.fail('movie:bad')
  assert.strictEqual(fetchDetail.calls.length, 1)
  assert.deepStrictEqual(errors, ['movie:bad'])

  // The card is still on screen. Re-reporting it (as a scroll or a resize
  // would) must not produce another request while the cooldown holds.
  for (let i = 0; i < 10; i++) { obs.show(el, 10 + i); await tick() }
  assert.strictEqual(fetchDetail.calls.length, 1, 'a failed card is spinning')
  assert.strictEqual(e._pending().length, 0)

  // After the cooldown it gets one more chance -- transient failures recover.
  clock.t = 1001
  obs.show(el, 10)
  await tick()
  assert.strictEqual(fetchDetail.calls.length, 2)
  await fetchDetail.fail('movie:bad')

  // Two attempts is the cap: no amount of scrolling or waiting revives it, and
  // the card keeps its basic form for the rest of the session.
  clock.t = 999999
  for (let i = 0; i < 5; i++) { obs.show(el, 10 + i); await tick() }
  assert.strictEqual(fetchDetail.calls.length, 2, 'a permanently dead title kept being retried')
})

test('a failure does not stall the queue behind it', async () => {
  const obs = fakeObserver()
  const fetchDetail = manualFetcher()
  const e = createEnricher({ fetchDetail: fetchDetail, observerFactory: obs.factory, concurrency: 1 })

  const a = {}, b = {}
  e.observe(a, 'movie:bad', function () {})
  e.observe(b, 'movie:good', function () {})
  obs.showAll([[a, 0], [b, 500]])
  await tick()

  await fetchDetail.fail('movie:bad')
  assert.deepStrictEqual(fetchDetail.calls, ['movie:bad', 'movie:good'], 'the slot was not released')
})

test('a fetcher that throws synchronously is treated as a failure, not a crash', async () => {
  const obs = fakeObserver()
  const calls = []
  const e = createEnricher({
    fetchDetail: function (key) { calls.push(key); throw new Error('sync boom') },
    observerFactory: obs.factory,
    concurrency: 1,
    retryBaseMs: 0,
  })
  const a = {}, b = {}
  e.observe(a, 'movie:x', function () {})
  e.observe(b, 'movie:y', function () {})
  obs.showAll([[a, 0], [b, 100]])
  await tick()
  assert.deepStrictEqual(calls, ['movie:x', 'movie:y'])
})

test('a result arriving after the card is gone does not throw', async () => {
  const obs = fakeObserver()
  const fetchDetail = manualFetcher()
  const cache = makeCache({ cap: 20, ttlMs: 60000 })
  const e = createEnricher({ fetchDetail: fetchDetail, observerFactory: obs.factory, cache: cache, concurrency: 2 })

  let applied = 0
  const el = {}
  e.observe(el, 'movie:gone', function () { applied++ })
  obs.show(el, 10)
  await tick()

  // The shelf re-rendered while the request was in the air.
  e.unobserve(el)
  await fetchDetail.settle('movie:gone', { runtime: 148 })
  assert.strictEqual(applied, 0, 'painted a detached card')
  // But the work was not wasted: the answer is cached for the re-render.
  assert.deepStrictEqual(cache.get('movie:gone'), { runtime: 148 })

  const fresh = {}
  e.observe(fresh, 'movie:gone', function () { applied++ })
  assert.strictEqual(applied, 1, 'the cached result did not paint the new card')
  assert.strictEqual(fetchDetail.calls.length, 1)
})

test('destroy during flight swallows the late result', async () => {
  const obs = fakeObserver()
  const fetchDetail = manualFetcher()
  const e = createEnricher({ fetchDetail: fetchDetail, observerFactory: obs.factory, concurrency: 2 })
  const el = {}
  let applied = 0
  e.observe(el, 'movie:t', function () { applied++ })
  obs.show(el, 0)
  await tick()
  e.destroy()
  await fetchDetail.settle('movie:t')
  assert.strictEqual(applied, 0)
})

test('one card whose apply throws does not stop its siblings painting', async () => {
  const obs = fakeObserver()
  const fetchDetail = manualFetcher()
  const e = createEnricher({ fetchDetail: fetchDetail, observerFactory: obs.factory, concurrency: 2 })
  const bad = {}, good = {}
  let ok = 0
  e.observe(bad, 'movie:z', function () { throw new Error('detached node') })
  e.observe(good, 'movie:z', function () { ok++ })
  obs.showAll([[bad, 0], [good, 10]])
  await tick()
  await fetchDetail.settle('movie:z')
  assert.strictEqual(ok, 1)
})

test('distance ranks by gap to the viewport and is zero for anything overlapping it', () => {
  const root = rect(0, 1000)
  assert.strictEqual(distance({ isIntersecting: true, boundingClientRect: rect(200, 500), rootBounds: root }), 0)
  assert.strictEqual(distance({ isIntersecting: true, boundingClientRect: rect(-100, 50), rootBounds: root }), 0)
  assert.strictEqual(distance({ isIntersecting: true, boundingClientRect: rect(1300, 1600), rootBounds: root }), 300)
  assert.strictEqual(distance({ isIntersecting: true, boundingClientRect: rect(-600, -400), rootBounds: root }), 400)
})

test('prefetch shares the card path: cached is free, in-flight coalesces', async () => {
  const obs = fakeObserver()
  const fetchDetail = manualFetcher()
  const cache = makeCache({ cap: 10, ttlMs: 60000 })
  const e = createEnricher({ fetchDetail: fetchDetail, observerFactory: obs.factory, cache: cache, concurrency: 2 })

  e.prefetch('movie:p')
  await tick()
  assert.strictEqual(fetchDetail.calls.length, 1)
  e.prefetch('movie:p')
  await tick()
  assert.strictEqual(fetchDetail.calls.length, 1, 'prefetch duplicated an in-flight request')
  await fetchDetail.settle('movie:p', { director: 'x' })
  e.prefetch('movie:p')
  await tick()
  assert.strictEqual(fetchDetail.calls.length, 1, 'prefetch ignored the cache')
})

test('the module loads as a classic script and attaches to the global', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'video-enrich.js'), 'utf8')
  // Same shape as the renderer: no CommonJS `module` in scope, so the wrapper
  // must fall through to attaching itself to the global object.
  assert.ok(!('PapaVideoEnrich' in globalThis), 'test precondition')
  try {
    new Function('module', src + '\n')(undefined)
    assert.strictEqual(typeof globalThis.PapaVideoEnrich, 'object')
    assert.strictEqual(typeof globalThis.PapaVideoEnrich.createEnricher, 'function')
  } finally {
    delete globalThis.PapaVideoEnrich
  }
})
