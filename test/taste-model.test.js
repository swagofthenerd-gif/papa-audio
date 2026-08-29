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
  const base = buildAffinity({ playCounts: { '/x.flac': 3 }, history: [], now: NOW })
  const liked = buildAffinity({ playCounts: { '/x.flac': 3 }, history: [], likedTracks: ['/x.flac'], now: NOW })
  assert.ok(liked.get('/x.flac') > base.get('/x.flac'))
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
