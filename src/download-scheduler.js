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
    done: {},         // key -> 'succeeded' | 'exhausted'
    peerFailures: {}, // username -> { consecutive, benchedUntil }
  }
}

// A file is identified by its remote path. The same path from two peers is the
// same want, so re-requesting elsewhere reuses the key rather than duplicating.
function itemKey(filename) { return String(filename == null ? '' : filename) }

// Peers name the same music under their own paths, so path equality is not
// enough to tell two requests apart. The basename is what a human means by
// "the same file", and it is what stops one track downloading twice at once.
function fileIdentity(filename) {
  var s = String(filename == null ? '' : filename)
  var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return (i >= 0 ? s.slice(i + 1) : s).toLowerCase()
}

function inflightIdentities(state) {
  var out = {}
  var keys = Object.keys(state.inflight)
  for (var i = 0; i < keys.length; i++) {
    var v = state.inflight[keys[i]]
    out[fileIdentity(v.sentFilename || v.filename || keys[i])] = true
    out[fileIdentity(keys[i])] = true
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

function addItem(state, item) {
  var key = itemKey(item.filename)
  if (!key) return null
  if (state.done[key]) return null
  if (state.inflight[key]) return null
  var existing = null
  for (var i = 0; i < state.pending.length; i++) {
    if (state.pending[i].key === key) { existing = state.pending[i]; break }
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
  var entry = {
    key: key,
    filename: String(item.filename),
    size: item.size != null ? Number(item.size) : 0,
    sources: sources,
    tried: [],
    triedAt: {},
    attempts: 0,
    addedAt: item.addedAt != null ? item.addedAt : Date.now(),
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
  // Oldest first, so a big album does not starve behind a later request.
  var queue = state.pending.slice().sort(function (a, b) { return a.addedAt - b.addedAt })
  for (var i = 0; i < queue.length; i++) {
    if (total >= cfg.maxGlobalInflight) break
    var entry = queue[i]
    if (entry.attempts >= cfg.maxAttempts) continue
    // Already coming from someone — never race a second copy of it.
    if (busy[fileIdentity(entry.filename)]) continue
    var src = eligibleSource(state, entry, cfg, byPeer, now)
    if (!src) continue
    plan.push({
      key: entry.key,
      username: src.username,
      filename: src.filename || entry.filename,
      size: src.size != null && src.size > 0 ? src.size : entry.size,
    })
    byPeer[src.username] = (byPeer[src.username] || 0) + 1
    busy[fileIdentity(entry.filename)] = true
    busy[fileIdentity(src.filename || entry.filename)] = true
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
    since: now == null ? Date.now() : now,
  }
  return state.inflight[key]
}

// A file the user cancelled, or that we removed, must never come back. This
// is terminal by design: reviving it is indistinguishable from ignoring the
// user, which is exactly how cancel appeared to be broken.
function recordAbandoned(state, key) {
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
  }
  // Nothing left to try: hold it, a later search may add a fresh source.
  state.pending.push(entry)
  return entry
}

function addSources(state, key, sources) {
  var norm = (sources || []).map(normalizeSource).filter(Boolean)
  var target = state.inflight[key] || null
  if (!target) {
    for (var i = 0; i < state.pending.length; i++) {
      if (state.pending[i].key === key) { target = state.pending[i]; break }
    }
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
  var entry = {
    key: key,
    filename: live.filename,
    size: live.size,
    sources: live.sources || [],
    tried: live.tried || [],
    triedAt: live.triedAt || {},
    attempts: live.attempts,
    addedAt: live.addedAt,
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
  }
}

var API = {
  DEFAULTS: DEFAULTS,
  createState: createState,
  itemKey: itemKey,
  fileIdentity: fileIdentity,
  inflightIdentities: inflightIdentities,
  normalizeSource: normalizeSource,
  addItem: addItem,
  addSources: addSources,
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

if (typeof module !== 'undefined' && module.exports) module.exports = API
if (typeof window !== 'undefined') window.PapaDownloadScheduler = API
