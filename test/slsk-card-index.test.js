// Soulseek result cards carry data-gi, an index into the array the cards were
// rendered from -- which is FLAC-partitioned, surround-sorted, filtered and
// capped at 60. bindSlskSearchEvents used to rebuild its own array by calling
// _slskGroupByFolder(), which applies none of that. Every click handler
// therefore indexed a different folder, usually from a different peer.
//
// Measured against a live search for "dark side of the moon": 46 of 60 cards
// (77%) would have acted on the wrong folder.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8')
const bindStart = src.indexOf('function bindSlskSearchEvents(')
assert.ok(bindStart > -1)
const bindBody = src.slice(bindStart, src.indexOf('\nfunction ', bindStart + 10))

test('the render side publishes exactly what it rendered', () => {
  const renderStart = src.indexOf('function renderSoulseekRow(')
  const renderBody = src.slice(renderStart, src.indexOf('\nfunction ', renderStart + 10))
  assert.ok(/_slskRendered\s*=\s*displayList/.test(renderBody),
    'renderSoulseekRow must publish displayList, the array data-gi indexes')
})

test('the bind side reads that array and does not regroup', () => {
  assert.ok(/const groups = _slskRendered/.test(bindBody),
    'handlers must index the rendered array')
  assert.ok(!/_slskGroupByFolder\(/.test(bindBody),
    'a fresh regroup here has no filter, no sort and no 60-cap — it is the bug')
})

test('data-gi is emitted from the same list it is read from', () => {
  assert.ok(/displayList\.map\(\(g, gi\)/.test(src), 'cards are indexed off displayList')
})
