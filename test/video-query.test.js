'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { parse, normalize, VOTE_FLOOR } = require('../src/video-query')

// Every case asserts the residual as well as the filters. A parser is allowed
// to understand nothing; it is not allowed to quietly drop what it did not
// understand, so "what was left over" is half of the contract and is checked
// everywhere.

function kinds(res) {
  return res.intents.map(function (i) { return i.kind })
}

// ---------------------------------------------------------------------------
// The table. `expect` is a partial filter match; `text` is the exact residual.
// ---------------------------------------------------------------------------
const CASES = [
  // --- decades -------------------------------------------------------------
  { q: '1970s thrillers', text: '', filters: { yearFrom: 1970, yearTo: 1979, genres: ['Thriller'] } },
  { q: '90s', text: '', filters: { yearFrom: 1990, yearTo: 1999 } },
  { q: 'the nineties', text: '', filters: { yearFrom: 1990, yearTo: 1999 } },
  { q: "1960's crime", text: '', filters: { yearFrom: 1960, yearTo: 1969, genres: ['Crime'] } },
  { q: '20s horror', text: '', filters: { yearFrom: 2020, yearTo: 2029, genres: ['Horror'] } },

  // --- years ---------------------------------------------------------------
  { q: 'from 1994', text: '', filters: { yearFrom: 1994, yearTo: 1994 } },
  { q: 'before 1980', text: '', filters: { yearTo: 1979, yearFrom: null } },
  { q: 'after 2010', text: '', filters: { yearFrom: 2011, yearTo: null } },
  { q: 'between 1960 and 1975', text: '', filters: { yearFrom: 1960, yearTo: 1975 } },
  { q: 'since 1990 documentaries', text: '', filters: { yearFrom: 1990, yearTo: null, genres: ['Documentary'] } },

  // --- runtime -------------------------------------------------------------
  { q: 'under 90 minutes', text: '', filters: { runtimeTo: 90, runtimeFrom: null } },
  { q: 'over 3 hours', text: '', filters: { runtimeFrom: 180 } },
  { q: 'under 2h', text: '', filters: { runtimeTo: 120 } },
  { q: '90 mins or less', text: '', filters: { runtimeTo: 90 } },
  { q: 'at least 100 min', text: '', filters: { runtimeFrom: 100 } },
  { q: '2 hours or more', text: '', filters: { runtimeFrom: 120 } },

  // --- countries and languages --------------------------------------------
  { q: 'korean films from the 90s', text: '', filters: { country: 'KR', catalog: 'movie', yearFrom: 1990, yearTo: 1999 } },
  { q: 'japanese horror', text: '', filters: { country: 'JP', genres: ['Horror'] } },
  { q: 'films from Iran', text: '', filters: { country: 'IR', catalog: 'movie' } },
  { q: 'korean', text: '', filters: { country: 'KR' } },
  { q: 'movies in japanese', text: '', filters: { language: 'ja', catalog: 'movie', country: null } },

  // --- genres --------------------------------------------------------------
  { q: 'sci-fi', text: '', filters: { genres: ['Science Fiction'] } },
  { q: 'science fiction movies', text: '', filters: { genres: ['Science Fiction'], catalog: 'movie' } },
  { q: 'scifi westerns', text: '', filters: { genres: ['Science Fiction', 'Western'] } },
  { q: 'docs about war', text: 'about', filters: { genres: ['Documentary', 'War'] } },

  // --- sort ----------------------------------------------------------------
  { q: 'best of 1994', text: '', filters: { sort: 'rating.desc', minVotes: VOTE_FLOOR, yearFrom: 1994, yearTo: 1994 } },
  { q: 'top rated horror', text: '', filters: { sort: 'rating.desc', genres: ['Horror'] } },
  { q: 'highest rated korean thrillers', text: '', filters: { sort: 'rating.desc', country: 'KR', genres: ['Thriller'] } },

  // --- similar -------------------------------------------------------------
  { q: 'films like parasite', text: '', filters: { similarTo: 'parasite', catalog: 'movie' } },
  { q: 'similar to the thing', text: '', filters: { similarTo: 'the thing' } },

  // --- catalog -------------------------------------------------------------
  { q: 'anime from 2019', text: '', filters: { catalog: 'anime', yearFrom: 2019, yearTo: 2019 } },
  { q: 'korean tv shows', text: '', filters: { catalog: 'tv', country: 'KR' } },

  // --- themes and movements ------------------------------------------------
  { q: 'neo-noir', text: '', filters: { keyword: 'neo-noir' } },
  { q: 'french new wave', text: '', filters: { movement: 'French New Wave', country: null } },
  { q: 'italian neorealism', text: '', filters: { movement: 'Italian Neorealism', country: null } },
  { q: '70s heist movies', text: '', filters: { keyword: 'heist', yearFrom: 1970, yearTo: 1979, catalog: 'movie' } },

  // --- mixed / residual ----------------------------------------------------
  { q: 'tarantino under 2 hours', text: 'tarantino', filters: { runtimeTo: 120 } },
  { q: 'kurosawa', text: 'kurosawa', filters: { yearFrom: null, genres: [] } },
  { q: 'directed by kurosawa', text: '', filters: { personName: 'kurosawa' } },
  { q: 'korean films from the 90s under 2 hours', text: '', filters: { country: 'KR', yearFrom: 1990, yearTo: 1999, runtimeTo: 120 } },

  // --- must NOT match ------------------------------------------------------
  { q: 'the french dispatch', text: 'the french dispatch', filters: { country: null, movement: null } },
  { q: '1917', text: '1917', filters: { yearFrom: null, yearTo: null } },
  { q: '1984', text: '1984', filters: { yearFrom: null, yearTo: null } },
  { q: 'drive', text: 'drive', filters: { genres: [], country: null } },
  { q: 'the italian job', text: 'the italian job', filters: { country: null } },
  { q: 'the drama teacher', text: 'the drama teacher', filters: { genres: [] } },
  { q: 'american psycho', text: 'american psycho', filters: { country: null } },
]

test('parses the table of real phrases', function (t) {
  for (const c of CASES) {
    const res = parse(c.q)
    assert.strictEqual(res.text, c.text, 'residual for ' + JSON.stringify(c.q) +
      ' was ' + JSON.stringify(res.text))
    for (const key of Object.keys(c.filters)) {
      assert.deepStrictEqual(res.filters[key], c.filters[key],
        key + ' for ' + JSON.stringify(c.q) + ' was ' + JSON.stringify(res.filters[key]))
    }
  }
})

test('the table is not vacuous - every non-title case extracted something', function () {
  const titleOnly = new Set(['the french dispatch', '1917', '1984', 'drive',
    'the italian job', 'the drama teacher', 'american psycho', 'kurosawa'])
  for (const c of CASES) {
    const res = parse(c.q)
    if (titleOnly.has(c.q)) {
      assert.strictEqual(res.intents.length, 0, 'expected no intents for ' + c.q)
      assert.strictEqual(res.confidence, 0)
    } else {
      assert.ok(res.intents.length > 0, 'expected intents for ' + c.q)
      assert.ok(res.confidence > 0, 'expected confidence for ' + c.q)
    }
  }
})

// ---------------------------------------------------------------------------
// Order independence
// ---------------------------------------------------------------------------

test('word order does not change the parse', function () {
  const a = parse('korean thrillers from the 90s')
  const b = parse('90s korean thrillers')
  assert.deepStrictEqual(a.filters, b.filters)
  assert.strictEqual(a.text, '')
  assert.strictEqual(b.text, '')

  const c = parse('under 90 minutes japanese horror')
  const d = parse('japanese horror under 90 minutes')
  assert.deepStrictEqual(c.filters, d.filters)
})

// ---------------------------------------------------------------------------
// Case and punctuation
// ---------------------------------------------------------------------------

test('case and punctuation are irrelevant', function () {
  const a = parse('KOREAN THRILLERS, from the 1990s!')
  assert.strictEqual(a.filters.country, 'KR')
  assert.deepStrictEqual(a.filters.genres, ['Thriller'])
  assert.strictEqual(a.filters.yearFrom, 1990)
  assert.strictEqual(a.text, '')

  assert.strictEqual(normalize("1960's"), '1960s')
  assert.strictEqual(normalize('Sci-Fi'), 'sci-fi')
})

// ---------------------------------------------------------------------------
// Spans - every intent must point at the text it came from
// ---------------------------------------------------------------------------

test('every intent carries the span it was read from', function () {
  const q = 'korean thrillers from the 90s under 2 hours'
  const res = parse(q)
  assert.ok(res.intents.length >= 4)
  for (const it of res.intents) {
    assert.strictEqual(q.slice(it.span[0], it.span[1]), it.source)
    assert.ok(it.confidence > 0 && it.confidence <= 1)
  }
  // Reported left-to-right so the UI can render chips in reading order.
  const starts = res.intents.map(function (i) { return i.span[0] })
  assert.deepStrictEqual(starts.slice().sort(function (a, b) { return a - b }), starts)
  assert.deepStrictEqual(kinds(res).sort(), ['country', 'decade', 'genre', 'runtime'])
})

// ---------------------------------------------------------------------------
// The ambiguity rules, stated as tests
// ---------------------------------------------------------------------------

test('a bare famous-title year is never a year filter, even with other intents', function () {
  const res = parse('korean films 1984')
  assert.strictEqual(res.filters.yearFrom, null)
  assert.strictEqual(res.filters.country, 'KR')
  assert.strictEqual(res.text, '1984')
})

test('a bare ordinary year becomes a year only when the query means something else', function () {
  const alone = parse('1973')
  assert.strictEqual(alone.filters.yearFrom, null)
  assert.strictEqual(alone.text, '1973')

  const cued = parse('korean films 1973')
  assert.strictEqual(cued.filters.yearFrom, 1973)
  assert.strictEqual(cued.filters.yearTo, 1973)
  assert.strictEqual(cued.text, '')
  // Low confidence, because it could still be a title.
  const yr = cued.intents.find(function (i) { return i.kind === 'year' })
  assert.ok(yr.confidence < 0.8)
})

test('an explicit cue rescues even an ambiguous year', function () {
  const res = parse('best of 1984')
  assert.strictEqual(res.filters.yearFrom, 1984)
  assert.strictEqual(res.filters.yearTo, 1984)
  assert.strictEqual(res.filters.sort, 'rating.desc')
  assert.strictEqual(res.text, '')
})

test('a nationality adjective followed by an unknown noun stays part of the title', function () {
  for (const q of ['the french dispatch', 'french dispatch', 'korean barbecue movie night']) {
    const res = parse(q)
    assert.strictEqual(res.filters.country, null, q)
  }
  // But corroborated by a catalogue word it is a real filter.
  assert.strictEqual(parse('french films').filters.country, 'FR')
  assert.strictEqual(parse('french thrillers').filters.country, 'FR')
})

test('a longer movement phrase beats the nationality inside it', function () {
  const res = parse('french new wave')
  assert.strictEqual(res.filters.movement, 'French New Wave')
  assert.strictEqual(res.filters.country, null)
  assert.strictEqual(res.intents.length, 1)
})

test('"the" suppresses genre, keyword and catalog matches', function () {
  assert.deepStrictEqual(parse('the drama teacher').filters.genres, [])
  assert.strictEqual(parse('the heist').filters.keyword, null)
  assert.strictEqual(parse('the movie').filters.catalog, null)
})

test('a probable match reports lower confidence than a certain one', function () {
  const sure = parse('korean films')          // corroborated adjective
  const guess = parse('korean')               // bare adjective
  const sureC = sure.intents.find(function (i) { return i.kind === 'country' }).confidence
  const guessC = guess.intents.find(function (i) { return i.kind === 'country' }).confidence
  assert.ok(guessC < sureC, guessC + ' should be under ' + sureC)
})

// ---------------------------------------------------------------------------
// Residual honesty
// ---------------------------------------------------------------------------

test('unrecognised text survives verbatim', function () {
  const res = parse('mifune samurai films under 2 hours')
  assert.strictEqual(res.text, 'mifune')
  assert.strictEqual(res.filters.keyword, 'samurai')
  assert.strictEqual(res.filters.runtimeTo, 120)
})

test('a pure title query is passed through untouched with zero confidence', function () {
  const res = parse('Once Upon a Time in Hollywood')
  assert.strictEqual(res.filters.yearFrom, null)
  assert.strictEqual(res.confidence, 0)
  assert.ok(res.text.toLowerCase().indexOf('hollywood') !== -1)
})

test('empty and whitespace input do not throw', function () {
  for (const q of ['', '   ', null, undefined, '???']) {
    const res = parse(q)
    assert.strictEqual(res.confidence, 0)
    assert.deepStrictEqual(res.intents, [])
    assert.deepStrictEqual(res.filters.genres, [])
  }
})

test('confidence rises as more of the input is understood', function () {
  const all = parse('korean thrillers from the 90s')
  const half = parse('korean thrillers about mifune and his dog')
  assert.ok(all.confidence > half.confidence)
  assert.ok(all.confidence > 0.7)
})

test('a rating sort always carries a vote floor', function () {
  for (const q of ['best of 1994', 'top rated', 'highest rated korean films']) {
    const res = parse(q)
    assert.strictEqual(res.filters.sort, 'rating.desc', q)
    assert.strictEqual(res.filters.minVotes, VOTE_FLOOR, q)
  }
})

test('similarTo consumes the whole trailing title', function () {
  const res = parse('films like once upon a time in the west')
  assert.strictEqual(res.filters.similarTo, 'once upon a time in the west')
  assert.strictEqual(res.text, '')
  assert.strictEqual(res.filters.catalog, 'movie')
})

test('a dangling cue with nothing after it is not an intent', function () {
  const res = parse('like')
  assert.strictEqual(res.filters.similarTo, null)
  assert.strictEqual(res.text, 'like')
})

test('the module exposes the same api through require and a global', function () {
  const mod = require('../src/video-query')
  assert.strictEqual(typeof mod.parse, 'function')
  assert.strictEqual(typeof mod.tokenize, 'function')
  assert.ok(mod.AMBIGUOUS_TITLE_YEARS.has(1917))
})
