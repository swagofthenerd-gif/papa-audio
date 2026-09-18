'use strict'
// L11 — pressing Search on the Soulseek hub with an empty box appeared to do
// nothing.
//
// It did put up "Type at least two characters to search", but the caret stayed
// wherever it had been and the notice is easy to miss, so the experience was a
// dead button. An empty box and a one-letter box also got the same message,
// which only describes the second one.
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

// The hub's own Search closure, sliced out of renderSoulseekHub so the real
// body runs rather than a transcription of it.
function liftRunHubSearch(source) {
  const at = source.indexOf('  var runHubSearch = function () {')
  assert.ok(at > -1, 'the hub Search closure must still exist')
  const end = source.indexOf('\n  }\n', at)
  assert.ok(end > at)
  return source.slice(at, end + 4).replace('  var runHubSearch =', 'var runHubSearch =')
}

function harness(source, value) {
  const input = {
    value, focused: 0, selected: 0,
    focus() { this.focused++ },
    select() { this.selected++ },
  }
  const calls = { snackbars: [], remembered: [], searched: [] }
  const ctx = {
    console, String, input, calls,
    showSnackbar(msg) { calls.snackbars.push(msg) },
    _rememberSearch(q, surface) { calls.remembered.push([q, surface]) },
    runSlskSearch(q) { calls.searched.push(q) },
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext(lift(source, '_slskHubSearchProblem') + '\n' + liftRunHubSearch(source), ctx)
  return { ctx, input, calls, run: () => vm.runInContext('runHubSearch()', ctx) }
}

test('Search on an empty box puts the caret in the box and says what to type', () => {
  const h = harness(RENDERER, '')
  h.run()
  assert.strictEqual(h.input.focused, 1, 'the button used to leave focus where it was')
  assert.strictEqual(h.calls.snackbars.length, 1)
  assert.match(h.calls.snackbars[0], /Type what you’re looking for/)
  assert.deepStrictEqual(h.calls.searched, [], 'and nothing was searched')
})

test('a box of spaces is the same empty box', () => {
  const h = harness(RENDERER, '    ')
  h.run()
  assert.strictEqual(h.input.focused, 1)
  assert.match(h.calls.snackbars[0], /Type what you’re looking for/)
})

test('one letter gets the message that is actually about one letter', () => {
  const h = harness(RENDERER, 'r')
  h.run()
  assert.strictEqual(h.input.focused, 1)
  assert.deepStrictEqual(h.calls.snackbars, ['Type at least two characters to search'])
  assert.deepStrictEqual(h.calls.searched, [])
})

test('the two mistakes do not share one message', () => {
  const empty = harness(RENDERER, '')
  empty.run()
  const one = harness(RENDERER, 'r')
  one.run()
  assert.notStrictEqual(empty.calls.snackbars[0], one.calls.snackbars[0])
})

test('a real query still searches, and is remembered, and nothing is focused at it', () => {
  const h = harness(RENDERER, '  Radiohead OK Computer  ')
  h.run()
  assert.deepStrictEqual(h.calls.searched, ['Radiohead OK Computer'], 'trimmed')
  assert.deepStrictEqual(h.calls.remembered, [['Radiohead OK Computer', 'soulseek']])
  assert.strictEqual(h.calls.snackbars.length, 0)
})

test('the decision itself is a plain function anyone can ask', () => {
  const ctx = vm.createContext({ String })
  vm.runInContext(lift(RENDERER, '_slskHubSearchProblem'), ctx)
  const ask = (v) => vm.runInContext('_slskHubSearchProblem(' + JSON.stringify(v) + ')', ctx)
  assert.ok(ask(''))
  assert.ok(ask(null))
  assert.ok(ask('a'))
  assert.strictEqual(ask('ab'), null)
  assert.strictEqual(ask('Radiohead'), null)
})

test('MUTATION: dropping the focus makes the button look dead again', () => {
  const broken = RENDERER.replace(
    '      if (input) { input.focus(); if (input.select) input.select() }\n', '')
  assert.notStrictEqual(broken, RENDERER, 'the mutation applied')
  const h = harness(broken, '')
  h.run()
  assert.strictEqual(h.input.focused, 0, 'this is the reported bug')
})

test('MUTATION: collapsing the two cases back to one loses the empty-box answer', () => {
  const broken = RENDERER.replace(
    "  if (!q) return 'Type what you’re looking for — an album or an artist'\n", '')
  assert.notStrictEqual(broken, RENDERER, 'the mutation applied')
  const h = harness(broken, '')
  h.run()
  assert.deepStrictEqual(h.calls.snackbars, ['Type at least two characters to search'],
    'this is the reported bug: the wrong instruction for an empty box')
})
