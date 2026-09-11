'use strict'
// J5 wiring: Ctrl+K opens the Omnibox, the box is painted from the model,
// every row kind is performed, and searches/opens land in the shared memory.
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
  const next = CODE.indexOf('\nfunction ', at + 1)
  return CODE.slice(at, next === -1 ? undefined : next)
}

test('the model loads after the brain and before the renderer; the palette markup is the Omnibox', () => {
  const order = [...HTML.matchAll(/<script src="([^"]+)"/g)].map(m => m[1])
  assert.ok(order.indexOf('omnibox-model.js') > order.indexOf('library-index.js') && order.indexOf('omnibox-model.js') < order.indexOf('renderer.js'))
  assert.match(HTML, /id="cmd-palette-input" placeholder="Search everything/)
  assert.match(HTML, /id="cmd-palette-results" role="listbox"/)
  assert.match(CSS, /\.cmd-group\s*\{/)
  assert.match(CSS, /\.cmd-item-sub\s*\{/)
})

test('Ctrl+K opens the Omnibox; Ctrl+Shift+P opens it in command mode', () => {
  assert.match(CODE, /matchesShortcut\('focusSearch', e\)\) \{\s*e\.preventDefault\(\); toggleCommandPalette\(\); return/)
  assert.match(CODE, /matchesShortcut\('commandPalette', e\)\) \{\s*e\.preventDefault\(\); toggleCommandPalette\('commands'\); return/)
  assert.doesNotMatch(CODE, /getElementById\('tb-search'\)\?\.focus\(\)\s*return\s*\}\s*if \(matchesShortcut\('commandPalette'/, 'Ctrl+K no longer merely focuses the music bar')
  assert.match(fn('toggleCommandPalette'), /mode === 'commands' \? '> ' : ''/)
  assert.match(CODE, /focusSearch: 'Search everything \(Omnibox\)'/)
})

test('the box is painted from the model with every source the app has', () => {
  const srcs = fn('_omniSources')
  assert.match(srcs, /mem\.recent\('music', \{ filter: q, limit: 8, elsewhereLimit: 3 \}\)/)
  assert.match(srcs, /state\.smartPlaylists/)
  assert.match(srcs, /index: _searchIndex, commands: _commands/)
  const render = fn('_omniRender')
  assert.match(render, /window\.PapaOmnibox\.buildSections\(q, _omniSources\(q\)\)/)
  assert.match(render, /_omniFetchVideo\(q\)/)
  assert.match(fn('_omniFetchVideo'), /window\.api\.videoSearch\(\{ query: q, type: 'all' \}\)/)
  assert.match(fn('_omniFetchVideo'), /if \(_omniVideo\.ticket !== ticket\) return/, 'a stale answer never repaints')
})

test('every row kind is performed, and searches and opens land in the shared memory', () => {
  const ex = fn('_omniExec')
  for (const k of ['recent', 'artist', 'album', 'track', 'playlist', 'video', 'page', 'tab', 'command', 'search-music', 'search-video', 'search-slsk']) {
    assert.match(ex, new RegExp("case '" + k + "'"), k + ' is handled')
  }
  assert.match(ex, /_rememberOpen\(typed, 'music', \{ kind: 'album', id: row\.id, label: row\.label \}\)/)
  assert.match(ex, /_rememberSearch\(typed, 'video'\); _rememberOpen\(typed, 'video'/)
  assert.match(ex, /case 'search-slsk': _rememberSearch\(row\.q, 'soulseek'\); navigate\('soulseek'\)/)
  assert.match(ex, /case 'tab': _mgState\.tab = row\.tab; navigate\('manage'\)/)
})

test('keyboard: arrows move over the flattened rows, Enter performs, a bare Enter searches', () => {
  const setup = fn('_setupCP')
  assert.match(setup, /e\.key === 'ArrowDown'[\s\S]{0,120}_omniRows\(\)\.length - 1/)
  assert.match(setup, /if \(!row && inp\.value\.trim\(\)\) \{ toggleCommandPalette\(\); commitSearchQuery\(inp\.value\.trim\(\)\); return \}/)
  assert.match(setup, /_omniExec\(_omniRows\(\)\[parseInt\(item\.dataset\.idx, 10\)\]\)/)
  assert.doesNotMatch(CODE, /function _filterCP\(/, 'the old label-substring palette is gone')
})
