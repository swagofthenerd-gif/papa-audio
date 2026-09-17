'use strict'
// "See all" could stop producing films and look like the end of the shelf.
//
// _loadShelfPage guards against two fetches for the same shelf being in the
// air at once with a `loading` flag, and against a stale answer appending
// itself to the wrong page with a ticket check:
//
//     if (_shelfPage.loading || _shelfPage.done) return
//     _shelfPage.loading = true
//     const res = await _fetchShelfPage(...)
//     if (_shelfPage.ticket !== ticket || state.currentPage !== 'shelf') return
//     _shelfPage.loading = false
//
// The early return took the guard but never released the lock. The infinite
// scroll fires this every time the sentinel comes into view, so a page that
// was in flight when the viewer clicked into a title — which is the normal way
// to leave a shelf — came back to a page that was no longer showing, returned,
// and left `loading` set on a _shelfPage object that is still the live one.
// From then on every further call returned at the first line. The grid simply
// stopped growing, with no error and no end-of-shelf line: it read as "that is
// all there is".
//
// A DIFFERENT shelf replaces _shelfPage wholesale, so the lock only needs
// releasing when this is still the same shelf — which is what the ticket says.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function extractFn (source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found')
  let i = source.indexOf('(', start)
  let paren = 0
  for (; i < source.length; i++) {
    if (source[i] === '(') paren++
    else if (source[i] === ')') { paren--; if (!paren) { i++; break } }
  }
  let depth = 0
  for (let j = source.indexOf('{', i); j < source.length; j++) {
    if (source[j] === '{') depth++
    else if (source[j] === '}') {
      depth--
      if (!depth) {
        const body = source.slice(start, j + 1)
        return (source.slice(Math.max(0, start - 6), start) === 'async ' ? 'async ' : '') + body
      }
    }
  }
  throw new Error('unbalanced braces in ' + name)
}

function el () {
  return {
    _html: '',
    dataset: {},
    get innerHTML () { return this._html },
    set innerHTML (v) { this._html = v },
    insertAdjacentHTML (_pos, html) { this._html += html },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener () {},
    textContent: '',
  }
}

function harness (source) {
  const els = { 'vshelf-more': el(), 'vshelf-grid': el(), 'vshelf-title': el(), 'vshelf-note': el() }
  let page = 0
  const sandbox = {
    document: { getElementById: id => els[id] || null, querySelector: () => null },
    state: { currentPage: 'shelf' },
    fetches: [],
    _shelfPage: { key: 'canon', page: 1, items: [], loading: false, done: false, ticket: 7, sort: '' },
    _hideSeen: false,
    esc: s => String(s == null ? '' : s),
    console,
    _videoErrorText: m => String(m),
    _videoCard: it => '<article data-video="' + it.type + ':' + it.id + '"></article>',
    _bindVideoCards () {},
    _repaintShelfGrid () {},
    _fetchShelfPage (key, p) {
      sandbox.fetches.push(key + '#' + p)
      page++
      return Promise.resolve({
        ok: true,
        shelf: { label: 'The Canon', note: '' },
        results: [{ type: 'movie', id: 100 + page }],
      })
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(extractFn(source, '_loadShelfPage'), sandbox)
  return { sandbox, els }
}

test('a shelf keeps loading pages as you scroll', async () => {
  const h = harness(SRC)
  await h.sandbox._loadShelfPage(7)
  await h.sandbox._loadShelfPage(7)
  await h.sandbox._loadShelfPage(7)
  assert.deepStrictEqual(h.sandbox.fetches, ['canon#1', 'canon#2', 'canon#3'])
})

test('a page that lands while the viewer is elsewhere does not wedge the shelf', async () => {
  const h = harness(SRC)
  await h.sandbox._loadShelfPage(7)
  assert.strictEqual(h.sandbox.fetches.length, 1)

  // The sentinel fires, the fetch goes out, and the viewer clicks into a title
  // before it lands.
  const inFlight = h.sandbox._loadShelfPage(7)
  h.sandbox.state.currentPage = 'video-detail'
  await inFlight
  assert.strictEqual(h.sandbox._shelfPage.loading, false,
    'the lock came off on the way out')

  // Back on the shelf, scrolling to the bottom again.
  h.sandbox.state.currentPage = 'shelf'
  await h.sandbox._loadShelfPage(7)
  assert.strictEqual(h.sandbox.fetches.length, 3,
    'the shelf can still load more films')
})

test('two sentinel hits at once are still only one fetch', async () => {
  const h = harness(SRC)
  const a = h.sandbox._loadShelfPage(7)
  const b = h.sandbox._loadShelfPage(7)
  await a; await b
  assert.strictEqual(h.sandbox.fetches.length, 1,
    'the lock still does the job it was there for')
})

test('an answer for a shelf the viewer has left behind touches nothing', async () => {
  const h = harness(SRC)
  const stale = h.sandbox._loadShelfPage(7)
  // A different shelf was opened: renderShelf replaces _shelfPage wholesale.
  h.sandbox._shelfPage = { key: 'world-cinema', page: 1, items: [], loading: false, done: false, ticket: 8, sort: '' }
  await stale
  assert.strictEqual(h.sandbox._shelfPage.page, 1,
    'the old shelf did not advance the new one')
  assert.strictEqual(h.sandbox._shelfPage.items.length, 0)
  assert.strictEqual(h.sandbox._shelfPage.loading, false,
    'and it certainly did not clear a lock it does not own')
})

test('MUTATION: the old early return wedges the shelf for good', async () => {
  const broken = SRC.replace(
    "  if (_shelfPage.ticket !== ticket) return\n" +
    "  if (state.currentPage !== 'shelf') { _shelfPage.loading = false; return }\n" +
    '  _shelfPage.loading = false',
    "  if (_shelfPage.ticket !== ticket || state.currentPage !== 'shelf') return\n" +
    '  _shelfPage.loading = false')
  assert.notStrictEqual(broken, SRC, 'the mutation applied')
  const h = harness(broken)
  const inFlight = h.sandbox._loadShelfPage(7)
  h.sandbox.state.currentPage = 'video-detail'
  await inFlight
  assert.strictEqual(h.sandbox._shelfPage.loading, true, 'the lock is stuck')

  h.sandbox.state.currentPage = 'shelf'
  await h.sandbox._loadShelfPage(7)
  await h.sandbox._loadShelfPage(7)
  assert.strictEqual(h.sandbox.fetches.length, 1,
    'this is the defect: the shelf never loads another page, and says nothing')
})
