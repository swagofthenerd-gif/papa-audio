'use strict'
// Searching the Library for something he does not own must show "no albums
// match" — not the whole library, and not a dead page.
//
// _libEmptyHtml() read `_moodDef`. The only declaration of that name was
// `var _moodDef = …` INSIDE renderLibrary(), i.e. another function's local, so
// the read threw ReferenceError every time the grid had zero results. Two
// symptoms, both seen live:
//   * a no-match query painted the WHOLE unfiltered library (200 cards,
//     "245 albums") with no "no results" message at all;
//   * any later full render died with "This page failed to render", and because
//     state.libSearch survives navigation, every return to Library stayed dead.
// 24 occurrences in one session's log.
//
// Same bug class as _playOnArrival (10d4662): a top-level function reading a
// name that only exists inside another function. The generalised guard for that
// class is test/renderer-cross-function-scope.test.js.
//
// renderer.js is a browser script with no exports, so the real functions are
// lifted and run in a vm whose scope is what the page actually has at that
// moment: renderLibrary's locals do NOT exist.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function lift(name) {
  const start = SRC.indexOf('\nfunction ' + name + '(')
  assert.ok(start > -1, name + ' must still exist as a top-level function in renderer.js')
  const rest = SRC.indexOf('\nfunction ', start + 1)
  const asy = SRC.indexOf('\nasync function ', start + 1)
  const stop = [rest, asy].filter(n => n > -1).sort((a, b) => a - b)[0]
  return SRC.slice(start, stop === undefined ? undefined : stop)
}

const PREAMBLE = `
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])) }
  var _audioFeaturesCache = {}
`

// The page's real scope at the moment the empty state paints: the top-level
// helpers exist, renderLibrary's body has not been entered, so nothing it
// declares locally is in scope.
function build({ state, window }) {
  const ctx = vm.createContext({ state, window, console })
  vm.runInContext(PREAMBLE + lift('_libMoodDef') + lift('_libMoodEmptyHint') + lift('_libEmptyHtml'), ctx)
  return ctx
}

function baseState(over) {
  return Object.assign({
    libMood: null, libSearch: '', library: [],
    musicFolders: ['/mnt/data/MUSIC'], _unavailableRoots: [],
  }, over || {})
}

const TOOLS = require('../src/music-tools.js')

test('a search with zero results renders the empty state instead of throwing', () => {
  // The exact live case: a folder is configured, albums exist, the text search
  // matched nothing, so the grid gets an empty list and one active filter.
  const state = baseState({ libSearch: 'nonexistent band', library: [{ id: 'a' }, { id: 'b' }] })
  const ctx = build({ state, window: { PapaMusicTools: TOOLS } })
  let html
  assert.doesNotThrow(() => { html = vm.runInContext('_libEmptyHtml(1)', ctx) },
    'the empty state must not throw — a throw here kills the whole Library page')
  assert.match(html, /No albums match/, 'and it must say so in words')
  assert.match(html, /lib-empty-reset/, 'with the one action that fits: clear the filters')
})

test('reading renderLibrary\'s local is the bug — the old form still throws', () => {
  // Pins the mechanism so the shared helper cannot be "tidied" back into a
  // renderLibrary-local. This is the byte-for-byte old expression.
  const state = baseState({ libMood: 'calm' })
  const ctx = build({ state, window: { PapaMusicTools: TOOLS } })
  assert.throws(() => vm.runInContext('_moodDef', ctx), /ReferenceError/,
    'renderLibrary\'s local must not be reachable from _libEmptyHtml\'s scope')
})

test('_libEmptyHtml names no identifier that only renderLibrary declares', () => {
  const body = lift('_libEmptyHtml')
  assert.doesNotMatch(body, /(^|[^.\w$])_moodDef\b/,
    '_libEmptyHtml must not reach for _moodDef; use the top-level _libMoodDef()')
})

test('the mood-filtered empty state still gets its own wording', () => {
  const moodMap = {
    moodById: id => (id === 'calm' ? { id: 'calm', name: 'Calm', emoji: '🌙', color: '#456' } : null),
    profile: () => ({ total: 2, analysed: 0 }),
  }
  const state = baseState({ libMood: 'calm', library: [{ id: 'a' }, { id: 'b' }] })
  const ctx = build({ state, window: { PapaMusicTools: TOOLS, PapaMoodMap: moodMap } })
  const html = vm.runInContext('_libEmptyHtml(1)', ctx)
  assert.match(html, /Nothing feels/)
  assert.match(html, /Calm/)
  assert.doesNotMatch(html, /No albums match/, 'the mood view keeps its own wording')
})

test('an empty library with no folder asks for a folder, not for fewer filters', () => {
  const state = baseState({ musicFolders: [] })
  const ctx = build({ state, window: { PapaMusicTools: TOOLS } })
  const html = vm.runInContext('_libEmptyHtml(0)', ctx)
  assert.match(html, /No music folder yet/)
  assert.match(html, /lib-empty-add-folder/)
})

test('renderLibrary still routes an empty grid to _libEmptyHtml', () => {
  // The scope fix is worth nothing if the empty path stops being taken.
  assert.match(SRC, /sortedAlbums\.length \? _libGridInitial\(\) : _libEmptyHtml\(activeFilterCount\)/,
    'the grid must fall back to the empty state when nothing matched')
})

test('renderLibrary and _libEmptyHtml agree on one source for the mood', () => {
  const render = SRC.slice(SRC.indexOf('\nfunction renderLibrary('))
  assert.match(render, /var _moodDef = _libMoodDef\(\)/,
    'renderLibrary must read the shared helper, not re-derive the mood itself')
})
