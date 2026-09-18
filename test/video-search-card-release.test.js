'use strict'
// Searching in Movies & TV retained every result card it had ever drawn.
//
// The enrichment queue (src/video-enrich.js) keys its bookkeeping on the card
// ELEMENT, in a plain Map, with an apply closure per card. _releaseCardsIn is
// what takes a discarded card back out of it, and setContent() calls it on
// every page change — which is why this leak was believed closed, and why
// _wipeVideoMounts was added when tab switching turned out not to be a page
// change either.
//
// Search is not a page change either, and it is the busiest repaint in the
// tab. #video-search-results is replaced:
//
//   - on every debounced keystroke (the "Searching…" skeleton),
//   - on the response,
//   - on every type chip and every decade change,
//   - on the typo-tolerance retry,
//   - when the query is cleared, Escape is pressed, or a tab is switched.
//
// None of those released anything. Typing "tokyo revengers" is fourteen
// fetches; each one replaced a full grid of cards, and the queue kept a
// record, a closure and a detached poster <img> for every one of them, for the
// life of the session.
//
// This drives the REAL enricher through the REAL paint paths.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const { createEnricher } = require('../src/video-enrich')

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

// The results box: replacing its innerHTML throws its cards away, which is the
// whole shape of the bug — the elements go, the enricher's records stay.
function box () {
  return {
    id: 'video-search-results',
    _cards: [],
    _html: '',
    dataset: {},
    style: { display: '', removeProperty () { this.display = '' } },
    get innerHTML () { return this._html },
    set innerHTML (v) { this._html = v; this._cards = [] },
    querySelectorAll (sel) {
      if (sel === '.vcard[data-enrich-observed="1"]') return this._cards.slice()
      return []
    },
    querySelector () { return null },
    addEventListener () {},
  }
}
function card (key) {
  return { dataset: { enrichObserved: '1', video: key }, getAttribute: () => key }
}

function harness (source, opts) {
  opts = opts || {}
  const observed = new Set()
  const enricher = createEnricher({
    fetchDetail: () => new Promise(() => {}),   // never resolves: no I/O here
    observerFactory: () => ({
      observe: el => observed.add(el),
      unobserve: el => observed.delete(el),
      disconnect: () => observed.clear(),
    }),
  })

  const els = { 'video-search-results': box(), vrows: box(), 'vhero-mount': box(), 'vtaste-row': box() }
  const filled = []

  const sandbox = {
    document: { getElementById: id => els[id] || null },
    window: { api: { videoSearch: opts.videoSearch || (() => new Promise(() => {})) } },
    state: { currentPage: 'video', currentVideoQuery: '' },
    _enricher: enricher,
    _videoSearchTicket: 0,
    _vSearchFilter: { results: [], type: 'all', decade: 'all' },
    _lastVideoSearch: null,
    _VICON: { left: '<', right: '>' },
    esc: s => String(s == null ? '' : s),
    console,
    // The leaves. _fillRow is the one that matters: in the app it ends in
    // _bindVideoCards -> _observeCards, so the stub registers the cards on the
    // real enricher exactly as the real path does.
    _fillRow (key, items) {
      filled.push([key, items.length])
      const target = els['video-search-results']
      for (const it of items) {
        const c = card((it.type || 'movie') + ':' + it.id)
        target._cards.push(c)
        enricher.observe(c, (it.type || 'movie') + ':' + it.id, function () {})
      }
    },
    _bindVideoSearchFilters () {},
    _vSearchIntentHtml: () => '',
    _searchIntent: () => null,
    _videoErrorText: m => String(m),
    _vSearchEmptyHtml: q => 'no matches for ' + q,
    _shortQ: q => String(q),
    _simplifyVideoQuery: q => q,
    _retryVideoTitleSearch () {},
    _rememberSearch () {},
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext([
    extractFn(source, '_releaseCardsIn'),
    extractFn(source, '_setVideoSearchHtml'),
    extractFn(source, '_vRailSkeleton'),
    extractFn(source, '_vRowShell'),
    extractFn(source, '_videoDecadeLabel'),
    extractFn(source, '_videoResultDecades'),
    extractFn(source, '_filterVideoResults'),
    extractFn(source, '_vSearchFilterBarHtml'),
    // The per-source honesty helpers the paint now calls. Lifted for real
    // rather than stubbed: a stub here could not see the note being painted.
    extractFn(source, '_vSearchFailedSources'),
    extractFn(source, '_vSearchRetryHtml'),
    extractFn(source, '_vSearchSourceNoteHtml'),
    extractFn(source, '_vSearchOutageHtml'),
    extractFn(source, '_bindVideoSearchRetry'),
    extractFn(source, '_paintVideoSearchResults'),
    extractFn(source, '_runVideoTitleSearch'),
    'const _VSEARCH_TYPE_CHIPS = ' + /var _VSEARCH_TYPE_CHIPS = (\[[\s\S]*?\n\])/.exec(source)[1],
  ].join('\n'), sandbox)

  return { sandbox, enricher, observed, els, filled }
}

function results (n, type) {
  const out = []
  for (let i = 0; i < n; i++) out.push({ type: type || 'movie', id: 1000 + i, title: 'Film ' + i, year: 1990 + (i % 30) })
  return out
}

test('a repaint of the results releases the cards it is throwing away', () => {
  const h = harness(SRC)
  h.sandbox._vSearchFilter = { results: results(12), type: 'all', decade: 'all', query: 'tokyo' }
  h.sandbox._paintVideoSearchResults()
  assert.strictEqual(h.observed.size, 12, 'twelve result cards are in the queue')

  h.sandbox._paintVideoSearchResults()
  assert.strictEqual(h.observed.size, 12,
    'a second paint holds twelve, not twenty-four — the first set was released')
})

test('every chip click through a session holds one set, not one per click', () => {
  const h = harness(SRC)
  h.sandbox._vSearchFilter = { results: results(12), type: 'all', decade: 'all', query: 'tokyo' }
  for (let click = 0; click < 20; click++) h.sandbox._paintVideoSearchResults()
  assert.strictEqual(h.observed.size, 12,
    'twenty repaints of the same result set, twelve cards held')
})

test('a keystroke replacing the results with the Searching skeleton releases them too', () => {
  const h = harness(SRC)
  h.sandbox._vSearchFilter = { results: results(9), type: 'all', decade: 'all', query: 'toky' }
  h.sandbox._paintVideoSearchResults()
  assert.strictEqual(h.observed.size, 9)

  // The next keystroke. The skeleton goes up and the nine cards are gone from
  // the screen — they have to be gone from the queue with them.
  h.sandbox._runVideoTitleSearch('tokyo')
  assert.strictEqual(h.observed.size, 0,
    'the discarded result set left the enrichment queue')
})

test('typing a fourteen-character query holds one result set, not fourteen', () => {
  const h = harness(SRC)
  const query = 'tokyo revengers'
  for (let i = 1; i <= query.length; i++) {
    h.sandbox._runVideoTitleSearch(query.slice(0, i))
    h.sandbox._vSearchFilter.results = results(20)
    h.sandbox._paintVideoSearchResults()
  }
  assert.strictEqual(h.observed.size, 20,
    'one result set held at the end of typing, whatever was typed on the way')
})

test('clearing the box releases everything', () => {
  const h = harness(SRC)
  h.sandbox._vSearchFilter = { results: results(20), type: 'all', decade: 'all', query: 'tokyo' }
  h.sandbox._paintVideoSearchResults()
  assert.strictEqual(h.observed.size, 20)
  h.sandbox._setVideoSearchHtml('')
  assert.strictEqual(h.observed.size, 0, 'an emptied box holds nothing')
})

test('the helper still paints what it was asked to paint', () => {
  const h = harness(SRC)
  const target = h.sandbox._setVideoSearchHtml('<div class="vrow-msg err">could not reach the catalog</div>')
  assert.ok(target, 'it hands back the box so callers can keep working with it')
  assert.match(h.els['video-search-results'].innerHTML, /could not reach the catalog/)
})

test('a missing box is not an error', () => {
  const h = harness(SRC)
  delete h.els['video-search-results']
  assert.strictEqual(h.sandbox._setVideoSearchHtml('anything'), null)
})

test('MUTATION: without the release, every repaint retains another set', () => {
  const broken = SRC.replace(
    "  if (typeof _releaseCardsIn === 'function') _releaseCardsIn(target)\n  target.innerHTML = html\n  return target",
    '  target.innerHTML = html\n  return target')
  assert.notStrictEqual(broken, SRC, 'the mutation applied')
  const h = harness(broken)
  h.sandbox._vSearchFilter = { results: results(12), type: 'all', decade: 'all', query: 'tokyo' }
  for (let click = 0; click < 20; click++) h.sandbox._paintVideoSearchResults()
  assert.strictEqual(h.observed.size, 240,
    'twenty repaints, twenty sets of twelve still held — this is the leak')
})
