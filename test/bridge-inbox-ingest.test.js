'use strict'

// Executing tests for the desktop's bridge-inbox ingester
// (src/bridge-inbox-ingest.js).
//
// Nothing here reads source as text. Every test drives the real module against
// a real temp USER_DATA, with real SideStore instances from ../side-store.js and
// real ops written by the bridge's own ../bridge-server/inbox.js append(). The
// assertion is against what the BRIDGE's read overlay would have shown the
// phone — applyInbox over the same base — so the desktop landing a different
// value than the phone was told is a failure, not a matter of opinion.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ingest = require('../src/bridge-inbox-ingest')
const inbox = require('../bridge-server/inbox')
const { SideStore } = require('../side-store')

const tmps = []
function mkUserData() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-inbox-ingest-'))
  tmps.push(d)
  return d
}
test.after(() => {
  for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }) } catch (_) {} }
})

// The seven stores the ops can name, with the same fallbacks main.js gives them.
function makeStores(dir) {
  const mk = (name, fallback) => new SideStore({ dir, name, fallback, debounceMs: 5 })
  return {
    likedTracks:    mk('liked-tracks', []),
    playlists:      mk('playlists', []),
    playCounts:     mk('play-counts', {}),
    playHistory:    mk('play-history', []),
    savedQueues:    mk('saved-queues', []),
    recentlyPlayed: mk('recently-played', []),
    playbackState:  mk('playback-state', null),
  }
}

async function flushAll(stores) {
  for (const s of Object.values(stores)) await s.flush()
}

function readSideFile(dir, name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8')) }
  catch (_) { return fallback }
}

// ── 1. The desktop lands exactly what the phone was shown ────────────────────

test('every queued op is applied through the side stores, matching the bridge replay', async () => {
  const ud = mkUserData()
  const stores = makeStores(ud)

  // A base the desktop already holds, so the test covers merge and not just
  // "write the phone's value over an empty store".
  stores.playCounts.set({ '/music/a.flac': 3 })
  stores.playlists.set([{ id: 'pl-desktop', name: 'From the desktop', tracks: [] }])
  await flushAll(stores)
  const basePlayCounts = { '/music/a.flac': 3 }
  const basePlaylists = [{ id: 'pl-desktop', name: 'From the desktop', tracks: [] }]

  // Written by the bridge's own append(), not hand-rolled — a change to the op
  // shape has to break this test.
  inbox.append(ud, 'likedTracks.set', { paths: ['/music/a.flac', '/music/b.flac'] })
  inbox.append(ud, 'playCounts.increment', { filePath: '/music/a.flac' })
  inbox.append(ud, 'playCounts.increment', { filePath: '/music/b.flac' })
  inbox.append(ud, 'playlists.upsert', { playlist: { id: 'pl-phone', name: 'From the phone', tracks: [] } })
  inbox.append(ud, 'playlists.delete', { id: 'pl-desktop' })
  inbox.append(ud, 'playHistory.push', { entry: { path: '/music/b.flac', at: 1 } })
  inbox.append(ud, 'savedQueues.upsert', { queue: { id: 'q1', tracks: ['/music/a.flac'] } })
  inbox.append(ud, 'recentlyPlayed.push', { id: 'alb1' })
  inbox.append(ud, 'playbackState.set', { state: { path: '/music/b.flac', position: 42 } })
  const ops = inbox.readInbox(ud).ops.slice()

  const r = ingest.ingestOnce({ userData: ud, sideStores: stores, log: () => {} })
  assert.strictEqual(r.ops, 9, 'all nine ops should have been consumed')
  await flushAll(stores)

  // The oracle: what the bridge's read overlay was showing the phone.
  assert.deepStrictEqual(readSideFile(ud, 'liked-tracks', null),
    inbox.applyInbox('likedTracks', [], ops))
  assert.deepStrictEqual(readSideFile(ud, 'play-counts', null),
    inbox.applyInbox('playCounts', basePlayCounts, ops))
  assert.deepStrictEqual(readSideFile(ud, 'play-counts', null), { '/music/a.flac': 4, '/music/b.flac': 1 })
  assert.deepStrictEqual(readSideFile(ud, 'playlists', null),
    inbox.applyInbox('playlists', basePlaylists, ops))
  assert.deepStrictEqual(readSideFile(ud, 'play-history', null),
    inbox.applyInbox('playHistory', [], ops))
  assert.deepStrictEqual(readSideFile(ud, 'saved-queues', null),
    inbox.applyInbox('savedQueues', [], ops))
  assert.deepStrictEqual(readSideFile(ud, 'recently-played', null),
    inbox.applyInbox('recentlyPlayed', [], ops))
  assert.deepStrictEqual(readSideFile(ud, 'playback-state', null),
    inbox.applyInbox('playbackState', null, ops))

  // Consumed ops are gone from the inbox, and the watermark is durable.
  assert.deepStrictEqual(inbox.readInbox(ud).ops, [], 'the inbox should be drained')
  assert.strictEqual(ingest.readWatermark(ud), 9)
})

// The caps are part of the replay contract, not an implementation detail: the
// phone's list is already truncated, so a desktop that keeps everything shows a
// different history than the device it came from.
test('the 2000 / 30 / 20 caps survive the ingest', async () => {
  const ud = mkUserData()
  const stores = makeStores(ud)
  stores.playHistory.set(Array.from({ length: 2000 }, (_, i) => ({ at: i })))
  stores.savedQueues.set(Array.from({ length: 30 }, (_, i) => ({ id: `old${i}` })))
  stores.recentlyPlayed.set(Array.from({ length: 20 }, (_, i) => `old${i}`))
  await flushAll(stores)

  inbox.append(ud, 'playHistory.push', { entry: { at: 'new' } })
  inbox.append(ud, 'savedQueues.upsert', { queue: { id: 'new' } })
  inbox.append(ud, 'recentlyPlayed.push', { id: 'new' })
  ingest.ingestOnce({ userData: ud, sideStores: stores, log: () => {} })
  await flushAll(stores)

  const hist = readSideFile(ud, 'play-history', [])
  const queues = readSideFile(ud, 'saved-queues', [])
  const recent = readSideFile(ud, 'recently-played', [])
  assert.strictEqual(hist.length, 2000, 'play history must stay capped at 2000')
  assert.deepStrictEqual(hist[0], { at: 'new' })
  assert.strictEqual(queues.length, 30, 'saved queues must stay capped at 30')
  assert.strictEqual(queues[0].id, 'new')
  assert.strictEqual(recent.length, 20, 'recently played must stay capped at 20')
  assert.strictEqual(recent[0], 'new')
})

// ── 2. Idempotency ───────────────────────────────────────────────────────────
// This is the one that matters most: playCounts.increment is not idempotent, so
// a second pass over the same op is a silently wrong number, not a no-op.

test('a second ingest of the same queue changes nothing', async () => {
  const ud = mkUserData()
  const stores = makeStores(ud)

  inbox.append(ud, 'playCounts.increment', { filePath: '/music/a.flac' })
  inbox.append(ud, 'playCounts.increment', { filePath: '/music/a.flac' })
  inbox.append(ud, 'playHistory.push', { entry: { at: 1 } })

  ingest.ingestOnce({ userData: ud, sideStores: stores, log: () => {} })
  await flushAll(stores)
  const afterFirst = readSideFile(ud, 'play-counts', null)
  assert.deepStrictEqual(afterFirst, { '/music/a.flac': 2 })

  // Three more passes, including one against a freshly-constructed store set —
  // the real second run is a restarted app that has no memory of the first.
  ingest.ingestOnce({ userData: ud, sideStores: stores, log: () => {} })
  ingest.ingestOnce({ userData: ud, sideStores: stores, log: () => {} })
  await flushAll(stores)
  const restarted = makeStores(ud)
  ingest.ingestOnce({ userData: ud, sideStores: restarted, log: () => {} })
  await flushAll(restarted)

  assert.deepStrictEqual(readSideFile(ud, 'play-counts', null), { '/music/a.flac': 2 },
    'the play count was incremented again by a repeat ingest')
  assert.strictEqual(readSideFile(ud, 'play-history', []).length, 1,
    'the history entry was pushed twice')
})

// The watermark, not the emptiness of the file, is what makes a repeat safe. If
// ops are still sitting there (a truncation that never landed, a crash between
// the two writes) they must still be skipped.
test('ops left in the file after a failed truncation are not re-applied', async () => {
  const ud = mkUserData()
  const stores = makeStores(ud)
  inbox.append(ud, 'playCounts.increment', { filePath: '/music/a.flac' })
  ingest.ingestOnce({ userData: ud, sideStores: stores, log: () => {} })
  await flushAll(stores)

  // Put the consumed op back, exactly as a lost truncation would leave it.
  const state = inbox.readInbox(ud)
  state.ops = [{ seq: 1, at: Date.now(), type: 'playCounts.increment', payload: { filePath: '/music/a.flac' } }]
  fs.writeFileSync(path.join(ud, inbox.INBOX_FILE), JSON.stringify(state), 'utf8')

  ingest.ingestOnce({ userData: ud, sideStores: stores, log: () => {} })
  await flushAll(stores)
  assert.deepStrictEqual(readSideFile(ud, 'play-counts', null), { '/music/a.flac': 1 },
    'an op below the watermark was applied a second time')
})

// ── 3. A bridge append during the ingest must not be lost ────────────────────
// The real window is between the snapshot read and the truncating rename, which
// is exactly where the side-store writes happen. Appending from inside one of
// those writes reproduces it honestly rather than by reaching into internals.

test('an op the bridge appends mid-ingest survives the truncation', async () => {
  const ud = mkUserData()
  const stores = makeStores(ud)

  inbox.append(ud, 'playCounts.increment', { filePath: '/music/a.flac' })

  const realUpdate = stores.playCounts.update.bind(stores.playCounts)
  let fired = false
  stores.playCounts.update = (fn) => {
    const out = realUpdate(fn)
    if (!fired) {
      fired = true
      // The bridge, in its own process, records a like while we are applying.
      inbox.append(ud, 'likedTracks.set', { paths: ['/music/late.flac'] })
    }
    return out
  }

  ingest.ingestOnce({ userData: ud, sideStores: stores, log: () => {} })
  await flushAll(stores)
  assert.ok(fired, 'the mid-ingest append never ran; the test proves nothing')

  const left = inbox.readInbox(ud).ops
  assert.strictEqual(left.length, 1, 'the op appended during the ingest was truncated away')
  assert.strictEqual(left[0].type, 'likedTracks.set')
  assert.strictEqual(left[0].payload.paths[0], '/music/late.flac')
  // And it is still above the watermark, so the next pass picks it up.
  assert.ok(left[0].seq > ingest.readWatermark(ud))

  stores.playCounts.update = realUpdate
  ingest.ingestOnce({ userData: ud, sideStores: stores, log: () => {} })
  await flushAll(stores)
  assert.deepStrictEqual(readSideFile(ud, 'liked-tracks', null), ['/music/late.flac'])
  assert.deepStrictEqual(readSideFile(ud, 'play-counts', null), { '/music/a.flac': 1 },
    'the first op was applied twice by the follow-up pass')
})

// ── 4. A corrupt inbox is quarantined, not swallowed ─────────────────────────

test('an unreadable inbox is kept aside and the app keeps going', async () => {
  const ud = mkUserData()
  const stores = makeStores(ud)
  const file = path.join(ud, inbox.INBOX_FILE)
  fs.writeFileSync(file, '{"version":1,"seq":3,"ops":[{"seq"', 'utf8')

  const logged = []
  const r = ingest.ingestOnce({ userData: ud, sideStores: stores, log: m => logged.push(m) })
  assert.strictEqual(r.quarantined, true)
  assert.strictEqual(fs.existsSync(file), false, 'the corrupt inbox was left in place')
  const kept = fs.readdirSync(ud).filter(f => f.startsWith(`${inbox.INBOX_FILE}.corrupt-`))
  assert.strictEqual(kept.length, 1, 'the corrupt inbox was not kept for recovery')
  assert.strictEqual(fs.readFileSync(path.join(ud, kept[0]), 'utf8'), '{"version":1,"seq":3,"ops":[{"seq"',
    'the quarantined copy must be the original bytes')
  assert.ok(logged.some(m => /unreadable/.test(m)), 'the corruption was not reported')

  // And the bridge can start a clean queue afterwards, which then ingests.
  inbox.append(ud, 'likedTracks.set', { paths: ['/music/a.flac'] })
  ingest.ingestOnce({ userData: ud, sideStores: stores, log: () => {} })
  await flushAll(stores)
  assert.deepStrictEqual(readSideFile(ud, 'liked-tracks', null), ['/music/a.flac'])
})

test('a file whose JSON parses but has no ops array is treated as corrupt', () => {
  const ud = mkUserData()
  const stores = makeStores(ud)
  fs.writeFileSync(path.join(ud, inbox.INBOX_FILE), JSON.stringify({ version: 1, seq: 2 }), 'utf8')
  const r = ingest.ingestOnce({ userData: ud, sideStores: stores, log: () => {} })
  assert.strictEqual(r.quarantined, true)
  assert.strictEqual(fs.readdirSync(ud).filter(f => f.includes('.corrupt-')).length, 1)
})

test('no inbox at all is not an error', () => {
  const ud = mkUserData()
  const stores = makeStores(ud)
  const r = ingest.ingestOnce({ userData: ud, sideStores: stores, log: () => {} })
  assert.strictEqual(r.applied, 0)
  assert.strictEqual(r.quarantined, false)
  assert.strictEqual(fs.readdirSync(ud).filter(f => f.includes('corrupt')).length, 0)
})

// ── The running ingester ─────────────────────────────────────────────────────

test('start() drains on the interval and stop() drains once more on the way out', async () => {
  const ud = mkUserData()
  const stores = makeStores(ud)
  inbox.append(ud, 'likedTracks.set', { paths: ['/music/first.flac'] })

  ingest.start({ userData: ud, sideStores: stores, intervalMs: 20, log: () => {} })
  try {
    // The first pass is deferred to setImmediate on purpose (main.js runs the
    // legacy-key migration after this call), so it has not happened yet.
    assert.strictEqual(ingest.readWatermark(ud), 0, 'the first pass must not run inline')
    const deadline = Date.now() + 5000
    while (ingest.readWatermark(ud) < 1 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10))
    }
    assert.strictEqual(ingest.readWatermark(ud), 1, 'the timer never drained the inbox')

    // Something arrives between the last tick and the quit.
    inbox.append(ud, 'likedTracks.set', { paths: ['/music/last.flac'] })
  } finally {
    ingest.stop()
  }
  await flushAll(stores)
  assert.deepStrictEqual(readSideFile(ud, 'liked-tracks', null), ['/music/last.flac'],
    'stop() did not drain the last ops before quit')

  // And stop() really stopped: a further append is not picked up.
  inbox.append(ud, 'likedTracks.set', { paths: ['/music/after-quit.flac'] })
  await new Promise(r => setTimeout(r, 120))
  assert.strictEqual(inbox.readInbox(ud).ops.length, 1, 'the ingester kept running after stop()')
})

// ── The config.json keys ─────────────────────────────────────────────────────
//
// likedAlbums, followedArtists, volume, eqSettings and agentModel never left
// config.json. The bridge used to write them there with its own electron-store
// while the desktop's `conf` rewrites that whole file on every set(): two
// writers, no lock, last one wins — and the bridge's writer has no
// `configFileMode`, so its write also widened the desktop's 0600 file. They now
// come through the inbox and land here, through the desktop's own store.

const Store = require('electron-store')

// The desktop's store, opened exactly as main.js opens it.
function makeStore(dir) {
  return new Store({ cwd: dir, name: 'config', configFileMode: 0o600 })
}
const cfgPath = dir => path.join(dir, 'config.json')
const cfgMode = dir => fs.statSync(cfgPath(dir)).mode & 0o777

test('the settings keys are applied through the desktop store, matching the bridge replay', async () => {
  const ud = mkUserData()
  const stores = makeStores(ud)
  const store = makeStore(ud)

  // A base the desktop already holds, so this covers "merge onto what is
  // there", not just "write onto empty".
  store.set('likedAlbums', ['alb-desktop'])
  store.set('volume', 0.8)
  fs.chmodSync(cfgPath(ud), 0o600)

  inbox.append(ud, 'likedAlbums.set', { ids: ['alb-phone-1', 'alb-phone-2'] })
  inbox.append(ud, 'followedArtists.set', { artists: ['Aphex Twin'] })
  inbox.append(ud, 'volume.set', { volume: 0.42 })
  inbox.append(ud, 'eqSettings.set', { settings: { enabled: false, gains: [1,0,0,0,0,0,0,0,0,0], preamp: 2 } })
  inbox.append(ud, 'agentModel.set', { model: 'gpt-4o-mini' })
  const ops = inbox.readInbox(ud).ops.slice()

  const r = ingest.ingestOnce({ userData: ud, sideStores: stores, store, log: () => {} })
  assert.strictEqual(r.ops, 5, 'all five settings ops should have been consumed')

  // The oracle again: what the bridge's read overlay showed the phone.
  const onDisk = JSON.parse(fs.readFileSync(cfgPath(ud), 'utf8'))
  assert.deepStrictEqual(onDisk.likedAlbums, inbox.applyInbox('likedAlbums', ['alb-desktop'], ops))
  assert.deepStrictEqual(onDisk.followedArtists, inbox.applyInbox('followedArtists', [], ops))
  assert.strictEqual(onDisk.volume, inbox.applyInbox('volume', 0.8, ops))
  assert.deepStrictEqual(onDisk.eqSettings, inbox.applyInbox('eqSettings', null, ops))
  assert.strictEqual(onDisk.agentModel, inbox.applyInbox('agentModel', '', ops))

  assert.strictEqual(cfgMode(ud), 0o600, 'the ingest widened the desktop’s 0600 config.json')

  // Consumed: the inbox is drained and the watermark moved.
  assert.strictEqual(inbox.readInbox(ud).ops.length, 0)
  assert.strictEqual(ingest.readWatermark(ud), ops[ops.length - 1].seq)
})

test('a settings op is never applied twice (volume does not bounce back)', async () => {
  const ud = mkUserData()
  const stores = makeStores(ud)
  const store = makeStore(ud)
  store.set('volume', 0.8)

  inbox.append(ud, 'volume.set', { volume: 0.3 })
  ingest.ingestOnce({ userData: ud, sideStores: stores, store, log: () => {} })
  assert.strictEqual(store.get('volume'), 0.3)

  // The desktop then changes it itself. A second pass must not re-apply the
  // phone's op over the newer desktop value.
  store.set('volume', 0.9)
  ingest.ingestOnce({ userData: ud, sideStores: stores, store, log: () => {} })
  assert.strictEqual(store.get('volume'), 0.9,
    'an already-ingested op was replayed over a newer desktop value')
})

test('a settings op with no store stays queued rather than being dropped', async () => {
  const ud = mkUserData()
  const stores = makeStores(ud)

  inbox.append(ud, 'likedAlbums.set', { ids: ['alb-phone'] })
  const r = ingest.ingestOnce({ userData: ud, sideStores: stores, log: () => {} })

  assert.strictEqual(r.partial, true, 'the pass claimed success with nowhere to put the op')
  assert.strictEqual(ingest.readWatermark(ud), 0,
    'the watermark moved past an op that was never applied')
  assert.strictEqual(inbox.readInbox(ud).ops.length, 1,
    'the op was truncated away without being applied')
})

test('side-store ops and settings ops in one batch both land', async () => {
  const ud = mkUserData()
  const stores = makeStores(ud)
  const store = makeStore(ud)

  inbox.append(ud, 'likedTracks.set', { paths: ['/music/a.flac'] })
  inbox.append(ud, 'likedAlbums.set', { ids: ['alb-phone'] })

  const r = ingest.ingestOnce({ userData: ud, sideStores: stores, store, log: () => {} })
  assert.strictEqual(r.ops, 2)
  await flushAll(stores)

  assert.deepStrictEqual(readSideFile(ud, 'liked-tracks', null), ['/music/a.flac'])
  assert.deepStrictEqual(store.get('likedAlbums'), ['alb-phone'])
})

test('every settings key the bridge can queue has somewhere on the desktop to land', () => {
  // The two lists are maintained in different files. If an op type is added to
  // the bridge and not here, the ingester logs "unknown key" and the phone's
  // change is silently truncated away — the exact failure this whole path
  // exists to prevent.
  const known = new Set([...Object.keys(ingest.OP_KEY_TO_STORE), ...Object.keys(ingest.OP_KEY_TO_CONFIG)])
  const orphans = [...inbox.OP_TYPES]
    .map(t => t.split('.')[0])
    .filter(k => !known.has(k))
  assert.deepStrictEqual([...new Set(orphans)], [],
    'the bridge can queue an op the desktop ingester cannot apply')
})
