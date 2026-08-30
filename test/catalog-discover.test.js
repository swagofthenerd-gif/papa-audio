'use strict'
// The discovery layer: URL/variable builders and normalisers for both
// catalogs. Pure, so these run offline against injected fetches.
const test = require('node:test')
const assert = require('node:assert')
const tmdb = require('../catalog/tmdb')
const anilist = require('../catalog/anilist')

// ── TMDB discover ───────────────────────────────────────────────────────────

test('discover maps neutral filter names to each media type’s TMDB names', () => {
  const movie = tmdb.buildDiscoverUrl('movie', { yearFrom: 2015, yearTo: 2020 })
  assert.match(movie, /primary_release_date\.gte=2015-01-01/)
  assert.match(movie, /primary_release_date\.lte=2020-12-31/)
  // A series has no primary_release_date; sending one silently returns nothing.
  const tv = tmdb.buildDiscoverUrl('tv', { yearFrom: 2015, yearTo: 2020 })
  assert.match(tv, /first_air_date\.gte=2015-01-01/)
  assert.match(tv, /first_air_date\.lte=2020-12-31/)
  assert.ok(!/primary_release_date/.test(tv))
})

test('sort names map per media type', () => {
  assert.match(tmdb.buildDiscoverUrl('movie', { sort: 'newest' }), /sort_by=primary_release_date\.desc/)
  assert.match(tmdb.buildDiscoverUrl('tv', { sort: 'newest' }), /sort_by=first_air_date\.desc/)
  assert.match(tmdb.buildDiscoverUrl('tv', { sort: 'title' }), /sort_by=name\.asc/)
  assert.match(tmdb.buildDiscoverUrl('movie', { sort: 'title' }), /sort_by=title\.asc/)
})

test('an unknown sort falls back to popularity rather than sending junk', () => {
  assert.match(tmdb.buildDiscoverUrl('movie', { sort: 'nonsense' }), /sort_by=popularity\.desc/)
  assert.match(tmdb.buildDiscoverUrl('movie', {}), /sort_by=popularity\.desc/)
})

// Sorting by rating with no vote floor surfaces titles with three votes and a
// perfect score. That is noise, not a recommendation.
test('sorting by rating applies a vote floor automatically', () => {
  assert.match(tmdb.buildDiscoverUrl('movie', { sort: 'rating' }), /vote_count\.gte=200/)
  assert.match(tmdb.buildDiscoverUrl('movie', { sort: 'rating', minVotes: 1000 }), /vote_count\.gte=1000/)
  // Other sorts must not be silently narrowed.
  assert.ok(!/vote_count/.test(tmdb.buildDiscoverUrl('movie', { sort: 'popularity' })))
})

test('genres can be included and excluded', () => {
  const url = tmdb.buildDiscoverUrl('movie', { genres: [28, 12], excludeGenres: [27] })
  assert.match(url, /with_genres=28%2C12/)
  assert.match(url, /without_genres=27/)
})

test('empty and absent filters are omitted, not sent as blanks', () => {
  const url = tmdb.buildDiscoverUrl('movie', { genres: [], minRating: '', language: null, runtimeFrom: undefined })
  assert.ok(!/with_genres/.test(url))
  assert.ok(!/vote_average/.test(url))
  assert.ok(!/with_original_language/.test(url))
  assert.ok(!/with_runtime/.test(url))
})

test('adult content is excluded unless explicitly asked for', () => {
  assert.match(tmdb.buildDiscoverUrl('movie', {}), /include_adult=false/)
  assert.ok(!/include_adult/.test(tmdb.buildDiscoverUrl('movie', { includeAdult: true })))
})

test('discover returns paging information, not just a list', async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({
    page: 2, total_pages: 7, total_results: 132,
    results: [{ id: 1, title: 'A', release_date: '2020-01-01', vote_average: 7.5 }],
  }) })
  const cat = tmdb.createTmdbCatalog({ apiKey: 'k', fetchFn })
  const out = await cat.discover('movie', { page: 2 })
  assert.strictEqual(out.page, 2)
  assert.strictEqual(out.totalPages, 7)
  assert.strictEqual(out.totalResults, 132)
  assert.strictEqual(out.results[0].title, 'A')
})

test('genres are normalised to id and name only', async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({
    genres: [{ id: 28, name: 'Action' }, { id: null, name: 'Broken' }, { id: 1 }],
  }) })
  const cat = tmdb.createTmdbCatalog({ apiKey: 'k', fetchFn })
  assert.deepStrictEqual(await cat.genres('movie'), [{ id: 28, name: 'Action' }])
})

test('a person carries what is needed to tell two of the same name apart', () => {
  const p = tmdb.normalizePerson({
    id: 5, name: 'Denis Villeneuve', profile_path: '/p.jpg', known_for_department: 'Directing',
    known_for: [{ media_type: 'movie', title: 'Dune' }, { media_type: 'tv', name: 'Show' }],
  })
  assert.strictEqual(p.type, 'person')
  assert.strictEqual(p.department, 'Directing')
  assert.deepStrictEqual(p.knownFor, ['Dune', 'Show'])
  assert.strictEqual(tmdb.normalizePerson(null), null)
  assert.strictEqual(tmdb.normalizePerson({ name: 'no id' }), null)
})

// One person is frequently writer and director on the same title, and a
// recurring actor appears once per episode credit.
test('a filmography lists each title once, newest first', async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({
    cast: [{ id: 1, media_type: 'movie', title: 'Old', release_date: '1999-01-01' },
           { id: 2, media_type: 'movie', title: 'New', release_date: '2021-01-01' }],
    crew: [{ id: 2, media_type: 'movie', title: 'New', release_date: '2021-01-01' },
           { id: 3, media_type: 'person', name: 'not a title' }],
  }) })
  const cat = tmdb.createTmdbCatalog({ apiKey: 'k', fetchFn })
  const out = await cat.personCredits(5)
  assert.deepStrictEqual(out.map(x => x.title), ['New', 'Old'])
})

test('a collection lists its parts in release order', async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({
    id: 9, name: 'Dune Collection', poster_path: '/c.jpg',
    parts: [{ id: 2, title: 'Part Two', release_date: '2024-01-01' },
            { id: 1, title: 'Dune', release_date: '2021-01-01' }],
  }) })
  const cat = tmdb.createTmdbCatalog({ apiKey: 'k', fetchFn })
  const out = await cat.collection(9)
  assert.strictEqual(out.name, 'Dune Collection')
  assert.deepStrictEqual(out.parts.map(p => p.title), ['Dune', 'Part Two'])
})

// ── AniList discover ────────────────────────────────────────────────────────

// AniList scores out of 100 and TMDB out of 10. Converting once at the catalog
// boundary is what stops a badge reading "92" beside another reading "8.4".
test('AniList scores are normalised to the same scale as TMDB', () => {
  assert.strictEqual(anilist.scoreTo10(88), 8.8)
  assert.strictEqual(anilist.scoreTo10(100), 10)
  // null and '' coerce to 0 through Number(); an unrated title must stay
  // unrated rather than becoming a zero score that sorts below everything.
  assert.strictEqual(anilist.scoreTo10(null), null)
  assert.strictEqual(anilist.scoreTo10(undefined), null)
  assert.strictEqual(anilist.scoreTo10(''), null)
  assert.strictEqual(anilist.scoreTo10('nonsense'), null)
  assert.strictEqual(anilist.scoreTo10(0), 0, 'a genuine zero is still a score')
  assert.strictEqual(anilist.scoreTo100(7.5), 75)
  const m = anilist.normalizeMedia({ id: 1, title: { romaji: 'X' }, averageScore: 88 })
  assert.strictEqual(m.rating, 8.8)
  assert.strictEqual(m.scoreRaw, 88, 'the raw score stays available')
})

test('a rating filter given in 0-10 is sent to AniList in 0-100', () => {
  const v = anilist.buildVariables('discover', { minRating: 7.5 })
  assert.strictEqual(v.score, 75)
})

test('only the filters the caller set are sent', () => {
  const v = anilist.buildVariables('discover', { genres: ['Action'], sort: 'rating' })
  assert.deepStrictEqual(v.genre, ['Action'])
  assert.deepStrictEqual(v.sort, ['SCORE_DESC'])
  assert.ok(!('tag' in v), 'an unset filter must not appear at all')
  assert.ok(!('season' in v))
  assert.ok(!('score' in v))
  assert.strictEqual(v.isAdult, false)
})

test('empty filter arrays are treated as no filter', () => {
  const v = anilist.buildVariables('discover', { genres: [], tags: [], formats: [] })
  assert.ok(!('genre' in v))
  assert.ok(!('tag' in v))
  assert.ok(!('format' in v))
})

test('the discover query filters on media, not on Page', () => {
  const q = anilist.buildQuery('discover')
  assert.match(q, /media\(type: ANIME[\s\S]*genre_in: \$genre/)
  assert.match(q, /pageInfo \{ total currentPage lastPage hasNextPage \}/)
  // Arguments on Page are a 400 from AniList; this bug has been fixed once.
  assert.ok(!/Page\(page: \$page, perPage: \$perPage, genre_in/.test(q))
})

test('AniList discover returns paging information', async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({ data: { Page: {
    pageInfo: { total: 5000, currentPage: 2, lastPage: 250, hasNextPage: true },
    media: [{ id: 1, title: { romaji: 'X' }, averageScore: 80 }],
  } } }) })
  const cat = anilist.createAnilistCatalog({ fetchFn })
  const out = await cat.discover({ page: 2 })
  assert.strictEqual(out.totalResults, 5000)
  assert.strictEqual(out.totalPages, 250)
  assert.strictEqual(out.hasMore, true)
  assert.strictEqual(out.results[0].rating, 8)
})

test('the fixed rows still get a plain list, not a paging envelope', async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({ data: { Page: {
    media: [{ id: 1, title: { romaji: 'X' } }],
  } } }) })
  const cat = anilist.createAnilistCatalog({ fetchFn })
  assert.ok(Array.isArray(await cat.trending(1)))
})

test('the adult genre is filtered out of the browse vocabulary', async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({
    data: { GenreCollection: ['Action', 'Hentai', 'Comedy'] },
  }) })
  const cat = anilist.createAnilistCatalog({ fetchFn })
  assert.deepStrictEqual(await cat.genres(), ['Action', 'Comedy'])
})

// 361 tags as a flat list is unusable; grouping is what makes it browsable.
test('tags come back grouped by category, adult tags removed', async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({ data: { MediaTagCollection: [
    { name: 'Time Skip', category: 'Technical', isAdult: false },
    { name: 'Nudity', category: 'Sexual Content', isAdult: true },
    { name: 'Achronological Order', category: 'Technical', isAdult: false },
    { name: 'Space', category: 'Setting-Universe', isAdult: false },
  ] } }) })
  const cat = anilist.createAnilistCatalog({ fetchFn })
  const out = await cat.tags()
  assert.deepStrictEqual(out.map(g => g.category), ['Setting-Universe', 'Technical'])
  assert.deepStrictEqual(out[1].tags, ['Achronological Order', 'Time Skip'])
  assert.ok(!JSON.stringify(out).includes('Nudity'))
})

test('a failed vocabulary fetch yields an empty list rather than throwing', async () => {
  const cat = anilist.createAnilistCatalog({ fetchFn: async () => ({ ok: false, status: 502 }) })
  assert.deepStrictEqual(await cat.genres(), [])
  assert.deepStrictEqual(await cat.tags(), [])
})

test('AniList media carries its trailer and format', () => {
  const m = anilist.normalizeMedia({
    id: 1, title: { romaji: 'X' }, format: 'TV', trailer: { id: 'abc', site: 'YouTube' },
  })
  assert.strictEqual(m.format, 'TV')
  assert.deepStrictEqual(m.trailer, { id: 'abc', site: 'youtube' })
  assert.strictEqual(anilist.normalizeMedia({ id: 1, title: {}, trailer: { site: 'youtube' } }).trailer, null)
})

// ── Anime season chains ─────────────────────────────────────────────────────
// AniList has no concept of "season 3 of Baki": each season is a separate
// entry linked to its neighbours by PREQUEL and SEQUEL edges, unlike TMDB
// where seasons nest inside one show. The run has to be walked.

function chainFetch(graph) {
  // graph: { id: { relations: [[type, node]], self: {...} } }
  return async (_url, opts) => {
    const body = JSON.parse(opts.body)
    const id = body.variables.id
    const entry = graph[id] || {}
    if (/relations \{/.test(body.query)) {
      return { ok: true, json: async () => ({ data: { Media: { id, relations: {
        edges: (entry.relations || []).map(([relationType, node]) => ({ relationType, node })),
      } } } }) }
    }
    return { ok: true, json: async () => ({ data: { Media: entry.self || null } }) }
  }
}

const node = (id, title, year, over = {}) => Object.assign({
  id, type: 'ANIME', format: 'TV', status: 'FINISHED', seasonYear: year,
  episodes: 12, title: { romaji: title }, coverImage: { large: null },
}, over)

test('a season chain is walked in both directions and ordered by year', async () => {
  const graph = {
    2: { self: node(2, 'Middle', 2018), relations: [['PREQUEL', node(1, 'First', 2015)], ['SEQUEL', node(3, 'Third', 2020)]] },
    1: { self: node(1, 'First', 2015), relations: [['SEQUEL', node(2, 'Middle', 2018)]] },
    3: { self: node(3, 'Third', 2020), relations: [['PREQUEL', node(2, 'Middle', 2018)], ['SEQUEL', node(4, 'Fourth', 2023)]] },
    4: { self: node(4, 'Fourth', 2023), relations: [['PREQUEL', node(3, 'Third', 2020)]] },
  }
  const cat = anilist.createAnilistCatalog({ fetchFn: chainFetch(graph) })
  const { seasons } = await cat.seasonChain(2)
  assert.deepStrictEqual(seasons.map(s => s.title), ['First', 'Middle', 'Third', 'Fourth'])
})

// Sharing the visited set between directions made the sequel walk stop on its
// first iteration, so a series only ever gained the one sequel picked up while
// walking backwards. Baki ended at 2020 with Baki Hanma missing.
test('walking backwards does not prevent walking forwards', async () => {
  const graph = {
    1: { self: node(1, 'S1', 2015), relations: [['SEQUEL', node(2, 'S2', 2018)]] },
    2: { self: node(2, 'S2', 2018), relations: [['PREQUEL', node(1, 'S1', 2015)], ['SEQUEL', node(3, 'S3', 2020)]] },
    3: { self: node(3, 'S3', 2020), relations: [['PREQUEL', node(2, 'S2', 2018)], ['SEQUEL', node(4, 'S4', 2022)]] },
    4: { self: node(4, 'S4', 2022), relations: [['PREQUEL', node(3, 'S3', 2020)]] },
  }
  const cat = anilist.createAnilistCatalog({ fetchFn: chainFetch(graph) })
  const { seasons } = await cat.seasonChain(1)
  assert.deepStrictEqual(seasons.map(s => s.title), ['S1', 'S2', 'S3', 'S4'],
    'every sequel beyond the first must be reached')
})

// A manga adaptation is not a season, and neither is a spin-off.
test('only anime prequels and sequels form the season list', async () => {
  const graph = {
    1: {
      self: node(1, 'Main', 2018),
      relations: [
        ['ADAPTATION', { id: 90, type: 'MANGA', title: { romaji: 'The Manga' } }],
        ['SIDE_STORY', node(50, 'A Spin-off', 2019)],
        ['SEQUEL', node(2, 'Season 2', 2020)],
      ],
    },
    2: { self: node(2, 'Season 2', 2020), relations: [] },
  }
  const cat = anilist.createAnilistCatalog({ fetchFn: chainFetch(graph) })
  const { seasons, related } = await cat.seasonChain(1)
  assert.deepStrictEqual(seasons.map(s => s.title), ['Main', 'Season 2'])
  assert.deepStrictEqual(related.map(r => r.title), ['A Spin-off'], 'side stories are related, not seasons')
  assert.ok(!JSON.stringify(seasons).includes('The Manga'), 'a manga is never a season')
})

// AniList's own data contains the occasional relation cycle.
test('a relation cycle terminates instead of looping forever', async () => {
  const graph = {
    1: { self: node(1, 'A', 2015), relations: [['SEQUEL', node(2, 'B', 2016)]] },
    2: { self: node(2, 'B', 2016), relations: [['SEQUEL', node(1, 'A', 2015)]] },
  }
  const cat = anilist.createAnilistCatalog({ fetchFn: chainFetch(graph) })
  const { seasons } = await cat.seasonChain(1)
  assert.strictEqual(seasons.length, 2)
})

test('the hop budget bounds how far a chain is walked', async () => {
  const graph = {}
  for (let i = 1; i <= 40; i++) {
    graph[i] = { self: node(i, 'S' + i, 2000 + i), relations: [['SEQUEL', node(i + 1, 'S' + (i + 1), 2001 + i)]] }
  }
  const cat = anilist.createAnilistCatalog({ fetchFn: chainFetch(graph) })
  const { seasons } = await cat.seasonChain(1, { maxHops: 5 })
  assert.ok(seasons.length <= 7, 'the walk must stop at the budget, saw ' + seasons.length)
})

test('a title with no relations still returns itself', async () => {
  const graph = { 7: { self: node(7, 'Standalone', 2019), relations: [] } }
  const cat = anilist.createAnilistCatalog({ fetchFn: chainFetch(graph) })
  const { seasons } = await cat.seasonChain(7)
  assert.deepStrictEqual(seasons.map(s => s.title), ['Standalone'])
})

test('a failed relation request degrades to what is already known', async () => {
  const cat = anilist.createAnilistCatalog({ fetchFn: async () => ({ ok: false, status: 500 }) })
  const out = await cat.seasonChain(1)
  assert.deepStrictEqual(out.seasons, [])
  assert.deepStrictEqual(out.related, [])
})

test('seasonChain refuses a missing id without making a request', async () => {
  let called = false
  const cat = anilist.createAnilistCatalog({ fetchFn: async () => { called = true } })
  assert.deepStrictEqual(await cat.seasonChain(null), { seasons: [], related: [] })
  assert.strictEqual(called, false)
})

// A film's equivalent of a season chain is its franchise.
test('a film carries the collection it belongs to, and null when standalone', () => {
  const inSeries = tmdb.normalizeMovie({
    id: 1, title: 'Dune',
    belongs_to_collection: { id: 726871, name: 'Dune Collection', poster_path: '/c.jpg' },
  })
  assert.strictEqual(inSeries.collection.id, 726871)
  assert.strictEqual(inSeries.collection.name, 'Dune Collection')
  assert.strictEqual(tmdb.normalizeMovie({ id: 2, title: 'Fight Club' }).collection, null)
})
