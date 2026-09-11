'use strict'
// J2 + J3 wiring: one search memory and one brain behind every box. These
// pin the seams in renderer.js / index.html / styles.css so a later edit
// cannot quietly give one surface its own history or its own matcher again.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const SRC = path.join(__dirname, '..', 'src')
const RENDERER = fs.readFileSync(path.join(SRC, 'renderer.js'), 'utf8')
const HTML = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8')
const CSS = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8')
const CODE = RENDERER.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')

function fn(name) {
  const at = CODE.indexOf('function ' + name + '(')
  assert.ok(at !== -1, name + ' must exist')
  // Up to the next top-level function: good enough for these seams.
  const next = CODE.indexOf('\nfunction ', at + 1)
  return CODE.slice(at, next === -1 ? undefined : next)
}

test('the shared memory and dropdown load after the storage reader and before the renderer', () => {
  const order = [...HTML.matchAll(/<script src="([^"]+)"/g)].map(m => m[1])
  const reader = order.indexOf('local-store.js')
  const mem = order.indexOf('search-memory.js')
  const ui = order.indexOf('search-recents-ui.js')
  const renderer = order.indexOf('renderer.js')
  assert.ok(reader !== -1 && mem > reader && ui > mem && renderer > ui, order.join(' > '))
})

test('no surface owns a private recent-search list any more', () => {
  for (const key of ['pa_search_history', 'papa-lib-recent-searches', 'papaVideoRecentSearches']) {
    assert.ok(!CODE.includes("'" + key + "'"), key + ' must only be known to the migration in search-memory.js')
  }
  assert.ok(!/function _fuzzyFind|function _levenshtein|fuzzyFilter\(/.test(CODE), 'the private matchers are gone')
})

test('every surface commits to the one memory, on an act, with its own surface tag', () => {
  // Music bar: Enter / a picked row → addToHistory → the shared commit.
  assert.match(fn('initSearchHistory'), /function addToHistory\(query\) \{ _rememberSearch\(query, 'music'\) \}/)
  // Library: Enter commits; typing (the debounced input handler) does not.
  const lib = fn('renderLibrary')
  assert.match(lib, /e\.key === 'Enter'[\s\S]{0,120}_rememberSearch\(q, 'library'\)/)
  const libInput = lib.slice(lib.indexOf("libSearch.addEventListener('input'"), lib.indexOf("libSearch.addEventListener('keydown'"))
  assert.doesNotMatch(libInput, /_rememberSearch/)
  // Movies & TV: the named seam delegates to the shared commit.
  assert.match(fn('_vSearchRemember'), /_rememberSearch\(q, 'video'\)/)
  // Soulseek hub: the search button / Enter commit before searching.
  assert.match(fn('renderSoulseekHub'), /_rememberSearch\(q, 'soulseek'\)[\s\S]{0,80}runSlskSearch\(q\)/)
})

test('every surface attaches the shared dropdown to its own container', () => {
  const attaches = [...CODE.matchAll(/_attachRecents\(([^,]+), ([^,]+), '(\w+)'/g)].map(m => m[3])
  assert.deepEqual(attaches.sort(), ['library', 'music', 'soulseek', 'video'])
  assert.match(HTML, /<div class="recents-dd" id="search-history-dropdown" hidden><\/div>/)
  assert.match(CODE, /id="lib-recent-searches" class="recents-dd" hidden/)
  assert.match(CODE, /id="video-recents" class="recents-dd" hidden/)
  assert.match(CODE, /id="slsk-hub-recents" class="recents-dd" hidden/)
  assert.match(CSS, /\.recents-dd\s*\{/)
  assert.match(CSS, /\.recents-row\.active/)
  assert.match(CSS, /\.slsk-hub-searchbar\s*\{\s*position:relative/)
  // Every dropdown closes on navigation, registered once at setup.
  assert.match(fn('setupListeners'), /_registerNavDismiss\(function \(\) \{ if \(window\.PapaSearchRecentsUI\) window\.PapaSearchRecentsUI\.hideAll\(\) \}\)/)
})

test('what was opened from a search is recorded, in capture, before the page navigates', () => {
  const setup = fn('setupListeners')
  const at = setup.indexOf('_openedItemOf(e.target)')
  assert.ok(at !== -1)
  const block = setup.slice(setup.lastIndexOf("addEventListener('click'", at), setup.indexOf('}, true)', at) + 8)
  assert.match(block, /state\.currentPage === 'search' && state\.currentSearchQuery/)
  assert.match(block, /state\.currentPage === 'library' && state\.libSearch/)
  assert.match(block, /\}, true\)$/, 'capture phase')
  // Movies & TV: the existing result-click commit now also records the title.
  assert.match(fn('_bindVideoSearch'), /_rememberOpen\(_vSearchFilter\.query, 'video'/)
})

test('the committed search page and the library grid rank with the shared index, not substrings', () => {
  const search = fn('renderSearch')
  assert.match(search, /window\.PapaLibraryIndex\.query\(_searchIndex, searchText/)
  assert.doesNotMatch(search, /toLowerCase\(\)\.includes\(q\)/, 'the OR-of-substrings scan is gone')
  assert.match(search, /window\.PapaLibraryIndex\.suggest\(_searchIndex, searchText, 3\)/)
  assert.match(search, /commitSearchQuery\(didYouMean\[idx\]\.query\)/, 'a suggestion runs as a real query')
  assert.match(search, /_correctionChipHtml\(correction\.to, correction\.from, 'search-page-undo'\)/)
  assert.match(search, /state\._searchNoCorrect = query/, 'undo pins the verbatim query')
  assert.match(search, /correct: state\._searchNoCorrect !== query/)
  const lib = fn('renderLibrary')
  assert.match(lib, /window\.PapaLibraryIndex\.filterAlbums\(_searchIndex, searchQ, \{ correct: state\._libNoCorrect !== searchQ \}\)/)
  assert.match(lib, /\.lib-correction-undo/)
})

test('the Soulseek undo pins the verbatim query so a re-render cannot re-correct it', () => {
  assert.match(fn('runSlskSearch'), /slsk\.noCorrectFor !== query/)
  assert.match(fn('bindSlskSearchEvents'), /slsk\.noCorrectFor = verbatim/)
  assert.match(fn('_slskCorrectionChip'), /_correctionChipHtml\(slsk\.correction\.to, slsk\.correction\.from, 'slsk-correction-undo'\)/)
})

test('debounce and keys are the shared rule: local grid 150-class, remote 300-class, Escape clears', () => {
  assert.match(fn('renderLibrary'), /window\.PapaSearchMemory\.DEBOUNCE\.local/)
  assert.match(fn('_bindVideoSearch'), /window\.PapaSearchMemory\.DEBOUNCE\.remote/)
  assert.match(fn('renderLibrary'), /e\.key === 'Escape'[\s\S]{0,160}state\.libSearch = ''/)
  assert.match(fn('renderSoulseekHub'), /e\.key === 'Escape'/)
  assert.match(fn('initSearchHistory'), /e\.key === 'Escape'[\s\S]{0,80}input\.value = ''/)
  // The music bar's live results are arrow-key navigable now.
  assert.match(fn('initSearchHistory'), /_setLiveActive\(_liveActive \+ \(e\.key === 'ArrowDown' \? 1 : -1\)\)/)
})

test('the bar\'s click-outside rule reads the event path, so a ✕ that re-paints the list cannot close it', () => {
  assert.match(fn('initSearchHistory'), /e\.composedPath\(\)\.some\(function \(el\) \{ return el && el\.id === 'tb-search-wrap' \}\)/)
})

test('the search landing "Recently searched" row reads the shared memory', () => {
  assert.match(fn('renderSearch'), /_mem\.recent\('music', \{ limit: 6, elsewhereLimit: 0 \}\)\.own/)
})
