'use strict'
// J1 — One navigation truth. The video search becomes a first-class journey
// (query navId + replayable results), every back-like affordance routes
// through the history stack, the stack survives restarts, overlays close on
// navigation, and Continue Watching removes in place.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = path.join(__dirname, '..', 'src')
const RENDERER = fs.readFileSync(path.join(SRC, 'renderer.js'), 'utf8')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

// navigate() refuses page ids outside NAV_PAGES (QA #18); the allow-list is
// declared just above it, so a lift of navigate carries it along.
const NAV_PAGES_AT = RENDERER.indexOf('const NAV_PAGES = new Set([')
const NAV_PAGES_SRC = NAV_PAGES_AT > -1
  ? RENDERER.slice(NAV_PAGES_AT, RENDERER.indexOf('\n])', NAV_PAGES_AT) + 3)
  : ''

function fnBody(name) {
  const start = RENDERER.indexOf(`function ${name}(`)
  assert.ok(start > -1, `${name} not found in the renderer`)
  const next = RENDERER.indexOf('\nfunction ', start + 1)
  const nextAsync = RENDERER.indexOf('\nasync function ', start + 1)
  const ends = [next, nextAsync].filter(i => i > -1)
  const body = RENDERER.slice(start, ends.length ? Math.min(...ends) : RENDERER.length)
  return name === 'navigate' ? NAV_PAGES_SRC + '\n' + body : body
}

// ── 1. The video search is a journey, not a mood ────────────────────────────

// (The three pins that used to sit here — currentVideoQuery on state,
// _currentNavId serving it for the video page, navigate() seeding it — are
// gone: "Back out of a title lands on the search that found it" at the foot of
// this file fails if any of them is broken, and it fails for the right reason.)

test('running a video search registers the query as the navId', () => {
  const run = fnBody('_runVideoTitleSearch')
  assert.match(run, /state\.currentVideoQuery = query/)
  // The typo-tolerance retry follows what actually matched.
  assert.match(fnBody('_retryVideoTitleSearch'), /state\.currentVideoQuery = simplified/)
})

test('a successful video search is cached for replay, by reference', () => {
  assert.match(RENDERER, /var VSEARCH_CACHE_TTL = /)
  assert.match(fnBody('_runVideoTitleSearch'),
    /_lastVideoSearch = \{ filter: _vSearchFilter, timestamp: Date\.now\(\) \}/)
  // The replay guards themselves (same query, fresh enough, has results, else
  // re-run) are driven in "a stale or missing cache makes Back re-run the
  // search" below rather than pinned here. What stays is the one thing that
  // test cannot see: the replay invalidates any in-flight fetch first, so a
  // slow older search cannot overwrite the results it lost the race to.
  assert.match(fnBody('_restoreVideoSearch'), /_videoSearchTicket\+\+/)
})

// (renderVideo's restore branch had five pins here. They are replaced by the
// behavioural tests at the foot of this file, which put a query in the box,
// press Back and look at what is on the page.)

test('_renderVideoTab only wipes the search when it is not restoring one', () => {
  const body = fnBody('_renderVideoTab')
  assert.match(body, /opts && opts\.preserveSearch/)
  // The wipe goes through _setVideoSearchHtml so the discarded result cards
  // leave the enrichment queue with them (test/video-search-card-release).
  assert.match(body, /if \(!preserve\) _setVideoSearchHtml\(''\)/)
  assert.match(body, /if \(!preserve && searchInput && searchInput\.value\)/)
  // And a genuine wipe ends the journey: the query navId is dropped.
  assert.match(body, /state\.currentVideoQuery = ''/)
})

test('clearing the video search box drops the query navId', () => {
  const bind = fnBody('_bindVideoSearch')
  const reset = bind.slice(bind.indexOf('const reset'), bind.indexOf('const run'))
  assert.match(reset, /state\.currentVideoQuery = ''/)
})

// ── 2. Back-like affordances go through history ─────────────────────────────

test('in-page back buttons route through the stack, front page only as fallback', () => {
  const helper = fnBody('_backOr')
  assert.match(helper, /if \(navHistory\.length\) return navigateBack\(\)/)
  assert.match(helper, /navigate\(page, navId \|\| null\)/)
  // The two verified hardcoders now use it.
  assert.match(RENDERER,
    /getElementById\('video-error-back'\)\?\.addEventListener\('click', function \(\) \{ _backOr\('video'\) \}\)/)
  assert.match(RENDERER,
    /getElementById\('vshelf-back'\)\?\.addEventListener\('click', function \(\) \{ _backOr\('video'\) \}\)/)
})

// ── 3. The journey survives restarts ────────────────────────────────────────

test('navigate persists trimmed history and future stacks in the session', () => {
  const nav = fnBody('navigate')
  assert.match(nav, /history: navHistory\.slice\(-NAV_SESSION_CAP\)\.map\(_navEntrySlim\)/)
  assert.match(nav, /future: navFuture\.slice\(-NAV_SESSION_CAP\)\.map\(_navEntrySlim\)/)
  assert.match(RENDERER, /const NAV_SESSION_CAP = 60/)
})

test('boot rebuilds the stacks before the first navigate', () => {
  // The restore call sits in init's cached-library path, ahead of navigate().
  const at = RENDERER.indexOf('_restoreNavStacks(session)')
  const nav = RENDERER.indexOf("navigate(_restorePage", at)
  assert.ok(at > -1 && nav > at, 'stacks restore before the boot navigate')
  // And the persisted scroll seeds the memory the restoreScroll flag reads.
  const between = RENDERER.slice(at, nav)
  assert.match(between, /_scrollMemory\.set\(session\.page/)
})

test('restored entries that fail the needs-a-navId rule are dropped, not forced home', () => {
  const body = fnBody('_restoreNavStacks')
  assert.match(body, /_NEEDS_NAV_ID\.indexOf\(e\.page\) !== -1 && !e\.navId/)
  assert.match(body, /\.filter\(ok\)/)
  assert.ok(!/home/.test(body), 'dropping, never redirecting to home')

  // Behavioral: run the function for real against a fake session.
  const slice = RENDERER.slice(RENDERER.indexOf('const NAV_HISTORY_CAP'),
    RENDERER.indexOf('// ── Overlay dismissal on navigation'))
  const out = vm.runInNewContext(slice + `
    _restoreNavStacks({
      history: [
        { page: 'video', navId: 'tokyo revengers' },
        { page: 'album', navId: null },            // dead: needs an id
        { page: 'home', navId: null },
        { page: '', navId: 'x' },                  // dead: no page
        { page: 'album', navId: 'abc123' },
      ],
      future: [{ page: 'artist', navId: null }, { page: 'library' }],
    })
    ;({ h: navHistory, f: navFuture })
  `)
  // join(): the arrays come from another realm, where deepStrictEqual balks
  // at the foreign Array prototype.
  assert.strictEqual(out.h.map(e => e.page).join(','), 'video,home,album')
  assert.strictEqual(out.f.map(e => e.page).join(','), 'library')
  // Slimmed: nothing but page + navId survives.
  assert.strictEqual(Object.keys(out.h[0]).sort().join(','), 'navId,page')
})

test('a saved current page that needs a navId and has one restores there', () => {
  // The forced-home rule fires only when the id is MISSING.
  assert.match(RENDERER,
    /if \(_NEEDS_NAV_ID\.indexOf\(_restorePage\) !== -1 && !_restoreNavId\) _restorePage = 'home'/)
  // One list, shared by boot, crash-restore and the stack rebuild — the three
  // used to carry private copies that could drift.
  const copies = RENDERER.match(/'album', 'artist', 'search', 'playlist', 'video-detail', 'person', 'shelf'/g) || []
  assert.strictEqual(copies.length, 1, 'exactly one needs-navId list')
})

test('album-id migration rewrites navIds inside the persisted stacks too', () => {
  const at = MAIN.indexOf("ipcMain.handle('library-migrate-album-id'")
  const body = MAIN.slice(at, at + 2400)
  assert.match(body, /session\.history/)
  assert.match(body, /session\.future/)
  assert.match(body, /e\.navId === oldId \? \{ \.\.\.e, navId: newId \}/)
})

// ── 4. Overlays close on navigation — the rule, not five patches ────────────

test('navigate() opens by dismissing registered overlays', () => {
  const nav = fnBody('navigate')
  // At the top: before the scroll save and the history push.
  const dismissAt = nav.indexOf('_runNavDismiss()')
  const scrollAt = nav.indexOf('_scrollMemory')
  assert.ok(dismissAt > -1 && dismissAt < scrollAt, 'dismissal runs first')
  // The registry survives one throwing closer.
  const run = fnBody('_runNavDismiss')
  assert.match(run, /Array\.from\(_navDismiss\)/)
  assert.match(run, /try \{ fn\(\) \} catch/)
})

test('the five verified surviving overlays register dismissers', () => {
  // saved-libraries modal
  assert.match(RENDERER, /_registerNavDismiss\(_closeSaved\)/)
  // anime numbering modal
  const anm = fnBody('_openAnimeNumberingDialog')
  assert.match(anm, /_registerNavDismiss\(close\)/)
  assert.match(anm, /_unregisterNavDismiss\(close\)/)
  // smart-playlist modal
  assert.match(RENDERER, /_registerNavDismiss\(_closeSmartPl\)/)
  // sleep panel + topbar history dropdown (registered once, no-op when shut)
  assert.match(RENDERER,
    /_registerNavDismiss\(function \(\) \{\s*document\.getElementById\('sleep-panel'\)\?\.classList\.remove\('open'\)\s*\}\)/)
  assert.match(RENDERER,
    /_registerNavDismiss\(function \(\) \{ hideDropdown\(\); hideLiveResults\(\) \}\)/)
})

test('persistent-by-design drawers are NOT registered', () => {
  assert.ok(!/_registerNavDismiss\([^)]*queue/i.test(RENDERER), 'queue panel stays')
  assert.ok(!/_registerNavDismiss\([^)]*[Cc]hat/.test(RENDERER), 'chat drawer stays')
})

test('the smart-playlist modal gained Esc and backdrop-click close', () => {
  const dlg = fnBody('showSmartPlaylistDialog')
  assert.match(dlg, /_onSmartPlKey/)
  assert.match(dlg, /e\.key === 'Escape'/)
  // The old wrapper-div bug: the click check compared against a classless
  // wrapper, so the backdrop test could never pass. The overlay itself is in
  // the body now and the check is a plain identity test.
  assert.match(dlg, /firstElementChild/)
  assert.match(dlg, /if \(e\.target === overlay\) _closeSmartPl\(\)/)
  assert.ok(!/e\.target\.className === 'modal-overlay'/.test(dlg))
  // Every exit path shares one closer, so the Esc listener cannot leak.
  assert.match(dlg, /document\.removeEventListener\('keydown', _onSmartPlKey\)/)
})

// ── 5. Continue Watching removes in place ───────────────────────────────────

test('the CW remove hides the card immediately and undo reinstates in place', () => {
  const body = fnBody('_removeFromContinueWatching')
  assert.match(body, /closest\('\[data-rail="continue"\]'\)/)
  assert.match(body, /cardEl\.style\.display = 'none'/)
  assert.match(body, /pushUndo\(/)
  // Undo is a display reset on the same element — no re-render, same slot.
  assert.match(body, /cardEl\.style\.display = ''/)
})

// ── The third catalog surface ───────────────────────────────────────────────
// #vtaste-row ("From your diary") is a SIBLING of #vrows, not a child, so the
// search paths that hid the rows and the hero left it stranded above the
// results. Invisible until the diary has an entry, which is why it survived
// this long — caught in the J1 live verification with one film logged.
test('every catalog-hiding path hides the taste row too', () => {
  // The search itself.
  const run = RENDERER.slice(RENDERER.indexOf('function _runVideoTitleSearch('), RENDERER.indexOf('function _retryVideoTitleSearch('))
  assert.match(run, /const taste = document\.getElementById\('vtaste-row'\)/)
  assert.match(run, /if \(taste\) taste\.style\.display = 'none'/)
  // The tab render, both branches.
  const tab = RENDERER.slice(RENDERER.indexOf('async function _renderVideoTab('), RENDERER.indexOf('async function _renderVideoTab(') + 1800)
  assert.match(tab, /if \(tasteMount\) tasteMount\.style\.display = 'none'/)
  assert.match(tab, /tasteMount\?\.style\.removeProperty\('display'\)/)
  // Clearing the box restores it with the rest of the catalog.
  const reset = RENDERER.slice(RENDERER.indexOf('const reset = function () {'), RENDERER.indexOf('const reset = function () {') + 700)
  assert.match(reset, /getElementById\('vtaste-row'\)\?\.style\.removeProperty\('display'\)/)
})

// ── The journey, driven ──────────────────────────────────────────────────────
// Seventeen of the eighteen tests above are regexes over renderer.js. They see
// that the lines exist; they cannot see whether Back actually brings the search
// back. Changing navigateBack to `navigate(prev.page, null, …)` — Back losing
// the query it was carrying — left all eighteen green.
//
// What follows runs the real stack: navigate, navigateBack, navigateForward,
// _currentNavId, _pushNavHistory, the real renderVideo and the real
// _restoreVideoSearch, against a DOM stub.

function extractFn (name) {
  const start = RENDERER.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found')
  let i = RENDERER.indexOf('(', start)
  let paren = 0
  for (; i < RENDERER.length; i++) {
    if (RENDERER[i] === '(') paren++
    else if (RENDERER[i] === ')') { paren--; if (!paren) { i++; break } }
  }
  let depth = 0
  for (let j = RENDERER.indexOf('{', i); j < RENDERER.length; j++) {
    if (RENDERER[j] === '{') depth++
    else if (RENDERER[j] === '}') {
      depth--
      if (!depth) {
        const body = RENDERER.slice(start, j + 1)
        return (RENDERER.slice(Math.max(0, start - 6), start) === 'async ' ? 'async ' : '') + body
      }
    }
  }
  throw new Error('unbalanced braces in ' + name)
}

function fakeEl (id) {
  return {
    id,
    value: '',
    hidden: false,
    scrollTop: 0,
    _html: '',
    style: { display: '', removeProperty () { this.display = '' } },
    get innerHTML () { return this._html },
    set innerHTML (v) { this._html = v },
    classList: { toggle () {}, remove () {}, add () {} },
    addEventListener () {},
    querySelector: () => null,
    querySelectorAll: () => [],
  }
}

function journey (mutate) {
  const source = mutate ? mutate(RENDERER) : RENDERER
  const lift = name => {
    const src = source
    const start = src.indexOf('function ' + name + '(')
    assert.ok(start > -1, name + ' not found')
    let i = src.indexOf('(', start)
    let paren = 0
    for (; i < src.length; i++) {
      if (src[i] === '(') paren++
      else if (src[i] === ')') { paren--; if (!paren) { i++; break } }
    }
    let depth = 0
    for (let j = src.indexOf('{', i); j < src.length; j++) {
      if (src[j] === '{') depth++
      else if (src[j] === '}') {
        depth--
        if (!depth) {
          const body = src.slice(start, j + 1)
          return (src.slice(Math.max(0, start - 6), start) === 'async ' ? 'async ' : '') + body
        }
      }
    }
    throw new Error('unbalanced braces in ' + name)
  }

  const els = {}
  for (const id of ['content', 'video-search-input', 'video-search-clear', 'vrows',
    'vhero-mount', 'vtaste-row', 'video-search-results']) els[id] = fakeEl(id)
  const painted = []
  const fetched = []
  const tabs = []
  const detailsRendered = []
  const sandbox = {
    document: {
      getElementById: id => els[id] || null,
      querySelectorAll: () => [],
      body: { classList: { toggle () {} } },
    },
    window: { api: { saveSessionState () {} }, PapaJourney: null },
    state: { currentPage: '', currentVideoQuery: '', library: [], playlists: [], smartPlaylists: [] },
    // navigate() consults the page allow-list (QA #18); evaluate the real one
    // from the (possibly mutated) source so the sandbox agrees with the code.
    NAV_PAGES: (() => {
      const at = source.indexOf('const NAV_PAGES = new Set([')
      assert.ok(at > -1, 'NAV_PAGES must be declared beside navigate')
      return vm.runInNewContext(source.slice(at, source.indexOf('\n])', at) + 3) + '\nNAV_PAGES')
    })(),
    _scrollMemory: new Map(),
    SCROLL_MEMORY_CAP: 50,
    VIDEO_PAGES: new Set(['video', 'browse', 'video-detail', 'person', 'shelf', 'diary', 'calendar']),
    requestAnimationFrame: fn => fn(),
    Date, Set, Map, Array, Object, JSON, console,
    // Everything that is not the navigation itself.
    _initVideoUI () {},
    _videoTab: 'all',
    setContent () {},
    _vHeadHtml: () => '',
    _bindVideoHead () {},
    _renderVideoTab: (ticket, opts) => { tabs.push(opts || null) },
    _videoCatalogTicket: 0,
    _videoSearchTicket: 0,
    _paintVideoSearchResults: () => { painted.push(sandbox._vSearchFilter.query) },
    _runVideoTitleSearch: q => { fetched.push(q) },
    _vSearchFilter: { query: null, results: [] },
    _lastVideoSearch: null,
    VSEARCH_CACHE_TTL: 1000 * 60 * 10,
    renderVideoDetail: id => { detailsRendered.push(id) },
    _stopInlineTrailer () {},
    retuneDownloadsPolling () {},
    hideContextMenu () {},
    _renderFailure: (page, err) => { throw err },
    _dlLastSig: '',
    slsk: { lastQuery: '' },
    _videoDetail: null,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext([
    source.slice(source.indexOf('const NAV_HISTORY_CAP'),
                 source.indexOf('// ── Overlay dismissal on navigation')),
    'const _navDismiss = new Set()',
    'function _registerNavDismiss(fn) { _navDismiss.add(fn); return fn }',
    'function _runNavDismiss() { Array.from(_navDismiss).forEach(function (fn) { try { fn() } catch (_) {} }) }',
    lift('_currentNavId'),
    lift('navigate'),
    // Back's scroll restore retries while the page is still too short to hold
    // the position; the real one runs here rather than a stub of it.
    lift('_restoreScrollTop'),
    lift('navigateBack'),
    lift('navigateForward'),
    lift('_backOr'),
    lift('updateNavBtns'),
    lift('renderVideo'),
    lift('_restoreVideoSearch'),
    'globalThis.__api = { navigate, navigateBack, navigateForward, _backOr, _currentNavId,' +
      ' history: navHistory, future: navFuture }',
  ].join('\n'), sandbox)

  const api = sandbox.__api
  return {
    sandbox, api, els, painted, fetched, tabs, detailsRendered,
    // What running a search does to the page state, without the search code:
    // the query becomes the video page's id in place, no navigation.
    searchFor (q, results) {
      sandbox.state.currentVideoQuery = q
      sandbox._vSearchFilter = { query: q, results: results || [{ id: 1 }, { id: 2 }] }
      sandbox._lastVideoSearch = { filter: sandbox._vSearchFilter, timestamp: Date.now() }
    },
  }
}

test('Back out of a title lands on the search that found it, query and results', async () => {
  const j = journey()
  j.api.navigate('video', null)
  j.searchFor('tokyo revengers')
  j.api.navigate('video-detail', 'anime:21')
  assert.deepStrictEqual(j.detailsRendered, ['anime:21'], 'the title page opened')

  j.api.navigateBack()
  await new Promise(r => setImmediate(r))
  assert.strictEqual(j.sandbox.state.currentPage, 'video')
  assert.strictEqual(j.sandbox.state.currentVideoQuery, 'tokyo revengers',
    'the page he came back to is the search, not the clean catalogue')
  assert.strictEqual(j.els['video-search-input'].value, 'tokyo revengers',
    'and the box he typed it into still holds it')
  assert.strictEqual(j.els['video-search-clear'].hidden, false, 'with its clear button showing')
  assert.deepStrictEqual(j.painted, ['tokyo revengers'],
    'the cached results are replayed rather than re-fetched')
  assert.deepStrictEqual(j.fetched, [], 'nothing was asked for again')
  assert.strictEqual(JSON.stringify(j.tabs), JSON.stringify([null, { preserveSearch: true }]),
    'and the catalogue underneath is painted without wiping the results')
})

test('a stale or missing cache makes Back re-run the search rather than show nothing', async () => {
  const j = journey()
  j.api.navigate('video', null)
  j.searchFor('perfect blue')
  j.sandbox._lastVideoSearch.timestamp = Date.now() - (1000 * 60 * 60)
  j.api.navigate('video-detail', 'movie:1')
  j.api.navigateBack()
  await new Promise(r => setImmediate(r))
  assert.deepStrictEqual(j.fetched, ['perfect blue'], 'it goes and gets them again')
  assert.deepStrictEqual(j.painted, [])
  assert.strictEqual(j.els['video-search-input'].value, 'perfect blue')
})

test('Back to a catalogue with no search open leaves the box empty', async () => {
  const j = journey()
  j.api.navigate('video', null)
  j.api.navigate('video-detail', 'anime:21')
  j.api.navigateBack()
  await new Promise(r => setImmediate(r))
  assert.strictEqual(j.sandbox.state.currentVideoQuery, '')
  assert.strictEqual(j.els['video-search-input'].value, '')
  assert.deepStrictEqual(j.fetched, [])
  assert.strictEqual(JSON.stringify(j.tabs), JSON.stringify([null, null]), 'the clean catalogue, as before')
})

test('Forward returns to the title, and Back again to the search', async () => {
  const j = journey()
  j.api.navigate('video', null)
  j.searchFor('tokyo revengers')
  j.api.navigate('video-detail', 'anime:21')
  j.api.navigateBack()
  await new Promise(r => setImmediate(r))
  j.api.navigateForward()
  assert.strictEqual(j.sandbox.state.currentPage, 'video-detail')
  assert.deepStrictEqual(j.detailsRendered, ['anime:21', 'anime:21'])
  j.api.navigateBack()
  await new Promise(r => setImmediate(r))
  assert.strictEqual(j.sandbox.state.currentVideoQuery, 'tokyo revengers',
    'the query survives a round trip, not just the first Back')
})

test("an in-page back button goes back to the search, not to the tab's front page", async () => {
  const j = journey()
  j.api.navigate('video', null)
  j.searchFor('paprika')
  j.api.navigate('video-detail', 'movie:9')
  j.api._backOr('video')
  await new Promise(r => setImmediate(r))
  assert.strictEqual(j.sandbox.state.currentVideoQuery, 'paprika')

  // With nowhere to return to, the stated fallback applies and is clean.
  const fresh = journey()
  fresh.api._backOr('video')
  await new Promise(r => setImmediate(r))
  assert.strictEqual(fresh.sandbox.state.currentPage, 'video')
  assert.strictEqual(fresh.sandbox.state.currentVideoQuery, '')
})

test('MUTATION: Back dropping the navId loses the search silently', async () => {
  const j = journey(src => {
    const out = src.replace('  navigate(prev.page, prev.navId, { skipHistory: true, restoreScroll: true })',
      '  navigate(prev.page, null, { skipHistory: true, restoreScroll: true })')
    assert.notStrictEqual(out, src, 'the mutation applied')
    return out
  })
  j.api.navigate('video', null)
  j.searchFor('tokyo revengers')
  j.api.navigate('video-detail', 'anime:21')
  j.api.navigateBack()
  await new Promise(r => setImmediate(r))
  assert.strictEqual(j.sandbox.state.currentVideoQuery, '',
    'this is the bug: Back to a blank catalogue, the search gone')
  assert.strictEqual(j.els['video-search-input'].value, '')
})

test('MUTATION: the video page forgetting its query id has the same effect', async () => {
  const j = journey(src => {
    const out = src.replace("  if (state.currentPage === 'video') return state.currentVideoQuery || null",
      "  if (state.currentPage === 'video') return null")
    assert.notStrictEqual(out, src, 'the mutation applied')
    return out
  })
  j.api.navigate('video', null)
  j.searchFor('tokyo revengers')
  j.api.navigate('video-detail', 'anime:21')
  j.api.navigateBack()
  await new Promise(r => setImmediate(r))
  assert.strictEqual(j.sandbox.state.currentVideoQuery, '',
    'nothing recorded the query when the page was left')
})

test('MUTATION: not replaying the results leaves the box full and the page empty', async () => {
  const j = journey(src => {
    const out = src.replace('    _restoreVideoSearch(restoreQuery)\n', '')
    assert.notStrictEqual(out, src, 'the mutation applied')
    return out
  })
  j.api.navigate('video', null)
  j.searchFor('tokyo revengers')
  j.api.navigate('video-detail', 'anime:21')
  j.api.navigateBack()
  await new Promise(r => setImmediate(r))
  assert.deepStrictEqual(j.painted, [])
  assert.deepStrictEqual(j.fetched, [], 'nothing replayed and nothing re-fetched')
})
