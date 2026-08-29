'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  DEFAULT_BASE_URLS, buildQuery, buildFeedUrl, parseFeed,
  matchesEpisode, createNyaaProvider,
} = require('../providers/nyaa')

const item = (title, hash, seeders) =>
  `<item><title><![CDATA[${title}]]></title><link>https://nyaa.si/download/1.torrent</link>` +
  `<nyaa:infoHash>${hash}</nyaa:infoHash><nyaa:seeders>${seeders}</nyaa:seeders><nyaa:size>1.4 GiB</nyaa:size></item>`

const FEED = '<?xml version="1.0"?><rss><channel>' +
  item('[SubsPlease] Frieren - 09 (1080p) [AAC2.0]', 'HASH09', 120) +
  item('[Judas] Frieren - 09 [Dual Audio] [1080p] [DDP5.1]', 'HASHDUB', 30) +
  item('[SubsPlease] Frieren - 19 (1080p)', 'HASH19', 500) +
  item('[Batch] Frieren - 01~28 (1080p)', 'HASHBATCH', 900) +
  '</channel></rss>'

const feedResponse = xml => ({ ok: true, text: async () => xml })

test('buildQuery zero-pads the episode the way nyaa titles do', () => {
  assert.strictEqual(buildQuery('Frieren', 9), 'Frieren 09')
  assert.strictEqual(buildQuery('Frieren', 19), 'Frieren 19')
  assert.strictEqual(buildQuery('Frieren', null), 'Frieren')
  assert.strictEqual(buildQuery('', 9), '')
})

test('buildFeedUrl targets the English-translated anime category', () => {
  assert.strictEqual(
    buildFeedUrl('https://nyaa.si', 'Frieren 09'),
    'https://nyaa.si/?page=rss&q=Frieren%2009&c=1_2&f=0'
  )
})

test('parseFeed reads title, hash and seeders out of each item', () => {
  const items = parseFeed(FEED)
  assert.strictEqual(items.length, 4)
  assert.strictEqual(items[0].title, '[SubsPlease] Frieren - 09 (1080p) [AAC2.0]')
  assert.strictEqual(items[0].infoHash, 'HASH09')
  assert.strictEqual(items[0].seeders, 120)
})

test('parseFeed survives an empty or non-feed body', () => {
  assert.deepStrictEqual(parseFeed(''), [])
  assert.deepStrictEqual(parseFeed('<html>blocked</html>'), [])
  assert.deepStrictEqual(parseFeed(null), [])
})

// Nyaa's q= is a plain text search, so a query for "Frieren 09" happily returns
// episode 19 and batch packs. Playing one of those is worse than showing nothing.
test('matchesEpisode accepts the requested episode and rejects near-misses', () => {
  const t = '[SubsPlease] Frieren - 09 (1080p) [ABC].mkv'
  assert.strictEqual(matchesEpisode(t, 9), true)
  assert.strictEqual(matchesEpisode(t, 19), false)
  assert.strictEqual(matchesEpisode(t, 109), false)
  assert.strictEqual(matchesEpisode(t, null), true)
})

test('matchesEpisode handles the SxxEyy and v2 forms', () => {
  assert.strictEqual(matchesEpisode('Show S01E09 1080p', 9), true)
  assert.strictEqual(matchesEpisode('Show S01E09 1080p', 19), false)
  assert.strictEqual(matchesEpisode('Show S01E19 1080p', 9), false)
  assert.strictEqual(matchesEpisode('[Group] Show - 09v2 [1080p]', 9), true)
})

test('a batch pack is never mistaken for a single episode', () => {
  assert.strictEqual(matchesEpisode('[Batch] Frieren - 01~28 (1080p)', 9), false)
})

test('the provider returns only matching episodes, best-seeded first', async () => {
  const provider = createNyaaProvider({ fetchFn: async () => feedResponse(FEED) })
  const entries = await provider({ type: 'anime', title: 'Frieren', episode: 9 })
  assert.strictEqual(entries.length, 2, 'episode 19 and the batch pack must be excluded')
  assert.strictEqual(entries[0].infoHash, 'HASH09')
  assert.strictEqual(entries[0].seeds, 120)
  assert.strictEqual(entries[0].source, 'Nyaa')
  assert.ok(entries[0].magnet.startsWith('magnet:?xt=urn:btih:HASH09'))
  // The scratch ordering field must not leak into the entry contract.
  assert.ok(!('_preferred' in entries[0]))
})

test('asking for a dub promotes the dual-audio release above a better-seeded sub', async () => {
  const provider = createNyaaProvider({ fetchFn: async () => feedResponse(FEED) })
  const entries = await provider({ type: 'anime', title: 'Frieren', episode: 9, dub: true })
  assert.strictEqual(entries[0].infoHash, 'HASHDUB')
  assert.strictEqual(entries[0].dub, true)
  assert.strictEqual(entries[0].audioLayout, '5.1')
})

test('the provider declines non-anime requests and empty titles', async () => {
  let called = false
  const provider = createNyaaProvider({ fetchFn: async () => { called = true; return feedResponse(FEED) } })
  assert.deepStrictEqual(await provider({ type: 'movie', title: 'X', episode: 1 }), [])
  assert.deepStrictEqual(await provider({ type: 'anime', title: '', episode: 1 }), [])
  assert.strictEqual(called, false)
})

test('a dead mirror falls through and a total failure yields []', async () => {
  const calls = []
  const provider = createNyaaProvider({
    baseUrls: ['https://dead', 'https://live'],
    fetchFn: async url => {
      calls.push(url)
      if (url.startsWith('https://dead')) throw new Error('ENOTFOUND')
      return feedResponse(FEED)
    },
  })
  const entries = await provider({ type: 'anime', title: 'Frieren', episode: 9 })
  assert.strictEqual(entries.length, 2)
  assert.strictEqual(calls.length, 2)

  const allDead = createNyaaProvider({ baseUrls: ['https://a'], fetchFn: async () => { throw new Error('boom') } })
  assert.deepStrictEqual(await allDead({ type: 'anime', title: 'Frieren', episode: 9 }), [])
})

test('the default mirror list is used when none is injected', async () => {
  const calls = []
  const provider = createNyaaProvider({ fetchFn: async url => { calls.push(url); return feedResponse(FEED) } })
  await provider({ type: 'anime', title: 'Frieren', episode: 9 })
  assert.ok(calls[0].startsWith(DEFAULT_BASE_URLS[0]))
})

// ── Title fallback: the reason the anime section found nothing ──────────────
// Nyaa indexes releases under the ROMAJI title. Searching with AniList's
// English display title ("BLEACH: Thousand-Year Blood War - The Calamity")
// matched nothing at all for a large share of shows, because q= is a literal
// AND over every word in the query.
{
  const { titleCandidates } = require('../providers/nyaa')

  test('romaji is tried before english', () => {
    const c = titleCandidates({ titles: { english: 'Frieren: Beyond Journey’s End', romaji: 'Sousou no Frieren' } })
    assert.strictEqual(c[0], 'Sousou no Frieren')
    assert.ok(c.includes('Frieren: Beyond Journey’s End'))
  })

  test('season suffixes are dropped, since release names omit them', () => {
    const c = titleCandidates({ titles: { romaji: 'Tensei Shitara Slime Datta Ken 4th Season' } })
    assert.deepStrictEqual(c, ['Tensei Shitara Slime Datta Ken 4th Season', 'Tensei Shitara Slime Datta Ken'])
  })

  test('a trailing subtitle after a colon or dash is dropped', () => {
    const c = titleCandidates({ titles: { romaji: 'BLEACH: Sennen Kessen-hen - Kashin-tan' } })
    assert.ok(c.includes('BLEACH'), 'the bare series name must be one of the attempts')
  })

  test('"Season 2 Part 2" loses both suffixes', () => {
    const c = titleCandidates({ titles: { romaji: 'Some Show Season 2 Part 2' } })
    assert.ok(c.includes('Some Show'))
  })

  test('the plain request.title still works when no variants are supplied', () => {
    assert.deepStrictEqual(titleCandidates({ title: 'Frieren' }), ['Frieren'])
    assert.deepStrictEqual(titleCandidates({}), [])
  })

  test('candidates are de-duplicated case-insensitively', () => {
    const c = titleCandidates({ titles: { romaji: 'Naruto', english: 'naruto' }, title: 'NARUTO' })
    assert.strictEqual(c.length, 1)
  })

  const feed = titles => ({
    ok: true,
    text: async () => '<rss><channel>' + titles.map((t, i) =>
      `<item><title><![CDATA[${t}]]></title><nyaa:infoHash>H${i}</nyaa:infoHash><nyaa:seeders>${10 + i}</nyaa:seeders></item>`
    ).join('') + '</channel></rss>',
  })

  test('a title that finds nothing falls through to the next candidate', async () => {
    const queries = []
    const provider = createNyaaProvider({
      baseUrls: ['https://n'],
      fetchFn: async url => {
        const q = decodeURIComponent(new URL(url).searchParams.get('q'))
        queries.push(q)
        // Only the romaji-derived query has anything indexed.
        if (q.startsWith('Sousou no Frieren')) return feed(['[SubsPlease] Sousou no Frieren - 09 (1080p)'])
        return feed([])
      },
    })
    const entries = await provider({
      type: 'anime', episode: 9,
      titles: { english: 'Frieren: Beyond Journey’s End', romaji: 'Sousou no Frieren' },
    })
    assert.strictEqual(entries.length, 1)
    assert.strictEqual(queries[0], 'Sousou no Frieren 09', 'romaji must be attempted first')
  })

  test('the first candidate that yields results stops the search', async () => {
    let calls = 0
    const provider = createNyaaProvider({
      baseUrls: ['https://n'],
      fetchFn: async () => { calls++; return feed(['[G] Show - 01 (1080p)']) },
    })
    const entries = await provider({ type: 'anime', episode: 1, titles: { romaji: 'Show Season 2', english: 'Other' } })
    assert.strictEqual(entries.length, 1)
    assert.strictEqual(calls, 1, 'a hit on the first candidate must not trigger more requests')
  })

  test('every candidate failing still returns [] rather than throwing', async () => {
    const provider = createNyaaProvider({ baseUrls: ['https://n'], fetchFn: async () => feed([]) })
    assert.deepStrictEqual(
      await provider({ type: 'anime', episode: 9, titles: { romaji: 'A', english: 'B' } }),
      []
    )
  })
}
