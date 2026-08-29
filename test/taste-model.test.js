'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { buildAffinity } = require('../src/taste-model')

const NOW = Date.UTC(2026, 7, 29)
const day = 86400000

test('affinity rises with play count but is damped, so one obsession cannot dominate', () => {
  const a = buildAffinity({ playCounts: { '/a.flac': 2, '/b.flac': 40 }, history: [], now: NOW })
  assert.ok(a.get('/b.flac') > a.get('/a.flac'))
  // 20x the plays must not buy 20x the affinity
  assert.ok(a.get('/b.flac') < a.get('/a.flac') * 5)
})

test('a recent play outranks an old one at equal play count', () => {
  const a = buildAffinity({
    playCounts: { '/new.flac': 3, '/old.flac': 3 },
    history: [
      { filePath: '/new.flac', ts: NOW - 2 * day },
      { filePath: '/old.flac', ts: NOW - 400 * day },
    ],
    now: NOW,
  })
  assert.ok(a.get('/new.flac') > a.get('/old.flac'))
})

test('liked tracks are boosted', () => {
  // Include two tracks to show relative boost: when x is liked, the gap between x and y grows
  const base = buildAffinity({ playCounts: { '/x.flac': 3, '/y.flac': 2 }, history: [], now: NOW })
  const liked = buildAffinity({ playCounts: { '/x.flac': 3, '/y.flac': 2 }, history: [], likedTracks: ['/x.flac'], now: NOW })
  // When x is liked, y's normalized value drops because x's raw score increased, becoming the new max
  assert.ok(liked.get('/y.flac') < base.get('/y.flac'))
})

test('affinity stays within 0..1', () => {
  const a = buildAffinity({ playCounts: { '/x.flac': 9999 }, history: [], likedTracks: ['/x.flac'], now: NOW })
  assert.ok(a.get('/x.flac') <= 1 && a.get('/x.flac') > 0)
})

test('history written under the old timestamp key still counts', () => {
  const a = buildAffinity({
    playCounts: {},
    history: [{ filePath: '/legacy.flac', timestamp: NOW - day }],
    now: NOW,
  })
  assert.ok(a.get('/legacy.flac') > 0, 'legacy entry was dropped')
})

test('an unplayed track has no entry rather than a zero', () => {
  const a = buildAffinity({ playCounts: {}, history: [], now: NOW })
  assert.strictEqual(a.get('/never.flac'), undefined)
})

test('affinity spreads across a realistic range instead of saturating', () => {
  const pc = {}, hist = []
  ;[1, 2, 3, 5, 8, 15, 40].forEach((n, i) => {
    const p = `/t${n}.flac`
    pc[p] = n
    hist.push({ filePath: p, ts: NOW - (i + 1) * day })
  })
  const a = buildAffinity({ playCounts: pc, history: hist, now: NOW })
  const vals = [...a.values()]
  const distinct = new Set(vals.map(v => v.toFixed(6))).size
  assert.ok(distinct >= 6, `affinity collapsed: only ${distinct} distinct values across 7 play counts`)
  assert.ok(vals.filter(v => v >= 1).length === 1, 'exactly one track should sit at the top of the scale')
  assert.ok(a.get('/t40.flac') > a.get('/t2.flac'), '40 plays must outrank 2')
})
