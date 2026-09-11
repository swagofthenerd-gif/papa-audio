'use strict'
// V2.1: episode rows carry what a wall of numbers could not.
const test = require('node:test')
const assert = require('node:assert')
const EL = require('../src/episode-list')

const eps = [
  { episodeNumber: 1, name: 'Pilot', overview: 'It begins.', still: 's1.jpg', airDate: '2024-03-01', runtime: 48 },
  { episodeNumber: 2, name: 'The Bathtub', overview: 'A bath.', still: '', airDate: '2024-03-08', runtime: 61 },
  { episodeNumber: 3, name: null, overview: null, airDate: '2099-01-02' },
]
const prog = { items: { 1: { watched: true, ratio: 0.98, position: 2800, duration: 2880 }, 2: { watched: false, ratio: 0.5, position: 1830, duration: 3660 } }, resume: { episode: 2 } }

test('rows: title, date, runtime, watched tick, bar and left, up-next and current', () => {
  const r = EL.rows(eps, prog, 1, Date.UTC(2025, 0, 1))
  assert.equal(r.length, 3)
  assert.equal(r[0].title, 'Pilot'); assert.equal(r[0].date, '1 Mar 2024'); assert.equal(r[0].runtime, '48m')
  assert.ok(r[0].watched && r[0].pct === 0 && r[0].current && !r[0].upNext)
  assert.equal(r[1].runtime, '1h 01m'); assert.equal(r[1].pct, 50); assert.equal(r[1].left, 1830); assert.ok(r[1].upNext && !r[1].watched)
  assert.equal(r[2].title, 'Episode 3'); assert.equal(r[2].date, 'Airs 2 Jan 2099'); assert.ok(r[2].unaired); assert.equal(r[2].runtime, '')
})

test('next-up comes from prog.next when nothing is mid-way; junk is safe', () => {
  const r = EL.rows(eps, { items: {}, next: { episode: 3 } }, 9)
  assert.ok(r[2].upNext && !r[0].upNext)
  assert.deepEqual(EL.rows(null, null, null), [])
  assert.equal(EL.dateLabel('soon'), ''); assert.equal(EL.runtimeLabel(NaN), '')
})
