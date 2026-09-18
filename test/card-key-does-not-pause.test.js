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

// A node that knows its ancestors and its children: enough for closest(),
// classList.contains() and querySelector() over one subtree.
function node(cls, parent) {
  const n = {
    cls: String(cls || ''), parent: parent || null, clicked: 0, children: [],
    attrs: {}, text: '',
    get classList() {
      return { contains: (c) => n.cls.split(/\s+/).includes(c) }
    },
    closest(sel) {
      const wanted = sel.split(',').map(s => s.trim().replace(/^\./, ''))
      let cur = n
      while (cur) {
        if (wanted.some(w => cur.cls.split(/\s+/).includes(w))) return cur
        cur = cur.parent
      }
      return null
    },
    querySelector(sel) {
      const wanted = sel.replace(/^\./, '')
      const walk = (kids) => {
        for (const k of kids) {
          if (k.cls.split(/\s+/).includes(wanted)) return k
          const deeper = walk(k.children)
          if (deeper) return deeper
        }
        return null
      }
      return walk(n.children)
    },
    // Enough of the text model for the label builder: a cell's own text is a
    // text node, and any badge inside it is an element after it.
    get firstChild() {
      return n.text ? { nodeType: 3, textContent: n.text } : (n.children[0] || null)
    },
    get textContent() { return n.text + n.children.map(c => c.textContent).join('') },
    click() { n.clicked++ },
    hasAttribute(a) { return a in n.attrs },
    setAttribute(a, v) { n.attrs[a] = String(v) },
    getAttribute(a) { return a in n.attrs ? n.attrs[a] : null },
  }
  if (parent) parent.children.push(n)
  return n
}

// An album/search/playlist song row: the row, with the track number that the
// mouse has to hit for the row to PLAY rather than navigate.
function trackRow(extraCls = '', { num = true, title = 'Lady Fantasy', artist = 'Camel' } = {}) {
  const row = node(('track-row ' + extraCls).trim())
  if (num) node('track-num', row)
  const info = node('track-info', row)
  const t = node('track-title', info); t.text = title
  const a = node('track-artist', info); a.text = artist
  return row
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

// ── Songs are reachable, and Enter on one PLAYS it ──────────────────────────
//
// The selector above covered 21 card and row classes. `.track-row` — every
// song inside an album, a search result or a playlist — was not one of them,
// and the rows carried no tabindex and no role either, so Tab skipped every
// song in the app and there was no keyboard route to one at all.
//
// Making them focusable is only half of it. A song row means two things to the
// mouse: the track NUMBER plays it, the rest of the row opens the album it
// came from. A keypress that clicked the row would have navigated away instead
// of playing, which is not what Enter on a song means.

test('Space on a song row activates it', () => {
  const row = trackRow()
  const { reachedGlobalShortcut } = fireSpace(row)
  assert.strictEqual(reachedGlobalShortcut, false,
    'and it must not also toggle play/pause — the original bug, on a new surface')
})

test('Enter on a song routes to the play path, not to album navigation', () => {
  const row = trackRow()
  const num = row.querySelector('.track-num')
  fireSpace(row, 'Enter')
  assert.strictEqual(num.clicked, 1,
    'the keypress must land where the mouse plays the track')
  assert.strictEqual(row.clicked, 0,
    'clicking the row itself is what opens the album — never what Enter meant')
})

test('a song row with no track number still activates', () => {
  const row = trackRow('', { num: false })
  fireSpace(row)
  assert.strictEqual(row.clicked, 1, 'the row is the fallback, not nothing at all')
})

test('a playlist row is routed the same way, and still does not pause', () => {
  // Playlist rows carry BOTH classes; whichever the selector matches, the
  // behaviour must be one behaviour.
  const row = trackRow('pl-track-row')
  const num = row.querySelector('.track-num')
  const { e, reachedGlobalShortcut } = fireSpace(row)
  assert.strictEqual(num.clicked, 1)
  assert.strictEqual(e.defaultPrevented, true)
  assert.strictEqual(reachedGlobalShortcut, false)
})

test('a card is still clicked directly — the routing is for songs only', () => {
  const card = node('album-card')
  const inner = node('track-num', card)   // a card could contain anything
  fireSpace(card)
  assert.strictEqual(card.clicked, 1)
  assert.strictEqual(inner.clicked, 0)
})

test('a button inside a song row keeps its own behaviour', () => {
  const row = trackRow()
  const btn = node('button track-like-btn', row)
  const { e } = fireSpace(btn)
  assert.strictEqual(row.querySelector('.track-num').clicked, 0)
  assert.strictEqual(row.clicked, 0)
  assert.strictEqual(e.defaultPrevented, false)
})

// ── And they are reachable in the first place ───────────────────────────────

// The real a11y pass, lifted out of bindContentEvents().
function liftRowA11y() {
  const marker = "document.querySelectorAll('#content .track-row').forEach(function (row) {"
  const at = src.indexOf(marker)
  assert.ok(at > -1, 'the track-row focus pass must still exist in bindContentEvents')
  const bodyStart = src.indexOf('{', src.indexOf('function (row) {', at)) + 1
  let depth = 1, i = bodyStart
  while (depth > 0 && i < src.length) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    i++
  }
  // _rowLabelText is a module-level helper the pass calls; take the real one.
  const hAt = src.indexOf('function _rowLabelText(el) {')
  assert.ok(hAt > -1, '_rowLabelText must still exist')
  const helper = src.slice(hAt, src.indexOf('\nfunction ', hAt + 1))
  return new Function('row', helper + '\n' + src.slice(bodyStart, i - 1))
}

const ROW_A11Y = liftRowA11y()

test('a song row is a tab stop, is announced as a control, and is named', () => {
  const row = trackRow('', { title: 'Lady Fantasy', artist: 'Camel' })
  ROW_A11Y(row)
  assert.strictEqual(row.getAttribute('tabindex'), '0', 'Tab skipped every song before this')
  assert.strictEqual(row.getAttribute('role'), 'button')
  assert.strictEqual(row.getAttribute('aria-label'), 'Play Lady Fantasy by Camel')
})

test('the name is the song, not the badges printed next to it', () => {
  const row = trackRow('', { title: 'Riverside', artist: 'Agnes Obel' })
  node('track-explicit', row.querySelector('.track-title')).text = 'E'
  node('track-bpm', row.querySelector('.track-artist')).text = '120 BPM'
  ROW_A11Y(row)
  assert.strictEqual(row.getAttribute('aria-label'), 'Play Riverside by Agnes Obel',
    'reading "RiversideE by Agnes Obel120 BPM" aloud is worse than reading nothing')
})

test('a row that already says what it is is left alone', () => {
  const row = trackRow()
  row.setAttribute('tabindex', '-1')
  row.setAttribute('aria-label', 'Something more specific')
  ROW_A11Y(row)
  assert.strictEqual(row.getAttribute('tabindex'), '-1')
  assert.strictEqual(row.getAttribute('aria-label'), 'Something more specific')
})

test('a row with no title is focusable but not given an empty name', () => {
  const row = node('track-row')
  node('track-num', row)
  ROW_A11Y(row)
  assert.strictEqual(row.getAttribute('tabindex'), '0')
  assert.strictEqual(row.getAttribute('aria-label'), null, 'an empty label is worse than none')
})
