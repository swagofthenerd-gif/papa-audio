'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  CACHE_CAP, CACHE_TTL_MS, degraded, cacheKey, normalize, cacheGet, cacheSet,
  wikipediaTitleFromMb, wikidataIdFromMb, wikipediaTitleFromWikidata,
  bioFromWikiSummary, resolve,
} = require('../src/artist-info')

// --- shape / normalisation ------------------------------------------------

test('degraded is the always-safe {bio:null, similar:[]} shape', () => {
  assert.deepStrictEqual(degraded(), { bio: null, similar: [] })
})

test('cacheKey folds case and whitespace', () => {
  assert.strictEqual(cacheKey('Boards Of Canada'), 'boards of canada')
  assert.strictEqual(cacheKey('  Aphex   Twin '), 'aphex twin')
})

test('normalize coerces to the contract shape', () => {
  assert.deepStrictEqual(normalize({ bio: '  hi  ', similar: ['A', '', ' B '] }),
    { bio: 'hi', similar: ['A', 'B'] })
  assert.deepStrictEqual(normalize({ bio: '', similar: null }), { bio: null, similar: [] })
  assert.deepStrictEqual(normalize(null), { bio: null, similar: [] })
})

// --- MusicBrainz / Wikipedia parsing --------------------------------------

test('wikipediaTitleFromMb pulls the page title out of a wikipedia relation', () => {
  const mb = { relations: [
    { type: 'discogs', url: { resource: 'https://discogs.com/x' } },
    { type: 'wikipedia', url: { resource: 'https://en.wikipedia.org/wiki/Aphex_Twin' } },
  ] }
  assert.strictEqual(wikipediaTitleFromMb(mb), 'Aphex_Twin')
  assert.strictEqual(wikipediaTitleFromMb({ relations: [] }), null)
  assert.strictEqual(wikipediaTitleFromMb(null), null)
})

test('wikidataIdFromMb pulls the Q-id out of a wikidata relation', () => {
  const mb = { relations: [
    { type: 'discogs', url: { resource: 'https://discogs.com/x' } },
    { type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q123' } },
  ] }
  assert.strictEqual(wikidataIdFromMb(mb), 'Q123')
  assert.strictEqual(wikidataIdFromMb({ relations: [] }), null)
  assert.strictEqual(wikidataIdFromMb(null), null)
})

test('wikipediaTitleFromWikidata reads the enwiki sitelink title', () => {
  const entity = { entities: { Q123: { sitelinks: { enwiki: { title: 'Aphex Twin' } } } } }
  assert.strictEqual(wikipediaTitleFromWikidata(entity, 'Q123'), 'Aphex Twin')
  // No English sitelink → null.
  assert.strictEqual(
    wikipediaTitleFromWikidata({ entities: { Q1: { sitelinks: { frwiki: { title: 'X' } } } } }, 'Q1'),
    null)
  assert.strictEqual(wikipediaTitleFromWikidata(null, 'Q1'), null)
})

test('bioFromWikiSummary returns the extract for a standard page, null otherwise', () => {
  assert.strictEqual(bioFromWikiSummary({ type: 'standard', extract: 'A bio.' }), 'A bio.')
  assert.strictEqual(bioFromWikiSummary({ type: 'disambiguation', extract: 'x' }), null)
  assert.strictEqual(bioFromWikiSummary({ extract: '' }), null)
  assert.strictEqual(bioFromWikiSummary(null), null)
})

// --- cache (cap 100, 30-day TTL) ------------------------------------------

test('cacheSet / cacheGet round-trip a normalised entry', () => {
  const now = 1_000_000
  const store = cacheSet({}, 'aphex twin', { bio: 'Cornish electronic musician.', similar: [] }, now)
  assert.deepStrictEqual(cacheGet(store, 'aphex twin', now),
    { bio: 'Cornish electronic musician.', similar: [] })
})

test('cacheGet treats an entry past the 30-day TTL as absent', () => {
  const t0 = 1_000_000
  const store = cacheSet({}, 'a', { bio: 'x', similar: [] }, t0)
  assert.ok(cacheGet(store, 'a', t0 + CACHE_TTL_MS - 1))            // still fresh
  assert.strictEqual(cacheGet(store, 'a', t0 + CACHE_TTL_MS + 1), undefined) // expired
})

test('cacheSet evicts the oldest entries once over the cap of 100', () => {
  let store = {}
  // Insert cap+5 entries with strictly increasing timestamps.
  for (let i = 0; i < CACHE_CAP + 5; i++) {
    store = cacheSet(store, 'artist-' + i, { bio: 'b' + i, similar: [] }, 1000 + i)
  }
  const keys = Object.keys(store)
  assert.strictEqual(keys.length, CACHE_CAP)
  // The five oldest (artist-0..artist-4) are gone; the newest survive.
  assert.strictEqual(cacheGet(store, 'artist-0', 1000 + CACHE_CAP + 5), undefined)
  assert.ok(cacheGet(store, 'artist-' + (CACHE_CAP + 4), 1000 + CACHE_CAP + 5))
})

test('cacheSet never mutates the input store', () => {
  const original = {}
  const next = cacheSet(original, 'a', { bio: 'x', similar: [] }, 1)
  assert.deepStrictEqual(original, {})
  assert.notStrictEqual(next, original)
})

// --- resolve (injected fetchers, no network) ------------------------------

const wikiSummary = (extract) => ({ type: 'standard', extract })

test('resolve returns a bio via MusicBrainz→Wikipedia and similar:[] by design', async () => {
  const calls = []
  const info = await resolve('Aphex Twin', {
    mb: async (url) => {
      calls.push('mb')
      if (/\/artist\?/.test(url)) return { artists: [{ id: 'mbid-1', name: 'Aphex Twin' }] }
      return { relations: [{ type: 'wikipedia', url: { resource: 'https://en.wikipedia.org/wiki/Aphex_Twin' } }] }
    },
    wiki: async (url) => {
      calls.push('wiki')
      assert.match(url, /Aphex_Twin/)   // used the MB-resolved title
      return wikiSummary('Richard David James, known as Aphex Twin.')
    },
  })
  assert.strictEqual(info.bio, 'Richard David James, known as Aphex Twin.')
  assert.deepStrictEqual(info.similar, [])
  assert.deepStrictEqual(calls, ['mb', 'mb', 'wiki'])
})

test('resolve uses the Wikidata hop when MB has only a wikidata relation', async () => {
  const calls = []
  const info = await resolve('Aphex Twin', {
    mb: async (url) => (/\/artist\?/.test(url)
      ? { artists: [{ id: 'mbid-1', name: 'Aphex Twin' }] }
      // No direct wikipedia relation, only a wikidata one.
      : { relations: [{ type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q123' } }] }),
    wd: async (url) => {
      calls.push('wd')
      assert.match(url, /Q123/)
      return { entities: { Q123: { sitelinks: { enwiki: { title: 'Aphex Twin' } } } } }
    },
    wiki: async (url) => {
      assert.match(url, /Aphex%20Twin/)   // used the Wikidata-resolved title
      return wikiSummary('Richard David James.')
    },
  })
  assert.strictEqual(info.bio, 'Richard David James.')
  assert.deepStrictEqual(calls, ['wd'])
})

test('resolve falls back to a Wikipedia-by-name lookup when MB has no wiki link', async () => {
  const info = await resolve('Some Artist', {
    mb: async (url) => (/\/artist\?/.test(url)
      ? { artists: [{ id: 'mbid', name: 'Some Artist' }] }
      : { relations: [] }),   // no wikipedia relation
    wiki: async (url) => {
      assert.match(url, /Some%20Artist/)
      return wikiSummary('A musician.')
    },
  })
  assert.strictEqual(info.bio, 'A musician.')
})

test('resolve degrades to {bio:null, similar:[]} when every source fails', async () => {
  const info = await resolve('Nobody', {
    mb: async () => { throw new Error('MB down') },
    wiki: async () => { throw new Error('wiki down') },
  })
  assert.deepStrictEqual(info, { bio: null, similar: [] })
})

test('resolve degrades on a blank artist name without calling anything', async () => {
  let called = false
  const info = await resolve('   ', { mb: async () => { called = true }, wiki: async () => { called = true } })
  assert.deepStrictEqual(info, { bio: null, similar: [] })
  assert.strictEqual(called, false)
})

test('resolve treats a disambiguation page as no bio, then degrades', async () => {
  const info = await resolve('Ambiguous', {
    mb: async () => ({ artists: [] }),   // MB finds nothing → straight to name lookup
    wiki: async () => ({ type: 'disambiguation', extract: 'Could mean several things.' }),
  })
  assert.deepStrictEqual(info, { bio: null, similar: [] })
})
