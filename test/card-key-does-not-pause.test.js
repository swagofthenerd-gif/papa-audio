'use strict'
// Choosing a song with the keyboard must not also pause it.
//
// The cards and rows in #content are focusable and carry role="button", so
// Space and Enter activate them. The handler called preventDefault() and
// card.click() but never stopPropagation(), so the SAME keypress carried on up
// to the document handler, where Space is the play/pause shortcut. Picking a
// track started it and immediately paused it; opening an album stopped
// whatever was playing. preventDefault does not stop propagation, and
// defaultPrevented is checked in exactly one unrelated place in renderer.js,
// so nothing downstream noticed.
//
// The real handler source is lifted out of renderer.js and driven through a
// small but faithful event model: a target, its ancestors, and the actual
// stopPropagation / preventDefault semantics.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

// The card-activation keydown handler, taken from the shipped source.
function liftCardKeydown() {
  const marker = "if (e.key !== 'Enter' && e.key !== ' ') return"
  const at = src.indexOf(marker)
  assert.ok(at > -1, 'the card-activation keydown handler must still exist')
  const open = src.lastIndexOf('addEventListener(\'keydown\', e => {', at)
  assert.ok(open > -1 && open < at)
  const bodyStart = src.indexOf('{', src.indexOf('e => {', open)) + 1
  // Balance braces to find the end of the arrow body.
  let depth = 1, i = bodyStart
  while (depth > 0 && i < src.length) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    i++
  }
  return src.slice(bodyStart, i - 1)
}

const BODY = liftCardKeydown()

// A node that knows its ancestors, enough for closest().
function node(cls, parent) {
  const n = {
    cls: String(cls || ''), parent: parent || null, clicked: 0,
    closest(sel) {
      const wanted = sel.split(',').map(s => s.trim().replace(/^\./, ''))
      let cur = n
      while (cur) {
        if (wanted.some(w => cur.cls.split(/\s+/).includes(w))) return cur
        cur = cur.parent
      }
      return null
    },
    click() { n.clicked++ },
  }
  return n
}

function fireSpace(target, key = ' ') {
  const e = {
    key, target,
    defaultPrevented: false, propagationStopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.propagationStopped = true },
  }
  const handler = new Function('e', BODY)
  handler(e)
  // What the document-level shortcut handler would do next.
  const reachedGlobalShortcut = !e.propagationStopped && e.key === ' '
  return { e, reachedGlobalShortcut }
}

test('Space on a playlist track row does not reach the play/pause shortcut', () => {
  const row = node('pl-track-row')
  const { e, reachedGlobalShortcut } = fireSpace(row)
  assert.strictEqual(row.clicked, 1, 'the row is still activated')
  assert.strictEqual(e.defaultPrevented, true, 'and the page still must not scroll')
  assert.strictEqual(reachedGlobalShortcut, false,
    'the same keypress must not also toggle play/pause — that is the bug')
})

test('Space on an album card does not stop what is playing', () => {
  const card = node('album-card')
  const { reachedGlobalShortcut } = fireSpace(card)
  assert.strictEqual(card.clicked, 1)
  assert.strictEqual(reachedGlobalShortcut, false)
})

test('Enter activates the card too, and is not the play/pause key anyway', () => {
  const card = node('quick-card')
  const { e } = fireSpace(card, 'Enter')
  assert.strictEqual(card.clicked, 1)
  assert.strictEqual(e.defaultPrevented, true)
})

test('a key on something that is not a card is left completely alone', () => {
  const plain = node('some-div')
  const { e, reachedGlobalShortcut } = fireSpace(plain)
  assert.strictEqual(plain.clicked, 0)
  assert.strictEqual(e.defaultPrevented, false, 'untouched, so Space still pauses as it should')
  assert.strictEqual(reachedGlobalShortcut, true, 'the global shortcut is still reachable in general')
})

test('a button inside a card keeps its own behaviour', () => {
  const card = node('album-card')
  const btn = node('button', card)
  const { e } = fireSpace(btn)
  assert.strictEqual(card.clicked, 0, 'the card must not be activated by its own button')
  assert.strictEqual(e.defaultPrevented, false)
})
