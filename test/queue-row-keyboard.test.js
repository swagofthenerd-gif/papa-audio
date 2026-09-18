'use strict'
// Queue rows were divs with a click listener and nothing else: no tabindex, no
// role. Tab walked straight past the whole queue, so Alt+Up/Down -- the
// keyboard route to reordering, which works perfectly once a row has focus --
// could never be reached, because nothing could give a row focus. And with the
// rows focusable there still has to be a way to PLAY one: the card-activation
// keydown handler is scoped to #content, and the queue panel is not in
// #content, so it never saw these rows.
//
// The real pass is lifted out of renderQueuePanel and run against a small but
// faithful element model, so this follows the shipped code rather than a copy.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

// The per-row body inside renderQueuePanel's `.queue-row` forEach that carries
// the click listener — the one the a11y pass was added to.
function liftQueueRowPass() {
  const marker = "list.querySelectorAll('.queue-row').forEach(row => {\n    row.addEventListener('click', e => {"
  const at = src.indexOf(marker)
  assert.ok(at > -1, 'the queue-row wiring pass must still exist in renderQueuePanel')
  const bodyStart = src.indexOf('{', src.indexOf('forEach(row => {', at)) + 1
  let depth = 1, i = bodyStart
  while (depth > 0 && i < src.length) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    i++
  }
  return src.slice(bodyStart, i - 1)
}

function liftFn(name) {
  const at = src.indexOf('function ' + name + '(')
  assert.ok(at > -1, name + ' must still exist in renderer.js')
  return src.slice(at, src.indexOf('\nfunction ', at + 1))
}

const ROW_PASS = liftQueueRowPass()
const ROW_LABEL = liftFn('_rowLabelText')

function node(cls, parent) {
  const n = {
    cls: String(cls || ''), parent: parent || null, children: [], attrs: {},
    text: '', dataset: {}, listeners: {}, focused: 0,
    get classList() { return { contains: c => n.cls.split(/\s+/).includes(c) } },
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
      const walk = kids => {
        for (const k of kids) {
          if (k.cls.split(/\s+/).includes(wanted)) return k
          const deeper = walk(k.children)
          if (deeper) return deeper
        }
        return null
      }
      return walk(n.children)
    },
    get firstChild() { return n.text ? { nodeType: 3, textContent: n.text } : (n.children[0] || null) },
    get textContent() { return n.text + n.children.map(c => c.textContent).join('') },
    addEventListener(type, fn) { (n.listeners[type] = n.listeners[type] || []).push(fn) },
    hasAttribute(a) { return a in n.attrs },
    setAttribute(a, v) { n.attrs[a] = String(v) },
    getAttribute(a) { return a in n.attrs ? n.attrs[a] : null },
    focus() { n.focused++ },
  }
  if (parent) parent.children.push(n)
  return n
}

function queueRow(idx, { title = 'Lady Fantasy', artist = 'Camel', playing = false } = {}) {
  const row = node('queue-row' + (playing ? ' playing' : ''))
  row.dataset.queueIdx = String(idx)
  node('queue-drag-handle', row)
  const info = node('queue-row-info', row)
  const t = node('queue-row-title', info); t.text = title
  const a = node('queue-row-artist', info); a.text = artist
  return row
}

function run(row, queueLength) {
  const log = []
  const state = { queue: new Array(queueLength == null ? 12 : queueLength).fill(0), queueIndex: 0 }
  const document = {
    querySelector() { return row },        // the repainted row, same node here
  }
  const env = { state, row, document }
  new Function('env', 'log', `
    const { state, row, document } = env
    function playCurrentTrack() { log.push('playCurrentTrack:' + state.queueIndex) }
    function renderQueuePanel() { log.push('renderQueuePanel') }
    ${ROW_LABEL}
    ;(function (row) { ${ROW_PASS} })(row)
  `)(env, log)
  return { row, state, log }
}

function fire(row, key, target) {
  const e = {
    key, target: target || row,
    defaultPrevented: false, propagationStopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.propagationStopped = true },
  }
  for (const fn of row.listeners.keydown || []) fn(e)
  // What the document-level shortcut handler would do next: Space is play/pause.
  return { e, reachedGlobalShortcut: !e.propagationStopped && key === ' ' }
}

test('a queue row is a tab stop and is announced as a control', () => {
  const row = queueRow(3)
  run(row, 12)
  assert.strictEqual(row.getAttribute('tabindex'), '0',
    'Tab skipped the entire queue before this, so Alt+Up/Down was unreachable')
  assert.strictEqual(row.getAttribute('role'), 'button')
})

test('a queue row is named by its song, its artist and its place in the queue', () => {
  const row = queueRow(3, { title: 'Riverside', artist: 'Agnes Obel' })
  run(row, 12)
  assert.strictEqual(row.getAttribute('aria-label'), 'Play Riverside by Agnes Obel, #4 of 12')
})

test('the badges printed beside the song are not read as part of its name', () => {
  const row = queueRow(0, { title: 'Riverside', artist: 'Agnes Obel' })
  node('track-explicit', row.querySelector('.queue-row-title')).text = 'E'
  node('track-bpm', row.querySelector('.queue-row-artist')).text = '120 BPM'
  run(row, 3)
  assert.strictEqual(row.getAttribute('aria-label'), 'Play Riverside by Agnes Obel, #1 of 3',
    'reading "RiversideE by Agnes Obel120 BPM" aloud is worse than reading nothing')
})

test('the row that is playing says so', () => {
  const playing = queueRow(1, { playing: true })
  run(playing, 4)
  assert.strictEqual(playing.getAttribute('aria-current'), 'true')
  const other = queueRow(2)
  run(other, 4)
  assert.strictEqual(other.getAttribute('aria-current'), 'false')
})

test('Enter on a focused queue row plays that track', () => {
  const row = queueRow(5)
  const h = run(row, 12)
  fire(row, 'Enter')
  assert.strictEqual(h.state.queueIndex, 5, 'the focused row is the one that plays')
  assert.ok(h.log.includes('playCurrentTrack:5'))
})

test('Space plays the row and does not also pause it', () => {
  const row = queueRow(5)
  const h = run(row, 12)
  const { e, reachedGlobalShortcut } = fire(row, ' ')
  assert.ok(h.log.includes('playCurrentTrack:5'))
  assert.strictEqual(e.defaultPrevented, true, 'the panel must not scroll')
  assert.strictEqual(reachedGlobalShortcut, false,
    'the same keypress reaching the play/pause shortcut would start the track and stop it')
})

test('the chosen row keeps focus through the repaint', () => {
  const row = queueRow(5)
  run(row, 12)
  fire(row, 'Enter')
  assert.ok(row.focused > 0,
    'the panel is rebuilt from innerHTML, so without this the keyboard user loses their place')
})

test('a button inside a queue row keeps its own behaviour', () => {
  const row = queueRow(5)
  const btn = node('button queue-row-remove', row)
  const h = run(row, 12)
  const { e } = fire(row, 'Enter', btn)
  assert.ok(!h.log.some(l => l.startsWith('playCurrentTrack')),
    'Enter on Remove must remove, not play')
  assert.strictEqual(e.defaultPrevented, false)
})

test('any other key is left completely alone', () => {
  const row = queueRow(5)
  const h = run(row, 12)
  const { e } = fire(row, 'a')
  assert.strictEqual(e.defaultPrevented, false)
  assert.strictEqual(h.log.length, 0)
})

test('a row with no title is still focusable but is not given an empty name', () => {
  const row = node('queue-row')
  row.dataset.queueIdx = '0'
  run(row, 2)
  assert.strictEqual(row.getAttribute('tabindex'), '0')
  assert.strictEqual(row.getAttribute('aria-label'), null, 'an empty label is worse than none')
})
