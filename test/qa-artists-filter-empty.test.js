'use strict'
// L9 — filtering the Artists page to nothing left a blank page.
//
// The input handler hid every non-matching card and stopped there. Type
// "zzzz" and you got the page header, the search box, and a void: no message,
// nothing to distinguish a typo from an empty library, and no one-click way
// back to the full list.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function lift(source, name) {
  const m = new RegExp(`\\n(async )?function ${name}\\(`).exec(source)
  assert.ok(m, `${name} not found in the renderer`)
  const start = m.index + 1
  const end = source.indexOf('\n}\n', start)
  assert.ok(end > start, `${name} has no closing brace`)
  return source.slice(start, end + 2)
}

function harness(source, names = ['Radiohead', 'Portishead', 'Boards of Canada']) {
  const cards = names.map(n => ({ dataset: { artist: n }, style: { display: '' } }))
  const els = {
    'artist-grid': { querySelectorAll: () => cards },
    'artist-filter-empty': { style: { display: 'none' } },
    'artist-filter-empty-msg': { textContent: '' },
    'artist-search': { value: '', focused: 0, focus() { this.focused++ } },
  }
  const ctx = {
    console, String,
    document: { getElementById: id => els[id] || null },
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext(lift(source, '_applyArtistFilter'), ctx)
  return {
    els, cards,
    filter: (q) => vm.runInContext('_applyArtistFilter(' + JSON.stringify(q) + ')', ctx),
    visible: () => cards.filter(c => c.style.display !== 'none').map(c => c.dataset.artist),
    emptyShown: () => els['artist-filter-empty'].style.display !== 'none',
    emptyMsg: () => els['artist-filter-empty-msg'].textContent,
  }
}

test('a filter that matches nothing says which query found nothing', () => {
  const h = harness(RENDERER)
  h.filter('zzzz')
  assert.deepStrictEqual(h.visible(), [], 'the grid really is empty')
  assert.ok(h.emptyShown(), 'and that used to be all the user got')
  assert.strictEqual(h.emptyMsg(), 'No artists match “zzzz”')
})

test('a filter that matches keeps the message hidden', () => {
  const h = harness(RENDERER)
  h.filter('head')
  assert.deepStrictEqual(h.visible(), ['Radiohead', 'Portishead'])
  assert.strictEqual(h.emptyShown(), false)
})

test('clearing the box brings everyone back and hides the message', () => {
  const h = harness(RENDERER)
  h.filter('zzzz')
  h.filter('')
  assert.strictEqual(h.visible().length, 3)
  assert.strictEqual(h.emptyShown(), false)
})

test('an all-whitespace box is not "no match"', () => {
  const h = harness(RENDERER)
  h.filter('   ')
  assert.strictEqual(h.emptyShown(), false,
    'a space matches every name, so there is nothing to report')
})

test('the message quotes the query as typed, trimmed', () => {
  const h = harness(RENDERER)
  h.filter('  Björk  ')
  assert.strictEqual(h.emptyMsg(), 'No artists match “Björk”')
})

test('the page paints the empty block and a Clear button for it', () => {
  const body = RENDERER.slice(RENDERER.indexOf('\nfunction renderArtists('),
    RENDERER.indexOf('\nfunction renderArtists(') + 9000)
  assert.match(body, /id="artist-filter-empty"/)
  assert.match(body, /id="artist-filter-clear"/)
  assert.match(body, /getElementById\('artist-filter-clear'\)/, 'and the Clear button is bound')
  assert.match(body, /_applyArtistFilter\(e\.target\.value\)/, 'and the box drives the filter')
})

test('MUTATION: hiding cards without reporting the empty result is the old blank page', () => {
  const broken = RENDERER.replace(
    /  if \(empty\) \{\n    var none = !shown && !!q\.trim\(\)\n    empty\.style\.display = none \? '' : 'none'\n    if \(none && msg\) msg\.textContent = [^\n]*\n  \}\n/,
    '')
  assert.notStrictEqual(broken, RENDERER, 'the mutation applied')
  const h = harness(broken)
  h.filter('zzzz')
  assert.deepStrictEqual(h.visible(), [])
  assert.strictEqual(h.emptyShown(), false, 'this is the reported bug: a void')
})
