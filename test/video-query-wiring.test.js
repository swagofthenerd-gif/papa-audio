'use strict';
// The parser was complete and unreachable: the search box did a title lookup
// and nothing else, so "1970s thrillers" came back "No matches" for a
// perfectly good ask. These tests cover the join between the two.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const RENDERER = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8')
const HTML = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8')
const query = require(path.join(ROOT, 'src', 'video-query.js'))

// The mapping functions are lifted out and run, because what matters is what
// they produce for a real query — not that they exist.
function lift() {
  const from = RENDERER.indexOf('const _QUERY_SORTS = {')
  const to = RENDERER.indexOf('function _querySummary(parsed)')
  assert.ok(from > 0 && to > from, 'found the mapping block')
  const src = RENDERER.slice(from, to)
  // _emptyFilters is Browse's, and the mapper is checked against the real one.
  const ef = RENDERER.slice(RENDERER.indexOf('function _emptyFilters()'),
                            RENDERER.indexOf('var _browse = {'))
  // eslint-disable-next-line no-new-func
  return new Function('window', src + ef + `
    return { _queryBrowseFilters, _emptyFilters, _QUERY_SORTS, QUERY_MIN_CONFIDENCE, _BROWSE_FILTER_KEYS }
  `)({ PapaVideoQuery: query })
}

test('the parser is loaded in the renderer', () => {
  assert.match(HTML, /<script src="video-query\.js"><\/script>/)
  // Before renderer.js, or window.PapaVideoQuery is undefined when it runs.
  assert.ok(HTML.indexOf('video-query.js') < HTML.indexOf('renderer.js'),
    'the parser must load before the renderer')
})

test('every sort the parser can emit has a Browse equivalent', () => {
  // A missing entry means the sort is silently dropped and the grid comes back
  // in a different order than the words asked for.
  const { _QUERY_SORTS } = lift()
  const emitted = new Set()
  for (const q of ['best films', 'top rated films', 'popular films', 'trending films',
                   'newest films', 'latest films', 'oldest films', 'recent films']) {
    const s = query.parse(q).filters.sort
    if (s) emitted.add(s)
  }
  assert.ok(emitted.size >= 4, `only ${emitted.size} sorts emitted`)
  for (const s of emitted) {
    assert.ok(_QUERY_SORTS[s], `the parser emits ${s} and Browse has no mapping for it`)
  }
})

test('every mapped sort is one Browse actually offers', () => {
  const { _QUERY_SORTS } = lift()
  const offered = new Set([...RENDERER.matchAll(/_BROWSE_SORTS = \[([\s\S]*?)\]/g)]
    .flatMap(m => [...m[1].matchAll(/key: '([a-z]+)'/g)].map(x => x[1])))
  assert.ok(offered.size >= 4, 'found the Browse sort list')
  for (const v of Object.values(_QUERY_SORTS)) {
    assert.ok(offered.has(v), `${v} is not a Browse sort key`)
  }
})

test('a described query becomes Browse filters', () => {
  const { _queryBrowseFilters } = lift()
  const f = _queryBrowseFilters(query.parse('1970s thrillers'))
  // genres are NAMES at this stage; the ids come later, from the vocabulary.
  assert.deepStrictEqual(f, { yearFrom: 1970, yearTo: 1979, genres: ['Thriller'] })
})

test('a genre name is turned into the id TMDB needs, not passed through', () => {
  // TMDB's with_genres takes numeric ids and the parser speaks in names, so
  // putting "Thriller" straight into filters.genres sent
  // `with_genres=Thriller` and the genre half of every parsed query was
  // silently dropped. Caught by tracing the value to the wire rather than by
  // any test — which is why this one traces it.
  const from = RENDERER.indexOf('function _resolvePendingGenreNames')
  const to = RENDERER.indexOf('async function _loadBrowseVocab')
  assert.ok(from > 0 && to > from, 'found the resolver')
  const world = {
    _browse: { filters: { catalog: 'movie', genres: [] }, pendingGenreNames: ['Thriller', 'Drama'] },
    _browseVocab: { genres: { movie: [{ id: 53, name: 'Thriller' }, { id: 18, name: 'Drama' }] } },
    said: [],
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('_browse', '_browseVocab', 'showSnackbar',
    RENDERER.slice(from, to) + '; return _resolvePendingGenreNames')
  run(world._browse, world._browseVocab, m => world.said.push(m))()
  assert.deepStrictEqual(world._browse.filters.genres, [53, 18])
  assert.strictEqual(world._browse.pendingGenreNames, null, 'consumed, so it cannot apply twice')
  assert.deepStrictEqual(world.said, [])
})

test('a genre the catalogue does not have is dropped and said out loud', () => {
  // An unknown id returns an empty grid, and an empty grid for a query that was
  // mostly understood is worse than the same query without its genre.
  const from = RENDERER.indexOf('function _resolvePendingGenreNames')
  const to = RENDERER.indexOf('async function _loadBrowseVocab')
  const world = {
    _browse: { filters: { catalog: 'movie', genres: [] }, pendingGenreNames: ['Thriller', 'Mumblecore'] },
    _browseVocab: { genres: { movie: [{ id: 53, name: 'Thriller' }] } },
    said: [],
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('_browse', '_browseVocab', 'showSnackbar',
    RENDERER.slice(from, to) + '; return _resolvePendingGenreNames')
  run(world._browse, world._browseVocab, m => world.said.push(m))()
  assert.deepStrictEqual(world._browse.filters.genres, [53])
  assert.match(world.said[0], /Could not filter by Mumblecore/)
})

test('the resolver is called after the vocabulary loads, not before', () => {
  // The vocabulary is what turns a name into an id; running first would drop
  // every genre.
  const fn = RENDERER.slice(RENDERER.indexOf('async function renderBrowse'),
                            RENDERER.indexOf('async function renderBrowse') + 1400)
  const vocabAt = fn.indexOf('await _loadBrowseVocab')
  const resolveAt = fn.indexOf('_resolvePendingGenreNames()')
  assert.ok(vocabAt > 0 && resolveAt > vocabAt, 'the resolve must follow the load')
})

test('the parsed path stores names and never ids', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('function _actOnParsedQuery'),
                            RENDERER.indexOf('async function _openPersonByName'))
  assert.match(fn, /_browse\.pendingGenreNames = names/)
  assert.match(fn, /delete filters\.genres/, 'the names must not reach filters.genres directly')
})

test('a national query carries its country and catalog', () => {
  const { _queryBrowseFilters } = lift()
  const f = _queryBrowseFilters(query.parse('korean films from the 90s'))
  assert.strictEqual(f.country, 'KR')
  assert.strictEqual(f.catalog, 'movie')
  assert.strictEqual(f.yearFrom, 1990)
  assert.strictEqual(f.yearTo, 1999)
})

test('a runtime query carries the bound', () => {
  const { _queryBrowseFilters } = lift()
  assert.strictEqual(_queryBrowseFilters(query.parse('under 90 minutes')).runtimeTo, 90)
  assert.strictEqual(_queryBrowseFilters(query.parse('over 3 hours')).runtimeFrom, 180)
})

test('a bare title produces no filters at all', () => {
  // The whole point of the parser's restraint. If any of these produced
  // filters, typing a film name would silently take you to a grid.
  const { _queryBrowseFilters } = lift()
  for (const t of ['the french dispatch', 'american psycho', '1917', 'drive',
                   'parasite', 'seven samurai', 'heat']) {
    assert.strictEqual(_queryBrowseFilters(query.parse(t)), null, t)
  }
})

test('a filter the parser can emit and Browse cannot express is not silently dropped', () => {
  // movement, keyword, similarTo and minVotes are parsed and have nowhere to
  // go. That is a decision, and it is written down where the next person will
  // read it rather than looking like an oversight.
  const { _BROWSE_FILTER_KEYS } = lift()
  const block = RENDERER.slice(RENDERER.indexOf('// What Browse can actually express'),
                               RENDERER.indexOf('function _queryBrowseFilters'))
  for (const k of ['movement', 'keyword', 'similarTo', 'minVotes']) {
    assert.ok(block.includes(k), `${k} is unhandled and unmentioned`)
    assert.ok(!_BROWSE_FILTER_KEYS.includes(k), `${k} is not a Browse filter`)
  }
})

test('the confidence floor keeps every bare title out and lets the real shapes through', () => {
  const { QUERY_MIN_CONFIDENCE } = lift()
  const shouldAct = ['1970s thrillers', 'korean films from the 90s', 'under 90 minutes',
                     'best japanese films of the 1960s', 'films by kurosawa',
                     'anime from the 2010s', 'tv shows from japan']
  const shouldNot = ['the french dispatch', 'american psycho', '1917', 'drive', 'kurosawa']
  for (const q of shouldAct) {
    assert.ok(query.parse(q).confidence >= QUERY_MIN_CONFIDENCE,
      `${q} scored ${query.parse(q).confidence}, below the floor`)
  }
  for (const q of shouldNot) {
    assert.ok(query.parse(q).confidence < QUERY_MIN_CONFIDENCE,
      `${q} scored ${query.parse(q).confidence}, above the floor — a title would reroute the page`)
  }
})

test('filters are applied over Browse defaults, not merged into leftovers', () => {
  // Otherwise a previous search's country or runtime survives into the next
  // one and the grid answers a question nobody asked.
  const fn = RENDERER.slice(RENDERER.indexOf('function _actOnParsedQuery'),
                            RENDERER.indexOf('async function _openPersonByName'))
  assert.match(fn, /Object\.assign\(_emptyFilters\(\), filters\)/)
  assert.match(fn, /_browse\.page = 1/, 'and it starts at page one')
  assert.match(fn, /_browse\.results = \[\]/)
})

test('the parse is offered on Enter and never on every keystroke', () => {
  // Typing must keep doing the title search it always did. A box that
  // redirects while you are still typing cannot be told what you meant.
  const body = RENDERER.slice(RENDERER.indexOf('function _bindVideoSearch'),
                              RENDERER.indexOf('function _runVideoTitleSearch'))
  assert.match(body, /setTimeout\(run, 300\)/)
  const enter = body.slice(body.indexOf("e.key === 'Enter'"))
  assert.match(enter, /_actOnParsedQuery\(_parseVideoQuery\(query\)\)/)
  // The debounced path must not consult the parser at all.
  const input = body.slice(body.indexOf("addEventListener('input'"), body.indexOf("addEventListener('keydown'"))
  assert.doesNotMatch(input, /_actOnParsedQuery|_parseVideoQuery/)
})

test('a cued person resolves to a person page, and falls back to titles', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('async function _openPersonByName'),
                            RENDERER.indexOf('function _videoCard(item)'))
  assert.match(fn, /window\.api\.videoPerson\(\{ query: name \}\)/)
  assert.match(fn, /navigate\('person'/)
  // The parser leaves a bare surname residual because it cannot tell one from a
  // title; when a cued name turns out not to be a person, the words are still
  // worth searching.
  assert.match(fn, /_runVideoTitleSearch\(name\)/)
  assert.match(fn, /_videoSearchTicket !== ticket/, 'a stale person lookup must not navigate')
})

test('the parser is never allowed to throw into the search box', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('function _parseVideoQuery'),
                            RENDERER.indexOf('// Below this the parse is a guess'))
  assert.match(fn, /try \{/)
  assert.match(fn, /catch/)
  assert.match(fn, /if \(!window\.PapaVideoQuery\) return null/,
    'a missing script must not break search')
})
