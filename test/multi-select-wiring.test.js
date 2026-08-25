// Ctrl-click selection was dead on track rows: the rows carry TWO click
// handlers on the same element (the album page binds its own .track-row
// handler, and bindContentEvents binds a generic one), and both reached
// _selHandleClick. e.stopPropagation() does not stop other listeners on the
// SAME element, so one Ctrl-click ran applyClick twice -- toggle on, toggle
// off -- and the selection was always empty. Shift only looked healthy because
// applying the same range twice is idempotent.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const M = require('../src/multi-select')

const src = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8')
const handler = src.slice(
  src.indexOf('function _selHandleClick'),
  src.indexOf('\n}', src.indexOf('function _selHandleClick')))

test('the selection handler stops other listeners on the same element', () => {
  assert.ok(handler.includes('stopImmediatePropagation()'),
    'stopPropagation alone leaves same-element listeners running')
})

test('and marks the event so a re-entrant call cannot double-toggle', () => {
  assert.ok(/_papaSelHandled/.test(handler), 'needs a per-event guard')
  assert.ok(handler.indexOf('_papaSelHandled') < handler.indexOf('M.applyClick'),
    'the guard must come BEFORE applyClick, or it does not prevent the toggle')
})

test('double-applying a ctrl click is what cancelled the selection', () => {
  // Reproduces the old behaviour against the real module, to show the guard
  // is protecting against something concrete.
  const once = M.applyClick({ index: 1, ctrl: true, selected: [], anchor: null })
  assert.deepEqual(once.selected, [1])
  const twice = M.applyClick({ index: 1, ctrl: true, selected: once.selected, anchor: once.anchor })
  assert.deepEqual(twice.selected, [], 'second toggle clears it — the bug')
})

test('shift survives double-application, which is why only ctrl looked broken', () => {
  const a = M.applyClick({ index: 5, shift: true, selected: [], anchor: 3 })
  const b = M.applyClick({ index: 5, shift: true, selected: a.selected, anchor: a.anchor })
  assert.deepEqual(a.selected, b.selected)
})
