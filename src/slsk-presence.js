// Presence for saved Soulseek libraries.
//
// slskd answers GET /users/{name}/status with { isPrivileged, presence } where
// presence is "Online" | "Away" | "Offline". A peer that has never been seen,
// or a lookup made while the Soulseek server connection is down, is neither
// online nor offline — it is unknown, and must not be painted as offline or
// the list lies during a reconnect.

var PRESENCE_ONLINE  = 'online'
var PRESENCE_AWAY    = 'away'
var PRESENCE_OFFLINE = 'offline'
var PRESENCE_UNKNOWN = 'unknown'

function presenceLabel(raw) {
  var p = String(raw == null ? '' : raw).trim().toLowerCase()
  if (p === 'online') return PRESENCE_ONLINE
  if (p === 'away') return PRESENCE_AWAY
  if (p === 'offline') return PRESENCE_OFFLINE
  return PRESENCE_UNKNOWN
}

// `checkFailed` is the difference between "we have not asked yet" and "we
// asked and could not find out". Without it a failed lookup sat on "Checking…"
// forever, which reads as a request still in flight.
function presenceText(label, checkFailed) {
  if (label === PRESENCE_ONLINE) return 'Online'
  if (label === PRESENCE_AWAY) return 'Away'
  if (label === PRESENCE_OFFLINE) return 'Offline'
  return checkFailed ? "Couldn't check" : 'Checking…'
}

// Online sorts above away, away above offline, offline above unknown, so the
// peers you can actually browse right now are always at the top of the list.
function presenceRank(label) {
  if (label === PRESENCE_ONLINE) return 0
  if (label === PRESENCE_AWAY) return 1
  if (label === PRESENCE_OFFLINE) return 2
  return 3
}

function statusKey(name) { return String(name == null ? '' : name).trim().toLowerCase() }

// statuses: array or map of { username, presence, isPrivileged, checkedAt }
function indexStatuses(statuses) {
  var out = {}
  var arr = Array.isArray(statuses) ? statuses : (statuses ? Object.keys(statuses).map(function (k) { return statuses[k] }) : [])
  for (var i = 0; i < arr.length; i++) {
    var s = arr[i]
    if (!s || !s.username) continue
    out[statusKey(s.username)] = s
  }
  return out
}

function mergeStatuses(users, statuses, opts) {
  var checkFailed = !!(opts && opts.checkFailed)
  var byName = indexStatuses(statuses)
  return (users || []).map(function (u) {
    var s = byName[statusKey(u.username)]
    var label = s ? presenceLabel(s.presence) : PRESENCE_UNKNOWN
    return {
      username: u.username,
      note: u.note || '',
      fileCount: u.fileCount == null ? null : u.fileCount,
      dirCount: u.dirCount == null ? null : u.dirCount,
      savedAt: u.savedAt || 0,
      lastBrowsedAt: u.lastBrowsedAt || null,
      presence: label,
      presenceText: presenceText(label, checkFailed && label === PRESENCE_UNKNOWN),
      isPrivileged: !!(s && s.isPrivileged),
      checkedAt: s && s.checkedAt ? s.checkedAt : null,
    }
  })
}

// One peer's online truth, out of a statuses snapshot. THREE answers, not two:
// true, false, or null for "we do not know" — a peer nobody has looked up, or
// one whose lookup failed while the Soulseek connection was down. Painting
// unknown as offline is the lie this whole module exists to avoid, and it is
// the lie a browse-failure message would tell if it read a missing record as
// "they are offline".
//
// Away counts as reachable: an away peer answers a browse.
function onlineOf(statuses, username) {
  var s = indexStatuses(statuses)[statusKey(username)]
  if (!s) return null
  var label = presenceLabel(s.presence)
  if (label === PRESENCE_ONLINE || label === PRESENCE_AWAY) return true
  if (label === PRESENCE_OFFLINE) return false
  return null
}

function sortFriends(rows) {
  return (rows || []).slice().sort(function (a, b) {
    var r = presenceRank(a.presence) - presenceRank(b.presence)
    if (r !== 0) return r
    var at = a.lastBrowsedAt || a.savedAt || 0
    var bt = b.lastBrowsedAt || b.savedAt || 0
    if (bt !== at) return bt - at
    return String(a.username).localeCompare(String(b.username))
  })
}

function countOnline(rows) {
  var n = 0
  for (var i = 0; i < (rows || []).length; i++) {
    if (rows[i].presence === PRESENCE_ONLINE || rows[i].presence === PRESENCE_AWAY) n++
  }
  return n
}

// Named per file on purpose: eight scripts share one global scope, and a bare
// `var API` in each meant every later file overwrote the earlier binding. It
// was latent only because each one reads it on the next line.
var _PapaSlskPresence = {
  PRESENCE_ONLINE: PRESENCE_ONLINE,
  PRESENCE_AWAY: PRESENCE_AWAY,
  PRESENCE_OFFLINE: PRESENCE_OFFLINE,
  PRESENCE_UNKNOWN: PRESENCE_UNKNOWN,
  presenceLabel: presenceLabel,
  presenceText: presenceText,
  presenceRank: presenceRank,
  statusKey: statusKey,
  indexStatuses: indexStatuses,
  mergeStatuses: mergeStatuses,
  onlineOf: onlineOf,
  sortFriends: sortFriends,
  countOnline: countOnline,
}

if (typeof module !== 'undefined' && module.exports) module.exports = _PapaSlskPresence
if (typeof window !== 'undefined') window.PapaSlskPresence = _PapaSlskPresence
