'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { buildAffinity, buildColdSet, buildTransitions } = require('../src/taste-model')

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

test('cold set holds tracks played twice or more but not in 90 days', () => {
  const cold = buildColdSet({
    playCounts: { '/cold.flac': 5, '/warm.flac': 5, '/once.flac': 1 },
    history: [
      { filePath: '/cold.flac', ts: NOW - 200 * day },
      { filePath: '/warm.flac', ts: NOW - 3 * day },
      { filePath: '/once.flac', ts: NOW - 300 * day },
    ],
    now: NOW,
  })
  assert.ok(cold.has('/cold.flac'), 'old favourite should be cold')
  assert.ok(!cold.has('/warm.flac'), 'recent play is not cold')
  assert.ok(!cold.has('/once.flac'), 'a single play is not a favourite gone cold')
})

test('a track never played is not cold, it is unheard', () => {
  const cold = buildColdSet({ playCounts: { '/x.flac': 4 }, history: [], now: NOW })
  assert.ok(!cold.has('/x.flac'))
})

test('transitions record what actually followed what, as probabilities', () => {
  const trackArtist = new Map([['/p1.flac', 'Pink Floyd'], ['/p2.flac', 'Pink Floyd'], ['/y1.flac', 'Yes']])
  // normaliseHistory sorts newest first, so listening order here is y1 -> p2 -> p1
  const t = buildTransitions({
    history: [
      { filePath: '/p1.flac', ts: NOW },
      { filePath: '/p2.flac', ts: NOW - 1000 },
      { filePath: '/y1.flac', ts: NOW - 2000 },
    ],
    trackArtist,
  })
  const fromYes = t.get('Yes')
  assert.ok(fromYes, 'Yes should have an outgoing row')
  assert.strictEqual(fromYes.get('Pink Floyd'), 1)
})

test('each transition row sums to 1', () => {
  const trackArtist = new Map([['/a.flac', 'A'], ['/b.flac', 'B'], ['/c.flac', 'C']])
  const t = buildTransitions({
    history: [
      { filePath: '/c.flac', ts: NOW },
      { filePath: '/a.flac', ts: NOW - 1000 },
      { filePath: '/b.flac', ts: NOW - 2000 },
      { filePath: '/a.flac', ts: NOW - 3000 },
    ],
    trackArtist,
  })
  for (const [, row] of t) {
    const total = [...row.values()].reduce((s, v) => s + v, 0)
    assert.ok(Math.abs(total - 1) < 1e-9)
  }
})

test('transitions ignore a track whose artist is unknown', () => {
  const t = buildTransitions({
    history: [{ filePath: '/a.flac', ts: NOW }, { filePath: '/ghost.flac', ts: NOW - 1000 }],
    trackArtist: new Map([['/a.flac', 'A']]),
  })
  assert.strictEqual(t.size, 0)
})

test('buildTransitions uses the injected now, not the wall clock', () => {
  const trackArtist = new Map([['/a.flac', 'A'], ['/b.flac', 'B']])
  const history = [
    { filePath: '/b.flac', ts: NOW },
    { filePath: '/a.flac', ts: NOW - 1000 },
  ]

  // With a `now` at the entries' own time, both are valid and A->B is learned.
  const current = buildTransitions({ history, trackArtist, now: NOW })
  assert.strictEqual(current.get('A') && current.get('A').get('B'), 1)

  // With a `now` ten days earlier, the very same entries are more than a day in
  // the future, normaliseHistory rejects them, and nothing is learned. This is
  // the assertion that fails if the parameter is ignored -- the previous version
  // compared two identical calls and could not fail for that reason.
  const stale = buildTransitions({ history, trackArtist, now: NOW - 10 * day })
  assert.strictEqual(stale.size, 0, 'injected now was ignored: entries should have been rejected as future-dated')
})
