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
  // The hard ceiling on TOTAL dispatches for one file, however few sources it
  // has. `maxAttempts` counts DISTINCT SOURCES (that is what the name has always
  // meant); gating dispatch on the raw attempt count instead meant a file with a
  // single known source died after four tries at that one peer — permanently,
  // even while the peer was online and browsable. Retries against the same peer
  // are paced by the escalating backoff below and stopped for real by peer
  // benching, so this ceiling only has to catch the genuinely hopeless.
  maxTotalAttempts: 24,
  peerFailureLimit: 5,     // consecutive failures before a peer is benched
  peerFailureCooldownMs: 10 * 60 * 1000,
  retryPeerAfterMs: 60 * 1000, // before re-asking a peer that already failed us
  // Each further attempt at the SAME peer doubles the wait (60s, 2m, 4m…) up to
  // this ceiling, so a one-source file keeps trying — Soulseek queues are
  // measured in hours — without ever hammering.
  maxRetryBackoffMs: 30 * 60 * 1000,
  stallAfterMs: 20 * 60 * 1000, // remotely queued this long counts as stalled
}

// How many distinct sources this file has actually been sent to. The cap that
// means "stop looking for new peers" — as opposed to the total-attempt ceiling,
// which means "give up on this file entirely".
function distinctTried(entry) {
  return ((entry && entry.tried) || []).length
}

// The wait before the same peer may be asked again: the base retry gap doubled
// once per attempt already spent, capped. An entry with no attempt history
// (the pseudo-entries stalledItems builds) gets the plain base gap.
function retryGapMs(entry, cfg) {
  var spent = Math.max(0, (Number(entry && entry.attempts) || 1) - 1)
  var gap = cfg.retryPeerAfterMs * Math.pow(2, Math.min(spent, 10))
  return Math.min(gap, cfg.maxRetryBackoffMs)
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
// they named the file. This is the key that makes a cancel stick across sources
// and stops the same song downloading three times over.
//
// FIELD LESSON (the second occurrence of this failure class): the old identity
// was the album FOLDER name plus the track title. Peers never share folder names
// — "witzmankid_stuff/", "jzdoot shares/", "Sleety/" are three peers' copies of
// ONE loose track — so a folder-based key never collapsed them, cross-peer dedupe
// never fired, and the song downloaded from every peer at once (one of them an
// MP3 riding alongside the FLACs).
//
// So identity is now TRACK-CENTRIC: parsed artist + parsed album + normalized
// title. The folder is run through parseAlbumFolder (the same parser the shelves
// use), which strips the peer's "Music/"/"Shared/" shelving and quality tags and
// yields the real artist/album — which two peers of the same release DO share,
// even when their raw folder strings do not.
//
// When folder parsing yields nothing usable — a loose single dumped in a peer's
// share folder, where "album" comes back as the peer's junk folder name and
// artist is empty — we fall back to the normalized title ALONE plus a size-band
// (rounded to 5 MB). Tradeoff, deliberately chosen: title-alone would false-merge
// two genuinely different songs that happen to share a title across albums; the
// size-band makes that far less likely (different songs are different sizes)
// while still collapsing the same loose single offered by several peers (the same
// release circulates at the same byte count). It is coarser than the parsed key
// but never throws identity away, and a lossy copy lands in a different band from
// its lossless twin — which is correct, they are not interchangeable anyway.
// Resolved lazily on first use, NOT at load time: in the renderer eight scripts
// share one scope and load order is not guaranteed, so a top-level lookup of
// window.PapaSlskShelves can run before that file has set the global. Under Node
// require works either way. Cached once resolved.
var _parseAlbumFolder = null
function _getParseAlbumFolder() {
  if (_parseAlbumFolder) return _parseAlbumFolder
  try {
    if (typeof require !== 'undefined') _parseAlbumFolder = require('./slsk-shelves').parseAlbumFolder
  } catch (_) {}
  try {
    if (!_parseAlbumFolder && typeof window !== 'undefined' && window.PapaSlskShelves) {
      _parseAlbumFolder = window.PapaSlskShelves.parseAlbumFolder
    }
  } catch (_) {}
  return _parseAlbumFolder
}

// The quality gate for folding a second peer's copy in as an ALTERNATE SOURCE of
// one item (rule 2 of the field fix). Reused, never re-derived: the same
// compatible()/fingerprint() that guards discovery and seed substitution decides
// whether an MP3 may ride alongside a FLAC (it may not). Lazy for the same
// load-order reason as above.
var _fp = null
function _getFp() {
  if (_fp) return _fp
  try {
    if (typeof require !== 'undefined') _fp = require('./source-fingerprint')
  } catch (_) {}
  try {
    if (!_fp && typeof window !== 'undefined' && window.PapaSourceFingerprint) {
      _fp = window.PapaSourceFingerprint
    }
  } catch (_) {}
  return _fp
}

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
// Path segments for parseAlbumFolder: the folder chain above the file, so the
// parser can read artist from the parent when the leaf is just the album.
function _folderSegs(s) {
  var str = String(s == null ? '' : s).replace(/\\/g, '/')
  var parts = str.split('/')
  parts.pop() // drop the filename; the rest is the folder chain
  return parts.filter(function (p) { return p !== '' })
}
// Normalize a track title: drop the extension, any leading disc/track number
// (incl. the "1-04" disc-track form and bare "04"/"04."), bracketed quality
// tags, then collapse everything non-alphanumeric. This is the extension the
// field fix called for — the old normalizer left leading track numbers in place,
// which is exactly why "19 - ItsNot…" and "21 - ItsNot…" did not match.
function _normTitle(base) {
  return String(base || '')
    .replace(/\.[a-z0-9]+$/i, '')        // extension
    .toLowerCase()
    // bracketed quality/format tags: [flac], (24-96), {2xcd}, etc.
    .replace(/[\[\({][^\])}]*[\]\)}]/g, ' ')
    // leading disc-track ("1-04", "1.04", "1_04") or plain track ("04", "04.")
    .replace(/^\s*\d{1,3}\s*[-_.]\s*\d{1,3}\b/, ' ')
    .replace(/^\s*\d{1,3}\s*[-_.)\s]/, ' ')
    .replace(/[\[\](){}_,'"`!?.\-]/g, ' ')
    .replace(/\b(cd|disc|disk)\s*\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
// A parsed album is "usable" only when it gives us a real disambiguator: an
// artist, or an album that is not merely the peer's junk share folder. Without
// one we cannot trust the folder to identify the release, and fall back to the
// size-banded title.
function _bandSize(size) {
  var n = Number(size)
  if (!Number.isFinite(n) || n <= 0) return null
  // 5 MB bands. Round to nearest so a 1-byte difference across peers does not
  // straddle a boundary; the same release circulates at effectively one size.
  return Math.round(n / (5 * 1024 * 1024))
}
function identityKey(filename, size) {
  var name = String(filename == null ? '' : filename)
  var title = _normTitle(_basename(name))
  if (!title) return ''
  var artist = ''
  var album = ''
  var parseFn = _getParseAlbumFolder()
  if (typeof parseFn === 'function') {
    try {
      var p = parseFn(_folderSegs(name)) || {}
      artist = String(p.artist || '').toLowerCase().trim()
      album = String(p.album || '').toLowerCase().trim()
    } catch (_) { artist = ''; album = '' }
  }
  // Usable when we have an artist (the strongest signal a real release shares
  // across peers). Album alone is not enough: parseAlbumFolder happily returns
  // the peer's junk folder name as "album" for a loose single, and those differ
  // per peer — the whole reason the old key failed.
  if (artist) return 'a:' + artist + '|' + album + '|' + title
  // Fallback: title + size-band. Comment the tradeoff at the top of this block.
  var band = _bandSize(size)
  return band != null ? 't:' + title + '|~' + band : 't:' + title
}

// The band-INDEPENDENT identity of a song, for ABANDONMENT only. identityKey
// separates loose singles by size band so different songs sharing a title do not
// false-merge on enqueue — but a cancel must be coarser than that: the field
// failure ("Lights Out", "Sleety" mp3) was a cancel on one peer's FLAC that did
// not stop the same song arriving as an MP3, which sits in a different band. So a
// cancel records BOTH the exact identity (precise) and this song key (so no
// re-encode, no other-band copy, no lossy twin comes back). It is only consulted
// for abandonment; a coarser cancel is the safe direction (worst case, a user
// who cancels one loose single also blocks a different same-titled single — rare,
// and re-asking with force overrides it), whereas a coarser DEDUP would drop
// wanted music, which is not.
function songKey(filename) {
  var name = String(filename == null ? '' : filename)
  var title = _normTitle(_basename(name))
  if (!title) return ''
  var artist = ''
  var album = ''
  var parseFn = _getParseAlbumFolder()
  if (typeof parseFn === 'function') {
    try {
      var p = parseFn(_folderSegs(name)) || {}
      artist = String(p.artist || '').toLowerCase().trim()
      album = String(p.album || '').toLowerCase().trim()
    } catch (_) { artist = ''; album = '' }
  }
  // With an artist the identity is already band-independent, so it IS the song
  // key. Only the loose-single fallback needs the band stripped.
  if (artist) return 'a:' + artist + '|' + album + '|' + title
  return 't:' + title
}

// Is this identity already accounted for — pending, in flight, or done under a
// DIFFERENT exact key? Used to reject a duplicate enqueue of the same track from
// another user. Scoped to identity, not basename, so unrelated albums that share
// a track name never collide.
function _identityBusy(state, id, exceptKey) {
  if (!id) return false
  for (var i = 0; i < state.pending.length; i++) {
    var e = state.pending[i]
    if (e.key !== exceptKey && identityKey(e.filename, e.size) === id) return true
  }
  var ik = Object.keys(state.inflight)
  for (var j = 0; j < ik.length; j++) {
    if (ik[j] === exceptKey) continue
    var v = state.inflight[ik[j]]
    if (identityKey(v.filename || ik[j], v.size) === id) return true
  }
  var dk = Object.keys(state.done)
  for (var k = 0; k < dk.length; k++) {
    if (dk[k] === exceptKey) continue
    // Only a positive terminal (succeeded) blocks a duplicate; 'exhausted' means
    // it failed and a fresh source is worth trying, and 'abandoned' is handled by
    // the abandonment gate above (which force does not bypass into here). The done
    // key is a bare filename with no recorded size, so its identity is computed
    // without one — it still matches an artist-keyed identity exactly, and falls
    // to the sizeless title band for loose singles, which is the safe direction.
    if (state.done[dk[k]] === 'succeeded' && identityKey(dk[k]) === id) return true
  }
  return false
}

// Has this piece of music been abandoned, by exact key OR by identity? Every
// enqueue path must call this before adding, so a cancelled track cannot return
// from any source. Migrating states created before abandonedIds existed: an
// `abandoned` entry in `done` still counts, keyed by its filename identity.
function isAbandoned(state, filename, key, size) {
  var k = key != null ? key : itemKey(filename)
  if (state.done[k] === 'abandoned') return true
  if (!state.abandonedIds) return false
  var id = identityKey(filename, size)
  if (id && state.abandonedIds[id]) return true
  // Band-independent song key: a cancel on one band (a FLAC) also blocks the same
  // song in another band (its MP3) and any re-encode — the field failure.
  var sk = songKey(filename)
  if (sk && state.abandonedIds[sk]) return true
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

// The same question fileIdentity answers, asked of two files that are being
// considered as substitutes for each other rather than as duplicates.
//
// The alternate-source hunt looks for another peer serving the file we already
// want, and matched on the basename alone. But "01 - Intro.flac" is a name
// dozens of records share, and the quality fingerprint the hunt checks next
// (surround, lossless, bit depth, sample rate) cannot tell two different songs
// apart — a 16/44 stereo FLAC looks exactly like any other 16/44 stereo FLAC.
// So the hunt could fetch a completely different song off a completely
// different album and mark the wanted track done.
//
// Size is the separator, for the same reason fileIdentity uses it: one release
// circulating between peers has one byte count. Exact equality is the real
// signal. The 2% band on top of it is for the same recording ripped by someone
// else — a legitimate alternate — while two different songs differ by far more
// than 2%.
//
// A size we do not know on either side proves nothing, and is refused rather
// than waved through: an unverifiable substitution is precisely how the wrong
// song gets downloaded and called done.
var SIZE_TOLERANCE = 0.02
function sameRecordingSize(wantSize, candidateSize) {
  var a = Number(wantSize)
  var b = Number(candidateSize)
  if (!Number.isFinite(a) || a <= 0) return false
  if (!Number.isFinite(b) || b <= 0) return false
  if (a === b) return true
  return Math.abs(a - b) <= a * SIZE_TOLERANCE
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
  var id = identityKey(item.filename, item.size)
  // Abandonment is checked at BOTH levels before anything else. The exact-key
  // case (`done[key]`) is handled just below; the identity case is the field
  // fix: a cancelled track must not return from a different user via discovery,
  // respread or a wishlist hit, and those arrive under a different exact key.
  // isAbandoned checks the exact identity AND the band-independent song key, so a
  // cancelled FLAC also blocks the same song's MP3/re-encode arriving in another
  // size band.
  if (!force && isAbandoned(state, item.filename, key, item.size)) {
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
    if (state.abandonedIds) {
      if (id) delete state.abandonedIds[id]
      var sk = songKey(item.filename)
      if (sk) delete state.abandonedIds[sk]
    }
  }
  if (state.inflight[key]) {
    // Unforced, this is the guard that stops the same file being queued twice
    // while it is downloading. Forced, it was the bug: both force callers
    // (slsk-retry-transfer and the respread) DELETE the transfer at the daemon
    // first and then re-enqueue, so by the time they get here the daemon no
    // longer has it and "inflight" describes something that no longer exists.
    // Refusing meant the retry silently did nothing while the UI said
    // "Retrying…", and the reconcile loop then read the vanished transfer as a
    // cancellation and blacklisted the track for good.
    if (!force) return { refused: 'inflight', key: key }
    delete state.inflight[key]
  }
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

// A quality fingerprint for one item/source, from whatever the caller passed on
// it — filename plus any bitDepth/sampleRate a source carries. When the
// fingerprint module is unavailable (it should never be) fall back to a coarse
// lossless-by-extension check so an MP3 still cannot join a FLAC.
var _LOSSLESS_RE = /\.(flac|wav|alac|ape|wv|aiff?|aif)$/i
function _itemFp(x) {
  var fp = _getFp()
  if (fp && fp.fingerprint) {
    return fp.fingerprint({
      filename: x.filename,
      bitDepth: x.bitDepth, sampleRate: x.sampleRate,
      files: x.files,
    })
  }
  return { lossless: _LOSSLESS_RE.test(String(x.filename || '')), surroundLabel: null }
}
function _fpCompatible(orig, cand) {
  var fp = _getFp()
  if (fp && fp.compatible) return fp.compatible(orig, cand)
  // Degraded gate: at least never let lossy stand in for lossless.
  return !!orig.lossless === !!cand.lossless
}

// Enqueue a batch of files, collapsing multiple peers of the SAME track into ONE
// item with ranked alternate sources — the definitive fix for the field failure
// where "DL All" (and discovery, and respread) enqueued the same song from three
// peers as three separate items, one of them an MP3 alongside the FLACs.
//
// The mechanism: group the incoming files by identityKey. The FIRST admissible
// file for an identity becomes the item (its fingerprint is the item's ORIGINAL
// request). Every later file of that identity is offered as an alternate SOURCE,
// and admitted only if compatible() with the original — so a FLAC item never
// gains an MP3 source, and a 5.1 item never gains a stereo one. Incompatible
// same-identity copies are dropped (logged), NOT enqueued as their own item:
// that is the whole point — the user asked for one track, they get one.
//
// Each incoming item is { filename, size, sources:[{username,filename,size,...}] }
// exactly as addItem takes; opts is passed through to addItem (force, priority).
// Returns { added, refused:[{filename,reason}], merged } for the caller to report.
function addItems(state, items, opts) {
  var out = { added: 0, refused: [], merged: 0, dropped: 0 }
  var list = (items || []).filter(function (it) { return it && it.filename })
  // Stable grouping by identity, preserving first-seen order so the file the user
  // actually clicked (first in the list) anchors the item.
  var order = []
  var groups = {}
  for (var i = 0; i < list.length; i++) {
    var it = list[i]
    var id = identityKey(it.filename, it.size)
    // No identity (unnameable) — cannot be collapsed; pass straight through.
    var gk = id || ('#raw:' + itemKey(it.filename))
    if (!groups[gk]) { groups[gk] = []; order.push(gk) }
    groups[gk].push(it)
  }
  // Batch-local lossy suppression. The field row was two FLACs and an MP3 of one
  // loose single; the two FLACs collapse by identity (same title, same size band)
  // but the MP3 lands in a DIFFERENT band, so it would survive as its own item —
  // the exact "an MP3 rode alongside the FLACs" failure. identity cannot link
  // them (different sizes are how we keep genuinely-different loose singles
  // apart), so this rule is deliberately scoped to THIS batch only: if any group
  // for a normalized title is lossless, every lossy group of that same title is
  // dropped. It never touches persistent identity or cross-batch state, so it
  // cannot false-merge two different songs enqueued at different times.
  var titleHasLossless = {}
  for (var t = 0; t < order.length; t++) {
    var gm = groups[order[t]]
    var tt = _normTitle(_basename(gm[0].filename))
    if (!tt) continue
    if (_itemFp(gm[0]).lossless) titleHasLossless[tt] = true
  }
  for (var g = 0; g < order.length; g++) {
    var members = groups[order[g]]
    var anchor = members[0]
    var atitle = _normTitle(_basename(anchor.filename))
    if (atitle && titleHasLossless[atitle] && !_itemFp(anchor).lossless) {
      // A lossy group whose title also came in lossless this batch: drop it whole.
      for (var d = 0; d < members.length; d++) {
        out.dropped++
        logSubstitution(state, {
          at: Date.now(), key: itemKey(members[d].filename),
          from: null, to: members[d].filename,
          candidate: (members[d].sources && members[d].sources[0] && members[d].sources[0].username) ||
            members[d].username || null,
          accepted: false,
          reason: 'same title arrived lossless this batch — lossy copy dropped, not enqueued',
        })
      }
      continue
    }
    var r = addItem(state, anchor, opts)
    if (r && r.refused) {
      out.refused.push({ filename: anchor.filename, reason: r.refused })
      // The identity is already accounted for (busy/abandoned/done). An abandoned
      // identity must stay dead — never widen its sources. For a plain duplicate
      // (a live item under a different key), widening is pointless from here (the
      // sources belong to the OTHER key), so we simply skip: the extra peers are
      // dropped, which is correct — the track is already queued.
      continue
    }
    if (!r) { out.refused.push({ filename: anchor.filename, reason: 'invalid' }); continue }
    out.added++
    if (members.length > 1) _foldSources(state, members, out)
  }
  return out
}

// Fold the peers of a same-identity group in as alternate sources of the item the
// group's anchor created (or of whatever item already holds the identity). The
// anchor's fingerprint is the original request; a peer is admitted only if its
// own file is compatible().
function _foldSources(state, members, out) {
  var anchor = members[0]
  var key = itemKey(anchor.filename)
  var origFp = _itemFp(anchor)
  for (var i = 1; i < members.length; i++) {
    var m = members[i]
    var candFp = _itemFp(m)
    var srcs = (m.sources && m.sources.length)
      ? m.sources
      : [{ username: (m.username || ''), filename: m.filename, size: m.size }]
    if (!_fpCompatible(origFp, candFp)) {
      logSubstitution(state, {
        at: Date.now(), key: key, from: anchor.filename, to: m.filename,
        candidate: (srcs[0] && srcs[0].username) || null, accepted: false,
        reason: 'same track, incompatible quality: original ' +
          (origFp.surroundLabel || 'stereo') + '/' + (origFp.lossless ? 'lossless' : 'lossy') +
          ' vs ' + (candFp.surroundLabel || 'stereo') + '/' + (candFp.lossless ? 'lossless' : 'lossy') +
          ' — dropped, not enqueued as a separate item',
      })
      continue
    }
    var n = addSources(state, key, srcs)
    if (n) {
      out.merged += n
      logSubstitution(state, {
        at: Date.now(), key: key, from: anchor.filename, to: m.filename,
        candidate: (srcs[0] && srcs[0].username) || null, accepted: true,
        reason: 'same track from another peer folded in as an alternate source',
      })
    }
  }
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
    if (!retry && (now - last) >= retryGapMs(entry, cfg)) retry = s
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
    // Out of SOURCES (every allowance spent on distinct peers) or out of road
    // entirely. Gating this on the raw attempt count was the stall: a file with
    // one source burned all four "attempts" re-asking that peer and was then
    // skipped forever — and starvedItems skipped it too, so no alternate-source
    // search ever ran for it. 108 files in the field sat in exactly that state,
    // every one of them with a reachable peer.
    if (distinctTried(entry) >= cfg.maxAttempts) continue
    if ((entry.attempts || 0) >= cfg.maxTotalAttempts) continue
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

// Take a pending entry as in flight WITHOUT sending a request, because slskd
// already has that file moving or queued (a restart wrote in-flight entries
// back to pending; slskd kept the transfer). Re-requesting a queued file is
// refused by the daemon and used to be counted as a failed attempt — five
// times over on the reported install, while the file sat happily in the
// peer's queue. Adoption is not an attempt: the count stays; the peer is
// recorded as tried so the source accounting stays honest.
function adoptLive(state, key, username, now, sentFilename) {
  var idx = -1
  for (var i = 0; i < state.pending.length; i++) {
    if (state.pending[i].key === key) { idx = i; break }
  }
  if (idx < 0) return null
  var entry = state.pending[idx]
  state.pending.splice(idx, 1)
  if (entry.tried.indexOf(username) === -1) entry.tried.push(username)
  entry.triedAt = entry.triedAt || {}
  if (!entry.triedAt[username]) entry.triedAt[username] = now == null ? Date.now() : now
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
    priority: Number(entry.priority) || 0,
    since: now == null ? Date.now() : now,
    adopted: true,
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
  var size = 0
  if (state.inflight[key] && state.inflight[key].filename) {
    filename = state.inflight[key].filename
    size = state.inflight[key].size || 0
  } else {
    for (var i = 0; i < state.pending.length; i++) {
      if (state.pending[i].key === key) {
        filename = state.pending[i].filename
        size = state.pending[i].size || 0
        break
      }
    }
  }
  var id = identityKey(filename, size)
  state.abandonedIds = state.abandonedIds || {}
  if (id) state.abandonedIds[id] = true
  // Also the band-independent song key, so a cancel of one copy blocks the same
  // song in every other band (a lossy twin, a re-encode) and from every peer.
  var sk = songKey(filename)
  if (sk) state.abandonedIds[sk] = true
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
  // Terminal only when the file has genuinely run out of road: every allowed
  // distinct source tried, or the total-attempt ceiling reached. A single-source
  // file is NOT terminal after four tries — it goes back to pending and retries
  // on the escalating backoff, which is what a Soulseek queue actually needs.
  if (distinctTried(live) >= cfg.maxAttempts ||
      (live.attempts || 0) >= cfg.maxTotalAttempts) {
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
    // Same gate as planDispatch, for the same reason: a file skipped here never
    // gets an alternate-source search, which is precisely what a file whose one
    // peer keeps failing needs most.
    if (distinctTried(e) >= cfg.maxAttempts) continue
    if ((e.attempts || 0) >= cfg.maxTotalAttempts) continue
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
  if (distinctTried(live) >= cfg.maxAttempts ||
      (live.attempts || 0) >= cfg.maxTotalAttempts) {
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

// Per-file explain data for the Downloads UI: for every pending and inflight
// item, keyed by its filename (what the renderer correlates an slskd transfer
// on), the scheduler's view of WHY it is waiting — attempts made, the cap, how
// many sources it has, and how many ms until the next retry may fire. This is
// what turns a bare "Waiting" row into "Retrying via another source in Ns
// (attempt X/4)". Pure: given state/cfg/now it derives the timing, no clock or
// I/O of its own.
//
// nextRetryInMs is only meaningful for a PENDING item that has already tried
// every source it knows and is now waiting out the per-peer backoff before
// re-asking the soonest-eligible one (eligibleSource's `retry` path). An item
// with an untried source is dispatched on the next tick, not "retrying", so it
// carries no countdown. An inflight item is actively in a peer's queue, so it
// too has no pending-retry countdown — its explanation comes from slskd's own
// state (position / not responding).
function explainState(state, cfg, now) {
  cfg = Object.assign({}, DEFAULTS, cfg || {})
  now = now == null ? Date.now() : now
  var byFile = {}
  var i
  for (i = 0; i < state.pending.length; i++) {
    var e = state.pending[i]
    byFile[e.filename] = {
      attempts: e.attempts || 0,
      // `attempts` counts DISPATCHES, and the ceiling on dispatches is
      // maxTotalAttempts. maxAttempts is the cap on distinct PEERS, which is a
      // different quantity with a different number — pairing the two in one
      // "attempt X/Y" was what pinned the row at 4/4 while the file was still
      // being worked on. Both pairs are published; neither is mixed.
      maxAttempts: cfg.maxAttempts,
      maxTotalAttempts: cfg.maxTotalAttempts,
      sourcesTried: distinctTried(e),
      sourceCount: (e.sources || []).length,
      nextRetryInMs: _nextRetryInMs(state, e, cfg, now),
      inflight: false,
    }
  }
  var ik = Object.keys(state.inflight)
  for (i = 0; i < ik.length; i++) {
    var v = state.inflight[ik[i]]
    byFile[v.filename] = {
      attempts: v.attempts || 0,
      maxAttempts: cfg.maxAttempts,
      maxTotalAttempts: cfg.maxTotalAttempts,
      sourcesTried: distinctTried(v),
      sourceCount: (v.sources || []).length,
      // Inflight: no queued retry countdown; slskd's state explains it instead.
      nextRetryInMs: null,
      inflight: true,
    }
  }
  return byFile
}

// ms until a pending item's soonest source becomes eligible again, or null when
// it has an untried source (dispatched next tick, not "retrying"), no source at
// all, or no retry left to wait for.
//
// This has to mirror what planDispatch and eligibleSource will actually DO,
// because the number goes on screen as a countdown and he watches it. It used to
// use the flat retryPeerAfterMs while the real gate was retryGapMs — the same
// base doubled once per attempt already spent, up to half an hour — so the
// countdown ran out four, eight, sixteen times too early, nothing happened, and
// the app looked broken while working correctly.
//
// The dispatch caps are checked for the same reason: a file that has used up its
// distinct sources, or its total dispatches, is never going to be re-asked, and
// counting down to a retry that cannot come is the same lie in a worse form.
function _nextRetryInMs(state, entry, cfg, now) {
  var ranked = rankSources(entry.sources)
  if (!ranked.length) return null
  if (distinctTried(entry) >= cfg.maxAttempts) return null
  if ((entry.attempts || 0) >= cfg.maxTotalAttempts) return null
  var gap = retryGapMs(entry, cfg)
  var triedAt = entry.triedAt || {}
  var soonest = null
  for (var i = 0; i < ranked.length; i++) {
    var s = ranked[i]
    if (peerBenched(state, s.username, now)) continue
    // An untried source is ready now — nothing to count down to.
    if ((entry.tried || []).indexOf(s.username) === -1) return null
    var last = triedAt[s.username] || 0
    var wait = gap - (now - last)
    if (wait <= 0) return null  // already eligible: ready now, not a countdown
    if (soonest == null || wait < soonest) soonest = wait
  }
  return soonest
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
  songKey: songKey,
  isAbandoned: isAbandoned,
  fileIdentity: fileIdentity,
  sameRecordingSize: sameRecordingSize,
  inflightIdentities: inflightIdentities,
  logSubstitution: logSubstitution,
  nextGlobalInflight: nextGlobalInflight,
  TUNE: TUNE,
  normalizeSource: normalizeSource,
  addItem: addItem,
  addItems: addItems,
  addSources: addSources,
  prioritizeGroup: prioritizeGroup,
  rankSources: rankSources,
  planDispatch: planDispatch,
  markDispatched: markDispatched,
  adoptLive: adoptLive,
  recordSuccess: recordSuccess,
  recordAbandoned: recordAbandoned,
  recordFailure: recordFailure,
  starvedItems: starvedItems,
  stalledItems: stalledItems,
  stalledWithoutAlternate: stalledWithoutAlternate,
  recordStall: recordStall,
  peerBenched: peerBenched,
  inflightByPeer: inflightByPeer,
  explainState: explainState,
  stats: stats,
  distinctTried: distinctTried,
  retryGapMs: retryGapMs,
}

if (typeof module !== 'undefined' && module.exports) module.exports = _PapaDownloadScheduler
if (typeof window !== 'undefined') window.PapaDownloadScheduler = _PapaDownloadScheduler
