'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  DEFAULT_BASE_URLS, buildSearchUrl, buildQueries, matchesTitle, matchesYear,
  matchesEpisode, matchesAnimeEpisode, requestTitles, isSentinel,
  normalizeResult, createApibayProvider, _resetMirrorHealth,
} = require('../providers/apibay')

const HASH = i => String(i).padStart(40, 'a')
const row = (name, over = {}) => Object.assign({
  id: '123', name, info_hash: HASH(1), seeders: '50', leechers: '2', size: '2000000000', category: '207',
}, over)

const jsonResponse = body => ({ ok: true, text: async () => JSON.stringify(body) })

test('buildSearchUrl targets the whole video category', () => {
  assert.strictEqual(
    buildSearchUrl('https://apibay.org', 'Dune 2024'),
    'https://apibay.org/q.php?q=Dune%202024&cat=200'
  )
})

// apibay signals "nothing found" with one sentinel row, not an empty array.
// Left in, it becomes an entry with a zero hash that can never play.
test('the no-results sentinel is rejected', () => {
  assert.strictEqual(isSentinel({ id: '0', name: 'No results returned', info_hash: '0'.repeat(40) }), true)
  assert.strictEqual(isSentinel({ id: '9', name: 'Real', info_hash: 'zz' }), true, 'a non-hex hash is unusable')
  assert.strictEqual(isSentinel(row('Real Movie 2024')), false)
})

// Without a title check a search for "Dune" happily returns "Dune Drifter".
test('matchesTitle requires every significant word of the title', () => {
  assert.strictEqual(matchesTitle('Dune.Part.Two.2024.1080p', 'Dune: Part Two'), true)
  assert.strictEqual(matchesTitle('Dune.Drifter.2020.1080p', 'Dune: Part Two'), false)
  assert.strictEqual(matchesTitle('Interstellar.2014.1080p', 'Interstellar'), true)
})

test('matchesTitle ignores punctuation and stopwords', () => {
  assert.strictEqual(matchesTitle('The.Grand.Budapest.Hotel.2014', 'The Grand Budapest Hotel'), true)
  assert.strictEqual(matchesTitle('Spider Man Across the Spider Verse', 'Spider-Man: Across the Spider-Verse'), true)
})

test('matchesYear allows a one-year drift for re-releases', () => {
  assert.strictEqual(matchesYear('Movie.2014.1080p', 2014), true)
  assert.strictEqual(matchesYear('Movie.2015.REMASTERED', 2014), true)
  assert.strictEqual(matchesYear('Movie.1999.1080p', 2014), false)
  assert.strictEqual(matchesYear('Movie.1080p', null), true)
  // A name with no year cannot contradict the request — and rejecting those
  // would discard exactly what the bare-title fallback query is for.
  assert.strictEqual(matchesYear('Movie.1080p.BluRay', 2014), true)
})

test('matchesEpisode accepts SxxEyy, 1x02 and full-season packs', () => {
  assert.strictEqual(matchesEpisode('Show.S01E02.1080p', 1, 2), true)
  assert.strictEqual(matchesEpisode('Show 1x02 720p', 1, 2), true)
  assert.strictEqual(matchesEpisode('Show.Season.1.Complete', 1, 2), true, 'a season pack contains the episode')
  assert.strictEqual(matchesEpisode('Show.S02E02.1080p', 1, 2), false)
  assert.strictEqual(matchesEpisode('Show.S01E03.1080p', 1, 2), false)
})

test('matchesAnimeEpisode handles bare numbers and batch ranges', () => {
  assert.strictEqual(matchesAnimeEpisode('[Group] Show - 09 (1080p)', 9), true)
  assert.strictEqual(matchesAnimeEpisode('[Group] Show - 19 (1080p)', 9), false)
  assert.strictEqual(matchesAnimeEpisode('[Group] Show 01-24 Batch', 9), true)
  assert.strictEqual(matchesAnimeEpisode('[Group] Show Complete', 9), true)
})

// Audit #3: a season known without a usable episode number must filter by
// season, not fall through to accept-all. Before the fix, a non-numeric episode
// accepted every result, flooding the sources list with other seasons.
test('matchesEpisode filters by season alone when the episode is not numeric', () => {
  // The requested season is accepted through any of its forms…
  assert.strictEqual(matchesEpisode('Show.S02E05.1080p', 2, null), true, 'SxxEyy in season 2')
  assert.strictEqual(matchesEpisode('Show 2x05 720p', 2, null), true, '2x05 in season 2')
  assert.strictEqual(matchesEpisode('Show.Season.2.Complete', 2, null), true, 'season-2 pack')
  // …and the wrong season is rejected rather than accepted wholesale.
  assert.strictEqual(matchesEpisode('Show.S01E05.1080p', 2, ''), false, 'wrong season rejected')
  assert.strictEqual(matchesEpisode('Show.Season.3.Complete', 2, undefined), false, 'wrong-season pack rejected')
  // A movie request (neither number) still accepts everything.
  assert.strictEqual(matchesEpisode('Some Movie 2020', null, null), true, 'movie request accepts all')
})

// Audit #4: a stated range is authoritative in both directions. A pack labelled
// "Batch"/"Complete" whose stated range excludes the episode must be rejected —
// the range decides, not the keyword. (Ported from nyaa's isPack logic.)
test('matchesAnimeEpisode: a stated range excluding the episode is rejected despite Batch/Complete', () => {
  // Range excludes 20 → reject even with the batch keyword present.
  assert.strictEqual(matchesAnimeEpisode('[Group] Show 01-12 Batch', 20), false, 'range 01-12 excludes ep 20')
  assert.strictEqual(matchesAnimeEpisode('[Group] Show 01~12 Complete', 20), false, 'range 01~12 excludes ep 20')
  // Range spans 05 → accepted (the range decides in its favour).
  assert.strictEqual(matchesAnimeEpisode('[Group] Show 01-12 Batch', 5), true, 'range 01-12 spans ep 5')
  // No stated range → a bare Batch/Complete stays accepted (the label is the evidence).
  assert.strictEqual(matchesAnimeEpisode('[Group] Show Batch', 20), true, 'bare batch, no range, accepted')
  assert.strictEqual(matchesAnimeEpisode('[Group] Show Complete', 20), true, 'bare complete, no range, accepted')
  // The absolute number rescues a range that spans it even if the plain one is out.
  assert.strictEqual(matchesAnimeEpisode('[Group] Show 1001-1100 Batch', 12, { absoluteEpisode: 1050 }), true,
    'absolute number 1050 lies inside the stated range')
})

test('requestTitles prefers romaji and de-duplicates', () => {
  assert.deepStrictEqual(
    requestTitles({ titles: { romaji: 'Sousou no Frieren', english: 'Frieren' }, title: 'frieren' }),
    ['Sousou no Frieren', 'Frieren']
  )
})

// Cam rips are a filmed cinema screen. They stay playable but must never be
// offered ahead of a real encode.
test('cam and telesync releases are flagged, not silently offered as normal', () => {
  const cam = normalizeResult(row('Interstellar.2014.TS.XViD.AC3'))
  assert.strictEqual(cam.lowQuality, true)
  assert.match(cam.label, /poor quality/)
  const real = normalizeResult(row('Interstellar.2014.1080p.BluRay.DDP5.1'))
  assert.strictEqual(real.lowQuality, false)
  assert.strictEqual(real.quality, '1080p')
  assert.strictEqual(real.audioLayout, '5.1')
})

test('normalizeResult builds a magnet and carries seeds', () => {
  const e = normalizeResult(row('Movie.2024.1080p', { seeders: '321' }))
  assert.strictEqual(e.kind, 'torrent')
  assert.strictEqual(e.source, 'TPB')
  assert.strictEqual(e.seeds, 321)
  assert.ok(e.magnet.startsWith('magnet:?xt=urn:btih:' + HASH(1)))
  assert.ok(e.magnet.includes('tr=udp'))
})

test('buildQueries tries the year first, then the bare title', () => {
  assert.deepStrictEqual(buildQueries({ type: 'movie', title: 'Dune', year: 2021 }), ['Dune 2021', 'Dune'])
  assert.deepStrictEqual(buildQueries({ type: 'movie', title: 'Dune' }), ['Dune'])
})

test('buildQueries for TV tries the episode, then the season, then the show', () => {
  assert.deepStrictEqual(
    buildQueries({ type: 'tv', title: 'Breaking Bad', season: 1, episode: 2 }),
    ['Breaking Bad S01E02', 'Breaking Bad season 1', 'Breaking Bad']
  )
})

test('the provider filters unrelated films out of a fuzzy search', async () => {
  const provider = createApibayProvider({
    baseUrls: ['https://a'],
    fetchFn: async () => jsonResponse([
      row('Dune.Drifter.2020.1080p', { info_hash: HASH(2) }),
      row('Dune.Part.Two.2024.1080p.BluRay', { info_hash: HASH(3), seeders: '900' }),
    ]),
  })
  const out = await provider({ type: 'movie', title: 'Dune: Part Two', year: 2024 })
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].seeds, 900)
})

test('real encodes are offered before cam rips regardless of seed count', async () => {
  const provider = createApibayProvider({
    baseUrls: ['https://a'],
    fetchFn: async () => jsonResponse([
      row('Movie.2024.HDCAM.x264', { info_hash: HASH(4), seeders: '9999' }),
      row('Movie.2024.1080p.WEB-DL', { info_hash: HASH(5), seeders: '10' }),
    ]),
  })
  const out = await provider({ type: 'movie', title: 'Movie', year: 2024 })
  assert.strictEqual(out.length, 2, 'the cam rip stays available as a last resort')
  assert.strictEqual(out[0].lowQuality, false, 'but never first')
  assert.strictEqual(out[1].lowQuality, true)
})

test('an empty first query falls through to the broader one', async () => {
  const queries = []
  const provider = createApibayProvider({
    baseUrls: ['https://a'],
    fetchFn: async url => {
      const q = decodeURIComponent(new URL(url).searchParams.get('q'))
      queries.push(q)
      if (q.includes('2024')) return jsonResponse([{ id: '0', name: 'No results returned', info_hash: '0'.repeat(40) }])
      return jsonResponse([row('Movie.1080p.BluRay', { info_hash: HASH(6) })])
    },
  })
  const out = await provider({ type: 'movie', title: 'Movie', year: 2024 })
  assert.strictEqual(out.length, 1)
  assert.deepStrictEqual(queries, ['Movie 2024', 'Movie'])
})

test('duplicate info hashes across queries are only offered once', async () => {
  const provider = createApibayProvider({
    baseUrls: ['https://a'],
    fetchFn: async () => jsonResponse([
      row('Movie.2024.1080p', { info_hash: HASH(7) }),
      row('Movie.2024.1080p.REPACK', { info_hash: HASH(7) }),
    ]),
  })
  const out = await provider({ type: 'movie', title: 'Movie', year: 2024 })
  assert.strictEqual(out.length, 1)
})

test('a dead mirror falls through and total failure yields []', async () => {
  const calls = []
  const provider = createApibayProvider({
    baseUrls: ['https://dead', 'https://live'],
    fetchFn: async url => {
      calls.push(url)
      if (url.startsWith('https://dead')) throw new Error('ENOTFOUND')
      return jsonResponse([row('Movie.2024.1080p', { info_hash: HASH(8) })])
    },
  })
  assert.strictEqual((await provider({ type: 'movie', title: 'Movie', year: 2024 })).length, 1)
  assert.ok(calls.length >= 2)

  const allDead = createApibayProvider({ baseUrls: ['https://x'], fetchFn: async () => { throw new Error('boom') } })
  assert.deepStrictEqual(await allDead({ type: 'movie', title: 'Movie', year: 2024 }), [])
})

test('non-video requests and empty titles are declined without a request', async () => {
  let called = false
  const provider = createApibayProvider({ fetchFn: async () => { called = true; return jsonResponse([]) } })
  assert.deepStrictEqual(await provider({ type: 'music', title: 'X' }), [])
  assert.deepStrictEqual(await provider({ type: 'movie', title: '' }), [])
  assert.strictEqual(called, false)
})

// A bare prefix match let a token claim the tail of a longer word: searching
// for "Her" matched "Another Movie" because "another " ends in "her ".
test('matchesTitle requires whole words, not word tails', () => {
  assert.strictEqual(matchesTitle('Another.Movie.2020.1080p', 'Her'), false)
  assert.strictEqual(matchesTitle('Her.2013.1080p.BluRay', 'Her'), true)
  assert.strictEqual(matchesTitle('Mother.2017.1080p', 'Her'), false)
})

// A pack labelled some OTHER season cannot contain the episode, however loudly
// it says "batch". Unlabelled packs stay accepted: the label is the evidence.
test('an anime pack labelled a different season is rejected when the season is known', () => {
  assert.strictEqual(matchesAnimeEpisode('[G] Show Season 2 Batch', 5, { season: 1 }), false)
  assert.strictEqual(matchesAnimeEpisode('[G] Show Season 1 Batch', 5, { season: 1 }), true)
  assert.strictEqual(matchesAnimeEpisode('[G] Show Complete', 5, { season: 1 }), true)
  // Without a known season the label proves nothing either way.
  assert.strictEqual(matchesAnimeEpisode('[G] Show Season 2 Batch', 5), true)
})

// Long-running shows are indexed by absolute number ("One Piece 1071"), so a
// release naming either the seasonal or the absolute number is the episode.
test('matchesAnimeEpisode accepts the absolute number when the caller supplies it', () => {
  assert.strictEqual(matchesAnimeEpisode('[G] Show - 64 (1080p)', 12, { absoluteEpisode: 64 }), true)
  assert.strictEqual(matchesAnimeEpisode('[G] Show - 64 (1080p)', 12), false)
  assert.strictEqual(matchesAnimeEpisode('[G] Show - 12 (1080p)', 12, { absoluteEpisode: 64 }), true)
  assert.strictEqual(matchesAnimeEpisode('[G] Show - 65 (1080p)', 12, { absoluteEpisode: 64 }), false)
})

test('buildQueries adds an absolute-number variant for anime when one is supplied', () => {
  assert.deepStrictEqual(
    buildQueries({ type: 'anime', title: 'Show', episode: 12, absoluteEpisode: 64 }),
    ['Show 12', 'Show 64', 'Show']
  )
  assert.deepStrictEqual(
    buildQueries({ type: 'anime', title: 'Show', episode: 12 }),
    ['Show 12', 'Show'],
    'nothing changes when no absolute number is supplied'
  )
})

// A dead first mirror otherwise burns its timeout on every single lookup.
test('the mirror that answered last is tried first on the next query', async () => {
  _resetMirrorHealth()
  const calls = []
  const provider = createApibayProvider({
    baseUrls: ['https://dead', 'https://live'],
    fetchFn: async url => {
      calls.push(new URL(url).origin)
      if (url.startsWith('https://dead')) throw new Error('ENOTFOUND')
      return jsonResponse([row('Movie.2024.1080p', { info_hash: HASH(10) })])
    },
  })
  await provider({ type: 'movie', title: 'Movie', year: 2024 })
  assert.deepStrictEqual(calls, ['https://dead', 'https://live'])
  await provider({ type: 'movie', title: 'Movie', year: 2024 })
  assert.strictEqual(calls[2], 'https://live', 'the known-good mirror must lead')
  _resetMirrorHealth()
})

test('the default mirror list is used when none is injected', async () => {
  const calls = []
  const provider = createApibayProvider({
    fetchFn: async url => { calls.push(url); return jsonResponse([row('Movie.2024.1080p', { info_hash: HASH(9) })]) },
  })
  await provider({ type: 'movie', title: 'Movie', year: 2024 })
  assert.ok(calls[0].startsWith(DEFAULT_BASE_URLS[0]))
})
