'use strict'
// Roadmap S3: "Show N more" appends the next page of Soulseek cards instead
// of rebuilding the whole section (112 → 249 ms and growing per click).
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
function fn(name) {
  const at = RENDERER.indexOf('function ' + name + '(')
  assert.ok(at !== -1, name + ' must exist')
  const next = RENDERER.indexOf('\nfunction ', at + 1)
  return RENDERER.slice(at, next === -1 ? undefined : next)
}

test('the card bindings are one function used for the whole section and for appended cards', () => {
  assert.match(fn('bindSlskSearchEvents'), /_bindSlskCards\(section, query, _slskRendered\)/)
  const cards = fn('_bindSlskCards')
  assert.match(cards, /section\.querySelectorAll\('\.slsk-dl-all-btn'\)/)
  assert.match(cards, /section\.querySelectorAll\('\.slsk-expand-btn'\)/)
  assert.doesNotMatch(cards, /section\.querySelector\(/, 'a fragment of cards has no section-level elements to find')
  assert.doesNotMatch(cards, /_slskRendered/, 'the cards index the array they were rendered from, passed in')
})

test('Show more appends the new cards, binds only them, refreshes the summary and the button, and falls back to a full render', () => {
  assert.match(fn('bindSlskSearchEvents'), /#slsk-show-more'\)\?\.addEventListener\('click', \(\) => _slskShowMore\(query\)\)/)
  const more = fn('_slskShowMore')
  assert.match(more, /_slskShowLimit \+= SLSK_SHOW_STEP/)
  assert.match(more, /if \(!_appendSlskUnits\(query\)\) _rerenderSlskSection\(query\)/)
  const app = fn('_appendSlskUnits')
  // The list the last render computed is reused; only the new cards render.
  assert.match(fn('renderSoulseekRow'), /_slskPipeline = \{\n\s+query, unitList, merged: _slskMergedMode, unitWord, updateNote,/)
  assert.match(app, /if \(P\.query !== query \|\| P\.resultsN !== slsk\.results\.length \|\| P\.filter !== slsk\.filter \|\| P\.sort !== slsk\.sort \|\| P\.groupBy !== slsk\.groupByUploader\) return false/)
  assert.match(app, /const add = displayList\.slice\(before\)/)
  assert.match(app, /P\.merged \? _slskMergedCardHtml\(g, before \+ i, query\) : _slskCardHtml\(g, before \+ i, query\)/)
  assert.match(app, /_slskRendered = displayList/)
  assert.match(app, /_bindSlskCards\(frag, query, _slskRendered\)/)
  assert.match(app, /grid\.appendChild\(frag\)/)
  assert.match(app, /SF\.summaryLine\(Object\.assign\(\{\}, P\.summaryArgs, \{ shown: displayList\.length \}\)\)/)
  assert.match(app, /btn\.textContent = `Show \$\{Math\.min\(hidden, SLSK_SHOW_STEP\)\} more of/)
  assert.match(app, /\} else row\.remove\(\)/)
  assert.doesNotMatch(app, /renderSoulseekRow\(/, 'no full render on the fast path')
})
