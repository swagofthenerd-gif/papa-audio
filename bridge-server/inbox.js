'use strict'

// The bridge's outbound queue of phone-side mutations.
//
// The eight retired keys (libraryCache, playbackState, recentlyPlayed,
// playHistory, playCounts, savedQueues, playlists, likedTracks) now live in
// SideStore files that the DESKTOP owns and writes. The bridge must not become
// a second writer: two processes rewriting the same file with no locking is how
// a like and a play count end up destroying each other.
//
// So a phone-side mutation is recorded here instead — one file, one writer (the
// bridge), append-only, capped — and the read routes overlay the queued ops on
// top of the desktop's value so the phone still sees its own action immediately.
//
// The same argument applies to the SETTINGS keys that never left config.json
// (likedAlbums, followedArtists, volume, eqSettings, agentModel). The bridge
// used to write those straight into config.json with its own electron-store
// instance while the desktop's `conf` rewrites that whole file on every set().
// Two writers, no lock: whichever landed last silently destroyed the other's
// change, and the bridge's write also dropped the desktop's 0600 file mode. So
// those are queued here too, and src/bridge-inbox-ingest.js applies them
// through the desktop's own store. The desktop is the only writer of
// config.json.
//
// `bridgeTranscode` is deliberately NOT here: nothing on the desktop reads it,
// so it is not a desktop-owned key at all. It moved to the bridge's own
// bridge-settings.json (bridge-settings.js), where the bridge is the single
// writer of a file the desktop never touches.
//
// src/bridge-inbox-ingest.js drains `ops`, applies them through the desktop's
// side stores and store, and truncates the file to the last consumed `seq`.

const fs = require('fs')
const path = require('path')

const INBOX_FILE = 'bridge-inbox.json'
// Bounded so an un-drained queue cannot grow without limit on a bridge that
// runs from boot to shutdown. Oldest ops are dropped first.
const MAX_OPS = 2000

// The op types the read overlay knows how to replay. An op whose type is not
// here is refused at write time rather than silently queued for nobody.
const OP_TYPES = new Set([
  'likedTracks.set',
  'playlists.upsert',
  'playlists.delete',
  'playCounts.increment',
  'playHistory.push',
  'savedQueues.upsert',
  'savedQueues.delete',
  'recentlyPlayed.push',
  'playbackState.set',
  // Settings keys that still live in config.json. The desktop's store is their
  // single writer; these carry the phone's change to it.
  'likedAlbums.set',
  'followedArtists.set',
  'volume.set',
  'eqSettings.set',
  'agentModel.set',
])

function inboxPath(userData) { return path.join(userData, INBOX_FILE) }

function readInbox(userData) {
  try {
    const raw = JSON.parse(fs.readFileSync(inboxPath(userData), 'utf8'))
    if (raw && Array.isArray(raw.ops)) return raw
  } catch (_) {}
  return { version: 1, seq: 0, ops: [] }
}

// Atomic: write a tmp beside the file and rename, so a crash mid-write cannot
// leave a truncated queue behind. Same discipline as SideStore, minus the
// debounce — phone mutations are rare enough to write straight through.
function writeInbox(userData, state) {
  const file = inboxPath(userData)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state), 'utf8')
  fs.renameSync(tmp, file)
}

// Record one mutation. Returns the stored op (with its seq), or throws on an
// unknown type — an op nothing can replay must not be accepted.
function append(userData, type, payload) {
  if (!OP_TYPES.has(type)) throw new Error(`unknown inbox op: ${type}`)
  const state = readInbox(userData)
  state.seq = (state.seq || 0) + 1
  state.ops.push({ seq: state.seq, at: Date.now(), type, payload })
  if (state.ops.length > MAX_OPS) state.ops.splice(0, state.ops.length - MAX_OPS)
  writeInbox(userData, state)
  return state.ops[state.ops.length - 1]
}

// Replay the queued ops for one store on top of the desktop's value, so a GET
// right after a POST reflects what the phone just did. Pure: takes the base
// value and the op list, returns a new value. Never mutates `base` — that is
// the side reader's cached object.
function applyInbox(key, base, ops) {
  let value = base
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || typeof op.type !== 'string') continue
    const [opKey, action] = op.type.split('.')
    if (opKey !== key) continue
    const p = op.payload || {}

    if (key === 'likedTracks' && action === 'set') {
      value = Array.isArray(p.paths) ? p.paths.slice() : []
    } else if (key === 'playlists' && action === 'upsert') {
      const list = Array.isArray(value) ? value.slice() : []
      const idx = list.findIndex(x => x && x.id === (p.playlist && p.playlist.id))
      if (idx >= 0) list[idx] = p.playlist
      else list.unshift(p.playlist)
      value = list
    } else if (key === 'playlists' && action === 'delete') {
      value = (Array.isArray(value) ? value : []).filter(x => x && x.id !== p.id)
    } else if (key === 'playCounts' && action === 'increment') {
      const counts = Object.assign({}, value || {})
      counts[p.filePath] = (counts[p.filePath] || 0) + 1
      value = counts
    } else if (key === 'playHistory' && action === 'push') {
      const h = (Array.isArray(value) ? value : []).slice()
      h.unshift(p.entry)
      if (h.length > 2000) h.splice(2000)
      value = h
    } else if (key === 'savedQueues' && action === 'upsert') {
      const q = (Array.isArray(value) ? value : [])
        .filter(x => x && x.id !== (p.queue && p.queue.id))
      q.unshift(p.queue)
      value = q.slice(0, 30)
    } else if (key === 'savedQueues' && action === 'delete') {
      value = (Array.isArray(value) ? value : []).filter(x => x && x.id !== p.id)
    } else if (key === 'recentlyPlayed' && action === 'push') {
      const r = (Array.isArray(value) ? value : []).filter(x => x !== p.id)
      r.unshift(p.id)
      value = r.slice(0, 20)
    } else if (key === 'playbackState' && action === 'set') {
      value = p.state
    } else if (key === 'likedAlbums' && action === 'set') {
      value = Array.isArray(p.ids) ? p.ids.slice() : []
    } else if (key === 'followedArtists' && action === 'set') {
      value = Array.isArray(p.artists) ? p.artists.slice() : []
    } else if (key === 'volume' && action === 'set') {
      // A non-number would land NaN in the desktop's config and mute playback;
      // an op that cannot say what it means leaves the base alone.
      value = (typeof p.volume === 'number' && isFinite(p.volume)) ? p.volume : value
    } else if (key === 'eqSettings' && action === 'set') {
      value = (p.settings && typeof p.settings === 'object') ? p.settings : value
    } else if (key === 'agentModel' && action === 'set') {
      value = typeof p.model === 'string' ? p.model : value
    }
  }
  return value
}

module.exports = { append, readInbox, applyInbox, inboxPath, OP_TYPES, MAX_OPS, INBOX_FILE }
