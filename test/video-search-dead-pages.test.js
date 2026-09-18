'use strict'
// The Movies & TV search box was dead on three of the four pages that show it.
//
// _vHeadHtml — the tab strip plus the search field — is rendered by four
// pages: the catalogue (renderVideo), Browse, the Diary and the Calendar. Only
// the catalogue has a #video-search-results container. _runVideoTitleSearch
// opens with
//
//     const box = document.getElementById('video-search-results')
//     if (!box) return
//
// so on Browse, the Diary and the Calendar you could click into the box, type
// a film's name, press Enter — and nothing happened at all. No results, no
// message, no navigation.
//
// Worse than uniformly dead: a query that parses as a KIND of film ("korean
// thrillers") leaves through _actOnParsedQuery BEFORE reaching this function,
// so it worked. The same box answered one sort of query and silently ignored
// another.
//
// A committed search now goes to the page that can answer it, by the same
// query-as-navId route Back-into-a-search already uses. A debounced keystroke
// does not — navigating away mid-word would take the page out from under
// someone still typing.
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

function el (id) {
  return {
    id,
    dataset: {},
    value: '',
    hidden: false,
    _html: '',
    style: { display: '', removeProperty () { this.display = '' } },
    _listeners: {},
    get innerHTML () { return this._html },
    set innerHTML (v) { this._html = v },
    addEventListener (type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn) },
    fire (type, ev) { for (const fn of this._listeners[type] || []) fn(ev || {}) },
    querySelector: () => null,
    querySelectorAll: () => [],
    focus () {}, blur () {},
  }
}

// `page` decides which elements exist, exactly as the four page shells do.
function harness (source, page) {
  const els = { 'video-search-input': el('video-search-input'), 'video-search-clear': el('video-search-clear'), 'video-recents': el('video-recents') }
  if (page === 'video') {
    els['video-search-results'] = el('video-search-results')
    els.vrows = el('vrows')
    els['vhero-mount'] = el('vhero-mount')
    els['vtaste-row'] = el('vtaste-row')
  }
  const sandbox = {
    // querySelectorAll answers the tab strip's lookup: _bindVideoHead walks
    // `.vtab` before it binds the search box, and an empty strip is a real
    // state (the Diary and Calendar shells render the head with no tabs
    // painted yet).
    // querySelector answers the tab strip's own lookup: the head binds the
    // strip's arrow keys (audit N13) before it binds the search box, and a
    // page with no strip painted yet is a real state.
    document: { getElementById: id => els[id] || null, querySelectorAll: () => [], querySelector: () => null },
    window: { api: { videoSearch: () => new Promise(() => {}) }, PapaSearchMemory: { DEBOUNCE: { remote: 0 } } },
    state: { currentPage: page, currentVideoQuery: '' },
    navigated: [],
    searched: [],
    _videoSearchTicket: 0,
    _videoSearchPending: null,
    _vSearchFilter: { results: [], type: 'all', decade: 'all' },
    _lastVideoSearch: null,
    navigate (p, id) { sandbox.navigated.push([p, id]) },
    esc: s => String(s == null ? '' : s),
    console,
    setTimeout, clearTimeout,
    _searchIntent: () => null,
    _vRowShell: () => '<section></section>',
    _setVideoSearchHtml (html) {
      const t = els['video-search-results']
      if (!t) return null
      t.innerHTML = html
      return t
    },
    _videoErrorText: m => String(m),
    _vSearchEmptyHtml: q => 'nothing for ' + q,
    _simplifyVideoQuery: q => q,
    _retryVideoTitleSearch () {},
    _paintVideoSearchResults () {},
    // Nothing in this file parses a query as a KIND of film, so the Browse
    // route is always declined and every query is a title — which is the case
    // that was broken.
    _actOnParsedQuery: () => false,
    _parseVideoQuery: () => null,
    _vSearchRemember (q) { sandbox.searched.push(q) },
    _attachRecents (input, dd, kind, onPick) { sandbox._recentsPick = onPick },
    _rememberOpen () {},
  }
  sandbox.window.api.videoSearch = function (req) {
    sandbox.searched.push('FETCH:' + req.query)
    return new Promise(() => {})
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext([
    extractFn(source, '_runVideoTitleSearch'),
    extractFn(source, '_bindVideoSearch'),
    // The binder's caller, lifted too. Every other test here calls
    // _bindVideoSearch by hand, which proves the box works but not that
    // anything in the app ever binds it.
    extractFn(source, '_bindVideoHead'),
    // The head also binds the tab strip's arrow keys now (audit N13); it is a
    // real function, not a stub, so a break in it shows up here too.
    extractFn(source, '_tablistNextIndex'),
    extractFn(source, '_bindTablist'),
  ].join('\n'), sandbox)
  return { sandbox, els }
}

test('Enter on the Browse page takes the title search to the page that can answer it', () => {
  const h = harness(SRC, 'browse')
  h.sandbox._bindVideoSearch()
  h.els['video-search-input'].value = 'Tokyo Revengers'
  h.els['video-search-input'].fire('keydown', { key: 'Enter' })
  assert.deepStrictEqual(h.sandbox.navigated, [['video', 'Tokyo Revengers']],
    'the query travels as the page id, so Back comes back to these results')
})

test('and on the Diary and the Calendar, which have the same dead box', () => {
  for (const page of ['diary', 'calendar']) {
    const h = harness(SRC, page)
    h.sandbox._bindVideoSearch()
    h.els['video-search-input'].value = 'Perfect Blue'
    h.els['video-search-input'].fire('keydown', { key: 'Enter' })
    assert.strictEqual(h.sandbox.navigated.length, 1, page + ' still did nothing')
    assert.strictEqual(h.sandbox.navigated[0][1], 'Perfect Blue')
  }
})

test('a debounced keystroke does not yank the page away mid-word', () => {
  const h = harness(SRC, 'browse')
  // What the input listener's timer ends up calling: a search that was not
  // committed. Someone typing "Tok" has not asked to leave Browse.
  h.sandbox._runVideoTitleSearch('Tok')
  h.sandbox._runVideoTitleSearch('Toky', {})
  h.sandbox._runVideoTitleSearch('Tokyo', { commit: false })
  assert.strictEqual(h.sandbox.navigated.length, 0)
})

test('picking a remembered search from the dropdown commits too', () => {
  const h = harness(SRC, 'browse')
  h.sandbox._bindVideoSearch()
  assert.ok(h.sandbox._recentsPick, 'the recents dropdown was attached')
  h.sandbox._recentsPick('Paprika')
  assert.deepStrictEqual(h.sandbox.navigated, [['video', 'Paprika']])
})

test('a query handed over from universal search is not swallowed', () => {
  // requestVideoSearch parks a query; _bindVideoSearch consumes it once and
  // clears it first. Landing on a page with no results box meant the query was
  // consumed and then dropped on the floor.
  const h = harness(SRC, 'browse')
  h.sandbox._videoSearchPending = 'Ghost in the Shell'
  h.sandbox._bindVideoSearch()
  assert.strictEqual(h.sandbox._videoSearchPending, null, 'consumed, as before')
  assert.deepStrictEqual(h.sandbox.navigated, [['video', 'Ghost in the Shell']],
    'and acted on rather than lost')
})

test('on the catalogue page the search still runs in place and never navigates', () => {
  const h = harness(SRC, 'video')
  h.sandbox._bindVideoSearch()
  h.els['video-search-input'].value = 'Tokyo Revengers'
  h.els['video-search-input'].fire('keydown', { key: 'Enter' })
  assert.strictEqual(h.sandbox.navigated.length, 0, 'it is already the right page')
  assert.ok(h.sandbox.searched.includes('FETCH:Tokyo Revengers'), 'and it actually searched')
  assert.strictEqual(h.sandbox.state.currentVideoQuery, 'Tokyo Revengers')
})

test('an empty box does not navigate anywhere', () => {
  const h = harness(SRC, 'browse')
  h.sandbox._bindVideoSearch()
  h.els['video-search-input'].value = '   '
  h.els['video-search-input'].fire('keydown', { key: 'Enter' })
  assert.strictEqual(h.sandbox.navigated.length, 0)
})

test('MUTATION: the old bail leaves the box dead on all three pages', () => {
  const broken = SRC.replace(
    "      if (opts && opts.commit && query) navigate('video', query)\n      return",
    '      return')
  assert.notStrictEqual(broken, SRC, 'the mutation applied')
  for (const page of ['browse', 'diary', 'calendar']) {
    const h = harness(broken, page)
    h.sandbox._bindVideoSearch()
    h.els['video-search-input'].value = 'Tokyo Revengers'
    h.els['video-search-input'].fire('keydown', { key: 'Enter' })
    assert.strictEqual(h.sandbox.navigated.length, 0, page + ': this is the bug')
    assert.strictEqual(h.sandbox.searched.filter(s => s.startsWith('FETCH:')).length, 0,
      page + ': nothing was searched either')
  }
})

// ── The wiring, not just the logic ───────────────────────────────────────────
// Nine test files drive this search box and all of them bind it themselves.
// Delete the `_bindVideoSearch()` call from _bindVideoHead — the one line in
// the app that ever binds it — and all nine stay green while the box on every
// page is inert. These two run the real head binder instead.

test('the page head binder is what binds the search box', () => {
  const h = harness(SRC, 'browse')
  h.sandbox._bindVideoHead()
  h.els['video-search-input'].value = 'Tokyo Revengers'
  h.els['video-search-input'].fire('keydown', { key: 'Enter' })
  assert.deepStrictEqual(h.sandbox.navigated, [['video', 'Tokyo Revengers']],
    'binding the head must leave the box live — nothing else in the app binds it')
})

test('and on the catalogue page the head binder leaves a box that searches', () => {
  const h = harness(SRC, 'video')
  h.sandbox._bindVideoHead()
  h.els['video-search-input'].value = 'Perfect Blue'
  h.els['video-search-input'].fire('keydown', { key: 'Enter' })
  assert.ok(h.sandbox.searched.includes('FETCH:Perfect Blue'),
    'the search box the head painted actually runs a search')
})

test('MUTATION: unbinding the search box from the head kills it everywhere', () => {
  // The exact edit: remove the _bindVideoSearch() call at the end of
  // _bindVideoHead. Every keystroke test above still passes, because they bind
  // by hand; these do not.
  const broken = SRC.replace(/\n  _bindVideoSearch\(\)\n\}/, '\n}')
  assert.notStrictEqual(broken, SRC, 'the mutation applied')
  for (const page of ['browse', 'video']) {
    const h = harness(broken, page)
    h.sandbox._bindVideoHead()
    h.els['video-search-input'].value = 'Tokyo Revengers'
    h.els['video-search-input'].fire('keydown', { key: 'Enter' })
    assert.strictEqual(h.sandbox.navigated.length, 0, page + ': nothing is bound')
    assert.strictEqual(h.sandbox.searched.filter(s => s.startsWith('FETCH:')).length, 0,
      page + ': and nothing searched')
  }
})
