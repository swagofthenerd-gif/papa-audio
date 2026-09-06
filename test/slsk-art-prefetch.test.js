'use strict'
// Pure-logic tests for the record shop's cover-art prefetch planner. The
// renderer owns the actual fetch pump and the IntersectionObserver; this module
// only decides ORDER, dedupes identities, and accounts for the negative cache.
const test = require('node:test')
const assert = require('node:assert')
const P = require('../src/slsk-art-prefetch')

// A normKey stub matching slsk-shelves' behaviour closely enough for ordering
// tests: lowercase, collapse non-alphanumerics, strip a leading article.
function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^\s*(the|a|an)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const alb = (artist, album, extra) => Object.assign({ artist, album }, extra || {})

test('planArtPrefetch orders Upgrades, then Missing-first, then the rest', () => {
  const shelves = {
    upgrades: [alb('A', 'Up1'), alb('B', 'Up2')],
    missing: [alb('C', 'Miss1'), alb('D', 'Miss2'), alb('E', 'Miss3')],
    surround: [alb('F', 'Sur1')],
    hires: [alb('G', 'Hi1')],
    everything: [alb('A', 'Up1'), alb('C', 'Miss1'), alb('H', 'Ev1')],
  }
  const plan = P.planArtPrefetch(shelves, { normKey, missingFirst: 2 })
  const albums = plan.map(p => p.album)
  // Upgrades first (in order), then first 2 Missing, then remaining Missing,
  // then Surround, Hi-Res, then Everything's new identities.
  assert.deepStrictEqual(albums, ['Up1', 'Up2', 'Miss1', 'Miss2', 'Miss3', 'Sur1', 'Hi1', 'Ev1'])
})

test('planArtPrefetch dedupes the same identity across shelves', () => {
  const shelves = {
    upgrades: [alb('Radiohead', 'OK Computer')],
    missing: [],
    // Same album under a different folder / casing appears in Everything.
    everything: [alb('radiohead', 'ok computer'), alb('Björk', 'Homogenic')],
  }
  const plan = P.planArtPrefetch(shelves, { normKey })
  assert.strictEqual(plan.length, 2, 'the duplicate identity is fetched once')
  assert.strictEqual(plan[0].album, 'OK Computer')
  assert.strictEqual(plan[1].album, 'Homogenic')
})

test('planArtPrefetch skips albums with local art', () => {
  const shelves = {
    upgrades: [alb('A', 'HasLocal'), alb('B', 'NoLocal')],
    everything: [],
  }
  const hasLocalArt = (a) => a.album === 'HasLocal'
  const plan = P.planArtPrefetch(shelves, { normKey, hasLocalArt })
  assert.deepStrictEqual(plan.map(p => p.album), ['NoLocal'])
})

test('planArtPrefetch skips already-cached identities (session + disk)', () => {
  const shelves = { upgrades: [alb('A', 'Cached'), alb('B', 'Fresh')], everything: [] }
  const cache = new Map([[normKey('A Cached'), 'file:///x.jpg']])
  const plan = P.planArtPrefetch(shelves, {
    normKey, alreadyCached: (k) => cache.has(k),
  })
  assert.deepStrictEqual(plan.map(p => p.album), ['Fresh'])
})

test('planArtPrefetch skips entries with no artist and no album', () => {
  const shelves = { upgrades: [alb('', ''), alb('', 'JustAlbum')], everything: [] }
  const plan = P.planArtPrefetch(shelves, { normKey })
  assert.deepStrictEqual(plan.map(p => p.album), ['JustAlbum'])
})

test('planArtPrefetch tolerates missing/empty shelves', () => {
  assert.deepStrictEqual(P.planArtPrefetch(null, { normKey }), [])
  assert.deepStrictEqual(P.planArtPrefetch({}, { normKey }), [])
  assert.deepStrictEqual(P.planArtPrefetch({ everything: [] }, { normKey }), [])
})

test('planArtPrefetch carries artist and album through for the fetch', () => {
  const shelves = { upgrades: [alb('Aphex Twin', 'Drukqs')], everything: [] }
  const plan = P.planArtPrefetch(shelves, { normKey })
  assert.deepStrictEqual(plan[0], {
    key: normKey('Aphex Twin Drukqs'), artist: 'Aphex Twin', album: 'Drukqs',
  })
})

test('shouldFetchArt: unknown key fetches, recorded miss and hit do not', () => {
  const store = new Map()
  assert.strictEqual(P.shouldFetchArt(store, 'k'), true, 'unknown → fetch')
  store.set('miss', '')            // recorded miss
  store.set('hit', 'file:///a.jpg')  // painted hit
  assert.strictEqual(P.shouldFetchArt(store, 'miss'), false, 'miss → no refetch')
  assert.strictEqual(P.shouldFetchArt(store, 'hit'), false, 'hit → nothing to do')
  assert.strictEqual(P.shouldFetchArt(store, ''), false, 'empty key never fetches')
  assert.strictEqual(P.shouldFetchArt(null, 'k'), true, 'no store → fetch')
})

test('artKeyOf uses the injected normKey and is order-stable for identity', () => {
  const k1 = P.artKeyOf({ artist: 'The Cure', album: 'Disintegration' }, normKey)
  const k2 = P.artKeyOf({ artist: 'the cure', album: 'disintegration' }, normKey)
  assert.strictEqual(k1, k2)
})
