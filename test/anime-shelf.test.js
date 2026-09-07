'use strict'
// The anime shelf fallback chain: live AniList → live Jikan/MAL → saved list →
// honest outage. This pins the ORDER and the branch points — especially that
// Jikan is only reached on a real outage, and that a jikan-fails result falls
// through to the saved cache rather than lying "nothing here". The chain exists
// because AniList has recurring global 403 outages; getting the order wrong means
// either an error page when a fallback was available, or a stale list served over
// a live one.
const test = require('node:test')
const assert = require('node:assert')
const { resolveAnimeShelf } = require('../catalog/anime-shelf')

// A card as the shelves render it. AniList cards carry a numeric id; Jikan
// fallback cards are marked source:'mal' with a mal- id.
const anilistCard = { id: 21, type: 'anime', title: 'One Piece', source: undefined }
const malCard = { id: 'mal-21', type: 'anime', title: 'One Piece', source: 'mal' }

// A dependency bag with recording stubs, so a test can assert both the returned
// shape and the side effects (what was cached, whether Jikan was even asked).
function deps(over = {}) {
  const calls = { fetchJikan: 0, writeCache: 0, memoWrite: 0 }
  const wrote = []
  return {
    calls, wrote,
    bag: {
      fetchJikan: async () => { calls.fetchJikan++; return over.jikan || [] },
      readCache: over.readCache || (() => over.saved || null),
      writeCache: (r) => { calls.writeCache++; wrote.push(r) },
      memoWrite: () => { calls.memoWrite++ },
    },
  }
}

// ── Step 1: a live, non-empty AniList result always wins ─────────────────────
test('a live AniList result wins and is cached — Jikan is never asked', async () => {
  const d = deps({ jikan: [malCard] })
  const out = await resolveAnimeShelf({ results: [anilistCard], failure: null }, d.bag)
  assert.strictEqual(out.ok, true)
  assert.deepStrictEqual(out.results, [anilistCard])
  assert.strictEqual(out.viaMal, undefined, 'not a MAL fallback')
  assert.strictEqual(out.fromCache, undefined)
  assert.strictEqual(d.calls.fetchJikan, 0, 'a healthy AniList never reaches Jikan')
  assert.strictEqual(d.calls.writeCache, 1, 'the good result is saved for a later outage')
  assert.strictEqual(d.calls.memoWrite, 1)
})

// ── A healthy-but-empty AniList is not an outage ─────────────────────────────
test('a healthy-but-empty AniList result falls through to a plain empty list, not a fallback', async () => {
  const d = deps({ jikan: [malCard], saved: { value: [anilistCard] } })
  const out = await resolveAnimeShelf({ results: [], failure: null }, d.bag)
  assert.deepStrictEqual(out, { ok: true, results: [] })
  assert.strictEqual(d.calls.fetchJikan, 0, 'no outage means no fallback, even with Jikan and a cache available')
})

// ── Step 2: an outage reaches live Jikan ─────────────────────────────────────
test('an AniList outage falls to live Jikan, marked viaMal and carrying the outage message', async () => {
  const d = deps({ jikan: [malCard] })
  const out = await resolveAnimeShelf(
    { results: [], failure: { message: 'AniList request failed (403)', status: 403 } }, d.bag)
  assert.strictEqual(d.calls.fetchJikan, 1, 'the outage reached Jikan')
  assert.deepStrictEqual(out.results, [malCard])
  assert.strictEqual(out.viaMal, true)
  assert.strictEqual(out.outage, 'AniList request failed (403)')
  assert.strictEqual(out.fromCache, undefined, 'a fresh Jikan hit is not a stale saved list')
  // A fresh Jikan result is cached like an AniList one, source mark and all.
  assert.strictEqual(d.calls.writeCache, 1)
  assert.strictEqual(d.wrote[0][0].source, 'mal', 'the MAL source mark rides through the cache write')
})

// ── Step 3: Jikan fails too → the saved list, NOT an error ───────────────────
test('when both AniList and Jikan are down, the last saved list is served (fromCache)', async () => {
  const d = deps({ jikan: [], saved: { value: [malCard] } })
  const out = await resolveAnimeShelf(
    { results: [], failure: { message: 'AniList request failed (403)', status: 403 } }, d.bag)
  assert.strictEqual(d.calls.fetchJikan, 1, 'Jikan was tried before the cache')
  assert.deepStrictEqual(out.results, [malCard])
  assert.strictEqual(out.fromCache, true)
  assert.strictEqual(out.viaMal, undefined, 'a saved list is not a live MAL hit')
  assert.strictEqual(out.outage, 'AniList request failed (403)')
  assert.strictEqual(d.calls.writeCache, 0, 'a served-from-cache result is not re-cached')
})

// ── Step 4: nothing anywhere → an honest outage, never "nothing here" ────────
test('with AniList down, Jikan empty and no cache, the result is an honest outage', async () => {
  const d = deps({ jikan: [], saved: null })
  const out = await resolveAnimeShelf(
    { results: [], failure: { message: 'AniList request failed (403)', status: 403 } }, d.bag)
  assert.deepStrictEqual(out, { ok: true, results: [], outage: 'AniList request failed (403)' })
})

// An empty saved list is not a usable fallback — it must read as an outage, not a
// silently-empty shelf.
test('an empty saved list is treated as no cache — an honest outage, not a blank shelf', async () => {
  const d = deps({ jikan: [], saved: { value: [] } })
  const out = await resolveAnimeShelf(
    { results: [], failure: { message: 'down', status: 403 } }, d.bag)
  assert.strictEqual(out.outage, 'down')
  assert.deepStrictEqual(out.results, [])
})
