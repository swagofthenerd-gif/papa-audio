'use strict'
// The async-render guard works by replacing the six renderers on the global
// object. That is only sound if a classic script's `function renderVideo() {}`
// creates a WRITABLE global property, and if a later call to renderVideo()
// resolves through that property rather than to the original binding.
//
// It does, and it does — but the whole fix is worth nothing if either were
// false, and neither is obvious from reading the code. So this runs a script
// shaped exactly like renderer.js (classic script, sloppy mode, top-level
// function declarations, index.html loads it with a plain <script src>) and
// checks that a call made from another top-level function reaches the wrapper.
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
const TABLE = /var _GUARDED_VIDEO_PAGES = \{[\s\S]*?\n\}/.exec(SRC)[0]

test('a classic script’s function declaration really can be replaced on the global', async () => {
  const failures = []
  const ctx = vm.createContext({
    console: { error () {} },
    state: { currentPage: 'video-detail' },
    _renderFailure (where, err) { failures.push({ where, err }) },
    report: null,
  })
  // `window` is the global object in a renderer, and index.html loads
  // renderer.js as a plain classic script — so this is the same shape.
  vm.runInContext('var window = this', ctx)
  vm.runInContext([
    TABLE,
    extractFn(SRC, '_guardVideoRenders'),
    // The renderer under test, and the dispatcher that calls it by bare name
    // exactly as navigate() does.
    'async function renderVideoDetail(id) { await null; throw new Error("boom " + id) }',
    'function dispatch(id) { try { renderVideoDetail(id) } catch (e) { _renderFailure("video-detail", e) } }',
    '_guardVideoRenders(window)',
  ].join('\n'), ctx)

  vm.runInContext('dispatch("tv:1396")', ctx)
  await new Promise(r => setImmediate(r))

  assert.strictEqual(failures.length, 1,
    'the bare-name call inside dispatch() reached the wrapper, not the original')
  assert.strictEqual(failures[0].where, 'video-detail')
  assert.match(String(failures[0].err.message), /boom tv:1396/)
})

test('the guard reports what it replaced, so a rename cannot silently unwire it', () => {
  const ctx = vm.createContext({ console, state: { currentPage: 'video' }, _renderFailure () {} })
  vm.runInContext('var window = this', ctx)
  vm.runInContext([TABLE, extractFn(SRC, '_guardVideoRenders')].join('\n'), ctx)
  // None of the six exist in this context.
  const wrapped = vm.runInContext('_guardVideoRenders(window)', ctx)
  assert.strictEqual(Array.from(wrapped).length, 0,
    'a renderer that is not there is skipped rather than wrapped as undefined')
})

test('the six names in the table are the six renderers the file declares', () => {
  // The table is the fix's only link to the functions. A renamed renderer that
  // nobody updates here would be silently unguarded again.
  for (const name of ['renderVideo', 'renderVideoDetail', 'renderShelf', 'renderBrowse', 'renderPerson', 'renderCalendar']) {
    assert.ok(TABLE.includes("'" + name + "'"), name + ' is in the guard table')
    assert.ok(SRC.includes('async function ' + name + '('),
      name + ' is still an async declaration — if it stopped being one it would no longer need the guard')
  }
})
