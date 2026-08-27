'use strict'
const test = require('node:test')
const assert = require('node:assert')
const H = require('../history')

const NOW = Date.UTC(2026, 7, 27, 12, 0, 0)
const day = n => NOW - n * 86400000

// The reported shape: newest entries use `ts`, older ones still use `timestamp`
// after a rename that had no migration. Every entry has a valid time.
function realWorldHistory() {
  const out = []
  for (let i = 0; i < 626; i++) out.push({ filePath: `/m/new${i}.flac`, title: `n${i}`, ts: day(i * 0.03) })
  for (let i = 0; i < 598; i++) out.push({ filePath: `/m/old${i}.flac`, title: `o${i}`, timestamp: day(24 + i * 0.05) })
  return out
}

// ── Item 91: the migration ───────────────────────────────────────────────────

test('entries keyed on timestamp are recovered, not discarded', () => {
  // An earlier report called these corrupt and proposed dropping the tail. That
  // would have destroyed two months of real listening.
  const r = H.normaliseHistory(realWorldHistory(), { now: NOW })
  assert.strictEqual(r.total, 1224, 'every entry must survive')
  assert.strictEqual(r.renamed, 598)
  assert.strictEqual(r.alreadyOk, 626)
  assert.strictEqual(r.quarantined.length, 0)
  assert.ok(r.entries.every(e => typeof e.ts === 'number'), 'every reader looks at ts')
})

test('the old key is removed only after its value is in the new one', () => {
  const r = H.normaliseHistory([{ filePath: '/m/a.flac', timestamp: day(30) }], { now: NOW })
  assert.strictEqual(r.entries[0].ts, day(30))
  assert.ok(!('timestamp' in r.entries[0]), 'two keys for one fact is what caused this')
})

test('the rest of the entry is left alone', () => {
  const r = H.normaliseHistory([
    { filePath: '/m/a.flac', title: 'A', artist: 'B', album: 'C', duration: 192, artPath: '/x.jpg', timestamp: day(30) },
  ], { now: NOW })
  const e = r.entries[0]
  assert.strictEqual(e.title, 'A')
  assert.strictEqual(e.duration, 192)
  assert.strictEqual(e.artPath, '/x.jpg')
})

test('ts wins when both keys are present and both are sane', () => {
  const r = H.normaliseHistory([{ filePath: '/m/a.flac', ts: day(1), timestamp: day(50) }], { now: NOW })
  assert.strictEqual(r.entries[0].ts, day(1))
})

test('a legacy key is used when ts is present but unusable', () => {
  for (const bad of [undefined, null, 0, NaN, 'yesterday', -1]) {
    const r = H.normaliseHistory([{ filePath: '/m/a.flac', ts: bad, timestamp: day(50) }], { now: NOW })
    assert.strictEqual(r.entries.length, 1, `ts=${bad} should fall back to timestamp`)
    assert.strictEqual(r.entries[0].ts, day(50))
  }
})

test('an entry with no usable time is quarantined, never deleted', () => {
  const r = H.normaliseHistory([
    { filePath: '/m/good.flac', ts: day(1) },
    { filePath: '/m/bad.flac' },
    { filePath: '/m/alsobad.flac', ts: 'nonsense', timestamp: null },
    null,
  ], { now: NOW })
  assert.strictEqual(r.total, 1)
  assert.strictEqual(r.quarantined.length, 3, 'kept aside, so the call stays reversible')
  assert.ok(r.quarantined.every(q => 'reason' in q && 'entry' in q))
})

test('a clock far in the future or before this app existed is not trusted', () => {
  const r = H.normaliseHistory([
    { filePath: '/m/a.flac', ts: Date.UTC(1994, 0, 1) },
    { filePath: '/m/b.flac', ts: NOW + 40 * 86400000 },
    { filePath: '/m/c.flac', ts: NOW + 3600000 },   // an hour ahead is fine
  ], { now: NOW })
  assert.strictEqual(r.total, 1)
  assert.strictEqual(r.entries[0].filePath, '/m/c.flac')
  assert.strictEqual(r.quarantined.length, 2)
})

test('a history that needs nothing reports no change, so startup writes nothing', () => {
  const clean = [{ filePath: '/m/a.flac', ts: day(1) }, { filePath: '/m/b.flac', ts: day(2) }]
  const r = H.normaliseHistory(clean, { now: NOW })
  assert.strictEqual(r.changed, false)
  assert.strictEqual(r.renamed, 0)
})

test('the migration reports the range it recovered', () => {
  const r = H.normaliseHistory(realWorldHistory(), { now: NOW })
  assert.ok(r.oldest < r.newest)
  // The oldest entry is in the legacy-keyed tail, which is the point.
  assert.ok(r.oldest < day(24), 'the recovered tail must extend the range')
})

test('nonsense input does not throw', () => {
  for (const bad of [null, undefined, 'x', 42, {}]) {
    assert.doesNotThrow(() => H.normaliseHistory(bad))
    assert.deepStrictEqual(H.normaliseHistory(bad).entries, [])
  }
})

test('sorting puts newest first, which is what every reader assumes', () => {
  const sorted = H.sortNewestFirst([{ ts: day(5) }, { ts: day(1) }, { ts: day(9) }])
  assert.deepStrictEqual(sorted.map(e => e.ts), [day(1), day(5), day(9)])
})

// ── Item 93: reconciliation, which reports rather than rewrites ──────────────

test('reconcile finds plays that were counted but never recorded', () => {
  // A 12-track album listened gaplessly recorded one history entry and twelve
  // play counts. That is the shape being detected.
  const history = [{ filePath: '/m/01.flac', ts: day(1) }]
  const counts = {}
  for (let i = 1; i <= 12; i++) counts[`/m/${String(i).padStart(2, '0')}.flac`] = 1
  const r = H.reconcile(history, counts)
  assert.strictEqual(r.countedTotal, 12)
  assert.strictEqual(r.historyTotal, 1)
  assert.strictEqual(r.missingFromHistory, 11)
  assert.strictEqual(r.disagreeing, 11)
})

test('reconcile also reports history with no matching count', () => {
  const r = H.reconcile([{ filePath: '/m/x.flac', ts: day(1) }, { filePath: '/m/x.flac', ts: day(2) }], {})
  assert.strictEqual(r.extraInHistory, 2)
  assert.strictEqual(r.historyTotal, 2)
})

test('reconcile agrees when the two agree', () => {
  const history = [{ filePath: '/m/a.flac', ts: day(1) }, { filePath: '/m/a.flac', ts: day(2) }]
  const r = H.reconcile(history, { '/m/a.flac': 2 })
  assert.strictEqual(r.disagreeing, 0)
  assert.strictEqual(r.missingFromHistory, 0)
  assert.strictEqual(r.extraInHistory, 0)
})

test('reconcile changes nothing it is given', () => {
  // It must not rewrite either side: which one is right is not its call.
  const history = [{ filePath: '/m/a.flac', ts: day(1) }]
  const counts = { '/m/a.flac': 5 }
  const historyCopy = JSON.parse(JSON.stringify(history))
  const countsCopy = { ...counts }
  H.reconcile(history, counts)
  assert.deepStrictEqual(history, historyCopy)
  assert.deepStrictEqual(counts, countsCopy)
})

test('reconcile survives junk', () => {
  for (const [h, c] of [[null, null], ['x', 3], [[{}], { a: 'b' }], [[null], {}]]) {
    assert.doesNotThrow(() => H.reconcile(h, c))
  }
})

// ── Item 96: the cap archives instead of dropping ────────────────────────────

test('under the cap nothing is split off', () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ ts: day(i) }))
  const { keep, overflow } = H.splitForArchive(entries, 2000)
  assert.strictEqual(keep.length, 10)
  assert.strictEqual(overflow.length, 0)
})

test('over the cap the oldest are handed to the archive, not dropped', () => {
  const entries = Array.from({ length: 2100 }, (_, i) => ({ ts: day(i * 0.01) }))
  const { keep, overflow } = H.splitForArchive(entries, 2000)
  assert.strictEqual(keep.length, 2000)
  assert.strictEqual(overflow.length, 100)
  assert.strictEqual(keep.length + overflow.length, entries.length, 'nothing may be lost')
})

test('the archive is grouped by month', () => {
  const overflow = [
    { ts: Date.UTC(2026, 5, 25) }, { ts: Date.UTC(2026, 5, 26) },
    { ts: Date.UTC(2026, 6, 2) },
    { ts: NaN },
  ]
  const byMonth = H.groupForArchive(overflow)
  assert.strictEqual(byMonth.get('2026-06').length, 2)
  assert.strictEqual(byMonth.get('2026-07').length, 1)
  assert.strictEqual(byMonth.get('undated').length, 1, 'even an unusable time gets a home')
})
