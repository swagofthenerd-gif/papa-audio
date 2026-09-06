// Multi-source download scheduler for Soulseek transfers.
//
// slskd will happily accept unlimited concurrent downloads, so the naive thing
// — POST every file the moment the user asks — "works", but it is slow. A
// Soulseek peer serves its queue from a handful of upload slots, so 88 files
// requested from one peer is an 88-deep line, not 88 transfers. Throughput
// comes from breadth (many peers, few files each), not depth.
//
// So this keeps the deep queue on OUR side, where it can be re-pointed at a
// different peer the moment one goes slow or dies, and only ever lets a small
// number of files sit in any single peer's remote queue.

// Holding depth back from a peer is NOT free. Your place in a peer's queue is
// earned, and re-requesting puts you behind everyone who queued in the
// meantime, so an aggressive cap costs throughput on a busy-but-working peer.
// The cap exists to stop absurd concentration (88 files on one peer while
// three other sources sit idle), not to keep queues shallow for its own sake.
// The real wins here are retry, alternate sourcing and benching dead peers.
var DEFAULTS = {
  maxGlobalInflight: 60,   // files sitting in remote queues across all peers
  maxPerPeer: 12,          // files sitting in any ONE peer's queue
  maxAttempts: 4,          // distinct sources tried per file before giving up
  peerFailureLimit: 5,     // consecutive failures before a peer is benched
  peerFailureCooldownMs: 10 * 60 * 1000,
  retryPeerAfterMs: 60 * 1000, // before re-asking a peer that already failed us
  stallAfterMs: 20 * 60 * 1000, // remotely queued this long counts as stalled
}

function createState() {
  return {
    pending: [],      // items waiting for a source
    inflight: {},     // key -> { username, filename, size, since }
    done: {},         // key -> 'succeeded' | 'exhausted' | 'abandoned'
    peerFailures: {}, // username -> { consecutive, benchedUntil }
    // Two-level abandonment. `done[key]='abandoned'` catches the EXACT source
    // (this user's copy under this path), but the field failure was a cancelled
    // track coming back from a DIFFERENT user via discovery — a different key
    // entirely. `abandonedIds` is the second, path-independent gate: the identity
    // of the music itself (folder + normalized track title), so once a track is
    // cancelled no peer's copy of it can be re-enqueued.
    abandonedIds: {}, // identityKey -> true
    // Substitution decisions, newest last, capped: the UI shows why an alternate
    // was accepted or rejected. Purely a log; nothing reads it back for control.
    subLog: [],
    // The adaptive value the tuner has learned for maxGlobalInflight. Null until
    // the tuner has run at least once; dlConfig folds it in over DEFAULTS.
    learnedGlobalInflight: null,
  }
}

// The identity of a piece of music, independent of which peer serves it or what
// they named the file. This is the key that makes a cancel stick across sources:
// "01 - Intro.flac" from user A and "01. Intro.flac" from user B in the same
// album folder are ONE track, so cancelling either abandons both — and blocks a
// third copy discovery might turn up.
//
// Built from the remote folder (dozens of albums share "01 - Intro.flac", so the
// folder is what disambiguates) plus a normalized track title. A missing folder
// falls back to the bare title, which is coarser but never throws away identity.
function _basename(s) {
  var str = String(s == null ? '' : s)
  var i = Math.max(str.lastIndexOf('/'), str.lastIndexOf('\\'))
  return i >= 0 ? str.slice(i + 1) : str
}
function _folderOf(s) {
  var str = String(s == null ? '' : s)
  var i = Math.max(str.lastIndexOf('/'), str.lastIndexOf('\\'))
  if (i < 0) return ''
  var dir = str.slice(0, i)
  // The immediate parent folder is the album; anything above it (the peer's
  // "Music/", "Shared/") is noise that differs between users, so drop it.
  var j = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'))
  return (j >= 0 ? dir.slice(j + 1) : dir).toLowerCase()
}
function _normTitle(base) {
  return String(base || '')
    .replace(/\.[a-z0-9]+$/i, '')        // extension
    .toLowerCase()
    .replace(/[\[\](){}_,'"`!?.\-]/g, ' ')
    .replace(/\b(cd|disc|disk)\s*\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
function identityKey(filename) {
  var name = String(filename == null ? '' : filename)
  var folder = _folderOf(name)
  var title = _normTitle(_basename(name))
  if (!title) return ''
  return folder ? folder + '::' + title : title
}

// Is this identity already accounted for — pending, in flight, or done under a
// DIFFERENT exact key? Used to reject a duplicate enqueue of the same track from
// another user. Scoped to identity, not basename, so unrelated albums that share
// a track name never collide.
function _identityBusy(state, id, exceptKey) {
  if (!id) return false
  for (var i = 0; i < state.pending.length; i++) {
    var e = state.pending[i]
    if (e.key !== exceptKey && identityKey(e.filename) === id) return true
  }
  var ik = Object.keys(state.inflight)
  for (var j = 0; j < ik.length; j++) {
    if (ik[j] === exceptKey) continue
    var v = state.inflight[ik[j]]
    if (identityKey(v.filename || ik[j]) === id) return true
  }
  var dk = Object.keys(state.done)
  for (var k = 0; k < dk.length; k++) {
    if (dk[k] === exceptKey) continue
    // Only a positive terminal (succeeded) blocks a duplicate; 'exhausted' means
    // it failed and a fresh source is worth trying, and 'abandoned' is handled by
    // the abandonment gate above (which force does not bypass into here).
    if (state.done[dk[k]] === 'succeeded' && identityKey(dk[k]) === id) return true
  }
  return false
}

// Has this piece of music been abandoned, by exact key OR by identity? Every
// enqueue path must call this before adding, so a cancelled track cannot return
// from any source. Migrating states created before abandonedIds existed: an
// `abandoned` entry in `done` still counts, keyed by its filename identity.
function isAbandoned(state, filename, key) {
  var k = key != null ? key : itemKey(filename)
  if (state.done[k] === 'abandoned') return true
  var id = identityKey(filename)
  if (id && state.abandonedIds && state.abandonedIds[id]) return true
  return false
}

// A file is identified by its remote path. The same path from two peers is the
// same want, so re-requesting elsewhere reuses the key rather than duplicating.
function itemKey(filename) { return String(filename == null ? '' : filename) }

// Two competing requirements meet here, and the basename alone satisfies only
// one of them.
//
//   - The same song offered by two peers under two paths is ONE want. Fetching
//     it twice wastes both slots. (Basename matching gets this right.)
//   - "01 - Intro.flac" is a name dozens of albums share. Matching on the
//     basename globally meant one album in flight blocked every other album's
//     first track indefinitely. (Basename matching gets this wrong.)
//
// Size is what separates them: the same release circulating between peers has
// the same byte count, while two different tracks that happen to share a name do
// not. So identity is basename plus size, and a missing size falls back to the
// basename so nothing becomes un-dedupable.
function fileIdentity(filename, size) {
  var s = String(filename == null ? '' : filename)
  var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  var base = (i >= 0 ? s.slice(i + 1) : s).toLowerCase()
  var n = Number(size)
  return Number.isFinite(n) && n > 0 ? base + '|' + n : base
}

function inflightIdentities(state) {
  var out = {}
  var keys = Object.keys(state.inflight)
  for (var i = 0; i < keys.length; i++) {
    var v = state.inflight[keys[i]]
    out[fileIdentity(v.sentFilename || v.filename || keys[i], v.size)] = true
    out[fileIdentity(keys[i], v.size)] = true
  }
  return out
}

function normalizeSource(s) {
  if (!s) return null
  var name = typeof s === 'string' ? s : s.username
  if (!name) return null
  return {
    username: String(name),
    filename: s && s.filename ? String(s.filename) : null,
    size: s && s.size != null ? Number(s.size) : null,
    hasFreeUploadSlot: !!(s && (s.hasFreeUploadSlot || s.freeUploadSlots > 0)),
    queueLength: s && s.queueLength != null ? Number(s.queueLength) : 0,
    uploadSpeed: s && s.uploadSpeed != null ? Number(s.uploadSpeed) : 0,
  }
}

// `reason` on the way out instead of a bare null, so a caller can tell "already
// downloading" from "you cancelled this" and say so. The old null meant the UI
// showed nothing at all when a re-add was refused.
function addItem(state, item, opts) {
  var key = itemKey(item.filename)
  if (!key) return null
  var force = !!(opts && opts.force)
  var id = identityKey(item.filename)
  // Abandonment is checked at BOTH levels before anything else. The exact-key
  // case (`done[key]`) is handled just below; the identity case is the field
  // fix: a cancelled track must not return from a different user via discovery,
  // respread or a wishlist hit, and those arrive under a different exact key.
  var idAbandoned = !force && id && state.abandonedIds && state.abandonedIds[id]
  if (idAbandoned) {
    // A user's explicit re-ask (force) overrides it; the scheduler acting on its
    // own never may. Report it so the caller can log/surface rather than silently
    // dropping — the old silent path is what made cancel look flaky either way.
    return { refused: 'abandoned', key: key }
  }
  var terminal = state.done[key]
  if (terminal && !force) {
    // Not silent any more: the caller decides whether to ask the user.
    return { refused: terminal, key: key }
  }
  // An explicit ask overrides a terminal state. The scheduler must not revive a
  // cancelled file by itself — that is what makes cancel look broken — but the
  // user asking again is new information, not the scheduler second-guessing them.
  if (terminal && force) {
    delete state.done[key]
    if (id && state.abandonedIds) delete state.abandonedIds[id]
  }
  if (state.inflight[key]) return { refused: 'inflight', key: key }
  var existing = null
  for (var i = 0; i < state.pending.length; i++) {
    if (state.pending[i].key === key) { existing = state.pending[i]; break }
  }
  // Duplicate-proofing by identity: the same track from a second user is a
  // no-op, whether that copy is already pending, in flight or done. Only when
  // the identity is genuinely new (or the caller forces) does a differently-keyed
  // copy get added. Without this, discovery adding "01.flac" from user B while
  // user A's "01 - .flac" is already inflight raced two copies of one track.
  if (!existing && id && !force && _identityBusy(state, id, key)) {
    return { refused: 'duplicate', key: key }
  }
  var sources = (item.sources || []).map(normalizeSource).filter(Boolean)
  if (existing) {
    // Merge in any source we did not already know about.
    for (var j = 0; j < sources.length; j++) {
      var known = false
      for (var k = 0; k < existing.sources.length; k++) {
        if (existing.sources[k].username === sources[j].username) { known = true; break }
      }
      if (!known) existing.sources.push(sources[j])
    }
    return existing
  }
  // Priority is a dispatch tie-breaker, not a queue-jump into a peer's remote
  // line: planDispatch sorts by it, so a higher number is sent BEFORE a lower one
  // this tick. Default 0 keeps every existing enqueue path — and every state file
  // written before priority existed — ordering purely by addedAt, unchanged.
  var priority = (opts && Number.isFinite(Number(opts.priority))) ? Number(opts.priority) : 0
  var entry = {
    key: key,
    filename: String(item.filename),
    size: item.size != null ? Number(item.size) : 0,
    sources: sources,
    tried: [],
    triedAt: {},
    attempts: 0,
    addedAt: item.addedAt != null ? item.addedAt : Date.now(),
    priority: priority,
  }
  state.pending.push(entry)
  return entry
}

function peerBenched(state, username, now) {
  var f = state.peerFailures[username]
  if (!f) return false
  if (!f.benchedUntil) return false
  return f.benchedUntil > now
}

function inflightByPeer(state) {
  var out = {}
  var keys = Object.keys(state.inflight)
  for (var i = 0; i < keys.length; i++) {
    var u = state.inflight[keys[i]].username
    out[u] = (out[u] || 0) + 1
  }
  return out
}

// Free slot first, then shortest remote queue, then fastest peer. A peer that
// advertises a free slot will usually start immediately; queue length is the
// next best proxy for how long the wait will be.
function rankSources(sources) {
  return (sources || []).slice().sort(function (a, b) {
    if (a.hasFreeUploadSlot !== b.hasFreeUploadSlot) return a.hasFreeUploadSlot ? -1 : 1
    if (a.queueLength !== b.queueLength) return a.queueLength - b.queueLength
    if (b.uploadSpeed !== a.uploadSpeed) return b.uploadSpeed - a.uploadSpeed
    return String(a.username).localeCompare(String(b.username))
  })
}

// Untried peers first. A peer that already failed this file is not excluded
// forever — that would strand any file with only one known source the moment
// that source hiccups — but it is held off until the retry backoff expires, so
// we never hammer a peer that just rejected us.
function eligibleSource(state, entry, cfg, byPeer, now) {
  var ranked = rankSources(entry.sources)
  var triedAt = entry.triedAt || {}
  var retry = null
  for (var i = 0; i < ranked.length; i++) {
    var s = ranked[i]
    if (peerBenched(state, s.username, now)) continue
    if ((byPeer[s.username] || 0) >= cfg.maxPerPeer) continue
    if (entry.tried.indexOf(s.username) === -1) return s
    var last = triedAt[s.username] || 0
    if (!retry && (now - last) >= cfg.retryPeerAfterMs) retry = s
  }
  return retry
}

// Decide what to POST right now. Pure: does not mutate state.
function planDispatch(state, cfg, now) {
  cfg = Object.assign({}, DEFAULTS, cfg || {})
  now = now == null ? Date.now() : now
  var byPeer = inflightByPeer(state)
  var total = Object.keys(state.inflight).length
  var busy = inflightIdentities(state)
  var plan = []
  // Highest priority first, then oldest first within a priority band, so a big
  // album does not starve behind a later request. Priority is absent (0) on
  // everything unless explicitly restamped, so the default order is pure addedAt.
  var queue = state.pending.slice().sort(function (a, b) {
    var pa = Number(a.priority) || 0
    var pb = Number(b.priority) || 0
    if (pa !== pb) return pb - pa
    return a.addedAt - b.addedAt
  })
  for (var i = 0; i < queue.length; i++) {
    if (total >= cfg.maxGlobalInflight) break
    var entry = queue[i]
    if (entry.attempts >= cfg.maxAttempts) continue
    // Already coming from someone — never race a second copy of it.
    if (busy[fileIdentity(entry.filename, entry.size)]) continue
    var src = eligibleSource(state, entry, cfg, byPeer, now)
    if (!src) continue
    plan.push({
      key: entry.key,
      username: src.username,
      filename: src.filename || entry.filename,
      size: src.size != null && src.size > 0 ? src.size : entry.size,
    })
    byPeer[src.username] = (byPeer[src.username] || 0) + 1
    var dispatchedSize = src.size != null && src.size > 0 ? src.size : entry.size
    busy[fileIdentity(entry.filename, entry.size)] = true
    busy[fileIdentity(src.filename || entry.filename, dispatchedSize)] = true
    total++
  }
  return plan
}

// `sentFilename` matters: an alternate source names the same music under its
// own path, and the remote side only knows the transfer by the path we sent.
// Recording the original key here instead is what caused reconcile to miss
// every alternate-source transfer and re-dispatch it as a duplicate.
function markDispatched(state, key, username, now, sentFilename) {
  var idx = -1
  for (var i = 0; i < state.pending.length; i++) {
    if (state.pending[i].key === key) { idx = i; break }
  }
  if (idx < 0) return null
  var entry = state.pending[idx]
  state.pending.splice(idx, 1)
  entry.attempts++
  if (entry.tried.indexOf(username) === -1) entry.tried.push(username)
  entry.triedAt = entry.triedAt || {}
  entry.triedAt[username] = now == null ? Date.now() : now
  state.inflight[key] = {
    username: username,
    filename: entry.filename,
    sentFilename: sentFilename || entry.filename,
    size: entry.size,
    sources: entry.sources,
    tried: entry.tried,
    triedAt: entry.triedAt,
    attempts: entry.attempts,
    addedAt: entry.addedAt,
    // Carried through the round-trip so a re-queue after failure/stall keeps the
    // priority the user restamped it with.
    priority: Number(entry.priority) || 0,
    since: now == null ? Date.now() : now,
  }
  return state.inflight[key]
}

// A file the user cancelled, or that we removed, must never come back. This
// is terminal by design: reviving it is indistinguishable from ignoring the
// user, which is exactly how cancel appeared to be broken.
function recordAbandoned(state, key) {
  // Record the identity BEFORE dropping the entry — that is what makes cancel
  // stick across sources. The filename is read from whatever record still holds
  // it (inflight, then pending), falling back to the key itself.
  var filename = key
  if (state.inflight[key] && state.inflight[key].filename) {
    filename = state.inflight[key].filename
  } else {
    for (var i = 0; i < state.pending.length; i++) {
      if (state.pending[i].key === key) { filename = state.pending[i].filename; break }
    }
  }
  var id = identityKey(filename)
  if (id) { state.abandonedIds = state.abandonedIds || {}; state.abandonedIds[id] = true }
  delete state.inflight[key]
  state.pending = state.pending.filter(function (e) { return e.key !== key })
  state.done[key] = 'abandoned'
  return true
}

function recordSuccess(state, key, username) {
  delete state.inflight[key]
  state.done[key] = 'succeeded'
  if (username) state.peerFailures[username] = { consecutive: 0, benchedUntil: 0 }
}

// A failure is never fatal to the file, only to that pairing: put it back in
// pending so the next tick sends it somewhere else.
function recordFailure(state, key, username, cfg, now) {
  cfg = Object.assign({}, DEFAULTS, cfg || {})
  now = now == null ? Date.now() : now
  var live = state.inflight[key]
  delete state.inflight[key]

  if (username) {
    var f = state.peerFailures[username] || { consecutive: 0, benchedUntil: 0 }
    f.consecutive++
    if (f.consecutive >= cfg.peerFailureLimit) f.benchedUntil = now + cfg.peerFailureCooldownMs
    state.peerFailures[username] = f
  }
  if (!live) return null
  if (live.attempts >= cfg.maxAttempts) { state.done[key] = 'exhausted'; return null }

  var entry = {
    key: key,
    filename: live.filename,
    size: live.size,
    sources: live.sources || [],
    tried: live.tried || [],
    triedAt: live.triedAt || {},
    attempts: live.attempts,
    addedAt: live.addedAt,
    priority: Number(live.priority) || 0,
  }
  // Nothing left to try: hold it, a later search may add a fresh source.
  state.pending.push(entry)
  return entry
}

function addSources(state, key, sources, cfg) {
  cfg = Object.assign({}, DEFAULTS, cfg || {})
  var norm = (sources || []).map(normalizeSource).filter(Boolean)
  var target = state.inflight[key] || null
  if (!target) {
    for (var i = 0; i < state.pending.length; i++) {
      if (state.pending[i].key === key) { target = state.pending[i]; break }
    }
  }
  // A file that exhausted its attempts is exactly the case the alternate-source
  // search exists for, and it used to be the one case that could not benefit: it
  // was in `done`, so nothing would take a new source for it. A real new peer
  // resets the attempt count and puts it back in the queue.
  if (!target && state.done[key] === 'exhausted' && norm.length &&
      !isAbandoned(state, key, key)) {
    delete state.done[key]
    target = {
      key: key, filename: key, size: 0, sources: [], tried: [], triedAt: {},
      attempts: 0, addedAt: Date.now(),
    }
    state.pending.push(target)
  }
  if (!target) return 0
  var added = 0
  for (var j = 0; j < norm.length; j++) {
    var known = false
    for (var k = 0; k < target.sources.length; k++) {
      if (target.sources[k].username === norm[j].username) { known = true; break }
    }
    if (!known) { target.sources.push(norm[j]); added++ }
  }
  return added
}

// Restamp the priority of every queued item belonging to one album group, so a
// user pinning "Time - Pink Floyd" to the top moves the whole folder, not one
// track. A group is identified the way a shelf is: the album folder (the parent
// of each file, matched via _folderOf so peer-specific "Music/"/"Shared/" prefixes
// never matter) plus the peer `username` that serves it. A missing username
// matches on folder alone — the UI always has a username, but a folder-only call
// stays useful. Restamps pending and inflight alike; an inflight item keeps its
// slot but its next re-queue lands in the higher band. Persistence is the
// caller's job (main writes state after). Returns how many entries were changed.
function prioritizeGroup(state, opts, priority) {
  opts = opts || {}
  var p = Number(priority)
  if (!Number.isFinite(p)) return 0
  // folderName may arrive as a bare album name ("DSOTM") or a fuller path
  // ("Shared/Rips/DSOTM"); reduce it to the last component, lowercased, exactly
  // the shape _folderOf(filename) produces for a file that lives inside it.
  var fn = String(opts.folderName || '')
  var fi = Math.max(fn.lastIndexOf('/'), fn.lastIndexOf('\\'))
  var wantFolder = (fi >= 0 ? fn.slice(fi + 1) : fn).toLowerCase()
  var wantUser = opts.username ? String(opts.username) : null
  var changed = 0
  var matches = function (filename, sources, inflightUser) {
    if (wantFolder && _folderOf(filename) !== wantFolder) return false
    if (!wantUser) return true
    if (inflightUser && inflightUser === wantUser) return true
    var srcs = sources || []
    for (var i = 0; i < srcs.length; i++) {
      if (srcs[i] && srcs[i].username === wantUser) return true
    }
    return false
  }
  for (var i = 0; i < state.pending.length; i++) {
    var e = state.pending[i]
    if (matches(e.filename, e.sources, null)) {
      if ((Number(e.priority) || 0) !== p) changed++
      e.priority = p
    }
  }
  var ik = Object.keys(state.inflight)
  for (var j = 0; j < ik.length; j++) {
    var v = state.inflight[ik[j]]
    if (matches(v.filename || ik[j], v.sources, v.username)) {
      if ((Number(v.priority) || 0) !== p) changed++
      v.priority = p
    }
  }
  return changed
}

// Files that ran out of untried sources — the caller can search for more.
function starvedItems(state, cfg, now) {
  cfg = Object.assign({}, DEFAULTS, cfg || {})
  now = now == null ? Date.now() : now
  var byPeer = inflightByPeer(state)
  var out = []
  for (var i = 0; i < state.pending.length; i++) {
    var e = state.pending[i]
    if (e.attempts >= cfg.maxAttempts) continue
    if (!eligibleSource(state, e, cfg, byPeer, now)) out.push(e)
  }
  return out
}

// A peer that accepts a request and then never uploads looks perfectly healthy
// to failure-based logic — it never errors, it just sits there. Only report a
// stall when there is somewhere better to go: abandoning a queue position we
// have already waited for, with no alternative lined up, is strictly worse
// than waiting. That mistake is what makes downloads look like they vanished.
function stalledItems(state, cfg, now) {
  cfg = Object.assign({}, DEFAULTS, cfg || {})
  now = now == null ? Date.now() : now
  var byPeer = inflightByPeer(state)
  var keys = Object.keys(state.inflight)
  var out = []
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i]
    var live = state.inflight[key]
    if ((now - live.since) < cfg.stallAfterMs) continue
    var pseudo = { sources: live.sources || [], tried: live.tried || [], triedAt: live.triedAt || {} }
    var alt = eligibleSource(state, pseudo, cfg, byPeer, now)
    if (!alt || alt.username === live.username) continue
    out.push({ key: key, from: live.username, to: alt.username, waitedMs: now - live.since })
  }
  return out
}

// Same as a failure in effect, but not in blame: the peer did not do anything
// wrong, so this must not count toward benching them.
function recordStall(state, key, username, cfg, now) {
  cfg = Object.assign({}, DEFAULTS, cfg || {})
  now = now == null ? Date.now() : now
  var live = state.inflight[key]
  if (!live) return null
  delete state.inflight[key]
  // Re-queueing at the attempt limit made a zombie: planDispatch skips it on
  // attempts, starvedItems skips it too so no fresh-source search ever runs, it
  // is never written to done, and it is persisted — so it showed in the UI as a
  // download waiting forever, across restarts.
  if (live.attempts >= cfg.maxAttempts) {
    state.done[key] = 'exhausted'
    return null
  }
  var entry = {
    key: key,
    filename: live.filename,
    size: live.size,
    sources: live.sources || [],
    tried: live.tried || [],
    triedAt: live.triedAt || {},
    attempts: live.attempts,
    addedAt: live.addedAt,
    priority: Number(live.priority) || 0,
  }
  state.pending.push(entry)
  return entry
}

// Files stuck in one peer's queue long enough to be worth hunting alternates
// for, whether or not we already have one.
function stalledWithoutAlternate(state, cfg, now) {
  cfg = Object.assign({}, DEFAULTS, cfg || {})
  now = now == null ? Date.now() : now
  var keys = Object.keys(state.inflight)
  var out = []
  for (var i = 0; i < keys.length; i++) {
    var live = state.inflight[keys[i]]
    if ((now - live.since) < cfg.stallAfterMs) continue
    if ((live.sources || []).length > 1) continue
    out.push({ key: keys[i], filename: live.filename, since: live.since })
  }
  return out
}

// Record a substitution decision so the UI can explain it later. Bounded — this
// is a log, not state anything reads back for control. `accepted` is the
// decision, `reason` the human-readable why.
var SUB_LOG_CAP = 200
function logSubstitution(state, entry) {
  state.subLog = state.subLog || []
  state.subLog.push({
    at: entry.at != null ? entry.at : Date.now(),
    key: entry.key || null,
    from: entry.from || null,     // original filename/identity
    to: entry.to || null,         // candidate filename
    candidate: entry.candidate || null, // candidate username
    accepted: !!entry.accepted,
    reason: entry.reason || '',
  })
  if (state.subLog.length > SUB_LOG_CAP) {
    state.subLog.splice(0, state.subLog.length - SUB_LOG_CAP)
  }
  return state.subLog[state.subLog.length - 1]
}

// ── Adaptive tuning of the global in-flight cap ──────────────────────────────
//
// Deliberately boring. The cap governs how many files sit in remote queues at
// once. Too low and we leave throughput on the table; too high and we flood
// peers and pile up stalls. This nudges it one step at a time from measured
// aggregate behaviour, never oscillates hard, and clamps to a safe band. A
// static-but-safe value is a perfectly good outcome — the point is only to move
// gently toward one, not to chase the throughput curve.
//
// Pure: given the current cap and a metrics window, return the next cap. No
// state, no clock, no I/O — the caller feeds it measurements and persists the
// result.
var TUNE = {
  step: 5,          // how far the cap moves in one adjustment
  ceiling: 90,      // hard upper bound; never flood past this
  floor: 20,        // hard lower bound; always keep some breadth
  // A window is "healthy" (room to grow) only when it is nearly saturated AND
  // throughput has been climbing: if we are not even filling the current cap,
  // raising it does nothing. Expressed as a fraction of the cap.
  saturationForGrow: 0.9,
  // Trouble threshold: this many stalls+timeouts in the window means step down.
  troubleForShrink: 3,
}

// metrics: {
//   currentInflight,  // files actually in remote queues right now
//   throughputRising, // aggregate bytes/s higher than the previous window
//   troubleCount,     // stalls + timeouts observed in this window
// }
function nextGlobalInflight(currentCap, metrics, tune) {
  tune = Object.assign({}, TUNE, tune || {})
  var cap = Number(currentCap) || DEFAULTS.maxGlobalInflight
  var m = metrics || {}
  var inflight = Number(m.currentInflight) || 0
  var trouble = Number(m.troubleCount) || 0

  // Trouble wins over growth every time: back off first, ask questions later.
  // Flooding peers is the failure that hurts the user (stalled downloads that
  // look vanished), so shrinking is the safe direction and takes priority.
  if (trouble >= tune.troubleForShrink) {
    return Math.max(tune.floor, cap - tune.step)
  }

  // Grow only when there is evidence it would help: the current cap is nearly
  // full (so more slots would actually be used) and throughput is climbing (so
  // the peers we have are keeping up). Both, or we hold.
  var nearlyFull = inflight >= cap * tune.saturationForGrow
  if (m.throughputRising && nearlyFull) {
    return Math.min(tune.ceiling, cap + tune.step)
  }

  // No clear signal: hold. Holding is the common, correct case.
  return Math.max(tune.floor, Math.min(tune.ceiling, cap))
}

function stats(state) {
  var byPeer = inflightByPeer(state)
  var doneKeys = Object.keys(state.done)
  var succeeded = 0, exhausted = 0
  for (var i = 0; i < doneKeys.length; i++) {
    if (state.done[doneKeys[i]] === 'succeeded') succeeded++
    else exhausted++
  }
  return {
    pending: state.pending.length,
    inflight: Object.keys(state.inflight).length,
    peers: Object.keys(byPeer).length,
    byPeer: byPeer,
    succeeded: succeeded,
    exhausted: exhausted,
    benched: Object.keys(state.peerFailures).filter(function (u) {
      return peerBenched(state, u, Date.now())
    }),
    abandoned: Object.keys(state.done).filter(function (k) {
      return state.done[k] === 'abandoned'
    }).length,
    substitutions: (state.subLog || []).length,
    learnedGlobalInflight: state.learnedGlobalInflight != null ? state.learnedGlobalInflight : null,
  }
}

// Named per file on purpose: eight scripts share one global scope, and a bare
// `var API` in each meant every later file overwrote the earlier binding. It
// was latent only because each one reads it on the next line.
var _PapaDownloadScheduler = {
  DEFAULTS: DEFAULTS,
  createState: createState,
  itemKey: itemKey,
  identityKey: identityKey,
  isAbandoned: isAbandoned,
  fileIdentity: fileIdentity,
  inflightIdentities: inflightIdentities,
  logSubstitution: logSubstitution,
  nextGlobalInflight: nextGlobalInflight,
  TUNE: TUNE,
  normalizeSource: normalizeSource,
  addItem: addItem,
  addSources: addSources,
  prioritizeGroup: prioritizeGroup,
  rankSources: rankSources,
  planDispatch: planDispatch,
  markDispatched: markDispatched,
  recordSuccess: recordSuccess,
  recordAbandoned: recordAbandoned,
  recordFailure: recordFailure,
  starvedItems: starvedItems,
  stalledItems: stalledItems,
  stalledWithoutAlternate: stalledWithoutAlternate,
  recordStall: recordStall,
  peerBenched: peerBenched,
  inflightByPeer: inflightByPeer,
  stats: stats,
}

if (typeof module !== 'undefined' && module.exports) module.exports = _PapaDownloadScheduler
if (typeof window !== 'undefined') window.PapaDownloadScheduler = _PapaDownloadScheduler
