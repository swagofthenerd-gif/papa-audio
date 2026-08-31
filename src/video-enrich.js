'use strict';
// Card enrichment scheduler for the Movies & TV shelves.
//
// The catalogue's list endpoints (trending/popular/discover) return only id,
// title, year, poster and a score. Director, runtime, certificate and the three
// outside ratings (IMDb, RT, Metacritic) live only in the per-title detail
// response, so a fully-populated card costs one request per title. A home page
// carries five or six shelves of ~20 cards; enriching them all on paint is
// ~120 requests, the overwhelming majority for cards below the fold that the
// user never scrolls to. That burst is what gets an API key rate-limited, and
// it is exactly the work whose result is thrown away.
//
// So nothing is fetched because it exists -- it is fetched because it is on
// screen, and even then only a few at a time, nearest first, and never twice.
//
// All I/O is injected: the detail fetcher, the TTL cache, and the factory that
// builds the IntersectionObserver. The module touches no DOM API and knows
// nothing about Electron, which is what lets the tests drive the whole thing
// with a fake observer and a fake clock instead of a browser.
//
// UMD-wrapped like ttl-cache.js / video-store.js so it loads as a classic
// script in the renderer without leaking bindings into the shared scope.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaVideoEnrich = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Four. The detail endpoint is a small JSON document, so the win from more
  // parallelism is latency-shaped and flattens fast, while the cost is shaped
  // like a rate-limit ban. Four keeps a visible row of cards (typically 5-7
  // across on a desktop window) filling in within about two round-trips, which
  // reads as "instant" once posters have painted, and it means a fast scroll
  // through ten shelves has at most four wasted requests in the air rather
  // than two hundred.
  const CONCURRENCY = 4

  // Retry policy. A failure is remembered, and the same title is not tried
  // again until the cooldown has passed AND the card comes back into view.
  // Both halves matter:
  //   - No timer-driven retry. A card parked on screen must never turn into a
  //     request loop; if enrichment failed, the basic card is what the user
  //     keeps, and that is an acceptable outcome forever.
  //   - But a cooldown rather than a permanent tombstone, because the common
  //     failure here is not "this title has no detail record", it is the
  //     laptop's wifi dropping for ten seconds mid-scroll. Tombstoning would
  //     mean a brief blip permanently degrades every card the user happened to
  //     be looking at, for the life of the session, with no way back.
  // Backoff doubles per attempt and then gives up, so a title that genuinely
  // cannot be resolved costs three requests across a whole session, not three
  // per scroll.
  const RETRY_BASE_MS = 30 * 1000
  const RETRY_MAX_ATTEMPTS = 3

  // Cards below the fold are prefetched a screen early, so the row the user is
  // scrolling toward is already filled by the time it arrives. This is the
  // observer's rootMargin, not a distance we compute -- it decides membership
  // ("close enough to be worth fetching"), while `distance` below decides
  // order among the members.
  const ROOT_MARGIN = '600px 0px'

  // Order among visible cards. The observer hands us a geometry snapshot; the
  // card overlapping the viewport is distance 0, and anything in the prefetch
  // margin is ranked by how far it still has to travel. Split out and
  // injectable so ordering can be asserted with plain numbers instead of a
  // headless browser -- the tests feed rectangles, not scroll events.
  function distance(entry) {
    const r = entry && entry.boundingClientRect
    const root = entry && entry.rootBounds
    if (!r) return entry && entry.isIntersecting ? 0 : Infinity
    if (!root) return entry.isIntersecting ? 0 : Infinity
    if (r.bottom >= root.top && r.top <= root.bottom) return 0
    if (r.top > root.bottom) return r.top - root.bottom
    return root.top - r.bottom
  }

  function createEnricher(opts) {
    opts = opts || {}
    // Required: (key, ctx) -> Promise<detail>. Rejection means "not enriched".
    const fetchDetail = opts.fetchDetail
    if (typeof fetchDetail !== 'function') throw new TypeError('fetchDetail is required')
    // A ttl-cache instance. Shared with whoever else wants detail records, so
    // the same title on three shelves and in the detail page is one request.
    const cache = opts.cache || null
    // (callback, options) -> { observe, unobserve, disconnect }
    const observerFactory = typeof opts.observerFactory === 'function' ? opts.observerFactory : null
    const concurrency = Number(opts.concurrency) > 0 ? Number(opts.concurrency) : CONCURRENCY
    const rootMargin = opts.rootMargin || ROOT_MARGIN
    const now = typeof opts.now === 'function' ? opts.now : function () { return Date.now() }
    const rank = typeof opts.distance === 'function' ? opts.distance : distance
    const retryBaseMs = Number(opts.retryBaseMs) >= 0 ? Number(opts.retryBaseMs) : RETRY_BASE_MS
    const retryMaxAttempts = Number(opts.retryMaxAttempts) >= 0 ? Number(opts.retryMaxAttempts) : RETRY_MAX_ATTEMPTS
    const onError = typeof opts.onError === 'function' ? opts.onError : function () {}

    // element -> { key, apply, dist, visible }
    const cards = new Map()
    // key -> Set<record>, so one response paints every card for that title.
    const byKey = new Map()
    // key -> distance. Membership here IS the queue; the value is the priority.
    const pending = new Map()
    // key -> Promise. The coalescing point: a second card wanting a title
    // already in the air attaches to the same promise rather than issuing a
    // second request.
    const inflight = new Map()
    // key -> { attempts, nextAt }
    const failures = new Map()

    let inflightCount = 0
    let destroyed = false
    const stats = { requests: 0, maxInFlight: 0, applied: 0, cacheHits: 0, coalesced: 0, failed: 0 }

    let observer = null
    if (observerFactory) {
      observer = observerFactory(handleEntries, { rootMargin: rootMargin, threshold: 0 })
    }

    function handleEntries(entries) {
      if (destroyed) return
      for (const entry of entries || []) {
        const rec = cards.get(entry.target)
        if (!rec) continue
        if (entry.isIntersecting) {
          rec.visible = true
          rec.dist = rank(entry)
          enqueue(rec)
        } else {
          // Scrolled past before its turn came up. Dropping it from the queue
          // here is the whole point of the module: the request that would have
          // been wasted is never made. An already-started request is left to
          // finish -- there is nothing to abort in a plain promise, and its
          // result still lands in the cache for the way back.
          rec.visible = false
          rec.dist = Infinity
          reprice(rec.key)
        }
      }
      pump()
    }

    // The queue holds one entry per title, priced at the distance of its
    // nearest visible card. Recomputed from the cards rather than carried
    // forward, so a card going away can only ever lower the queue's claim on a
    // title, never leave a stale one behind.
    function reprice(key) {
      const set = byKey.get(key)
      let best = Infinity
      if (set) for (const r of set) if (r.visible && r.dist < best) best = r.dist
      if (best === Infinity) pending.delete(key)
      else if (pending.has(key)) pending.set(key, best)
    }

    function enqueue(rec) {
      const key = rec.key
      // Already showing its detail. Visibility events fire on every scroll and
      // resize; without this a painted card would re-run its apply dozens of
      // times a second, and a card is never refreshed once filled -- a runtime
      // and a director do not change while the window is open.
      if (rec.painted) return
      const hit = cache ? cache.get(key) : undefined
      // Paint only the card that just appeared: its siblings for this title
      // were painted when they appeared, and re-delivering to all of them on
      // every scroll event would be O(cards) DOM writes per frame.
      if (hit !== undefined) { stats.cacheHits++; applyTo(rec, hit); return }
      if (inflight.has(key)) {
        // Already in the air for another card; ride along rather than queueing.
        stats.coalesced++
        return
      }
      if (!retryable(key)) return
      const prev = pending.has(key) ? pending.get(key) : Infinity
      pending.set(key, Math.min(prev, rec.dist))
    }

    function retryable(key) {
      const f = failures.get(key)
      if (!f) return true
      if (f.attempts >= retryMaxAttempts) return false
      return now() >= f.nextAt
    }

    function pickNearest() {
      let bestKey = null
      let bestDist = Infinity
      for (const [key, d] of pending) {
        // Cooldowns are checked at dispatch, not only at enqueue: a card can
        // sit queued across the whole window between the failure and its retry.
        if (!retryable(key)) { pending.delete(key); continue }
        // `<` not `<=`, so ties keep insertion order and a shelf paints
        // left-to-right instead of in Map-iteration accidents.
        if (d < bestDist) { bestDist = d; bestKey = key }
      }
      return bestKey
    }

    function pump() {
      if (destroyed) return
      while (inflightCount < concurrency) {
        const key = pickNearest()
        if (key == null) return
        pending.delete(key)
        start(key)
      }
    }

    function start(key) {
      inflightCount++
      if (inflightCount > stats.maxInFlight) stats.maxInFlight = inflightCount
      stats.requests++
      let p
      try {
        p = Promise.resolve(fetchDetail(key, { key: key }))
      } catch (err) {
        // A fetcher that throws synchronously must not take the pump down with
        // it, or one bad key stalls every remaining card.
        p = Promise.reject(err)
      }
      inflight.set(key, p)
      p.then(function (data) {
        if (cache && data !== undefined) cache.set(key, data)
        failures.delete(key)
        deliver(key, data)
      }, function (err) {
        stats.failed++
        const f = failures.get(key) || { attempts: 0, nextAt: 0 }
        f.attempts++
        f.nextAt = now() + retryBaseMs * Math.pow(2, f.attempts - 1)
        failures.set(key, f)
        try { onError(key, err) } catch (_) {}
      }).then(function () {
        inflight.delete(key)
        inflightCount--
        pump()
      })
    }

    // A response can outlive its card: the user scrolled on, the shelf was
    // re-rendered, the whole view was torn down. Every one of those leaves an
    // `apply` pointing at a detached element, so delivery is best-effort by
    // construction -- an empty key is a no-op and a throwing apply is contained
    // to its own card.
    function deliver(key, data) {
      const set = byKey.get(key)
      if (!set) return
      for (const rec of Array.from(set)) applyTo(rec, data)
    }

    function applyTo(rec, data) {
      rec.painted = true
      try { rec.apply(data, rec.key); stats.applied++ } catch (err) { try { onError(rec.key, err) } catch (_) {} }
    }

    function observe(el, key, apply) {
      if (destroyed || !el || !key || typeof apply !== 'function') return function () {}
      const rec = { key: String(key), apply: apply, dist: Infinity, visible: false, painted: false, el: el }
      cards.set(el, rec)
      let set = byKey.get(rec.key)
      if (!set) { set = new Set(); byKey.set(rec.key, set) }
      set.add(rec)
      // A title already resolved paints immediately, without waiting for the
      // observer to report -- this is the same-title-on-three-shelves case, and
      // making it wait a frame is a visible flicker for no reason.
      const hit = cache ? cache.get(rec.key) : undefined
      if (hit !== undefined) { stats.cacheHits++; applyTo(rec, hit) }
      // Observed even when it painted from cache, so unobserve() stays
      // symmetrical and the observer's bookkeeping never drifts from ours.
      if (observer) observer.observe(el)
      return function () { unobserve(el) }
    }

    function unobserve(el) {
      const rec = cards.get(el)
      if (!rec) return
      cards.delete(el)
      const set = byKey.get(rec.key)
      if (set) {
        set.delete(rec)
        if (set.size === 0) byKey.delete(rec.key)
      }
      reprice(rec.key)
      if (observer) { try { observer.unobserve(el) } catch (_) {} }
    }

    function destroy() {
      destroyed = true
      cards.clear(); byKey.clear(); pending.clear()
      if (observer) { try { observer.disconnect() } catch (_) {} }
    }

    return {
      observe: observe,
      unobserve: unobserve,
      destroy: destroy,
      // Force a title through the same cache/coalesce path as a card would,
      // for the detail page opening on a title the shelves never reached.
      prefetch: function (key) {
        if (destroyed || !key) return
        const hit = cache ? cache.get(key) : undefined
        if (hit !== undefined) return
        if (inflight.has(key) || !retryable(key)) return
        if (!pending.has(key)) pending.set(key, 0)
        pump()
      },
      // Test/diagnostic surface only.
      _stats: function () { return Object.assign({}, stats) },
      _pending: function () { return Array.from(pending.keys()) },
      _inflight: function () { return Array.from(inflight.keys()) },
      _failures: function () { return new Map(failures) },
      get concurrency() { return concurrency },
    }
  }

  return {
    createEnricher: createEnricher,
    distance: distance,
    CONCURRENCY: CONCURRENCY,
    RETRY_BASE_MS: RETRY_BASE_MS,
    RETRY_MAX_ATTEMPTS: RETRY_MAX_ATTEMPTS,
    ROOT_MARGIN: ROOT_MARGIN,
  }
})
