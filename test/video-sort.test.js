'use strict';
// Sorting a loaded grid (plan item 37).
//
// A curated shelf's order is the curation — The Canon is rating-first by design
// — so this sorts what has been loaded rather than re-querying, and the control
// says so. The comparator is lifted out and run, because a sort is exactly the
// kind of code that looks right and gets the tie-break wrong.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')

function lift() {
  const from = RENDERER.indexOf('const VSORTS = [')
  const to = RENDERER.indexOf('function _vSortControlHtml')
  assert.ok(from > 0 && to > from, 'found the sort block')
  // eslint-disable-next-line no-new-func
  return new Function(RENDERER.slice(from, to) + '; return { VSORTS, _vSortItems, _vNullsLast }')()
}

const FILMS = [
  { id: 1, title: 'Seven Samurai', year: 1954, rating: 8.5 },
  { id: 2, title: 'Parasite', year: 2019, rating: 8.5 },
  { id: 3, title: 'Andrei Rublev', year: 1966, rating: 8.2 },
  { id: 4, title: 'A Nameless Thing', year: null, rating: null },
  { id: 5, title: 'Zerkalo', year: 1975, rating: 8.1 },
]

test('no sort returns the order it was given', () => {
  // The default is the shelf's own order, which is the whole point.
  const { _vSortItems } = lift()
  assert.deepStrictEqual(_vSortItems(FILMS, '').map(f => f.id), [1, 2, 3, 4, 5])
  assert.deepStrictEqual(_vSortItems(FILMS, null).map(f => f.id), [1, 2, 3, 4, 5])
})

test('the returned list is a copy, so the loaded items are not reordered', () => {
  // The grid repaints from _shelfPage.items; sorting in place would make the
  // "shelf order" option unable to get back.
  const { _vSortItems } = lift()
  const out = _vSortItems(FILMS, 'title')
  assert.notStrictEqual(out, FILMS)
  assert.deepStrictEqual(FILMS.map(f => f.id), [1, 2, 3, 4, 5], 'the input moved')
})

test('best first is by rating, descending', () => {
  const { _vSortItems } = lift()
  const out = _vSortItems(FILMS, 'rating').map(f => f.id)
  assert.deepStrictEqual(out.slice(0, 2), [1, 2], 'the two 8.5s keep their original order')
  assert.deepStrictEqual(out, [1, 2, 3, 5, 4])
})

test('newest and oldest are by year, and are exact reverses apart from the unknowns', () => {
  const { _vSortItems } = lift()
  assert.deepStrictEqual(_vSortItems(FILMS, 'newest').map(f => f.id), [2, 5, 3, 1, 4])
  assert.deepStrictEqual(_vSortItems(FILMS, 'oldest').map(f => f.id), [1, 3, 5, 2, 4])
})

test('an item missing the sorted field goes last, not first', () => {
  // Treating a missing year as 0 would put every undated film at the top of
  // "oldest" — and the catalogue has plenty of undated entries.
  const { _vSortItems } = lift()
  for (const sort of ['rating', 'newest', 'oldest']) {
    const out = _vSortItems(FILMS, sort)
    assert.strictEqual(out[out.length - 1].id, 4, sort + ' put the unknown first')
  }
})

test('everything unknown is stable rather than shuffled', () => {
  const { _vSortItems } = lift()
  const blanks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.deepStrictEqual(_vSortItems(blanks, 'rating').map(x => x.id), ['a', 'b', 'c'])
})

test('A–Z is case-insensitive and uses locale collation', () => {
  const { _vSortItems } = lift()
  const list = [
    { title: 'zodiac' }, { title: 'Amélie' }, { title: 'Andrei Rublev' }, { title: 'ikiru' },
  ]
  assert.deepStrictEqual(_vSortItems(list, 'title').map(x => x.title),
    ['Amélie', 'Andrei Rublev', 'ikiru', 'zodiac'])
})

test('a title-less item sorts as empty rather than throwing', () => {
  const { _vSortItems } = lift()
  const list = [{ title: 'B' }, {}, { title: 'A' }, { name: 'C' }]
  assert.doesNotThrow(() => _vSortItems(list, 'title'))
  // `name` is used where `title` is absent, because the anime entries carry it.
  assert.deepStrictEqual(_vSortItems(list, 'title').map(x => x.title || x.name || ''), ['', 'A', 'B', 'C'])
})

test('the sort is stable across repeated repaints', () => {
  // The grid repaints on every appended page. An unstable sort would make two
  // films of the same year swap places each time.
  const { _vSortItems } = lift()
  const once = _vSortItems(FILMS, 'rating').map(f => f.id)
  for (let i = 0; i < 5; i++) {
    assert.deepStrictEqual(_vSortItems(FILMS, 'rating').map(f => f.id), once)
  }
})

test('an unknown sort key is ignored rather than emptying the grid', () => {
  const { _vSortItems } = lift()
  assert.deepStrictEqual(_vSortItems(FILMS, 'by-vibes').map(f => f.id), [1, 2, 3, 4, 5])
})

test('a non-array is handled', () => {
  const { _vSortItems } = lift()
  for (const bad of [null, undefined, 'nope', 42, {}]) {
    assert.deepStrictEqual(_vSortItems(bad, 'rating'), [])
  }
})

// ── the control ───────────────────────────────────────────────────────────

test('every sort offered has an implementation', () => {
  // A label in the dropdown with no comparator is a control that does nothing.
  const { VSORTS, _vSortItems } = lift()
  for (const s of VSORTS) {
    if (!s.key) continue
    const out = _vSortItems(FILMS, s.key).map(f => f.id)
    assert.notDeepStrictEqual(out, [1, 2, 3, 4, 5], s.key + ' changed nothing, so it has no comparator')
  }
})

test('the control says when it is sorting only what is loaded', () => {
  // Otherwise it looks like the whole shelf was re-queried, which it was not.
  const fn = RENDERER.slice(RENDERER.indexOf('function _vSortControlHtml'),
                            RENDERER.indexOf('async function renderShelf'))
  assert.match(fn, /of what is loaded/)
  // …and only when a sort is applied AND the grid is paged. A filmography is
  // not paged — every credit is already there — so the caveat would be a lie.
  assert.match(fn, /current && partial \? '<span class="vsort-note">/)
})

test('a sorted shelf repaints instead of appending', () => {
  // An appended page belongs wherever the sort puts it, which is usually not
  // the end.
  const fn = RENDERER.slice(RENDERER.indexOf('async function _loadShelfPage'),
                            RENDERER.indexOf('function _repaintShelfGrid'))
  // The condition also covers the hide-seen filter, which is a whole-grid
  // question for the same reason: the count of hidden titles changes.
  assert.match(fn, /if \(_shelfPage\.sort \|\| _hideSeen\)/)
  assert.match(fn, /_repaintShelfGrid\(\)/)
  assert.match(fn, /insertAdjacentHTML\('beforeend'/, 'the unsorted path still appends')
})

test('the sort does not follow you to the next shelf', () => {
  // It belongs to the grid in front of you; inheriting it would silently
  // reorder the next curated shelf you opened.
  const fn = RENDERER.slice(RENDERER.indexOf('async function renderShelf(key)'),
                            RENDERER.indexOf('async function _loadShelfPage'))
  assert.match(fn, /ticket: ticket, sort: ''/)
})

test('the repaint rebinds the cards', () => {
  // innerHTML discards the old nodes and their listeners with them, so every
  // card would be dead without this.
  const fn = RENDERER.slice(RENDERER.indexOf('function _repaintShelfGrid'),
                            RENDERER.indexOf('// Loads the next page as the end'))
  assert.match(fn, /_bindVideoCards\(grid\)/)
})

test('the control is styled and focusable', () => {
  assert.match(CSS, /\.cinema \.vsort-select \{/)
  assert.match(CSS, /\.cinema \.vsort-select:focus-visible/, 'a control needs a visible focus state')
  assert.match(CSS, /\.cinema \.vsort-note \{/)
})

test('the paged grid claims the caveat and the unpaged one does not', () => {
  // The shelf is paged; the filmography is not.
  assert.match(RENDERER, /_vSortControlHtml\('', 'vshelf-sort', true\)/)
  assert.match(RENDERER, /_vSortControlHtml\(_person\.sort, 'vperson-sort-select'\)/)
})

test('a filmography defaults to newest rather than TMDB order', () => {
  // TMDB returns credits in an order that is neither chronological nor ranked,
  // and the order is the question a filmography is being asked.
  const fn = RENDERER.slice(RENDERER.indexOf("_person = { films: films"),
                            RENDERER.indexOf('function _paintPersonRows'))
  assert.match(fn, /sort: 'newest'/)
})

test('the filmography rebinds its own control after each repaint', () => {
  // innerHTML replaces the control, so a listener bound once would be dead
  // after the first change — the classic one-shot dropdown.
  const fn = RENDERER.slice(RENDERER.indexOf('function _paintPersonRows'),
                            RENDERER.indexOf('// The name and photo of the person just clicked'))
  // The controls row (filter box + sort) is written into rows.innerHTML, then
  // the sort is re-bound after it — the markup that holds the control has just
  // been replaced, so a once-bound listener would be dead.
  assert.match(fn, /rows\.innerHTML =/)
  const after = fn.slice(fn.indexOf('rows.innerHTML ='))
  assert.match(after, /getElementById\('vperson-sort-select'\)\?\.addEventListener/,
    'the control must be re-bound after the markup that contains it is replaced')
})
