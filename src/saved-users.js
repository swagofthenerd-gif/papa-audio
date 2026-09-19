// Saved Soulseek libraries.
//
// Finding a peer with a genuinely good collection is the hard part and it
// happens by accident mid-search. Without somewhere to put them, the only way
// back is to remember the name and re-run a search that surfaces them.

const MAX_NOTE = 200

// "New since last visit" used to be a subtraction of two file COUNTS, which can
// say "13 new files" but can never say WHICH. The badge promised a shelf that
// had nothing to render. So a browse also records a snapshot of the peer's
// folder list — hashed, not stored verbatim, because a big share has tens of
// thousands of paths and this lives in the settings store beside everything
// else.
//
// FNV-1a over the lowercased path. A 32-bit hash will collide eventually; the
// cost of a collision here is one genuinely-new folder not being listed as new,
// which is the right way round for a discovery shelf to be wrong.
const DIR_SIG_CAP = 8000
const NEW_DIRS_CAP = 200

function hashDirPath(p) {
  const s = String(p || '').toLowerCase()
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

// One browse's folder list, as a comparable snapshot. Sorted so two snapshots
// of the same share are byte-identical regardless of listing order, and capped
// — a share past the cap records `truncated`, and a truncated snapshot refuses
// to answer the diff rather than calling every unseen folder new.
function dirSnapshot(paths, cap) {
  const limit = cap > 0 ? cap : DIR_SIG_CAP
  const set = new Set()
  for (const p of paths || []) {
    const k = String(p || '')
    if (k) set.add(hashDirPath(k))
  }
  const sig = Array.from(set).sort()
  if (sig.length > limit) return { sig: sig.slice(0, limit), truncated: true }
  return { sig, truncated: false }
}

// The folders present now that were not in the previous snapshot, in listing
// order, capped. Empty when there is no previous snapshot — a first visit has
// nothing to be new against, and answering "all of it" would be a lie dressed
// as a discovery.
function newDirPaths(prev, paths, cap) {
  const limit = cap > 0 ? cap : NEW_DIRS_CAP
  if (!prev || !Array.isArray(prev.sig) || !prev.sig.length || prev.truncated) return []
  const have = new Set(prev.sig)
  const out = []
  for (const p of paths || []) {
    const k = String(p || '')
    if (!k) continue
    if (!have.has(hashDirPath(k))) {
      out.push(k)
      if (out.length >= limit) break
    }
  }
  return out
}

function normalizeUser(name) { return String(name || '').trim() }

// Soulseek usernames are case-sensitive as identifiers, but people retype them
// with the wrong case; match loosely for lookup, store what the peer reports.
function findIndex(list, username) {
  const u = normalizeUser(username).toLowerCase()
  return (list || []).findIndex(e => String(e.username || '').toLowerCase() === u)
}

function isSaved(list, username) { return findIndex(list, username) >= 0 }

function saveUser(list, username, meta = {}) {
  const u = normalizeUser(username)
  if (!u) return list || []
  const out = (list || []).slice()
  const i = findIndex(out, u)
  const entry = {
    username: u,
    note: String(meta.note || '').slice(0, MAX_NOTE),
    savedAt: i >= 0 ? out[i].savedAt : Date.now(),
    lastBrowsedAt: meta.lastBrowsedAt ?? (i >= 0 ? out[i].lastBrowsedAt : null),
    fileCount: meta.fileCount ?? (i >= 0 ? out[i].fileCount : null),
    dirCount: meta.dirCount ?? (i >= 0 ? out[i].dirCount : null),
    // "New since last visit" needs the count from the PREVIOUS browse, kept
    // beside the current one. Preserved untouched unless the caller passes it.
    prevFileCount: meta.prevFileCount ?? (i >= 0 ? out[i].prevFileCount : null),
    // And the folder snapshots behind the shelf itself: the current browse's,
    // and the one before it. Same preserve-unless-passed rule.
    dirSnap: meta.dirSnap ?? (i >= 0 ? out[i].dirSnap : null),
    prevDirSnap: meta.prevDirSnap ?? (i >= 0 ? out[i].prevDirSnap : null),
  }
  if (i >= 0) out[i] = { ...out[i], ...entry }
  else out.unshift(entry)
  return out
}

function removeUser(list, username) {
  const i = findIndex(list, username)
  if (i < 0) return (list || []).slice()
  const out = (list || []).slice()
  out.splice(i, 1)
  return out
}

function toggleUser(list, username, meta) {
  return isSaved(list, username) ? removeUser(list, username) : saveUser(list, username, meta)
}

function touchUser(list, username, meta = {}) {
  if (!isSaved(list, username)) return (list || []).slice()
  return saveUser(list, username, { ...meta, lastBrowsedAt: Date.now() })
}

// A completed browse of a saved user. Before overwriting fileCount and the
// folder snapshot with the fresh ones, the old pair is rolled into
// prevFileCount / prevDirSnap — that is what "new since last visit" is computed
// from. A user who is not saved is left alone: the diff only exists for the
// libraries the user chose to keep.
//
// Call this ONLY for a browse the user asked for. It used to run on the
// background refresh too, which rotated the snapshot behind their back: the
// "new" folders became last visit's folders seconds after the badge appeared,
// so opening the library showed nothing new. A visit is something a person
// does.
function recordBrowse(list, username, meta = {}) {
  if (!isSaved(list, username)) return (list || []).slice()
  const i = findIndex(list, username)
  const prev = (i >= 0 && list[i].fileCount != null) ? list[i].fileCount : null
  const prevSnap = (i >= 0 && list[i].dirSnap) ? list[i].dirSnap : null
  return saveUser(list, username, {
    ...meta,
    prevFileCount: prev,
    prevDirSnap: prevSnap,
    lastBrowsedAt: Date.now(),
  })
}

// Most recently browsed first; never-browsed fall back to when they were saved.
function sortUsers(list) {
  return (list || []).slice().sort((a, b) =>
    (b.lastBrowsedAt || b.savedAt || 0) - (a.lastBrowsedAt || a.savedAt || 0))
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isSaved, saveUser, removeUser, toggleUser, touchUser, recordBrowse, sortUsers, findIndex,
    hashDirPath, dirSnapshot, newDirPaths, MAX_NOTE, DIR_SIG_CAP, NEW_DIRS_CAP }
}
if (typeof window !== 'undefined') {
  window.PapaSavedUsers = { isSaved, saveUser, removeUser, toggleUser, touchUser, recordBrowse, sortUsers,
    dirSnapshot, newDirPaths }
}
