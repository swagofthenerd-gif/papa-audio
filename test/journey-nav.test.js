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

function fnBody(name) {
  const start = RENDERER.indexOf(`function ${name}(`)
  assert.ok(start > -1, `${name} not found in the renderer`)
  const next = RENDERER.indexOf('\nfunction ', start + 1)
  const nextAsync = RENDERER.indexOf('\nasync function ', start + 1)
  const ends = [next, nextAsync].filter(i => i > -1)
  return RENDERER.slice(start, ends.length ? Math.min(...ends) : RENDERER.length)
}

// ── 1. The video search is a journey, not a mood ────────────────────────────

test('the video search query is the video page navId', () => {
  // state carries the committed query…
  assert.match(RENDERER, /currentVideoQuery: ''/)
  // …_currentNavId serves it for the video page…
  assert.match(fnBody('_currentNavId'),
    /currentPage === 'video'\) return state\.currentVideoQuery \|\| null/)
  // …and navigate() seeds it from a video navId (and clears it elsewhere).
  assert.match(fnBody('navigate'),
    /state\.currentVideoQuery\s*=\s*page === 'video' \? \(navId \|\| ''\) : ''/)
})

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
  const restore = fnBody('_restoreVideoSearch')
  // Replay guards: same query, fresh, has results — else re-run the search.
  assert.match(restore, /c\.filter\.query === query/)
  assert.match(restore, /VSEARCH_CACHE_TTL/)
  assert.match(restore, /_runVideoTitleSearch\(query\)/)
  // The replay invalidates any in-flight fetch before painting.
  assert.match(restore, /_videoSearchTicket\+\+/)
})

test('renderVideo restores a query navId instead of wiping to the catalog', () => {
  const rv = fnBody('renderVideo')
  assert.match(rv, /renderVideo\(navId\)/)
  assert.match(rv, /const restoreQuery = typeof navId === 'string'/)
  assert.match(rv, /preserveSearch: true/)
  assert.match(rv, /_restoreVideoSearch\(restoreQuery\)/)
  // The dispatcher hands the navId through.
  assert.match(fnBody('navigate'), /renderVideo\(navId\)/)
})

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
