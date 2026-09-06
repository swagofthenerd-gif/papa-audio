'use strict'
const test = require('node:test')
const assert = require('node:assert')
const bs = require('../src/backup-schedule')

const DAY = 24 * 60 * 60 * 1000

test('interval 0 is off — never due', () => {
  assert.strictEqual(bs.isBackupDue({ intervalDays: 0, lastBackupAt: 0, now: 9e12 }), false)
  assert.strictEqual(bs.isBackupDue({ intervalDays: 0, lastBackupAt: 1, now: 9e12 }), false)
})

test('an enabled schedule that has never run is due immediately', () => {
  assert.strictEqual(bs.isBackupDue({ intervalDays: 7, lastBackupAt: 0, now: 1000 }), true)
})

test('due only once a full interval has elapsed', () => {
  const last = 10_000_000_000
  assert.strictEqual(
    bs.isBackupDue({ intervalDays: 7, lastBackupAt: last, now: last + 6 * DAY }), false)
  assert.strictEqual(
    bs.isBackupDue({ intervalDays: 7, lastBackupAt: last, now: last + 7 * DAY }), true)
})

test('staleBackups keeps the newest KEEP and returns the rest oldest-first', () => {
  // ISO-stamped names sort chronologically as strings.
  const names = [
    'papa-backup-2026-01-01.json',
    'papa-backup-2026-02-01.json',
    'papa-backup-2026-03-01.json',
    'papa-backup-2026-04-01.json',
    'papa-backup-2026-05-01.json',
    'papa-backup-2026-06-01.json',
    'papa-backup-2026-07-01.json',
  ]
  const stale = bs.staleBackups(names, 5)
  assert.deepStrictEqual(stale, [
    'papa-backup-2026-01-01.json',
    'papa-backup-2026-02-01.json',
  ], 'the two oldest of seven are pruned when keeping five')
})

test('staleBackups is order-independent', () => {
  const shuffled = [
    'papa-backup-2026-07-01.json',
    'papa-backup-2026-01-01.json',
    'papa-backup-2026-04-01.json',
    'papa-backup-2026-02-01.json',
    'papa-backup-2026-06-01.json',
    'papa-backup-2026-03-01.json',
    'papa-backup-2026-05-01.json',
  ]
  const stale = bs.staleBackups(shuffled, 5)
  assert.deepStrictEqual(stale, [
    'papa-backup-2026-01-01.json',
    'papa-backup-2026-02-01.json',
  ])
})

test('staleBackups prunes nothing at or under the cap', () => {
  assert.deepStrictEqual(bs.staleBackups(['a', 'b', 'c'], 5), [])
  assert.deepStrictEqual(bs.staleBackups([], 5), [])
})

test('the default keep is five', () => {
  assert.strictEqual(bs.KEEP, 5)
  const many = Array.from({ length: 8 }, (_, i) => `papa-backup-2026-0${i + 1}-01.json`)
  assert.strictEqual(bs.staleBackups(many).length, 3, 'eight minus the default five')
})
