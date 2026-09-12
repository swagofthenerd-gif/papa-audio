'use strict'
// V2.6, the "Approved" chip: a certificate that is a word, not a code, read
// as a genre tag on the card. It is prefixed, and every certificate chip
// says what it is on hover.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const at = RENDERER.indexOf('const _CERT_CODES')
const src = RENDERER.slice(at, RENDERER.indexOf('\n}\n', RENDERER.indexOf('function _certLabel')) + 3)

test('codes stand alone, words are prefixed', () => {
  const ctx = vm.createContext({})
  vm.runInContext(src + '\nthis._certLabel = _certLabel', ctx)
  for (const c of ['PG-13', 'R', 'G', 'TV-MA', '15', '12A', 'U', 'NC-17']) assert.equal(ctx._certLabel(c), c)
  assert.equal(ctx._certLabel('Approved'), 'Rated Approved')
  assert.equal(ctx._certLabel('Passed'), 'Rated Passed')
  assert.equal(ctx._certLabel('Not Rated'), 'Rated Not Rated')
  assert.equal(ctx._certLabel(''), '')
})

test('both certificate chips use the label and carry a title', () => {
  assert.match(RENDERER, /<span class="vcard-cert" title="Age rating">' \+ esc\(_certLabel\(m\.certification\)\)/)
  assert.match(RENDERER, /<span class="vfact vfact-cert" title="Age rating">' \+ esc\(_certLabel\(d\.certification\)\)/)
})
