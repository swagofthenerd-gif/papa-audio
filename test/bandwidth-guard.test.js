'use strict'
// Instant-play A: the download cap that made peer playback impossible.
// The live finding this is written from (2026-09-20): a stored cap of 1 Mbps
// with the quality preference on 2160p. Nothing on screen said why every
// peer-backed play buffered forever.
const test = require('node:test')
const assert = require('node:assert')
const B = require('../src/bandwidth-guard')

test('the Mbps→bytes/s conversion is the one main.js has always used', () => {
  assert.equal(B.capBytesPerSec(1), 125000)
  assert.equal(B.capBytesPerSec(8), 1000000)
  assert.equal(B.capBytesPerSec(2.5), 312500)
})

test('null, zero, negative and nonsense all mean uncapped', () => {
  for (const v of [null, undefined, 0, -3, '', 'fast', NaN]) {
    assert.equal(B.capBytesPerSec(v), null, String(v) + ' should be uncapped')
    assert.equal(B.isCapped(v), false, String(v) + ' should not be capped')
  }
  assert.equal(B.isCapped(1), true)
})

test('an uncapped setting never produces a complaint', () => {
  const v = B.capVerdict({ capMbps: null, height: 2160 })
  assert.equal(v.ok, true)
  assert.equal(v.capped, false)
  assert.equal(v.message, null)
})

test('the live case: 1 Mbps against a 4K release is refused, with both numbers said out loud', () => {
  const v = B.capVerdict({ capMbps: 1, height: 2160 })
  assert.equal(v.ok, false)
  assert.equal(v.capped, true)
  assert.equal(v.neededMbps, 35)
  assert.match(v.message, /1 Mbps/)
  assert.match(v.message, /35 Mbps/)
  assert.match(v.next, /Settings → Video/)
})

test('a cap below the floor is refused even when nothing is known about the file', () => {
  const v = B.capVerdict({ capMbps: 1 })
  assert.equal(v.ok, false)
  assert.equal(v.neededMbps, null)
  assert.match(v.message, /too slow to watch/)
})

test('a generous cap passes, and says nothing', () => {
  const v = B.capVerdict({ capMbps: 50, height: 2160 })
  assert.equal(v.ok, true)
  assert.equal(v.capped, true)
  assert.equal(v.message, null)
})

test('a cap that clears the floor but not this file is still refused', () => {
  // 8 Mbps is a fine cap for 1080p and hopeless for 4K: the floor alone
  // would have waved this through.
  const v = B.capVerdict({ capMbps: 8, height: 2160 })
  assert.equal(v.ok, false)
  assert.equal(v.neededMbps, 35)
})

test('the file own average beats the table when size and runtime are known', () => {
  // A 1.4 GB, 24-minute episode is ~7.8 Mbps; with headroom, ~9.7.
  const needed = B.neededMbps({ bytes: 1.4e9, durationSec: 1440, height: 1080 })
  assert.ok(needed > 9 && needed < 10.5, 'got ' + needed)
  // A small file for its runtime needs less than the table would guess.
  const light = B.neededMbps({ bytes: 3e8, durationSec: 1440, height: 2160 })
  assert.ok(light < 3, 'got ' + light)
})

test('sustained rate is null when the numbers are missing or absurd', () => {
  assert.equal(B.sustainedMbps({ bytes: 0, durationSec: 100 }), null)
  assert.equal(B.sustainedMbps({ bytes: 1e9, durationSec: 0 }), null)
  assert.equal(B.sustainedMbps({}), null)
})

test('the one-time lift clears a cap that cannot stream, and stamps itself', () => {
  const r = B.migrateCap({ downloadLimitMbps: 1, preferredQuality: '2160p' })
  assert.equal(r.changed, true)
  assert.equal(r.from, 1)
  assert.equal(r.next.downloadLimitMbps, null)
  assert.equal(r.next.downloadLimitMigrated, B.MIGRATION_STAMP)
  // Every other setting survives untouched.
  assert.equal(r.next.preferredQuality, '2160p')
})

test('the lift never runs twice, and never overrides a deliberate choice', () => {
  const already = B.migrateCap({ downloadLimitMbps: 1, downloadLimitMigrated: '2026-09-20' })
  assert.equal(already.changed, false)
  const chosen = B.migrateCap({ downloadLimitMbps: 1, downloadLimitByUser: true })
  assert.equal(chosen.changed, false)
  assert.equal(chosen.next.downloadLimitMbps, 1)
})

test('the lift leaves an uncapped or a workable setting alone', () => {
  assert.equal(B.migrateCap({ downloadLimitMbps: null }).changed, false)
  assert.equal(B.migrateCap({}).changed, false)
  assert.equal(B.migrateCap({ downloadLimitMbps: 20 }).changed, false)
  // Exactly at the floor counts as workable.
  assert.equal(B.migrateCap({ downloadLimitMbps: B.STREAMABLE_FLOOR_MBPS }).changed, false)
})

test('the lift does not mutate the settings object handed to it', () => {
  const stored = { downloadLimitMbps: 1 }
  const r = B.migrateCap(stored)
  assert.equal(stored.downloadLimitMbps, 1, 'the input must be left alone')
  assert.notEqual(r.next, stored)
})

test('a junk settings blob is survivable', () => {
  assert.equal(B.migrateCap(null).changed, false)
  assert.equal(B.migrateCap(undefined).changed, false)
  assert.equal(B.migrateCap('nope').changed, false)
})

test('the release-list quality words become heights, and junk becomes nothing', () => {
  assert.equal(B.heightOfQuality('2160p'), 2160)
  assert.equal(B.heightOfQuality('1080P'), 1080)
  assert.equal(B.heightOfQuality(' 720p '), 720)
  for (const junk of ['CAM', 'unknown', '', null, undefined, '4K', 'p', 1080]) {
    assert.equal(B.heightOfQuality(junk), null, String(junk) + ' is not a height')
  }
})

test('a 4K source entry is refused against the stored 1 Mbps cap end to end', () => {
  const v = B.capVerdict({ capMbps: 1, height: B.heightOfQuality('2160p') })
  assert.equal(v.ok, false)
  assert.match(v.message, /35 Mbps/)
})
