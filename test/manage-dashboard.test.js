'use strict'
const test = require('node:test')
const assert = require('node:assert')
const D = require('../src/manage-dashboard')

test('a clean library scores 100', () => {
  assert.equal(D.healthScore([]), 100)
})

test('findings dock the score by severity', () => {
  const one = D.healthScore([{ severity: 'high', count: 1 }])
  const clean = 100
  assert.ok(one < clean, 'a high-severity finding lowers the score')
  const low = D.healthScore([{ severity: 'low', count: 1 }])
  assert.ok(low > one, 'a low-severity finding docks less than a high one')
})

test('score is clamped to 0..100', () => {
  const s = D.healthScore(Array.from({ length: 50 }, () => ({ severity: 'high', count: 9999 })))
  assert.ok(s >= 0 && s <= 100)
})

test('a big finding does not zero the score alone (diminishing)', () => {
  const s = D.healthScore([{ severity: 'medium', count: 500 }])
  assert.ok(s > 0, 'one finding, however large, leaves a positive score')
})

test('healthLabel bands', () => {
  assert.equal(D.healthLabel(95), 'Healthy')
  assert.equal(D.healthLabel(75), 'Minor issues')
  assert.equal(D.healthLabel(50), 'Needs attention')
  assert.equal(D.healthLabel(10), 'Poor')
})

test('buildDashboard with no inputs marks every card unavailable', () => {
  const dash = D.buildDashboard({})
  assert.equal(dash.health.available, false)
  assert.equal(dash.storage.available, false)
  assert.equal(dash.duplicates.available, false)
  assert.equal(dash.genres.available, false)
  assert.equal(dash.trash.available, false)
})

test('buildDashboard folds each tool result into its card', () => {
  const dash = D.buildDashboard({
    storage: { totalBytes: 500e9, formats: [{ format: 'FLAC', bytes: 400e9, tracks: 2000 }, { format: 'MP3', bytes: 100e9, tracks: 400 }] },
    duplicates: { groups: [{}, {}, {}], reclaimBytes: 12e9 },
    health: { findings: [{ severity: 'medium', count: 3 }] },
    genres: { groups: [{ variants: [{}, {}] }, { variants: [{}] }], ungenred: 7 },
    trash: { items: [{}, {}], totalBytes: 3e9 },
  })
  assert.equal(dash.storage.available, true)
  assert.equal(dash.storage.totalBytes, 500e9)
  assert.equal(dash.storage.formats.length, 2)
  assert.equal(dash.duplicates.groupCount, 3)
  assert.equal(dash.duplicates.reclaimBytes, 12e9)
  assert.equal(dash.health.available, true)
  assert.ok(dash.health.score < 100)
  assert.equal(dash.genres.variantCount, 1, 'only groups with >1 spelling count as variants')
  assert.equal(dash.genres.missingCount, 7)
  assert.equal(dash.trash.itemCount, 2)
  assert.equal(dash.trash.bytes, 3e9)
})

test('health input accepts a bare findings array too', () => {
  const dash = D.buildDashboard({ health: [{ severity: 'low', count: 1 }] })
  assert.equal(dash.health.available, true)
  assert.equal(dash.health.findingCount, 1)
})
