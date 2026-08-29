'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { duration, size, bitrate, relativeDate, certification } = require('../src/video-format')

test('duration renders m:ss under an hour and h:mm:ss above', () => {
  assert.strictEqual(duration(443), '7:23')
  assert.strictEqual(duration(4043), '1:07:23')
  assert.strictEqual(duration(0), '0:00')
  assert.strictEqual(duration(59), '0:59')
  assert.strictEqual(duration(60), '1:00')
  assert.strictEqual(duration(3599), '59:59')
  assert.strictEqual(duration(3600), '1:00:00')
})

test('duration rounds and guards against non-numbers', () => {
  assert.strictEqual(duration(9.6), '0:10')
  assert.strictEqual(duration(null), '—')
  assert.strictEqual(duration(undefined), '—')
  assert.strictEqual(duration(''), '—')
  assert.strictEqual(duration('abc'), '—')
  assert.strictEqual(duration(-5), '0:00')
})

test('size formats bytes with one decimal above B', () => {
  assert.strictEqual(size(0), '0 B')
  assert.strictEqual(size(512), '512 B')
  assert.strictEqual(size(1024), '1.0 KB')
  assert.strictEqual(size(1536), '1.5 KB')
  assert.strictEqual(size(4.2 * 1024 * 1024 * 1024), '4.2 GB')
  assert.strictEqual(size(2.5 * 1024 * 1024), '2.5 MB')
  assert.strictEqual(size(1.5 * 1024 * 1024 * 1024 * 1024), '1.5 TB')
})

test('size guards against invalid input', () => {
  assert.strictEqual(size(null), '—')
  assert.strictEqual(size(undefined), '—')
  assert.strictEqual(size(-1), '—')
  assert.strictEqual(size('x'), '—')
})

test('bitrate uses decimal Mb/s and kb/s', () => {
  assert.strictEqual(bitrate(12400000), '12.4 Mb/s')
  assert.strictEqual(bitrate(800000), '800 kb/s')
  assert.strictEqual(bitrate(999), '999 b/s')
  assert.strictEqual(bitrate(null), '—')
  assert.strictEqual(bitrate('x'), '—')
})

test('relativeDate uses a stable, injectable now', () => {
  const now = new Date('2026-01-10T12:00:00Z').getTime()
  const ago = ms => new Date(now - ms).toISOString()
  assert.strictEqual(relativeDate(ago(30 * 1000), now), 'just now')
  assert.strictEqual(relativeDate(ago(5 * 60000), now), '5 minutes ago')
  assert.strictEqual(relativeDate(ago(60000), now), '1 minute ago')
  assert.strictEqual(relativeDate(ago(3 * 3600000), now), '3 hours ago')
  assert.strictEqual(relativeDate(ago(3 * 86400000), now), '3 days ago')
  assert.strictEqual(relativeDate(ago(1 * 86400000), now), '1 day ago')
  assert.strictEqual(relativeDate(ago(60 * 86400000), now), '2 months ago')
  assert.strictEqual(relativeDate(ago(400 * 86400000), now), '1 year ago')
})

test('relativeDate guards against invalid and future dates', () => {
  assert.strictEqual(relativeDate(null), '—')
  assert.strictEqual(relativeDate(''), '—')
  assert.strictEqual(relativeDate('not-a-date'), '—')
  assert.strictEqual(relativeDate('2026-01-01T00:00:00Z', new Date('2025-01-01T00:00:00Z').getTime()), 'just now')
})

test('certification prefers US theatrical, then GB, then null', () => {
  const releaseDates = {
    results: [
      {
        iso_3166_1: 'FR',
        release_dates: [{ certification: 'U', type: 3 }],
      },
      {
        iso_3166_1: 'US',
        release_dates: [
          { certification: 'PG', type: 3 },
          { certification: 'PG-13', type: 4 },
        ],
      },
    ],
  }
  // The type-4 re-rating must not shadow the theatrical type-3 rating.
  assert.strictEqual(certification(releaseDates), 'PG')
})

test('certification falls back to GB when the US is absent', () => {
  const releaseDates = {
    results: [
      { iso_3166_1: 'GB', release_dates: [{ certification: '15', type: 3 }] },
    ],
  }
  assert.strictEqual(certification(releaseDates), '15')
})

test('certification reads the TV content_ratings shape too', () => {
  const contentRatings = {
    results: [
      { iso_3166_1: 'US', rating: 'TV-MA' },
    ],
  }
  assert.strictEqual(certification(contentRatings), 'TV-MA')
})

test('certification returns null when nothing matches', () => {
  assert.strictEqual(certification(null), null)
  assert.strictEqual(certification({ results: [] }), null)
  assert.strictEqual(certification({ results: [{ iso_3166_1: 'JP', release_dates: [] }] }), null)
  assert.strictEqual(certification({}), null)
})
