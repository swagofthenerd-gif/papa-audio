'use strict'
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const fs = require('fs')

const m = require('../src/tracker-list')

const DAY = 24 * 60 * 60 * 1000

// ── Validation ───────────────────────────────────────────────────────────────

test('isValidTracker accepts udp/http/https and rejects everything else', () => {
  assert.ok(m.isValidTracker('udp://tracker.opentrackr.org:1337/announce'))
  assert.ok(m.isValidTracker('http://x.org/announce'))
  assert.ok(m.isValidTracker('https://x.org:443/announce'))
  assert.ok(!m.isValidTracker('wss://x.org'))
  assert.ok(!m.isValidTracker('ws://x.org'))
  assert.ok(!m.isValidTracker('garbage'))
  assert.ok(!m.isValidTracker(''))
  assert.ok(!m.isValidTracker(null))
})

test('parseTrackerList drops junk, dedupes, and caps at MAX_TRACKERS', () => {
  const lines = []
  for (let i = 0; i < 50; i++) lines.push(`udp://t${i}.org:1337/announce`)
  const text = ['# a comment', '', 'not-a-url', 'udp://dup.org:1/announce', 'udp://dup.org:1/announce', ...lines].join('\n')
  const out = m.parseTrackerList(text)
  assert.strictEqual(out.length, m.MAX_TRACKERS, 'capped')
  assert.ok(!out.includes('not-a-url'))
  // Dedup: dup appears once.
  assert.strictEqual(out.filter(u => u === 'udp://dup.org:1/announce').length, 1)
})

test('parseTrackerList on junk-only returns [] (caller treats as failed refresh)', () => {
  assert.deepStrictEqual(m.parseTrackerList('# only comments\n\nnonsense'), [])
  assert.deepStrictEqual(m.parseTrackerList(''), [])
  assert.deepStrictEqual(m.parseTrackerList(null), [])
})

test('validateList returns null for empty/corrupt, cleaned array otherwise', () => {
  assert.strictEqual(m.validateList([]), null)
  assert.strictEqual(m.validateList(['garbage']), null)
  assert.strictEqual(m.validateList(null), null)
  assert.deepStrictEqual(m.validateList(['udp://a.org:1/announce', 'garbage']), ['udp://a.org:1/announce'])
})

test('mergeAnnounce keeps the magnet trackers first, dedupes, caps', () => {
  const magnet = ['udp://own.org:1/announce']
  const curated = ['udp://own.org:1/announce', 'udp://c.org:2/announce']
  const out = m.mergeAnnounce(magnet, curated)
  assert.strictEqual(out[0], 'udp://own.org:1/announce', 'magnet trackers lead')
  assert.strictEqual(out.filter(u => u === 'udp://own.org:1/announce').length, 1, 'deduped')
  assert.ok(out.includes('udp://c.org:2/announce'))
})

// ── Staleness ────────────────────────────────────────────────────────────────

test('isRefreshDue: never-refreshed is due, then weekly', () => {
  const now = 30 * DAY
  assert.strictEqual(m.isRefreshDue({ lastRefreshAt: 0, now }), true)
  assert.strictEqual(m.isRefreshDue({ lastRefreshAt: now - 6 * DAY, now }), false)
  assert.strictEqual(m.isRefreshDue({ lastRefreshAt: now - 7 * DAY, now }), true)
})

// ── Exec layer ───────────────────────────────────────────────────────────────

function memStore(initial = null) {
  let v = initial
  return { get: () => v, set: x => { v = x } }
}

test('current() serves the default list before any refresh', () => {
  const tl = new m.TrackerList({ store: memStore(null) })
  const cur = tl.current()
  assert.ok(cur.length > 0)
  assert.deepStrictEqual(cur, m.DEFAULT_TRACKERS.slice())
})

test('refresh() persists a fresh list and stamps lastRefreshAt', async () => {
  const store = memStore(null)
  const text = 'udp://fresh1.org:1/announce\nudp://fresh2.org:2/announce\n'
  const tl = new m.TrackerList({
    store,
    nowFn: () => 5000,
    fetchFn: async () => ({ ok: true, status: 200, text: async () => text }),
  })
  const r = await tl.refresh({ force: true })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.count, 2)
  assert.strictEqual(store.get().lastRefreshAt, 5000)
  assert.deepStrictEqual(tl.current(), ['udp://fresh1.org:1/announce', 'udp://fresh2.org:2/announce'])
})

test('refresh() failure leaves last-good in place and does not stamp the clock', async () => {
  const store = memStore({ trackers: ['udp://good.org:1/announce'], lastRefreshAt: 1000 })
  const tl = new m.TrackerList({
    store,
    nowFn: () => 9999,
    fetchFn: async () => { throw new Error('offline') },
  })
  const r = await tl.refresh({ force: true })
  assert.strictEqual(r.ok, false)
  // last-good untouched; clock not advanced so the next tick retries.
  assert.strictEqual(store.get().lastRefreshAt, 1000)
  assert.deepStrictEqual(tl.current(), ['udp://good.org:1/announce'])
})

test('refresh() rejecting a junk-only body keeps the last-good list', async () => {
  const store = memStore({ trackers: ['udp://good.org:1/announce'], lastRefreshAt: 1000 })
  const tl = new m.TrackerList({
    store,
    fetchFn: async () => ({ ok: true, status: 200, text: async () => '# nothing valid\ngarbage' }),
  })
  const r = await tl.refresh({ force: true })
  assert.strictEqual(r.ok, false)
  assert.deepStrictEqual(tl.current(), ['udp://good.org:1/announce'])
})

test('announceFor merges the curated list into a magnet announce', () => {
  const tl = new m.TrackerList({ store: memStore({ trackers: ['udp://c.org:1/announce'], lastRefreshAt: 1 }) })
  const out = tl.announceFor(['udp://own.org:9/announce'])
  assert.strictEqual(out[0], 'udp://own.org:9/announce')
  assert.ok(out.includes('udp://c.org:1/announce'))
})

// ── Wiring ───────────────────────────────────────────────────────────────────

const root = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

test('main merges the curated announce into both torrent add sites', () => {
  const main = root('main.js')
  assert.match(main, /new TrackerList\(/)
  assert.match(main, /function _mergedAnnounce/)
  // download add
  assert.match(main, /announce: _mergedAnnounce\(null\)/)
  // streamer injection
  assert.match(main, /announceFn: _mergedAnnounce/)
})

test('torrent-stream applies the injected announceFn', () => {
  const ts = root('torrent-stream.js')
  assert.match(ts, /this\._announceFn/)
  assert.match(ts, /addOpts\.announce = announce/)
})
