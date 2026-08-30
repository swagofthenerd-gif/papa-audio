'use strict'
// The browse filter model: state, request mapping, active chips, and the
// empty-state reasoning. Pure functions, extracted and executed.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')

function extract(name) {
  const start = SRC.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found')
  let depth = 0
  for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++
    else if (SRC[j] === '}') { depth--; if (!depth) return SRC.slice(start, j + 1) }
  }
  throw new Error('unbalanced ' + name)
}

const ctx = {
  console,
  _browseVocab: {
    genres: { movie: [{ id: 27, name: 'Horror' }, { id: 28, name: 'Action' }], anime: [{ id: 'Action', name: 'Action' }] },
    tags: null,
  },
  _browse: { filters: null },
  _ANIME_STATUS: [{ key: 'RELEASING', label: 'Airing' }, { key: 'FINISHED', label: 'Finished' }],
  esc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
}
vm.createContext(ctx)
for (const fn of ['_emptyFilters', '_browseRequest', '_activeFilterChips', '_clearFilterKey', '_browseEmptyHtml']) {
  vm.runInContext(extract(fn), ctx)
}
const filters = over => Object.assign(ctx._emptyFilters(), over || {})
// Arrays built inside the vm belong to another realm, so deepStrictEqual fails
// on prototype identity even when the contents match. Spreading gives them this
// realm's prototype without weakening the comparison.
const local = a => [...a]

// ── Request mapping ─────────────────────────────────────────────────────────

test('a movie query carries the filters TMDB understands', () => {
  const req = ctx._browseRequest(filters({
    genres: [27], exclude: [35], yearFrom: 2015, yearTo: 2024,
    minRating: 7, runtimeFrom: 90, runtimeTo: 150, sort: 'rating',
  }), 2)
  assert.strictEqual(req.catalog, 'movie')
  assert.strictEqual(req.page, 2)
  assert.deepStrictEqual(local(req.genres), [27])
  assert.deepStrictEqual(local(req.excludeGenres), [35])
  assert.strictEqual(req.yearFrom, 2015)
  assert.strictEqual(req.runtimeTo, 150)
  assert.strictEqual(req.sort, 'rating')
})

// AniList has no runtime or exclusion, and takes season/format/status instead.
test('an anime query is mapped to AniList’s vocabulary', () => {
  const req = ctx._browseRequest(filters({
    catalog: 'anime', genres: ['Action'], tags: ['Martial Arts'],
    format: 'TV', status: 'FINISHED', season: 'WINTER', seasonYear: 2023, minRating: 7,
  }), 1)
  assert.deepStrictEqual(local(req.genres), ['Action'])
  assert.deepStrictEqual(local(req.tags), ['Martial Arts'])
  assert.deepStrictEqual(local(req.formats), ['TV'])
  assert.strictEqual(req.status, 'FINISHED')
  assert.strictEqual(req.seasonYear, 2023)
  assert.ok(!('excludeGenres' in req), 'AniList cannot exclude a genre')
  assert.ok(!('runtimeFrom' in req))
})

// Anime has no year range, so a plain "from" year is the closest thing.
test('a year filter falls back to the anime season year', () => {
  const req = ctx._browseRequest(filters({ catalog: 'anime', yearFrom: 2019 }), 1)
  assert.strictEqual(req.seasonYear, 2019)
})

test('the filter object is not mutated by building a request', () => {
  const f = filters({ genres: [27], tags: ['X'] })
  const req = ctx._browseRequest(f, 1)
  req.genres.push(99)
  assert.deepStrictEqual(local(f.genres), [27], 'the request must take copies')
})

// ── Active chips ────────────────────────────────────────────────────────────

test('only the filters that are set become chips', () => {
  assert.deepStrictEqual(local(ctx._activeFilterChips(filters())), [])
  const chips = local(ctx._activeFilterChips(filters({ genres: [27], minRating: 7, yearFrom: 2015, yearTo: 2024 })))
  assert.deepStrictEqual(chips.map(c => c.label), ['Horror', '2015–2024', '★ 7+'])
})

// No mainstream service can express this, so the chip has to make it obvious.
test('an excluded genre reads as an exclusion', () => {
  const chips = local(ctx._activeFilterChips(filters({ exclude: [27] })))
  assert.deepStrictEqual(chips.map(c => c.label), ['not Horror'])
})

test('a genre with no known name still produces a usable chip', () => {
  const chips = local(ctx._activeFilterChips(filters({ genres: [9999] })))
  assert.deepStrictEqual(chips.map(c => c.label), ['9999'])
})

test('every chip removes exactly its own filter', () => {
  const f = filters({ genres: [27, 28], exclude: [35], tags: ['A', 'B'], minRating: 7, yearFrom: 2015, yearTo: 2020 })
  ctx._clearFilterKey(f, 'genre:27')
  assert.deepStrictEqual(local(f.genres), [28], 'the other genre survives')
  ctx._clearFilterKey(f, 'tag:A')
  assert.deepStrictEqual(local(f.tags), ['B'])
  ctx._clearFilterKey(f, 'rating')
  assert.strictEqual(f.minRating, null)
  ctx._clearFilterKey(f, 'years')
  assert.strictEqual(f.yearFrom, null)
  assert.strictEqual(f.yearTo, null)
  ctx._clearFilterKey(f, 'exclude:35')
  assert.deepStrictEqual(local(f.exclude), [])
})

test('removing an unknown key changes nothing', () => {
  const f = filters({ genres: [27] })
  ctx._clearFilterKey(f, 'nonsense:1')
  assert.deepStrictEqual(local(f.genres), [27])
})

// ── Empty state ─────────────────────────────────────────────────────────────
// An empty result is almost always one filter set too tight. Naming the likely
// culprit is the difference between a dead end and an obvious next move.

test('a very high rating filter is named as the likely culprit', () => {
  ctx._browse.filters = filters({ minRating: 9 })
  const html = ctx._browseEmptyHtml()
  assert.match(html, /rating of 9 and above is very high/i)
  assert.match(html, /data-relax="rating"/)
})

test('too many combined themes are named', () => {
  ctx._browse.filters = filters({ catalog: 'anime', tags: ['A', 'B', 'C'] })
  const html = ctx._browseEmptyHtml()
  assert.match(html, /combining 3 themes/i)
  assert.match(html, /data-relax="tags"/)
})

test('too many combined genres explain that all must match', () => {
  ctx._browse.filters = filters({ genres: [1, 2, 3] })
  assert.match(ctx._browseEmptyHtml(), /has to match all 3 genres/i)
})

test('a narrow year range is named', () => {
  ctx._browse.filters = filters({ yearFrom: 2019, yearTo: 2020 })
  assert.match(ctx._browseEmptyHtml(), /year range is narrow/i)
})

test('with nothing obviously at fault it still offers a way out', () => {
  ctx._browse.filters = filters({ genres: [27] })
  const html = ctx._browseEmptyHtml()
  assert.match(html, /Try removing a filter or two/)
  assert.match(html, /vempty-clear/)
  assert.ok(!/data-relax/.test(html), 'no filter should be blamed without cause')
})

// ── Wiring ──────────────────────────────────────────────────────────────────

test('Browse is a routed page with its own tab', () => {
  assert.match(SRC, /page === 'browse'\)\s*renderBrowse\(\)/)
  assert.match(SRC, /\{ key: 'browse', label: 'Browse' \}/)
  assert.match(SRC, /if \(_videoTab === 'browse'\) return navigate\('browse'\)/)
})

test('a filter change is debounced and ticketed', () => {
  const run = extract('_runBrowse')
  assert.match(run, /clearTimeout\(_browseTimer\)/)
  assert.match(run, /setTimeout\(/)
  const fetchFn = SRC.slice(SRC.indexOf('async function _fetchBrowse('), SRC.indexOf('function _vGridSkeleton'))
  assert.match(fetchFn, /_browse\.ticket !== ticket/, 'a stale page must never be rendered')
})

test('paging stops at the last page', () => {
  const arm = extract('_armBrowseObserver')
  assert.match(arm, /_browse\.page >= _browse\.totalPages/)
  assert.match(arm, /That is everything/)
  assert.match(arm, /observer\.disconnect\(\)/, 'the previous observer must be released')
})

test('a genre chip cycles through include, exclude and off', () => {
  const bind = extract('_bindFilterRail')
  assert.match(bind, /const inc = f\.genres\.some/)
  assert.match(bind, /const exc = f\.exclude\.some/)
  assert.match(bind, /if \(!inc && !exc\) f\.genres\.push\(value\)/)
  // AniList has no exclusion, so the cycle is two-state there.
  assert.match(bind, /else if \(inc && f\.catalog !== 'anime'\) f\.exclude\.push\(value\)/)
})

// Re-rendering the rail on each keystroke would move focus out of the box.
test('searching the theme list does not re-render the rail', () => {
  const bind = extract('_bindFilterRail')
  const at = bind.indexOf("getElementById('vf-tagsearch')")
  const handler = bind.slice(at, at + 260)
  assert.match(handler, /_tagChipsHtml/)
  assert.ok(!/_renderFilterRail/.test(handler), 'the search box must keep focus')
})

// Re-querying on every digit of "2015" fires four times, three for nonsense.
test('number fields commit on change, not on every keystroke', () => {
  const bind = extract('_bindFilterRail')
  const at = bind.indexOf('const num = function')
  assert.match(bind.slice(at, at + 300), /addEventListener\('change'/)
})

test('the excluded-genre chip is visually distinct', () => {
  assert.match(CSS, /\.vf-chip\.off[\s\S]*?text-decoration:\s*line-through/)
})

test('the filter rail stays reachable while the grid scrolls', () => {
  assert.match(CSS, /\.vfilters[\s\S]*?position:\s*sticky/)
})

// ── Presets ─────────────────────────────────────────────────────────────────
// "Hidden gems" is the preset a streaming service could never offer: well
// rated but not widely voted on, which is precisely what popularity-driven
// rows bury.
test('the shipped presets are scoped to the catalogs they make sense in', () => {
  const block = SRC.slice(SRC.indexOf('var _BROWSE_PRESETS'), SRC.indexOf('var _BROWSE_SORTS'))
  assert.match(block, /Hidden gems/)
  assert.match(block, /Short films/)
  // A runtime filter is meaningless for a series, and a season for a film.
  assert.match(block, /'Short films'[\s\S]*?catalog: 'movie'/)
  assert.match(block, /'This season'[\s\S]*?catalog: 'anime'/)
})

test('a preset applies over a clean slate, keeping the catalog', () => {
  const bind = extract('_bindFilterRail')
  assert.match(bind, /_browse\.filters = Object\.assign\(_emptyFilters\(\), \{ catalog: catalog \}, p\.filters\)/)
})

test('saving names the set after its own filters', () => {
  const bind = extract('_bindFilterRail')
  assert.match(bind, /chips\.slice\(0, 3\)/, 'the name comes from the active filters')
  assert.match(bind, /Set some filters first/, 'an empty set is not worth saving')
  assert.match(bind, /Already saved/, 'the same set must not be stored twice')
})

test('saved presets are capped so the rail cannot grow without limit', () => {
  assert.match(extract('_bindFilterRail'), /_writePresets\(list\.slice\(0, 12\)\)/)
})

// A corrupt stored value must degrade to none rather than throwing on every
// render of the rail.
test('preset storage goes through the validated reader and fails soft', () => {
  const read = extract('_savedPresets')
  assert.match(read, /PapaLocal/)
  assert.match(read, /readArray/)
  assert.match(read, /catch \(_\) \{ return \[\] \}/)
  assert.match(extract('_writePresets'), /catch/)
})

// ── Genre navigation ────────────────────────────────────────────────────────
test('a genre chip anywhere opens Browse filtered to it', () => {
  const jump = SRC.slice(SRC.indexOf('async function _jumpToGenre('), SRC.indexOf('// Anything carrying a person id'))
  assert.match(jump, /_browse\.filters = _emptyFilters\(\)/)
  assert.match(jump, /navigate\('browse'\)/)
  // TMDB genres are numeric ids and AniList's are names, so the display name
  // has to be resolved against whichever vocabulary applies.
  assert.match(jump, /String\(g\.name\)\.toLowerCase\(\) === String\(name\)\.toLowerCase\(\)/)
})

test('a genre the target catalog lacks opens Browse rather than doing nothing', () => {
  const jump = SRC.slice(SRC.indexOf('async function _jumpToGenre('), SRC.indexOf('// Anything carrying a person id'))
  assert.match(jump, /else showToast/)
  const navAt = jump.indexOf("navigate('browse')")
  const elseAt = jump.indexOf('else showToast')
  assert.ok(elseAt < navAt, 'it must still navigate when the genre is unknown')
})

test('genre chips are buttons, not inert spans', () => {
  assert.match(SRC, /<button class="video-genre-chip" data-genre-jump=/)
  assert.match(CSS, /\.video-genre-chip:focus-visible/)
})

// ── Keyboard ────────────────────────────────────────────────────────────────
// The player handler already caused this bug once: bound to document for the
// life of the app and firing on every screen, it swallowed characters typed
// into the app's search box.
test('browsing keys are inert unless a video page is showing', () => {
  const bind = extract('_bindBrowseKeys')
  assert.match(bind, /page !== 'video' && page !== 'browse' && page !== 'person' && page !== 'video-detail'/)
  assert.match(bind, /_videoKeysBound/, 'it must bind once, not per render')
})

test('typing in a field never triggers a browsing shortcut', () => {
  const bind = extract('_bindBrowseKeys')
  assert.match(bind, /tag === 'INPUT' \|\| tag === 'TEXTAREA' \|\| tag === 'SELECT'/)
  assert.match(bind, /isContentEditable === true/)
  assert.match(bind, /if \(typing\) \{/)
  // Escape must still get you out of the box without reaching for the mouse.
  assert.match(bind, /e\.target\.blur\(\)/)
})

// The theatre is modal; while it is open its keys apply, not these.
test('the theatre keeps the keyboard while it is open', () => {
  assert.match(extract('_bindBrowseKeys'), /theatre\.classList\.contains\('hidden'\)/)
})

test('slash focuses search and b opens Browse', () => {
  const bind = extract('_bindBrowseKeys')
  assert.match(bind, /e\.key === '\/'/)
  assert.match(bind, /getElementById\('video-search-input'\)/)
  assert.match(bind, /e\.key === 'b' \|\| e\.key === 'B'/)
})

// The grid is responsive, so the column count changes with the window and
// cannot be assumed.
test('vertical movement measures the row width rather than assuming it', () => {
  const move = extract('_moveCardFocus')
  assert.match(move, /getBoundingClientRect\(\)\.top/)
  assert.match(move, /perRow/)
  assert.match(move, /if \(perRow <= 0\) perRow = cards\.length/, 'a single-row grid must not divide by zero')
})

test('arrow movement stays inside the grid', () => {
  const move = extract('_moveCardFocus')
  assert.match(move, /Math\.min\(cards\.length - 1, index \+ 1\)/)
  assert.match(move, /Math\.max\(0, index - 1\)/)
  assert.match(move, /cards\[0\]\.focus\(\)/, 'the first press enters the grid')
})

test('Enter opens the focused card', () => {
  assert.match(extract('_bindBrowseKeys'), /classList\.contains\('vcard'\)[\s\S]*?el\.click\(\)/)
})
