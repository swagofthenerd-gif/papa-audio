'use strict'
// My List painted an ungrouped title as a full-width poster (1975x3080 on a
// maximised window). The cause is layout, not sizing: once any franchise in
// the list folds, _myListGridHtml stops wrapping the page in a .vgrid and
// emits franchise blocks — each with its own .vgrid — as siblings of the
// bare singleton cards, inside a plain <div id="vmylist-grid"> that has no
// grid at all. A .vcard with no grid parent is a block: full container width.
//
// The contract this pins: every card the function emits, grouped or not, has
// a .vgrid ancestor, and the visual order of the list is unchanged.
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
      if (!depth) return source.slice(start, j + 1)
    }
  }
  throw new Error('unbalanced braces in ' + name)
}

// Build the real function with the collaborators it names stubbed: the card
// painter emits a recognisable .vcard, the grouper is the shape the real
// PapaMyListGroup returns.
function lift (groups) {
  const ctx = {
    window: { PapaMyListGroup: { groupMyList: function () { return groups } } },
    esc: function (s) { return String(s) },
    _videoCard: function (it) { return '<div class="vcard" data-id="' + it.id + '"></div>' },
    _myListUnfolded: new Set(),
  }
  vm.createContext(ctx)
  vm.runInContext(extractFn(SRC, '_myListGridHtml'), ctx)
  return ctx._myListGridHtml
}

// A crude HTML walker: returns, for each .vcard, whether any open ancestor
// element carried the vgrid class. Enough for markup this shallow, and it
// does not need a DOM.
function cardsWithoutGridAncestor (html) {
  const tokens = html.match(/<\/?div[^>]*>/g) || []
  const stack = []
  const orphans = []
  let idx = 0
  for (const t of tokens) {
    if (t.startsWith('</')) { stack.pop(); continue }
    const cls = (t.match(/class="([^"]*)"/) || [])[1] || ''
    const selfClosing = /\/>$/.test(t)
    if (/\bvcard\b/.test(cls)) {
      if (!stack.some(function (c) { return /\bvgrid\b/.test(c) })) {
        orphans.push((t.match(/data-id="([^"]*)"/) || [])[1] || String(idx))
      }
      idx++
      if (!selfClosing) stack.push(cls)
      continue
    }
    if (!selfClosing) stack.push(cls)
  }
  return orphans
}

function cardOrder (html) {
  return (html.match(/data-id="([^"]*)"/g) || []).map(function (m) {
    return m.slice(9, -1)
  })
}

test('an ungrouped title still sits inside a grid when a franchise folds', function () {
  const html = lift([
    { name: 'Dune', grouped: false, items: [{ id: 'dune' }] },
    { name: 'The Matrix', grouped: true, items: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] },
  ])()
  assert.deepStrictEqual(cardsWithoutGridAncestor(html), [],
    'every .vcard must have a .vgrid ancestor, or it lays out as a block')
})

test('several singletons around franchises keep list order', function () {
  const html = lift([
    { name: 'Arrival', grouped: false, items: [{ id: 'a' }] },
    { name: 'Sicario', grouped: false, items: [{ id: 'b' }] },
    { name: 'Alien', grouped: true, items: [{ id: 'c1' }, { id: 'c2' }] },
    { name: 'Heat', grouped: false, items: [{ id: 'd' }] },
  ])()
  assert.deepStrictEqual(cardsWithoutGridAncestor(html), [])
  // The folded franchise peeks with its first poster only, so c2 is absent.
  assert.deepStrictEqual(cardOrder(html), ['a', 'b', 'c1', 'd'])
})

test('consecutive singletons share one grid rather than one each', function () {
  const html = lift([
    { name: 'Arrival', grouped: false, items: [{ id: 'a' }] },
    { name: 'Sicario', grouped: false, items: [{ id: 'b' }] },
    { name: 'Alien', grouped: true, items: [{ id: 'c1' }, { id: 'c2' }] },
  ])()
  const singletonGrids = (html.split('<div class="vmylist-franchise')[0]
    .match(/class="vgrid/g) || []).length
  assert.strictEqual(singletonGrids, 1,
    'two adjacent singletons must share a grid so they sit side by side')
})

test('the flat fallback (nothing grouped) is still a grid', function () {
  const html = lift([
    { name: 'Dune', grouped: false, items: [{ id: 'dune' }] },
    { name: 'Heat', grouped: false, items: [{ id: 'heat' }] },
  ])([{ id: 'dune' }, { id: 'heat' }])
  assert.deepStrictEqual(cardsWithoutGridAncestor(html), [])
})
