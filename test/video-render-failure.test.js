'use strict'
// A Movies & TV page that fails halfway through said nothing at all.
//
// navigate() does this:
//
//     try {
//       ...
//       else if (page === 'video-detail') renderVideoDetail(navId)
//       ...
//     } catch (err) { _renderFailure(page, err) }
//
// and _renderFailure paints a card with the message, a Go Home and a Copy
// diagnostics. It works — for synchronous renderers. Six of the seven video
// pages are `async`, and an async function NEVER throws out of its call: it
// returns a promise and rejects it. So the catch was dead for exactly the
// pages this tab is made of.
//
// renderVideoDetail paints a grey skeleton and then awaits the catalog. Every
// throw after that point — a malformed detail record, a helper reading a field
// off null, a bridge method missing from an older preload — left that skeleton
// on screen permanently. No message, no retry, and the stack only in devtools.
//
// These tests run the real _guardVideoRenders over real async functions and
// prove the failure now reaches the real failure surface.
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
      if (!depth) {
        const body = source.slice(start, j + 1)
        return (source.slice(Math.max(0, start - 6), start) === 'async ' ? 'async ' : '') + body
      }
    }
  }
  throw new Error('unbalanced braces in ' + name)
}

function tableOf (source) {
  const m = /var _GUARDED_VIDEO_PAGES = \{[\s\S]*?\n\}/.exec(source)
  assert.ok(m, '_GUARDED_VIDEO_PAGES not found')
  return m[0]
}

// A scope standing in for `window`: the six renderers as real async functions
// whose behaviour each test chooses, plus the one failure surface they must
// reach. navigate()'s own try/catch is reproduced exactly as it is written, so
// what this asserts is what the app actually does.
function harness (source, opts) {
  opts = opts || {}
  const failures = []
  const logged = []
  const sandbox = {
    state: { currentPage: opts.currentPage || 'video-detail' },
    console: { error: (...a) => logged.push(a) },
    _renderFailure (where, err) { failures.push({ where, err }) },
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext([tableOf(source), extractFn(source, '_guardVideoRenders')].join('\n'), sandbox)
  return { sandbox, failures, logged }
}

// The shape of navigate()'s dispatch, verbatim in behaviour: call it, and
// catch only what throws synchronously.
function navigateLike (sandbox, page, navId) {
  let caught = null
  let result
  try {
    if (page === 'video') result = sandbox.renderVideo(navId)
    else if (page === 'video-detail') result = sandbox.renderVideoDetail(navId)
    else if (page === 'shelf') result = sandbox.renderShelf(navId)
  } catch (err) { caught = err; sandbox._renderFailure(page, err) }
  // navigate() discards the return value. The tests keep it only so the
  // unguarded case can be observed without the test runner aborting on an
  // unhandled rejection — that abort IS the bug, but it is not what is being
  // asserted here.
  return { caught, result }
}

const tick = () => new Promise(r => setImmediate(r))

test('a detail page that throws after its first await reaches the failure card', async () => {
  const h = harness(SRC)
  // Exactly the shape of the real one: paint a skeleton, await the catalog,
  // then fall over on the response.
  let painted = ''
  h.sandbox.renderVideoDetail = async function (id) {
    painted = 'skeleton'
    await Promise.resolve()
    throw new TypeError("Cannot read properties of null (reading 'seasons')")
  }
  const wrapped = h.sandbox._guardVideoRenders(h.sandbox)
  assert.ok(wrapped.includes('renderVideoDetail'))

  navigateLike(h.sandbox, 'video-detail', 'tv:1396')
  await tick()

  assert.strictEqual(painted, 'skeleton', 'the skeleton was painted, as it always was')
  assert.strictEqual(h.failures.length, 1, 'and the failure is now reported')
  assert.strictEqual(h.failures[0].where, 'video-detail')
  assert.match(String(h.failures[0].err.message), /seasons/)
})

test('MUTATION: unwrapped, navigate’s own catch sees nothing at all', async () => {
  const h = harness(SRC)
  h.sandbox.renderVideoDetail = async function () {
    await Promise.resolve()
    throw new TypeError("Cannot read properties of null (reading 'seasons')")
  }
  // The guard deliberately NOT applied — this is the code as it shipped.
  const { caught, result } = navigateLike(h.sandbox, 'video-detail', 'tv:1396')
  const escaped = []
  result.then(null, e => escaped.push(e))   // the test watching, not the app
  await tick()
  assert.strictEqual(caught, null, 'an async function does not throw out of its call')
  assert.strictEqual(escaped.length, 1, 'the failure happened — it just went nowhere')
  assert.strictEqual(h.failures.length, 0,
    'this is the bug: the page died and the app never noticed')
})

test('a page that renders fine is untouched', async () => {
  const h = harness(SRC)
  let ran = 0
  h.sandbox.renderVideo = async function (navId) { ran++; await Promise.resolve(); return 'ok:' + navId }
  h.sandbox._guardVideoRenders(h.sandbox)
  const out = await h.sandbox.renderVideo('tokyo')
  assert.strictEqual(ran, 1)
  assert.strictEqual(out, 'ok:tokyo', 'the return value survives the wrapper')
  assert.strictEqual(h.failures.length, 0)
})

test('a synchronous throw is still reported, and only once', async () => {
  const h = harness(SRC)
  h.sandbox.renderShelf = function () { throw new Error('bad shelf key') }
  h.sandbox._guardVideoRenders(h.sandbox)
  h.sandbox.state.currentPage = 'shelf'
  const { caught } = navigateLike(h.sandbox, 'shelf', 'canon')
  await tick()
  assert.strictEqual(caught, null, 'the wrapper absorbs it rather than double-reporting')
  assert.strictEqual(h.failures.length, 1)
  assert.strictEqual(h.failures[0].where, 'shelf')
})

test('a rejection arriving after the viewer has left does not blank the new page', async () => {
  // The slow page finally fails while the viewer is already somewhere else.
  // Painting the failure card here would take away a page that is working.
  const h = harness(SRC, { currentPage: 'video-detail' })
  h.sandbox.renderVideoDetail = async function () { await Promise.resolve(); throw new Error('too late') }
  h.sandbox._guardVideoRenders(h.sandbox)
  navigateLike(h.sandbox, 'video-detail', 'tv:1396')
  h.sandbox.state.currentPage = 'home'   // the viewer moved on
  await tick()
  assert.strictEqual(h.failures.length, 0, 'the screen is left alone')
  assert.strictEqual(h.logged.length, 1, 'but it is not swallowed either')
  assert.match(String(h.logged[0][0]), /renderVideoDetail failed after the page was left/)
})

test('all six video pages are covered, and wrapping twice is a no-op', async () => {
  const h = harness(SRC)
  const names = ['renderVideo', 'renderVideoDetail', 'renderShelf', 'renderBrowse', 'renderPerson', 'renderCalendar']
  const calls = []
  for (const n of names) h.sandbox[n] = async function () { calls.push(n); await Promise.resolve(); throw new Error('x ' + n) }
  const first = h.sandbox._guardVideoRenders(h.sandbox)
  assert.strictEqual(Array.from(first).sort().join(','), names.slice().sort().join(','),
    'every async video page is guarded, not just the one that was noticed')
  const second = h.sandbox._guardVideoRenders(h.sandbox)
  assert.strictEqual(second.length, 0, 'a second pass must not wrap the wrappers')

  for (const page of ['video', 'video-detail', 'shelf', 'browse', 'person', 'calendar']) {
    h.sandbox.state.currentPage = page
    const name = { video: 'renderVideo', 'video-detail': 'renderVideoDetail', shelf: 'renderShelf',
      browse: 'renderBrowse', person: 'renderPerson', calendar: 'renderCalendar' }[page]
    h.sandbox[name]()
    await tick()
  }
  assert.strictEqual(h.failures.length, 6, 'each page reported its own failure')
  assert.strictEqual(h.failures.map(f => f.where).join(','),
    'video,video-detail,shelf,browse,person,calendar')
})

test('the guard is actually installed when the file loads', () => {
  // The wrapping is worth nothing if nobody calls it. Function declarations
  // hoist across the whole script, so the top-level call reaches all six.
  assert.match(SRC, /if \(typeof window !== 'undefined'\) _guardVideoRenders\(window\)/)
})
