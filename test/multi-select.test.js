const test = require('node:test')
const assert = require('node:assert')
const S = require('../src/multi-select')

test('a plain click picks exactly one row and sets the anchor', () => {
  const r = S.applyClick({ index: 3, selected: [1, 2], anchor: 1 })
  assert.deepEqual(r.selected, [3])
  assert.equal(r.anchor, 3)
  assert.equal(r.mode, 'single')
})

test('ctrl-click toggles a row without disturbing the rest', () => {
  const on = S.applyClick({ index: 5, ctrl: true, selected: [1, 2], anchor: 1 })
  assert.deepEqual(on.selected, [1, 2, 5])
  const off = S.applyClick({ index: 2, ctrl: true, selected: [1, 2, 5], anchor: 5 })
  assert.deepEqual(off.selected, [1, 5])
})

test('shift-click selects the range from the anchor, in either direction', () => {
  const down = S.applyClick({ index: 5, shift: true, selected: [2], anchor: 2 })
  assert.deepEqual(down.selected, [2, 3, 4, 5])
  const up = S.applyClick({ index: 0, shift: true, selected: [3], anchor: 3 })
  assert.deepEqual(up.selected, [0, 1, 2, 3])
})

test('the anchor does NOT move on shift-click, so the range can be re-dragged', () => {
  // Shift 2→5, then shift 2→3 must give 2..3, not ratchet from 5.
  let r = S.applyClick({ index: 5, shift: true, selected: [2], anchor: 2 })
  assert.equal(r.anchor, 2)
  r = S.applyClick({ index: 3, shift: true, selected: r.selected, anchor: r.anchor })
  assert.deepEqual(r.selected, [2, 3])
})

test('shift alone REPLACES the selection; ctrl+shift ADDS the range', () => {
  const replace = S.applyClick({ index: 4, shift: true, selected: [9], anchor: 2 })
  assert.deepEqual(replace.selected, [2, 3, 4])
  const add = S.applyClick({ index: 4, shift: true, ctrl: true, selected: [9], anchor: 2 })
  assert.deepEqual(add.selected, [2, 3, 4, 9])
})

test('shift with no anchor yet behaves as a first pick, not a no-op', () => {
  const r = S.applyClick({ index: 4, shift: true, selected: [], anchor: null })
  assert.deepEqual(r.selected, [4])
  assert.equal(r.anchor, 4)
})

test('a single-row range is just that row', () => {
  const r = S.applyClick({ index: 2, shift: true, selected: [], anchor: 2 })
  assert.deepEqual(r.selected, [2])
})

test('selection survives rows disappearing underneath it', () => {
  // A delete shortens the list; stale indices must not linger.
  const c = S.clampToLength([1, 4, 7], 7, 5)
  assert.deepEqual(c.selected, [1, 4])
  assert.equal(c.anchor, 4, 'anchor is pulled back inside the list')
})

test('clamping to an empty list clears the anchor rather than leaving it dangling', () => {
  const c = S.clampToLength([0, 1], 1, 0)
  assert.deepEqual(c.selected, [])
  assert.equal(c.anchor, null)
})

test('an out-of-range click is ignored rather than corrupting the selection', () => {
  const r = S.applyClick({ index: -1, selected: [1, 2], anchor: 1 })
  assert.deepEqual(r.selected, [1, 2])
  assert.equal(r.mode, 'none')
})

test('the count reads as a sentence', () => {
  assert.equal(S.describe(1), '1 track selected')
  assert.equal(S.describe(4), '4 tracks selected')
  assert.equal(S.describe(2, 'album'), '2 albums selected')
})

test('selectAll covers the whole list', () => {
  assert.deepEqual(S.selectAll(3), [0, 1, 2])
  assert.deepEqual(S.selectAll(0), [])
})
