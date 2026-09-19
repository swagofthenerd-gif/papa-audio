const test = require('node:test')
const assert = require('node:assert')
const R = require('../src/slsk-room-ui')

test('headerModel turns stats into ring slices that sum to 100', () => {
  const h = R.headerModel({ albums: 100, hiRes: 18, surround: 8, losslessPct: 71, tracks: 1000, size: 1e12 }, 'A 70s rock collector', { online: true, queue: 2 })
  const sum = h.ring.reduce((s, x) => s + x.pct, 0)
  assert.equal(sum, 100)
  assert.equal(h.ring[0].tier, 'hires')
  assert.equal(h.status, 'online now · 2 in their queue')
  assert.equal(h.line, 'A 70s rock collector')
})

test('modeKey is per peer and seeds from the old global key', () => {
  assert.equal(R.modeKey('Some User'), 'slsk_lib_mode:some user')
})

test('wander shelf order is fixed and empty shelves are dropped', () => {
  const shelves = R.wanderShelves({ goDeep: [], fresh: [1], because: [], onlyHere: null, decade: { decade: 1970, share: 40, albums: [1] }, surround: [], hires: [1] })
  assert.deepEqual(shelves.map(s => s.id), ['fresh', 'decade', 'hires'])
})
