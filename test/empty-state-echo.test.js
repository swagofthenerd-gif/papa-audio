'use strict'
// Roadmap W-T empty-state sweep: an empty state that echoes what was typed
// clamps it (a 10,000-character paste used to be echoed whole).
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const at = RENDERER.indexOf('function _shortQ(q, max)')
const src = RENDERER.slice(at, RENDERER.indexOf('\n}\n', at) + 3)

test('_shortQ keeps a short query, clamps a long one, and collapses whitespace', () => {
  const ctx = vm.createContext({})
  vm.runInContext(src + '\nthis._shortQ = _shortQ', ctx)
  assert.equal(ctx._shortQ('radiohead ok computer'), 'radiohead ok computer')
  assert.equal(ctx._shortQ('  a   b  '), 'a b')
  const long = 'x'.repeat(10000)
  const out = ctx._shortQ(long)
  assert.equal(out.length, 60)
  assert.ok(out.endsWith('…'))
  assert.equal(ctx._shortQ(null), '')
})

test('every empty state that echoes the query goes through _shortQ', () => {
  assert.match(RENDERER, /No matches for &ldquo;' \+ esc\(_shortQ\(query\)\)/)
  assert.match(RENDERER, /No results for "' \+ esc\(_shortQ\(searchText \|\| query\)\)/)
  assert.match(RENDERER, /No albums found for "' \+ _shortQ\(artistName\)/)
  assert.match(RENDERER, /Nothing found for "\$\{_shortQ\(q\)\}" on Soulseek/)
  assert.match(RENDERER, /Nothing matching "\$\{_shortQ\(input\.query\)\}" in library/)
  assert.equal((RENDERER.match(/Nothing found on YouTube for "\$\{_shortQ\(input\.query\)\}"/g) || []).length, 3)
  assert.doesNotMatch(RENDERER, /Nothing found on YouTube for "\$\{input\.query\}"/)
})
