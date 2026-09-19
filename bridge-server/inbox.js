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
// NOTHING ON THE DESKTOP READS THIS FILE YET. See the TODO in the audit report:
// main.js needs an ingester that drains `ops` at startup and on a timer, applies
// them through the existing sideStores, and truncates the file to the last
// consumed `seq`. Until that exists these mutations are durable and visible to
// the phone, but not yet merged into the desktop's copy.

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
    }
  }
  return value
}

module.exports = { append, readInbox, applyInbox, inboxPath, OP_TYPES, MAX_OPS, INBOX_FILE }
