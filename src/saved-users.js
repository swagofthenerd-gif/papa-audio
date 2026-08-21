// Saved Soulseek libraries.
//
// Finding a peer with a genuinely good collection is the hard part and it
// happens by accident mid-search. Without somewhere to put them, the only way
// back is to remember the name and re-run a search that surfaces them.

const MAX_NOTE = 200

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

// Most recently browsed first; never-browsed fall back to when they were saved.
function sortUsers(list) {
  return (list || []).slice().sort((a, b) =>
    (b.lastBrowsedAt || b.savedAt || 0) - (a.lastBrowsedAt || a.savedAt || 0))
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isSaved, saveUser, removeUser, toggleUser, touchUser, sortUsers, findIndex, MAX_NOTE }
}
if (typeof window !== 'undefined') {
  window.PapaSavedUsers = { isSaved, saveUser, removeUser, toggleUser, touchUser, sortUsers }
}
