'use strict'
const test = require('node:test')
const assert = require('node:assert')

const S = require('../catalog/shelves')

function params(url) {
  const q = url.slice(url.indexOf('?') + 1)
  const out = {}
  for (const pair of q.split('&')) {
    if (!pair) continue
    const i = pair.indexOf('=')
    out[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1))
  }
  return out
}

// Every shelf builder, called the way the page calls it.
const ALL_SHELVES = () => [
  S.canon(),
  S.decade(1970),
  S.directorInFocus(5026, 'Akira Kurosawa'),
  ...Object.keys(S.MOVEMENTS).map(k => S.movement(k)),
  ...Object.keys(S.THEMES).map(k => S.theme(k)),
  S.country('KR'),
  S.studio(41077),
  S.hiddenGems(),
  S.anniversary(50),
  S.runtimeUnder(90),
  S.runtimeOver(180),
]

test('buildDiscoverUrl encodes values and drops empty params', () => {
  const url = S.buildDiscoverUrl(null, null, {
    with_keywords: 207268,
    sort_by: 'vote_average.desc',
    with_original_language: null,
    search: '',
    label: 'a b&c',
  })
  const p = params(url)
  assert.ok(url.startsWith('https://api.themoviedb.org/3/discover/movie?'))
  assert.strictEqual(p.with_keywords, '207268')
  assert.strictEqual(p.label, 'a b&c')
  assert.ok(!('with_original_language' in p), 'null params must be dropped')
  assert.ok(!('search' in p), 'empty-string params must be dropped')
  assert.ok(!url.includes('a b&c'), 'raw ampersand would split the query string')
})

test('buildDiscoverUrl targets tv when asked and defaults to movie', () => {
  assert.ok(S.buildDiscoverUrl(null, null, { kind: 'tv' }).includes('/discover/tv?'))
  assert.ok(S.buildDiscoverUrl(null, null, {}).includes('/discover/movie?'))
  assert.ok(!S.buildDiscoverUrl(null, null, { kind: 'tv' }).includes('kind='))
})

test('buildDiscoverUrl appends the api key only when given one', () => {
  assert.ok(!S.buildDiscoverUrl(null, null, {}).includes('api_key'))
  assert.strictEqual(params(S.buildDiscoverUrl(null, 'abc123', {})).api_key, 'abc123')
})

test('buildDiscoverUrl excludes adult titles unless overridden', () => {
  assert.strictEqual(params(S.buildDiscoverUrl(null, null, {})).include_adult, 'false')
  assert.strictEqual(params(S.buildDiscoverUrl(null, null, { include_adult: 'true' })).include_adult, 'true')
})

test('buildDiscoverUrl honours a custom base url', () => {
  assert.ok(S.buildDiscoverUrl('http://localhost:9/3', null, {}).startsWith('http://localhost:9/3/discover/movie?'))
})

test('every shelf carries key, label, note, rank and url', () => {
  for (const s of ALL_SHELVES()) {
    assert.ok(s, 'a listed shelf builder returned null')
    assert.ok(s.key && s.label && s.note, `${s && s.key} is missing copy`)
    assert.ok(Number.isFinite(s.rank), `${s.key} has no rank`)
    assert.ok(s.url.includes('/discover/'), `${s.key} has no discover url`)
  }
})

test('shelf keys are unique across the page', () => {
  const keys = ALL_SHELVES().map(s => s.key)
  assert.strictEqual(new Set(keys).size, keys.length)
})

// The reason the floors exist. Without vote_count.gte, discover sorted by
// rating returns whatever three people rated 10 — verified live: Kurosawa's
// with_crew list leads with "Enoken's Surprising Life" instead of Seven
// Samurai. This test fails if any rating-sorted shelf ever loses its floor.
test('every rating-sorted shelf carries a vote floor', () => {
  for (const s of ALL_SHELVES()) {
    const p = params(s.url)
    if (p.sort_by !== 'vote_average.desc') continue
    const floor = Number(p['vote_count.gte'])
    assert.ok(Number.isFinite(floor) && floor > 0, `${s.key} sorts by rating with no vote floor`)
  }
})

test('the director shelf keeps its floor and queries crew, not cast', () => {
  const p = params(S.directorInFocus(5026, 'Akira Kurosawa').url)
  assert.strictEqual(p.with_crew, '5026')
  assert.ok(Number(p['vote_count.gte']) >= 100)
  assert.ok(!('with_cast' in p))
  assert.ok(S.directorInFocus(5026, 'Akira Kurosawa').label.includes('Akira Kurosawa'))
})

test('the director shelf refuses to exist without an id or a name', () => {
  assert.strictEqual(S.directorInFocus(null, 'Akira Kurosawa'), null)
  assert.strictEqual(S.directorInFocus(5026, ''), null)
})

test('canon uses the 5000-vote floor that produces Shawshank, not noise', () => {
  const p = params(S.canon().url)
  assert.strictEqual(p['vote_count.gte'], '5000')
  assert.strictEqual(p.sort_by, 'vote_average.desc')
})

test('decade builds a full ten-year window for each real decade', () => {
  for (const start of S.DECADES) {
    const p = params(S.decade(start).url)
    assert.strictEqual(p['primary_release_date.gte'], `${start}-01-01`)
    assert.strictEqual(p['primary_release_date.lte'], `${start + 9}-12-31`)
    assert.ok(S.decade(start).label.includes(String(start)))
  }
})

test('decade rejects decades that have not happened', () => {
  assert.strictEqual(S.decade(2030), null)
  assert.strictEqual(S.decade(1940), null)
  assert.strictEqual(S.decade('nope'), null)
})

test('movements are windows or keywords, never a bare rating sort', () => {
  for (const key of Object.keys(S.MOVEMENTS)) {
    const p = params(S.movement(key).url)
    const scoped = p.with_keywords || p.with_original_language || p.with_origin_country
    assert.ok(scoped, `${key} would return the whole database`)
  }
  const fnw = params(S.movement('french-new-wave').url)
  assert.strictEqual(fnw.with_original_language, 'fr')
  assert.strictEqual(fnw['primary_release_date.gte'], '1958-01-01')
  // The keyword returns five films and not one of them is The 400 Blows, so
  // the movement must be a period, not a tag.
  assert.ok(!('with_keywords' in fnw))
  assert.strictEqual(params(S.movement('dogme-95').url).with_keywords, '315002')
})

test('unknown movement or theme returns null rather than an empty shelf', () => {
  assert.strictEqual(S.movement('mumblecore'), null)
  assert.strictEqual(S.theme('one-location'), null, 'no verifiable keyword exists for it')
  assert.strictEqual(S.country('ZZ'), null)
  assert.strictEqual(S.studio(999999), null)
})

test('themes use the verified keyword ids', () => {
  assert.strictEqual(params(S.theme('neo-noir').url).with_keywords, '207268')
  assert.strictEqual(params(S.theme('heist').url).with_keywords, '10051')
  assert.strictEqual(params(S.theme('coming-of-age').url).with_keywords, '10683')
  assert.strictEqual(params(S.theme('unreliable-narrator').url).with_keywords, '174089')
})

test('country and studio shelves scope by the right field', () => {
  assert.strictEqual(params(S.country('KR').url).with_origin_country, 'KR')
  assert.ok(S.country('KR').label.includes('South Korea'))
  assert.strictEqual(params(S.studio(10342).url).with_companies, '10342')
  assert.strictEqual(S.studio(10342).label, 'Studio Ghibli')
})

// Without the ceiling this shelf is the canon with a different label — the
// whole claim of the row is that these are films you have not already seen.
test('hidden gems have both a floor and a ceiling', () => {
  const p = params(S.hiddenGems().url)
  const lo = Number(p['vote_count.gte'])
  const hi = Number(p['vote_count.lte'])
  assert.ok(lo > 0 && hi > lo, 'gems need a window, not just a floor')
  assert.ok(Number(p['vote_average.gte']) >= 7)
  assert.ok(hi < Number(params(S.canon().url)['vote_count.gte']), 'gems must not overlap the canon floor')
})

test('anniversary counts back from the current year', () => {
  const year = new Date().getFullYear() - 50
  const p = params(S.anniversary(50).url)
  assert.strictEqual(p['primary_release_date.gte'], `${year}-01-01`)
  assert.strictEqual(p['primary_release_date.lte'], `${year}-12-31`)
  assert.ok(S.anniversary(50).note.includes(String(year)))
  assert.strictEqual(S.anniversary(0), null)
  assert.strictEqual(S.anniversary(-5), null)
})

// with_runtime.lte alone sweeps in every title whose runtime TMDB stores as 0.
test('runtimeUnder sets a lower bound as well as an upper one', () => {
  const p = params(S.runtimeUnder(90).url)
  assert.strictEqual(p['with_runtime.lte'], '90')
  assert.ok(Number(p['with_runtime.gte']) > 0, 'a 0-minute record is not a short film')
  assert.strictEqual(S.runtimeUnder(30), null, 'below the lower bound the shelf is incoherent')
})

test('runtimeOver sets only a lower bound', () => {
  const p = params(S.runtimeOver(180).url)
  assert.strictEqual(p['with_runtime.gte'], '180')
  assert.ok(!('with_runtime.lte' in p))
  assert.strictEqual(S.runtimeOver('long'), null)
})

// --- quality filter ---

// The motivating case: Tagesschau (tv/1952), the German daily news bulletin,
// ranks in Popular TV because it has aired every day since 1952. A shelf that
// does not run this filter puts the evening news next to Seven Samurai.
test('isLowQualityForFilmShelf drops the Tagesschau case', () => {
  const tagesschau = { id: 1952, type: 'tv', title: 'Tagesschau', genre_ids: [10763] }
  assert.strictEqual(S.isLowQualityForFilmShelf(tagesschau), true)
})

test('isLowQualityForFilmShelf drops news, talk and reality by id', () => {
  for (const id of S.NON_FILM_GENRES) {
    assert.strictEqual(S.isLowQualityForFilmShelf({ id: 1, genre_ids: [18, id] }), true, `genre ${id} survived`)
  }
})

test('isLowQualityForFilmShelf reads normalised genre names too', () => {
  assert.strictEqual(S.isLowQualityForFilmShelf({ id: 1, genres: ['Drama', 'News'] }), true)
  assert.strictEqual(S.isLowQualityForFilmShelf({ id: 1, genres: [{ id: 10767, name: 'Talk' }] }), true)
  assert.strictEqual(S.isLowQualityForFilmShelf({ id: 1, genres: ['drama', ' reality '] }), true)
})

test('isLowQualityForFilmShelf keeps real films and rejects junk input', () => {
  assert.strictEqual(S.isLowQualityForFilmShelf({ id: 1, genre_ids: [18, 80] }), false)
  assert.strictEqual(S.isLowQualityForFilmShelf({ id: 1, genres: [{ id: 18, name: 'Drama' }] }), false)
  assert.strictEqual(S.isLowQualityForFilmShelf({ id: 1 }), false)
  assert.strictEqual(S.isLowQualityForFilmShelf(null), true)
  assert.strictEqual(S.isLowQualityForFilmShelf('Tagesschau'), true)
})

// --- dedupe ---

const M = (id, type) => ({ id, type: type || 'movie' })

test('dedupe gives a title to the more specific shelf', () => {
  const out = S.dedupe([
    { key: 'canon', rank: S.RANK.canon, items: [M(1), M(2)] },
    { key: 'theme-neo-noir', rank: S.RANK.theme, items: [M(1), M(3)] },
  ])
  const canonItems = out.find(s => s.key === 'canon').items.map(i => i.id)
  const themeItems = out.find(s => s.key === 'theme-neo-noir').items.map(i => i.id)
  assert.deepStrictEqual(themeItems, [1, 3], 'the specific shelf keeps the title')
  assert.deepStrictEqual(canonItems, [2], 'the generic shelf gives it up')
})

test('dedupe preserves the order the caller wrote the page in', () => {
  const out = S.dedupe([
    { key: 'canon', rank: S.RANK.canon, items: [M(1)] },
    { key: 'theme', rank: S.RANK.theme, items: [M(2)] },
  ])
  assert.deepStrictEqual(out.map(s => s.key), ['canon', 'theme'])
})

test('dedupe breaks rank ties by the order the shelves were passed', () => {
  const out = S.dedupe([
    { key: 'first', rank: 1, items: [M(7)] },
    { key: 'second', rank: 1, items: [M(7)] },
  ])
  assert.deepStrictEqual(out.map(s => s.key), ['first'])
  assert.deepStrictEqual(out[0].items.map(i => i.id), [7])
})

test('dedupe treats movie 1 and tv 1 as different titles', () => {
  const out = S.dedupe([
    { key: 'a', rank: 1, items: [M(1, 'movie')] },
    { key: 'b', rank: 2, items: [M(1, 'tv')] },
  ])
  assert.strictEqual(out.length, 2)
})

test('dedupe drops shelves emptied by deduping and never mutates the input', () => {
  const shelves = [
    { key: 'specific', rank: 1, items: [M(1)] },
    { key: 'generic', rank: 4, items: [M(1)] },
  ]
  const out = S.dedupe(shelves)
  assert.deepStrictEqual(out.map(s => s.key), ['specific'])
  assert.strictEqual(shelves[1].items.length, 1, 'input shelves must be left alone')
})

test('dedupe survives junk', () => {
  assert.deepStrictEqual(S.dedupe(null), [])
  assert.deepStrictEqual(S.dedupe([null, undefined]), [])
  assert.deepStrictEqual(S.dedupe([{ key: 'a', rank: 1 }]), [])
  const out = S.dedupe([{ key: 'a', rank: 1, items: [M(1), { id: null }, null] }])
  assert.deepStrictEqual(out[0].items.map(i => i.id), [1])
})

test('shelves with no rank sort last rather than throwing', () => {
  const out = S.dedupe([
    { key: 'unranked', items: [M(1)] },
    { key: 'ranked', rank: 1, items: [M(1)] },
  ])
  assert.deepStrictEqual(out.map(s => s.key), ['ranked'])
})

// ── Hidden gems, tuned against the live catalogue ───────────────────────────
// The obvious thresholds do not work, and the failures were specific enough to
// be worth pinning down. A floor of 300 votes is not a sample but noise, and
// sorting by average over noise returned "Accidental Partners" and "Facing El
// Chapo". Raising the floor alone then surfaced whatever was being hyped that
// month, because a film's average peaks in its first weeks before the wider
// audience arrives to pull it back down. The settle window is what turned the
// shelf into Harakiri, Seven Samurai and Cinema Paradiso.
test('a gem needs a sample large enough to trust', () => {
  const { FLOOR } = require('../catalog/shelves')
  assert.ok(FLOOR.gems >= 1000,
    'below about a thousand votes the average is noise, not a verdict')
})

test('a gem must have had time to settle', () => {
  const { hiddenGems, GEMS_SETTLE_YEARS } = require('../catalog/shelves')
  assert.ok(GEMS_SETTLE_YEARS >= 2)
  const url = hiddenGems().url
  assert.match(url, /primary_release_date\.lte=\d{4}-12-31/,
    'without this the shelf fills with whatever is being hyped this month')
  const capped = Number(/primary_release_date\.lte=(\d{4})/.exec(url)[1])
  assert.ok(capped <= new Date().getFullYear() - 2, 'the cap must actually exclude recent releases')
})

// Without the ceiling this is just the canon a second time, which is the other
// way for the shelf to be worthless.
test('a gem must still be under-seen', () => {
  const { hiddenGems, GEMS_CEILING, FLOOR } = require('../catalog/shelves')
  assert.ok(GEMS_CEILING > FLOOR.gems, 'the ceiling has to leave a band to select from')
  assert.match(hiddenGems().url, new RegExp('vote_count\\.lte=' + GEMS_CEILING))
})
