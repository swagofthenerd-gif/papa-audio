'use strict'

// Drain the bridge's phone-mutation queue into the desktop's side stores.
//
// The LAN bridge (bridge-server/) must not write the SideStore files: the
// desktop is their single writer, and two processes rewriting the same file
// with no locking is how a like and a play count destroy each other. So a
// phone-side mutation is appended to <USER_DATA>/bridge-inbox.json instead
// (bridge-server/inbox.js), and the bridge's read routes replay the queue on
// top of the desktop's value so the phone sees its own action immediately.
//
// Nothing on the desktop read that file. The mutations were durable and
// visible to the phone, but never merged into the desktop's copy — a like made
// on the phone stayed a phone-only like forever. This is the missing half.
//
// The contract, in one place:
//
//   * ONE WRITER PER STORE. The desktop writes the side stores AND config.json;
//     this module is the desktop. The bridge writes the inbox; this module only
//     ever TRUNCATES it, and only ops it has already applied.
//   * The settings keys that never left config.json (likedAlbums,
//     followedArtists, volume, eqSettings, agentModel) come through here too.
//     The bridge used to write them into config.json with its own
//     electron-store instance while `conf` rewrites that whole file on every
//     set(): last writer won and the other change vanished, and the bridge's
//     write dropped the desktop's 0600 mode. They are applied through the
//     desktop's own `store` below, so config.json has exactly one writer.
//   * The replay semantics are not reimplemented here. `applyInbox` is required
//     straight out of bridge-server/inbox.js, so the value the phone was shown
//     by the read overlay and the value the desktop lands on disk come from the
//     same function and cannot drift.
//   * `lastIngestedSeq` lives in a SIBLING file, bridge-inbox.state.json, not in
//     the inbox itself. The bridge rewrites the whole inbox object on every
//     append, so a watermark stored inside it can be clobbered by an append that
//     started before our write and finished after it. In the sibling file the
//     bridge cannot touch it, which makes the watermark — the thing that makes
//     re-application impossible — the durable part. A lost truncation then costs
//     nothing but a re-read: every op at or below the watermark is skipped.
//   * The watermark is persisted BEFORE the truncation, never after. A crash
//     between the two leaves ops in the file that are already applied, and the
//     seq guard drops them on the next pass. The other order would re-apply
//     them, and `playCounts.increment` is not idempotent.

const fs = require('fs')
const path = require('path')

const { applyInbox, INBOX_FILE } = require('../bridge-server/inbox')

const STATE_FILE = 'bridge-inbox.state.json'
const DEFAULT_INTERVAL_MS = 30000
// fs.watch fires several times for one atomic rename (the tmp write, the
// rename, sometimes a spurious 'change'). Coalesce them.
const WATCH_DEBOUNCE_MS = 500

// op key -> the `sideStores` entry that owns that value. An op naming anything
// else is skipped rather than guessed at; the bridge refuses unknown types at
// write time, so this only fires if the two lists drift.
const OP_KEY_TO_STORE = {
  likedTracks: 'likedTracks',
  playlists: 'playlists',
  playCounts: 'playCounts',
  playHistory: 'playHistory',
  savedQueues: 'savedQueues',
  recentlyPlayed: 'recentlyPlayed',
  playbackState: 'playbackState',
}

// op key -> the config.json key and the default to merge onto when the desktop
// has never set it. These are the keys that stayed in config.json; the desktop
// store is their single writer and this is where the phone's version of them
// lands. The fallbacks mirror main.js's own reads so an ingest cannot invent a
// different default than the app uses.
const OP_KEY_TO_CONFIG = {
  likedAlbums:     { key: 'likedAlbums', fallback: [] },
  followedArtists: { key: 'followedArtists', fallback: [] },
  volume:          { key: 'volume', fallback: 0.8 },
  eqSettings:      { key: 'eqSettings', fallback: { enabled: true, gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], replayGainMode: 'track', preamp: 0 } },
  agentModel:      { key: 'agentModel', fallback: '' },
}

function inboxPath(userData) { return path.join(userData, INBOX_FILE) }
function statePath(userData) { return path.join(userData, STATE_FILE) }

// Read the inbox, telling "not there yet" apart from "there and unreadable".
// The bridge's own readInbox() swallows both into an empty queue, which is the
// right answer for serving a request and the wrong one here: a corrupt file has
// to be quarantined, not silently treated as empty and then truncated over.
function readInboxStrict(userData) {
  let raw
  try {
    raw = fs.readFileSync(inboxPath(userData), 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return { state: null, corrupt: false }
    return { state: null, corrupt: true, reason: (e && e.code) || (e && e.message) }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { state: null, corrupt: true, reason: (e && e.message) || 'unparseable' }
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.ops)) {
    return { state: null, corrupt: true, reason: 'no ops array' }
  }
  return { state: parsed, corrupt: false }
}

function readWatermark(userData) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(userData), 'utf8'))
    const n = parsed && parsed.lastIngestedSeq
    return typeof n === 'number' && isFinite(n) ? n : 0
  } catch (_) {
    // Absent or unreadable: start from zero. The cost of being wrong here is
    // re-applying ops the bridge has since dropped, which is why the watermark
    // is written before the truncation and not after.
    return 0
  }
}

// Atomic, same discipline as SideStore and the bridge's own writer: tmp beside
// the file, then rename, so a crash mid-write cannot leave a torn watermark.
function writeWatermark(userData, seq) {
  const file = statePath(userData)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, lastIngestedSeq: seq, at: Date.now() }), 'utf8')
  fs.renameSync(tmp, file)
}

// Move an unreadable inbox aside rather than deleting it or overwriting it.
// Whatever survived in it is still there to be recovered by hand; the same rule
// SideStore applies to its own files.
function quarantine(userData, reason, log) {
  const file = inboxPath(userData)
  let kept = null
  try {
    kept = `${file}.corrupt-${Date.now()}`
    fs.renameSync(file, kept)
  } catch (_) { kept = null }
  log(`[papa][inbox] bridge-inbox.json unreadable (${reason}); starting empty` +
    (kept ? `. The unreadable file was kept at ${kept}` : ''))
  return kept
}

// Rewrite the inbox with `keep` as its ops, guarding against a bridge append
// that landed while we were applying.
//
// The guard is a re-read immediately before the rename: if the file on disk has
// grown a higher seq than the snapshot we consumed, the ops above the watermark
// are recomputed from the FRESH file, so the new append survives the truncation
// instead of being written over by our stale copy.
function truncateInbox(userData, consumedSeq, snapshotSeq) {
  const file = inboxPath(userData)
  const fresh = readInboxStrict(userData)
  // Vanished or turned corrupt under us: leave it alone. The watermark is
  // already durable, so nothing gets re-applied either way.
  if (!fresh.state) return { written: false, kept: 0 }
  const keep = fresh.state.ops.filter(op => op && typeof op.seq === 'number' && op.seq > consumedSeq)
  const next = Object.assign({}, fresh.state, { ops: keep })
  // The bridge derives the next seq from `state.seq`, so it must never go
  // backwards — a reset would make it re-issue seq numbers this module has
  // already consumed and the guard would then drop live ops.
  next.seq = Math.max(fresh.state.seq || 0, snapshotSeq || 0, consumedSeq || 0)
  const tmp = `${file}.ingest-tmp`
  fs.writeFileSync(tmp, JSON.stringify(next), 'utf8')
  fs.renameSync(tmp, file)
  return { written: true, kept: keep.length }
}

// One pass: read, apply everything above the watermark through the real side
// stores, persist the new watermark, truncate. Synchronous on purpose — the
// side stores' own writes are async and coalesced, so the only I/O on the
// thread here is one small read and two small writes, and doing it in one shot
// removes every interleaving question with the bridge's appends.
//
// Returns a small report so the tests (and the caller's log) can see what
// happened without reaching into the file.
function ingestOnce({ userData, sideStores, store, log = () => {} } = {}) {
  if (!userData || !sideStores) throw new Error('ingestOnce needs userData and sideStores')

  const read = readInboxStrict(userData)
  if (read.corrupt) {
    quarantine(userData, read.reason, log)
    return { applied: 0, lastSeq: readWatermark(userData), quarantined: true }
  }
  const state = read.state
  if (!state) return { applied: 0, lastSeq: readWatermark(userData), quarantined: false }

  const watermark = readWatermark(userData)
  const fresh = state.ops.filter(op =>
    op && typeof op.seq === 'number' && op.seq > watermark && typeof op.type === 'string')
  if (!fresh.length) {
    // Nothing new. Still worth truncating if the file is carrying ops that are
    // all already applied — otherwise a bridge that never appends again leaves
    // them there forever and every pass re-filters them.
    if (state.ops.length) {
      try { truncateInbox(userData, watermark, state.seq || 0) } catch (_) { /* next pass */ }
    }
    return { applied: 0, lastSeq: watermark, quarantined: false }
  }

  const consumedSeq = fresh.reduce((m, op) => Math.max(m, op.seq), watermark)

  // Which stores this batch actually touches. Applying a key with no ops would
  // still dirty its store and cost a pointless write.
  const keys = new Set()
  const configKeys = new Set()
  for (const op of fresh) {
    const key = String(op.type).split('.')[0]
    if (OP_KEY_TO_STORE[key]) keys.add(key)
    else if (OP_KEY_TO_CONFIG[key]) configKeys.add(key)
    else log(`[papa][inbox] skipping op with unknown key: ${op.type}`)
  }

  let applied = 0
  for (const key of keys) {
    const side = sideStores[OP_KEY_TO_STORE[key]]
    if (!side) { log(`[papa][inbox] no side store for ${key}; its ops stay queued`); continue }
    try {
      // update() is a read-modify-write against the store's in-memory value, so
      // this can never race the store's own writer. applyInbox filters by key
      // and never mutates the base it is handed.
      side.update(prev => applyInbox(key, prev, fresh))
      applied++
    } catch (e) {
      log(`[papa][inbox] applying ${key} failed (${(e && e.message) || e}); its ops stay queued`)
      // One store failing must not advance the watermark past ops it never
      // took, so this pass stops here and the next one retries from the same
      // point. Nothing is truncated.
      return { applied, lastSeq: watermark, quarantined: false, partial: true }
    }
  }

  // The config.json keys. Same read-modify-write shape, through the desktop's
  // electron-store — which is the only thing in the system allowed to write
  // that file.
  for (const key of configKeys) {
    if (!store) {
      // Started without a store (a caller that only cares about side stores).
      // The ops stay queued rather than being dropped on the floor, and the
      // watermark must not move past them, so this pass ends here.
      log(`[papa][inbox] no config store available for ${key}; its ops stay queued`)
      return { applied, lastSeq: watermark, quarantined: false, partial: true }
    }
    const spec = OP_KEY_TO_CONFIG[key]
    try {
      const base = store.get(spec.key, spec.fallback)
      const next = applyInbox(key, base, fresh)
      // An op whose payload was unusable leaves the base untouched; writing it
      // back anyway would rewrite the whole 0600 file for nothing.
      if (next !== base) store.set(spec.key, next)
      applied++
    } catch (e) {
      log(`[papa][inbox] applying ${key} failed (${(e && e.message) || e}); its ops stay queued`)
      return { applied, lastSeq: watermark, quarantined: false, partial: true }
    }
  }

  // Watermark first (see the header): the crash window between these two must
  // leave applied ops UNAPPLIABLE, not re-appliable.
  try {
    writeWatermark(userData, consumedSeq)
  } catch (e) {
    log(`[papa][inbox] could not persist lastIngestedSeq (${(e && e.message) || e}); not truncating`)
    return { applied, lastSeq: watermark, quarantined: false, partial: true }
  }
  let kept = 0
  try {
    kept = truncateInbox(userData, consumedSeq, state.seq || 0).kept
  } catch (e) {
    log(`[papa][inbox] truncating the inbox failed (${(e && e.message) || e}); the watermark still holds`)
  }
  log(`[papa][inbox] ingested ${fresh.length} phone op(s) up to seq ${consumedSeq}` +
    (kept ? `, ${kept} newer op(s) kept` : ''))
  return { applied, ops: fresh.length, lastSeq: consumedSeq, kept, quarantined: false }
}

// ── The running ingester ──────────────────────────────────────────────────────
let _timer = null
let _watcher = null
let _watchTimer = null
let _ctx = null

function _run() {
  if (!_ctx) return
  try {
    ingestOnce(_ctx)
  } catch (e) {
    // A failure here must never take the app down; the next tick retries.
    try { _ctx.log(`[papa][inbox] ingest pass failed (${(e && e.message) || e})`) } catch (_) {}
  }
}

function start({ userData, sideStores, store, intervalMs = DEFAULT_INTERVAL_MS, log } = {}) {
  if (!userData || !sideStores) throw new Error('bridge-inbox-ingest needs userData and sideStores')
  stop()
  _ctx = { userData, sideStores, store, log: log || (m => { try { console.log(m) } catch (_) {} }) }

  // The first pass is deferred to the next tick rather than run inline. This
  // module is started from main.js's module body, right after `sideStores` is
  // built and BEFORE retireLegacyKeys() runs — and that migration only adopts a
  // legacy config value when the side FILE does not exist yet. Writing here
  // first would not create the file (SideStore writes are debounced), but the
  // in-memory value would be replaced by the legacy one a few lines later and
  // the phone's ops would be silently undone. setImmediate puts the first pass
  // after the whole synchronous startup block, migration included.
  setImmediate(_run)

  _timer = setInterval(_run, intervalMs)
  _timer.unref?.()

  // The interval alone means up to 30 s between a phone like and the desktop
  // seeing it. A watch makes it near-instant when the platform supports one,
  // and costs nothing when it does not — a failed watch is not an error, the
  // interval is still there.
  try {
    _watcher = fs.watch(inboxPath(userData), () => {
      if (_watchTimer) clearTimeout(_watchTimer)
      _watchTimer = setTimeout(() => { _watchTimer = null; _run() }, WATCH_DEBOUNCE_MS)
      _watchTimer.unref?.()
    })
    // Our own truncation rename fires this watcher. That is harmless (the next
    // pass finds nothing above the watermark and returns immediately) but it
    // must not be able to raise.
    _watcher.on('error', () => { try { _watcher.close() } catch (_) {} ; _watcher = null })
  } catch (_) {
    // No file yet, or a platform without inotify. The interval covers it.
    _watcher = null
  }
  return { stop }
}

// Called from will-quit. Drains once more on the way out so the last 30 s of
// phone activity is not lost, then stops everything. The final pass is
// synchronous and lands in the side stores' in-memory values, which the
// flushSideStores() call immediately after writes to disk.
function stop() {
  if (_timer) { clearInterval(_timer); _timer = null }
  if (_watchTimer) { clearTimeout(_watchTimer); _watchTimer = null }
  if (_watcher) { try { _watcher.close() } catch (_) {} _watcher = null }
  if (_ctx) {
    try { ingestOnce(_ctx) } catch (_) { /* exiting anyway */ }
    _ctx = null
  }
}

module.exports = {
  start,
  stop,
  ingestOnce,
  inboxPath,
  statePath,
  readWatermark,
  STATE_FILE,
  OP_KEY_TO_STORE,
  OP_KEY_TO_CONFIG,
  WATCH_DEBOUNCE_MS,
  DEFAULT_INTERVAL_MS,
}
