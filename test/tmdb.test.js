'use strict'
// Papa Cinema additions to the TMDB catalog: hero art selection, crew,
// certification, keywords, and the richer detail request. The existing
// coverage lives in catalog-tmdb.test.js; this file only guards the new
// behaviour, and each test names the failure it exists to prevent.
const test = require('node:test')
const assert = require('node:assert')
const {
  pickTitleLogo,
  pickBackdrop,
  directorsOf,
  keyCrewOf,
  certificationFor,
  keywordsOf,
  buildAppendedDetailUrl,
  buildDetailUrl,
  normalizeMovie,
  normalizeTv,
  createTmdbCatalog,
  MOVIE_APPEND,
  TV_APPEND,
  MOVIE_APPEND_FULL,
  TV_APPEND_FULL,
} = require('../catalog/tmdb')

const LOGO = 'https://image.tmdb.org/t/p/w500'
const BACKDROP = 'https://image.tmdb.org/t/p/w1280'

const logo = (o) => ({ file_path: '/x.png', iso_639_1: 'en', width: 1000, height: 300, vote_average: 5, ...o })
const shot = (o) => ({ file_path: '/b.jpg', iso_639_1: null, width: 1920, height: 1080, vote_average: 5, ...o })

// --- pickTitleLogo ---------------------------------------------------------

// Guards: the hero showing a foreign-language wordmark because that entry
// happened to be first in TMDB's 84-logo list.
test('pickTitleLogo honours the requested language over list order', () => {
  const images = {
    logos: [
      logo({ file_path: '/hu.png', iso_639_1: 'hu' }),
      logo({ file_path: '/ja.png', iso_639_1: 'ja' }),
      logo({ file_path: '/en.png', iso_639_1: 'en' }),
    ],
  }
  assert.strictEqual(pickTitleLogo(images, 'ja').path, '/ja.png')
  assert.strictEqual(pickTitleLogo(images, 'en').path, '/en.png')
  // No language asked for: English is the default, never the first entry.
  assert.strictEqual(pickTitleLogo(images).path, '/en.png')
})

// Guards: falling back to a random language when the requested one is absent.
// English, then the language-less graphic mark, then anything else.
test('pickTitleLogo falls back English → no-language → other', () => {
  const withEn = { logos: [logo({ file_path: '/de.png', iso_639_1: 'de' }), logo({ file_path: '/en.png' }), logo({ file_path: '/none.png', iso_639_1: null })] }
  assert.strictEqual(pickTitleLogo(withEn, 'fr').path, '/en.png')
  const noEn = { logos: [logo({ file_path: '/de.png', iso_639_1: 'de' }), logo({ file_path: '/none.png', iso_639_1: null })] }
  assert.strictEqual(pickTitleLogo(noEn, 'fr').path, '/none.png')
  const onlyOther = { logos: [logo({ file_path: '/de.png', iso_639_1: 'de' })] }
  assert.strictEqual(pickTitleLogo(onlyOther, 'fr').path, '/de.png')
})

// Guards: an SVG winning inside the right language band. TMDB SVG logos report
// width/height 0 and can render blank in Chromium, so a PNG of the same
// language must always beat one.
test('pickTitleLogo prefers PNG over SVG within a language, but takes SVG alone', () => {
  const both = { logos: [logo({ file_path: '/a.svg', width: 0, height: 0, vote_average: 9 }), logo({ file_path: '/a.png' })] }
  assert.strictEqual(pickTitleLogo(both, 'en').path, '/a.png')
  const svgOnly = { logos: [logo({ file_path: '/a.svg', width: 0, height: 0 })] }
  assert.strictEqual(pickTitleLogo(svgOnly, 'en').path, '/a.svg')
})

// Guards: a 120px thumbnail or a 4000px poster rip landing in the hero because
// it scored a fraction higher on votes.
test('pickTitleLogo prefers a hero-sized logo over tiny or oversized ones', () => {
  const images = {
    logos: [
      logo({ file_path: '/tiny.png', width: 180, vote_average: 9 }),
      logo({ file_path: '/huge.png', width: 4000, vote_average: 9 }),
      logo({ file_path: '/good.png', width: 1400, vote_average: 1 }),
    ],
  }
  assert.strictEqual(pickTitleLogo(images, 'en').path, '/good.png')
})

// Guards: the hero rendering `undefined` in an <img src> for a title with no
// title art, and a half-built object passing a truthiness check.
test('pickTitleLogo returns null when there is nothing usable', () => {
  assert.strictEqual(pickTitleLogo(null), null)
  assert.strictEqual(pickTitleLogo({}), null)
  assert.strictEqual(pickTitleLogo({ logos: [] }), null)
  assert.strictEqual(pickTitleLogo({ logos: [{ iso_639_1: 'en', width: 900 }] }), null)
})

test('pickTitleLogo builds a full url and carries the dimensions', () => {
  const p = pickTitleLogo({ logos: [logo({ file_path: '/en.png', width: 1200, height: 400 })] }, 'en')
  assert.deepStrictEqual(p, {
    url: `${LOGO}/en.png`, path: '/en.png', lang: 'en', width: 1200, height: 400, voteAverage: 5,
  })
})

// Accepts a bare array too — some callers hold images.logos directly.
test('pickTitleLogo accepts a bare logos array', () => {
  assert.strictEqual(pickTitleLogo([logo({ file_path: '/en.png' })], 'en').path, '/en.png')
})

// --- pickBackdrop ----------------------------------------------------------

// Guards: the single most visible failure of the new hero — drawing the title
// logo on top of a backdrop that already has the title burned into it.
test('pickBackdrop prefers a textless plate over a higher-rated titled one', () => {
  const images = {
    backdrops: [
      shot({ file_path: '/titled-en.jpg', iso_639_1: 'en', vote_average: 9.9 }),
      shot({ file_path: '/textless.jpg', iso_639_1: null, vote_average: 1 }),
    ],
  }
  assert.strictEqual(pickBackdrop(images, 'en').path, '/textless.jpg')
})

// Guards: a Hungarian titled plate beating the English one when no textless
// plate exists at all.
test('pickBackdrop falls back to the requested language, then English', () => {
  const noTextless = { backdrops: [shot({ file_path: '/hu.jpg', iso_639_1: 'hu', vote_average: 9 }), shot({ file_path: '/en.jpg', iso_639_1: 'en', vote_average: 1 })] }
  assert.strictEqual(pickBackdrop(noTextless, 'en').path, '/en.jpg')
  assert.strictEqual(pickBackdrop(noTextless, 'hu').path, '/hu.jpg')
})

test('pickBackdrop uses the wide base and returns null when empty', () => {
  assert.strictEqual(pickBackdrop({ backdrops: [shot({ file_path: '/t.jpg' })] }).url, `${BACKDROP}/t.jpg`)
  assert.strictEqual(pickBackdrop({ backdrops: [] }), null)
  assert.strictEqual(pickBackdrop(null), null)
})

// --- directorsOf / keyCrewOf ----------------------------------------------

// Guards: the Coens (and Wachowskis, and Russos) collapsing to one name.
test('directorsOf keeps both directors of a co-directed film, in billing order', () => {
  const credits = {
    crew: [
      { id: 1, name: 'Joel Coen', job: 'Director' },
      { id: 2, name: 'Ethan Coen', job: 'Director' },
      { id: 3, name: 'Roger Deakins', job: 'Director of Photography' },
    ],
  }
  assert.deepStrictEqual(directorsOf(credits).map(d => d.name), ['Joel Coen', 'Ethan Coen'])
})

// Guards: a person credited twice (Director and Screenplay both list them, and
// TMDB repeats the Director row per department) showing up twice on the card.
test('directorsOf de-duplicates a repeated credit', () => {
  const credits = {
    crew: [
      { id: 1, name: 'Francis Ford Coppola', job: 'Director', department: 'Directing' },
      { id: 1, name: 'Francis Ford Coppola', job: 'Director', department: 'Writing' },
      { id: 1, name: 'Francis Ford Coppola', job: 'Screenplay' },
    ],
  }
  assert.strictEqual(directorsOf(credits).length, 1)
})

// Guards: a crew block that throws on a title where TMDB has no DP credit.
test('keyCrewOf returns all five keys as arrays, empty when absent', () => {
  const crew = keyCrewOf({ crew: [{ id: 1, name: 'D', job: 'Director' }] })
  assert.deepStrictEqual(Object.keys(crew).sort(), ['cinematographers', 'composers', 'directors', 'editors', 'writers'])
  for (const v of Object.values(crew)) assert.ok(Array.isArray(v))
  assert.deepStrictEqual(crew.cinematographers, [])
  assert.deepStrictEqual(keyCrewOf(null).directors, [])
  assert.deepStrictEqual(keyCrewOf(undefined).writers, [])
})

// Guards: the crew block silently dropping the DP or composer because TMDB
// spells the jobs "Director of Photography" and "Original Music Composer".
test('keyCrewOf picks up the exact TMDB job spellings', () => {
  const credits = {
    crew: [
      { id: 1, name: 'Coppola', job: 'Director' },
      { id: 2, name: 'Puzo', job: 'Screenplay' },
      { id: 3, name: 'Willis', job: 'Director of Photography' },
      { id: 4, name: 'Rota', job: 'Original Music Composer' },
      { id: 5, name: 'Marks', job: 'Editor' },
      { id: 6, name: 'Someone', job: 'Best Boy' },
    ],
  }
  const crew = keyCrewOf(credits)
  assert.deepStrictEqual(crew.directors.map(p => p.name), ['Coppola'])
  assert.deepStrictEqual(crew.writers.map(p => p.name), ['Puzo'])
  assert.deepStrictEqual(crew.cinematographers.map(p => p.name), ['Willis'])
  assert.deepStrictEqual(crew.composers.map(p => p.name), ['Rota'])
  assert.deepStrictEqual(crew.editors.map(p => p.name), ['Marks'])
})

// --- certificationFor ------------------------------------------------------

// Guards: reading the re-rating of a director's cut instead of the theatrical
// certificate the poster shows.
test('certificationFor prefers the theatrical entry of the requested region', () => {
  const rd = {
    results: [
      { iso_3166_1: 'US', release_dates: [{ certification: 'NC-17', type: 6 }, { certification: 'R', type: 3 }] },
    ],
  }
  assert.strictEqual(certificationFor(rd, 'US'), 'R')
})

// Guards: a foreign film with no US release showing no certificate at all,
// when TMDB carries a perfectly good BBFC or home rating.
test('certificationFor falls back region → US → GB → any', () => {
  const noUs = {
    results: [
      { iso_3166_1: 'FR', release_dates: [{ certification: 'T', type: 3 }] },
      { iso_3166_1: 'GB', release_dates: [{ certification: '15', type: 3 }] },
    ],
  }
  assert.strictEqual(certificationFor(noUs, 'US'), '15')
  assert.strictEqual(certificationFor(noUs, 'FR'), 'T')
  const onlyJp = { results: [{ iso_3166_1: 'JP', release_dates: [{ certification: 'G', type: 3 }] }] }
  assert.strictEqual(certificationFor(onlyJp, 'US'), 'G')
})

// Guards: rendering an empty certificate badge. TMDB fills unrated regions
// with "", which is truthy-looking in a template but renders as an empty box.
test('certificationFor returns null rather than an empty string', () => {
  assert.strictEqual(certificationFor({ results: [{ iso_3166_1: 'US', release_dates: [{ certification: '', type: 3 }] }] }, 'US'), null)
  assert.strictEqual(certificationFor({ results: [] }, 'US'), null)
  assert.strictEqual(certificationFor(null, 'US'), null)
  assert.strictEqual(certificationFor({}, 'US'), null)
})

// Guards: the tv content_ratings shape (rating on the entry, no release_dates
// array) silently returning null and every series losing its certificate.
test('certificationFor reads the tv content_ratings shape too', () => {
  const cr = { results: [{ iso_3166_1: 'GB', rating: '15' }, { iso_3166_1: 'US', rating: 'TV-MA' }] }
  assert.strictEqual(certificationFor(cr, 'US'), 'TV-MA')
  assert.strictEqual(certificationFor(cr, 'GB'), '15')
})

// --- keywordsOf ------------------------------------------------------------

// Guards: thematic shelves working for film and silently empty for television,
// because the two append shapes differ.
test('keywordsOf reads the movie shape and the tv shape', () => {
  const movie = { keywords: { keywords: [{ id: 10, name: 'gangster' }, { id: 11, name: 'based on novel or book' }] } }
  assert.deepStrictEqual(keywordsOf(movie), [{ id: 10, name: 'gangster' }, { id: 11, name: 'based on novel or book' }])
  const tv = { keywords: { results: [{ id: 20, name: 'high school' }] } }
  assert.deepStrictEqual(keywordsOf(tv), [{ id: 20, name: 'high school' }])
})

// Guards: a keyword appearing twice in a shelf's chip row.
test('keywordsOf de-duplicates and drops unusable entries', () => {
  const raw = { keywords: { keywords: [{ id: 1, name: 'noir' }, { id: 1, name: 'noir' }, { id: 2 }, null, { name: 'heist' }] } }
  assert.deepStrictEqual(keywordsOf(raw), [{ id: 1, name: 'noir' }, { id: null, name: 'heist' }])
})

test('keywordsOf returns [] for anything unusable', () => {
  assert.deepStrictEqual(keywordsOf(null), [])
  assert.deepStrictEqual(keywordsOf({}), [])
  assert.deepStrictEqual(keywordsOf({ keywords: {} }), [])
})

// --- buildAppendedDetailUrl ------------------------------------------------

// Guards: the detail page needing a second round-trip for keywords or images,
// and the 422 that asking a movie for content_ratings (or tv for
// release_dates) produces.
test('buildAppendedDetailUrl bundles keywords and images per media type', () => {
  const m = buildAppendedDetailUrl('movie', 238)
  assert.ok(m.startsWith('https://api.themoviedb.org/3/movie/238?append_to_response='))
  assert.match(m, /keywords/)
  assert.match(m, /images/)
  assert.match(m, /release_dates/)
  assert.ok(!m.includes('content_ratings'))
  const t = buildAppendedDetailUrl('tv', 9)
  assert.ok(t.startsWith('https://api.themoviedb.org/3/tv/9?append_to_response='))
  assert.match(t, /content_ratings/)
  assert.ok(!t.includes('release_dates'))
  // The full lists are supersets of the originals — nothing the old detail
  // page relied on was dropped to make room.
  for (const part of MOVIE_APPEND.split(',')) assert.ok(MOVIE_APPEND_FULL.includes(part), part)
  for (const part of TV_APPEND.split(',')) assert.ok(TV_APPEND_FULL.includes(part), part)
})

// Guards: an English hero getting no logo for a Japanese film. Without
// include_image_language TMDB returns only original-language art, and `null`
// is what asks for the textless plates.
test('buildAppendedDetailUrl requests the image languages the hero needs', () => {
  assert.match(buildAppendedDetailUrl('movie', 1), /include_image_language=en,null/)
  assert.match(buildAppendedDetailUrl('movie', 1, { lang: 'fr' }), /include_image_language=fr,en,null/)
})

test('buildDetailUrl is untouched — the old caller keeps its exact URL', () => {
  assert.strictEqual(buildDetailUrl('movie', 101), `https://api.themoviedb.org/3/movie/101?append_to_response=${MOVIE_APPEND}`)
})

// --- normalizer wiring -----------------------------------------------------

// Guards: the appended fields being computed but never reaching the app.
test('normalizeMovie surfaces logo, textless backdrop, directors, crew, keywords', () => {
  const e = normalizeMovie({
    id: 238,
    title: 'The Godfather',
    release_date: '1972-03-14',
    runtime: 175,
    original_language: 'en',
    release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'R', type: 3 }] }] },
    belongs_to_collection: { id: 230, name: 'The Godfather Collection', poster_path: '/c.jpg' },
    credits: {
      cast: [],
      crew: [
        { id: 1776, name: 'Francis Ford Coppola', job: 'Director' },
        { id: 3, name: 'Gordon Willis', job: 'Director of Photography' },
      ],
    },
    keywords: { keywords: [{ id: 10, name: 'gangster' }] },
    images: {
      logos: [logo({ file_path: '/gf.png', width: 1400 }), logo({ file_path: '/gf-hu.png', iso_639_1: 'hu' })],
      backdrops: [shot({ file_path: '/titled.jpg', iso_639_1: 'en', vote_average: 9 }), shot({ file_path: '/plain.jpg', iso_639_1: null })],
    },
  })
  assert.strictEqual(e.logo.url, `${LOGO}/gf.png`)
  assert.strictEqual(e.backdropTextless.url, `${BACKDROP}/plain.jpg`)
  assert.deepStrictEqual(e.directors.map(d => d.name), ['Francis Ford Coppola'])
  assert.deepStrictEqual(e.keyCrew.cinematographers.map(p => p.name), ['Gordon Willis'])
  assert.deepStrictEqual(e.keywords, [{ id: 10, name: 'gangster' }])
  assert.strictEqual(e.certification, 'R')
  assert.strictEqual(e.runtime, 175)
  assert.strictEqual(e.collection.name, 'The Godfather Collection')
  // The pre-existing crew list is untouched — the detail page still reads it.
  assert.strictEqual(e.crew.length, 2)
})

test('normalizeTv surfaces the same fields from the tv shapes', () => {
  const e = normalizeTv({
    id: 1396,
    name: 'Breaking Bad',
    first_air_date: '2008-01-20',
    content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-MA' }] },
    credits: { crew: [{ id: 1, name: 'Vince Gilligan', job: 'Director' }] },
    keywords: { results: [{ id: 5, name: 'new mexico' }] },
    images: { logos: [logo({ file_path: '/bb.png' })], backdrops: [shot({ file_path: '/bb.jpg' })] },
  })
  assert.strictEqual(e.certification, 'TV-MA')
  assert.deepStrictEqual(e.keywords, [{ id: 5, name: 'new mexico' }])
  assert.deepStrictEqual(e.directors.map(d => d.name), ['Vince Gilligan'])
  assert.strictEqual(e.logo.path, '/bb.png')
})

// Guards: growing the shape of every trending/search card with a row of empty
// keys. The appended fields appear only when the append was actually made —
// exactly as `seasons` already behaves.
test('entries built without the appends keep their old shape exactly', () => {
  const e = normalizeMovie({ id: 1, title: 'M', release_date: '2020-01-01' })
  for (const k of ['logo', 'backdropTextless', 'directors', 'keyCrew', 'keywords']) {
    assert.ok(!(k in e), `${k} must not appear without its append`)
  }
})

// Guards: a title with credits but no images (or vice versa) throwing, or
// producing a truthy-but-empty logo object the hero would try to render.
test('a partial append yields only the fields it can support', () => {
  const e = normalizeMovie({ id: 1, credits: { crew: [] }, images: { logos: [] } })
  assert.strictEqual(e.logo, null)
  assert.strictEqual(e.backdropTextless, null)
  assert.deepStrictEqual(e.directors, [])
  assert.ok(!('keywords' in e))
})

// Guards: the catalog still fetching the old, thinner detail URL — the whole
// feature is invisible if detail() does not ask for the new sub-objects.
test('createTmdbCatalog.detail requests the appended URL', async () => {
  let seen = null
  const fetchFn = async (url) => {
    seen = url
    return { ok: true, json: async () => ({ id: 238, title: 'G', images: { logos: [logo({ file_path: '/g.png' })] } }) }
  }
  const cat = createTmdbCatalog({ apiKey: 'KEY', fetchFn })
  const e = await cat.detail('movie', 238)
  assert.match(seen, /keywords/)
  assert.match(seen, /include_image_language=/)
  assert.ok(seen.includes('api_key=KEY'))
  assert.strictEqual(e.logo.path, '/g.png')
})
