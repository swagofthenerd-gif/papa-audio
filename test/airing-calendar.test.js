'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { dayKey, daysInMonth, bucketMonth } = require('../src/airing-calendar')

// Rows are the shape main's _mergeAiring produces: { key, title, episode, airsAt,
// type } with airsAt in epoch MILLISECONDS. Local midnight of a given day is
// constructed the same way _mergeAiring anchors TMDB day strings, so the tests
// are timezone-independent: new Date(y, m-1, d) is local.
const localMs = (y, m, d, h = 0) => new Date(y, m - 1, d, h).getTime()

test('daysInMonth handles month lengths incl. leap February', () => {
  assert.strictEqual(daysInMonth(2026, 9), 30)   // September
  assert.strictEqual(daysInMonth(2026, 2), 28)   // non-leap Feb
  assert.strictEqual(daysInMonth(2024, 2), 29)   // leap Feb
  assert.strictEqual(daysInMonth(2026, 1), 31)
})

test('dayKey renders the LOCAL calendar day of an epoch-ms timestamp', () => {
  assert.strictEqual(dayKey(localMs(2026, 9, 10, 13)), '2026-09-10')
})

test('bucketMonth returns a complete month with every day present', () => {
  const cal = bucketMonth([], 2026, 9)
  assert.strictEqual(cal.year, 2026)
  assert.strictEqual(cal.month, 9)
  assert.strictEqual(cal.days.length, 30)
  assert.strictEqual(cal.days[0].day, 1)
  assert.strictEqual(cal.days[0].date, '2026-09-01')
  assert.strictEqual(cal.days[29].date, '2026-09-30')
  assert.strictEqual(cal.total, 0)
})

test('bucketMonth places each row in its local-day cell, soonest-first', () => {
  const rows = [
    { key: 'tv:1', title: 'B', episode: 4, airsAt: localMs(2026, 9, 10, 20), type: 'tv' },
    { key: 'anime:2', title: 'A', episode: 12, airsAt: localMs(2026, 9, 10, 9), type: 'anime' },
    { key: 'tv:3', title: 'C', episode: 1, airsAt: localMs(2026, 9, 25, 12), type: 'tv' },
  ]
  const cal = bucketMonth(rows, 2026, 9)
  const d10 = cal.days.find(d => d.day === 10)
  const d25 = cal.days.find(d => d.day === 25)
  assert.strictEqual(d10.entries.length, 2)
  assert.strictEqual(d25.entries.length, 1)
  // Input order within a day is preserved (main pre-sorts soonest-first).
  assert.deepStrictEqual(d10.entries.map(e => e.title), ['B', 'A'])
  assert.strictEqual(cal.total, 3)
})

test('bucketMonth drops rows outside the requested month or with no time', () => {
  const rows = [
    { key: 'tv:1', title: 'In', episode: 1, airsAt: localMs(2026, 9, 5), type: 'tv' },
    { key: 'tv:2', title: 'NextMonth', episode: 1, airsAt: localMs(2026, 10, 5), type: 'tv' },
    { key: 'tv:3', title: 'NoTime', episode: 1, airsAt: 0, type: 'tv' },
    { key: 'tv:4', title: 'Garbage', episode: 1, airsAt: NaN, type: 'tv' },
  ]
  const cal = bucketMonth(rows, 2026, 9)
  assert.strictEqual(cal.total, 1)
  assert.strictEqual(cal.days.find(d => d.day === 5).entries[0].title, 'In')
})

test('bucketMonth tags entries with isFollowed from the followed key set', () => {
  const rows = [
    { key: 'anime:2', title: 'Followed', episode: 1, airsAt: localMs(2026, 9, 3), type: 'anime' },
    { key: 'tv:9', title: 'NotFollowed', episode: 1, airsAt: localMs(2026, 9, 4), type: 'tv' },
  ]
  const followed = new Set(['anime:2'])
  const cal = bucketMonth(rows, 2026, 9, { followed })
  const followedEntry = cal.days.find(d => d.day === 3).entries[0]
  const otherEntry = cal.days.find(d => d.day === 4).entries[0]
  assert.strictEqual(followedEntry.isFollowed, true)
  assert.strictEqual(otherEntry.isFollowed, false)
  assert.strictEqual(cal.followedTotal, 1)
  assert.strictEqual(cal.total, 2)
})

test('bucketMonth accepts a followed Array as well as a Set', () => {
  const rows = [{ key: 'tv:1', title: 'X', episode: 1, airsAt: localMs(2026, 9, 2), type: 'tv' }]
  const cal = bucketMonth(rows, 2026, 9, { followed: ['tv:1'] })
  assert.strictEqual(cal.days.find(d => d.day === 2).entries[0].isFollowed, true)
})

test('bucketMonth rejects an invalid month with an empty (zero-day) shape', () => {
  const cal = bucketMonth([{ key: 'tv:1', airsAt: Date.now(), type: 'tv' }], 2026, 13)
  assert.strictEqual(cal.days.length, 0)
  assert.strictEqual(cal.total, 0)
})
