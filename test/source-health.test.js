'use strict'
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const fs = require('fs')

const m = require('../src/source-health')
const providers = require('../providers/index')

const DAY = 24 * 60 * 60 * 1000

// ── Record update ────────────────────────────────────────────────────────────

test('applyResult: success resets the streak and stamps lastOkAt', () => {
  const r = m.applyResult({ ok: false, failStreak: 3, lastOkAt: null }, true, 100)
  assert.deepStrictEqual(r, { ok: true, lastOkAt: 100, lastCheckAt: 100, failStreak: 0 })
})

test('applyResult: failure increments the streak and preserves lastOkAt', () => {
  const r = m.applyResult({ ok: true, failStreak: 0, lastOkAt: 50 }, false, 100)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.failStreak, 1)
  assert.strictEqual(r.lastOkAt, 50, 'a fail must not erase the last success')
  assert.strictEqual(r.lastCheckAt, 100)
})

test('applyResult: a missing prior record starts neutral', () => {
  assert.strictEqual(m.applyResult(null, false, 10).failStreak, 1)
  assert.strictEqual(m.applyResult(undefined, true, 10).ok, true)
})

// ── Tiebreak key + ordering ──────────────────────────────────────────────────

test('healthKey: unknown and ok are neutral (0), failing is its streak', () => {
  assert.strictEqual(m.healthKey({}, 'x'), 0)
  assert.strictEqual(m.healthKey({ x: { ok: true, failStreak: 0 } }, 'x'), 0)
  assert.strictEqual(m.healthKey({ x: { ok: false, failStreak: 4 } }, 'x'), 4)
})

test('orderByPersistedHealth is a stable tiebreak that never drops a name', () => {
  const names = ['A', 'B', 'C']
  const health = { B: { ok: false, failStreak: 5 } }   // B is unhealthy
  const out = m.orderByPersistedHealth(names, health)
  assert.deepStrictEqual(out, ['A', 'C', 'B'], 'the failing source sinks; the rest keep order')
  assert.strictEqual(out.length, 3)
})

test('statusRows maps records to traffic-light statuses', () => {
  const rows = m.statusRows({
    good: { ok: true, failStreak: 0, lastCheckAt: 10, lastOkAt: 10 },
    bad: { ok: false, failStreak: m.RED_STREAK, lastCheckAt: 10 },
    flaky: { ok: false, failStreak: 1, lastCheckAt: 10 },
    fresh: { ok: false, failStreak: 0, lastCheckAt: 0 },
  }, 100)
  const by = Object.fromEntries(rows.map(r => [r.name, r.status]))
  assert.strictEqual(by.good, 'green')
  assert.strictEqual(by.bad, 'red')
  assert.strictEqual(by.flaky, 'amber')
  assert.strictEqual(by.fresh, 'unknown')
})

// ── Staleness ────────────────────────────────────────────────────────────────

test('isCheckDue: never-run is due, then every 3 days', () => {
  const now = 30 * DAY
  assert.strictEqual(m.isCheckDue({ lastRunAt: 0, now }), true)
  assert.strictEqual(m.isCheckDue({ lastRunAt: now - 2 * DAY, now }), false)
  assert.strictEqual(m.isCheckDue({ lastRunAt: now - 3 * DAY, now }), true)
})

// ── Store (persistence) ──────────────────────────────────────────────────────

function memStore(initial = null) {
  let v = initial
  return { get: () => v, set: x => { v = x } }
}

test('SourceHealthStore.recordBatch persists and stamps lastRunAt', () => {
  const store = memStore(null)
  const s = new m.SourceHealthStore({ store, nowFn: () => 7000 })
  s.recordBatch({ YTS: true, EZTV: false })
  const saved = store.get()
  assert.strictEqual(saved.lastRunAt, 7000)
  assert.strictEqual(saved.sources.YTS.ok, true)
  assert.strictEqual(saved.sources.EZTV.ok, false)
  assert.strictEqual(saved.sources.EZTV.failStreak, 1)
})

test('SourceHealthStore.due reflects lastRunAt', () => {
  const s = new m.SourceHealthStore({ store: memStore({ sources: {}, lastRunAt: 0 }), nowFn: () => 10 * DAY })
  assert.strictEqual(s.due(), true)
  s.recordBatch({ X: true })
  // Just recorded (nowFn stamped it), so not due immediately after.
  assert.strictEqual(s.due(), false)
})

test('SourceHealthStore.rows exposes panel data', () => {
  const s = new m.SourceHealthStore({ store: memStore(null), nowFn: () => 100 })
  s.recordBatch({ YTS: true, EZTV: false })
  const rows = s.rows()
  const by = Object.fromEntries(rows.map(r => [r.name, r.status]))
  assert.strictEqual(by.YTS, 'green')
  assert.strictEqual(by.EZTV, 'amber')
})

// ── Router integration: the tiebreak + onSweep hook ──────────────────────────

test('orderBackendsByHealth uses persisted health as a tiebreak beneath session', () => {
  providers._resetSourceHealth()
  const A = () => []; A.sourceName = 'A'
  const B = () => []; B.sourceName = 'B'
  const C = () => []; C.sourceName = 'C'
  // No session history yet → all session-equal. Persisted marks B unhealthy.
  const persisted = { B: { ok: false, failStreak: 9 } }
  const ordered = providers.orderBackendsByHealth([A, B, C], persisted).map(x => x.name)
  assert.deepStrictEqual(ordered, ['A', 'C', 'B'], 'B sinks by persisted health')
})

test('resolveStream calls onSweep with per-source results and allZero', async () => {
  providers._resetSourceHealth()
  const good = () => [{ magnet: 'magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', quality: '1080p' }]
  good.sourceName = 'Good'
  const empty = () => []
  empty.sourceName = 'Empty'
  let sweepArg = null
  await providers.resolveStream({}, [good, empty], { onSweep: s => { sweepArg = s } })
  assert.ok(sweepArg, 'onSweep fired')
  assert.strictEqual(sweepArg.results.Good, true)
  assert.strictEqual(sweepArg.results.Empty, false)
  assert.strictEqual(sweepArg.allZero, false, 'one source produced, so not all-zero')
})

test('resolveStream reports allZero when every backend comes back empty', async () => {
  providers._resetSourceHealth()
  const e1 = () => []; e1.sourceName = 'E1'
  const e2 = () => []; e2.sourceName = 'E2'
  let sweepArg = null
  await providers.resolveStream({}, [e1, e2], { onSweep: s => { sweepArg = s } })
  assert.strictEqual(sweepArg.allZero, true)
})

test('a throwing onSweep never breaks a search', async () => {
  providers._resetSourceHealth()
  const s = () => [{ magnet: 'magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', quality: '720p' }]
  s.sourceName = 'S'
  const out = await providers.resolveStream({}, [s], { onSweep: () => { throw new Error('boom') } })
  assert.ok(Array.isArray(out), 'the search still returns its ranked results')
})

// ── Wiring ───────────────────────────────────────────────────────────────────

const root = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

test('main threads persisted health and the sweep hook into resolveStream', () => {
  const main = root('main.js')
  assert.match(main, /new SourceHealthStore\(/)
  assert.match(main, /persistedHealth: _persistedSourceHealth\(\)/)
  assert.match(main, /onSweep: _onSearchSweep/)
  assert.match(main, /function _runSourceCanary/)
  assert.match(main, /ipcMain\.handle\('sources-canary-now'/)
})
