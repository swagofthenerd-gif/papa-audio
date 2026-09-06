'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { DEFAULTS, currentLimitKbps, limitToBytesPerSec, _isDayHour } =
  require('../src/bandwidth-schedule')

// `now` is a local Date so the hour used by currentLimitKbps is unambiguous.
const at = (h) => new Date(2026, 8, 10, h, 0, 0)

test('a disabled schedule never caps, whatever the time', () => {
  const s = { enabled: false, dayLimitKbps: 500, nightLimitKbps: 0, dayStartHour: 8, nightStartHour: 23 }
  assert.strictEqual(currentLimitKbps(s, at(12)), null)
  assert.strictEqual(currentLimitKbps(s, at(2)), null)
})

test('day hours use the day limit, night hours use the night limit', () => {
  const s = { enabled: true, dayLimitKbps: 500, nightLimitKbps: 5000, dayStartHour: 8, nightStartHour: 23 }
  assert.strictEqual(currentLimitKbps(s, at(9)), 500)    // mid-day → day cap
  assert.strictEqual(currentLimitKbps(s, at(23)), 5000)  // 23:00 → night cap
  assert.strictEqual(currentLimitKbps(s, at(2)), 5000)   // 02:00 (wrapped) → night
  assert.strictEqual(currentLimitKbps(s, at(7)), 5000)   // just before day opens
  assert.strictEqual(currentLimitKbps(s, at(8)), 500)    // day opens exactly at 8
})

test('a zero or null band limit means uncapped for that band', () => {
  // Throttle by day, wide open at night — the roadmap's headline use case.
  const s = { enabled: true, dayLimitKbps: 800, nightLimitKbps: 0, dayStartHour: 8, nightStartHour: 22 }
  assert.strictEqual(currentLimitKbps(s, at(12)), 800)
  assert.strictEqual(currentLimitKbps(s, at(23)), null)  // night band uncapped
})

test('the night window wraps past midnight when nightStart > dayStart', () => {
  // day 06..21, night 21..06 (wrapping). Both edges and the wrap are checked.
  assert.strictEqual(_isDayHour(6, 6, 21), true)
  assert.strictEqual(_isDayHour(20, 6, 21), true)
  assert.strictEqual(_isDayHour(21, 6, 21), false)  // night opens at 21
  assert.strictEqual(_isDayHour(0, 6, 21), false)   // still night after midnight
  assert.strictEqual(_isDayHour(5, 6, 21), false)
})

test('a day window that itself wraps midnight (dayStart > nightStart)', () => {
  // night 02..09, day 09..02 (day wraps midnight). Unusual but must be coherent.
  assert.strictEqual(_isDayHour(10, 9, 2), true)
  assert.strictEqual(_isDayHour(23, 9, 2), true)
  assert.strictEqual(_isDayHour(1, 9, 2), true)     // day wraps past midnight
  assert.strictEqual(_isDayHour(2, 9, 2), false)    // night opens at 2
  assert.strictEqual(_isDayHour(8, 9, 2), false)
})

test('defaults fill in missing fields and hold the pipe open', () => {
  assert.strictEqual(DEFAULTS.enabled, false)
  // Enabled with nothing else set → both bands default to 0 (uncapped).
  assert.strictEqual(currentLimitKbps({ enabled: true }, at(12)), null)
})

test('an out-of-range start hour falls back to the default hour', () => {
  const s = { enabled: true, dayLimitKbps: 300, nightLimitKbps: 3000, dayStartHour: 99, nightStartHour: 23 }
  // dayStartHour 99 is invalid → falls back to the default 8, so 09:00 is day.
  assert.strictEqual(currentLimitKbps(s, at(9)), 300)
})

test('limitToBytesPerSec converts kbps (kilobytes/s) to bytes/s, null stays null', () => {
  assert.strictEqual(limitToBytesPerSec(500), 500000)
  assert.strictEqual(limitToBytesPerSec(null), null)
  assert.strictEqual(limitToBytesPerSec(0), null)
})
