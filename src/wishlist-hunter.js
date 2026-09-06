// Wishlist auto-download engine.
//
// The wishlist used to be a list you looked at: entries sat there and it was on
// you to re-run the search, eyeball the results and click download. This turns
// it into something that hunts on its own — a sweep runs every entry as one
// search, scores what comes back exactly the way the results grid does, and if a
// folder is clearly the album (lossless with real track count, or a near-exact
// query match) it enqueues it and drops the entry.
//
// The logic here is pure and injected: a `search` function, an `enqueue`
// function, a clock and a `sleep`. That is deliberate — the real sweep talks to
// slskd and takes minutes, but the decisions it makes (which folder wins, does
// it cross the bar, is this a repeat) are the part worth testing, and they test
// in milliseconds with fakes.

// Lossless extensions, matched to the renderer's LOSSLESS set. A folder is
// "lossless" if any file in it is one of these.
var LOSSLESS_EXTS = { flac: 1, wav: 1, alac: 1, ape: 1, wv: 1, aiff: 1, aif: 1 }
var AUDIO_EXTS = {
  flac: 1, wav: 1, alac: 1, ape: 1, wv: 1, aiff: 1, aif: 1,
  mp3: 1, m4a: 1, aac: 1, ogg: 1, opus: 1, wma: 1,
}

function extOf(filename) {
  var s = String(filename == null ? '' : filename)
  var i = s.lastIndexOf('.')
  return i >= 0 ? s.slice(i + 1).toLowerCase() : ''
}

// A wishlist query normalized for dedupe and matching: lowercased, punctuation
// flattened to spaces, runs of space collapsed. The same query typed twice with
// different casing or spacing is one query, so the hunter never enqueues it
// twice and never re-hunts a query it already satisfied.
function normalizeQuery(q) {
  return String(q == null ? '' : q)
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Raw slskd responses -> folder groups, the same shape the results grid builds:
// one group per (user, folder) with its files and the peer's availability
// signals. slskd separates path components with either slash; both are handled.
function groupResponses(responses) {
  var folders = new Map()
  var list = responses || []
  for (var i = 0; i < list.length; i++) {
    var resp = list[i]
    var files = (resp && resp.files) || []
    for (var j = 0; j < files.length; j++) {
      var f = files[j]
      var norm = String(f.filename || '').replace(/\//g, '\\')
      var parts = norm.split('\\')
      var ext = extOf(parts[parts.length - 1])
      if (!AUDIO_EXTS[ext]) continue
      var folderPath = parts.slice(0, -1).join('\\')
      var key = resp.username + '::' + folderPath
      if (!folders.has(key)) {
        var folderName = parts[parts.length - 2] || parts[parts.length - 1] || folderPath
        folders.set(key, {
          username: resp.username,
          folderPath: folderPath,
          folderName: folderName,
          // slskd sends hasFreeUploadSlot (boolean) and queueLength; it has
          // never sent freeUploadSlots. Read the name it actually uses.
          hasFreeUploadSlot: !!resp.hasFreeUploadSlot,
          queueLength: Number(resp.queueLength) || 0,
          uploadSpeed: Number(resp.uploadSpeed) || 0,
          files: [],
        })
      }
      var g = folders.get(key)
      g.files.push({
        filename: f.filename,
        size: f.size,
        ext: ext,
        isFlac: !!LOSSLESS_EXTS[ext],
        bitRate: f.bitRate,
        bitDepth: f.bitDepth,
        sampleRate: f.sampleRate,
      })
    }
  }
  var out = []
  folders.forEach(function (g) { if (g.files.length) out.push(g) })
  return out
}

function losslessCount(g) {
  var n = 0
  var files = (g && g.files) || []
  for (var i = 0; i < files.length; i++) if (files[i].isFlac) n++
  return n
}

// The results grid's relevance score, reproduced so the hunter's idea of "best"
// matches what a person scrolling the same results would land on: lossless is
// worth a lot per file, more tracks is better, keyword hits count, a free slot
// is decisive, a deep queue hurts, a fast peer helps, a lone file is penalized.
function scoreGroup(g, queryWords) {
  var nameL = String((g && g.folderName) || '').toLowerCase()
  var pathL = String((g && g.folderPath) || '').toLowerCase()
  var text = nameL + ' ' + pathL
  var s = 0
  var flacCount = losslessCount(g)
  s += flacCount * 8
  var trackCount = (g.files || []).length
  s += Math.min(trackCount, 20) * 2
  var words = queryWords || []
  for (var i = 0; i < words.length; i++) if (text.indexOf(words[i]) !== -1) s += 5
  if (g.hasFreeUploadSlot) s += 25
  if (g.queueLength > 0) s -= Math.min(Math.log2(g.queueLength + 1) * 3, 30)
  if (g.uploadSpeed > 0) s += Math.min(Math.log2(g.uploadSpeed / 1024 + 1) * 2, 12)
  if (trackCount === 1) s -= 5
  return s
}

function queryWords(q) {
  return normalizeQuery(q).split(' ').filter(function (w) { return w.length >= 2 })
}

// Pick the best folder for a query: score every candidate and take the top one.
// Null when nothing came back at all.
function pickBest(groups, query) {
  var words = queryWords(query)
  var best = null
  var bestScore = -Infinity
  for (var i = 0; i < (groups || []).length; i++) {
    var sc = scoreGroup(groups[i], words)
    if (sc > bestScore) { bestScore = sc; best = groups[i] }
  }
  return best
}

// The quality bar an entry has to clear before the hunter enqueues on its own.
// Two ways over it, because two different things are worth grabbing unattended:
//
//   - A lossless folder with a real track count (>= 3). This is the headline
//     case: an actual album, in a format worth keeping, from someone offering
//     it. LOSSLESS_MIN_FILES guards against a single stray FLAC.
//   - A near-exact query match, whatever the format. If the folder name
//     essentially IS the query, the user asked for precisely this; holding out
//     for lossless would mean never grabbing a release that only exists as MP3.
//
// Deliberately conservative. An unattended download is spending the user's
// slots and disk without them watching, so the bar is set where a person would
// have clicked without hesitating, not where they might have.
var LOSSLESS_MIN_FILES = 3

function _tokenSet(str) {
  var out = {}
  var parts = normalizeQuery(str).split(' ')
  for (var i = 0; i < parts.length; i++) if (parts[i]) out[parts[i]] = 1
  return out
}

// "Near-exact" means every word of the query appears in the folder name. Word
// containment rather than string equality, because the folder carries extras
// the query never will — year, format tag, catalogue number — and demanding an
// exact string would reject every real-world folder.
function isExactishMatch(folderName, query) {
  var want = _tokenSet(query)
  var wantKeys = Object.keys(want)
  if (!wantKeys.length) return false
  var have = _tokenSet(folderName)
  for (var i = 0; i < wantKeys.length; i++) if (!have[wantKeys[i]]) return false
  return true
}

// Does a folder-group look like it carries a surround (5.1/7.1/Atmos/etc.) mix?
// Text-based, the same signal a person reading the listing sees: surround is
// labelled in folder and file names, never reported as a channel count by
// slskd. Kept self-contained (the hunter is pure and browser-loadable) but the
// markers mirror src/source-fingerprint.js so the two agree on what "surround"
// means. Word-boundary anchored so "Symphony 5 1st Movement" and "Album 51" do
// not read as 5.1.
// The N.1 form requires a dot/underscore/dash between the digits, NOT a bare
// space: "5 1st Movement" and "Symphony 5 1" are not surround claims, only
// "5.1"/"5_1"/"5-1" (and the word forms) are.
var SURROUND_RE = /\b(?:5[._-]1|7[._-]1|quad(?:raphonic)?|atmos|dts[ ._-]?(?:hd|x)?|dolby[ ._-]?(?:digital|surround)|multi[ ._-]?ch(?:annel)?|surround)\b/i
function isSurround(group) {
  if (!group) return false
  var parts = []
  if (group.folderName) parts.push(String(group.folderName))
  if (group.folderPath) parts.push(String(group.folderPath))
  var files = group.files || []
  for (var i = 0; i < files.length; i++) {
    if (files[i] && files[i].filename) parts.push(String(files[i].filename))
  }
  return SURROUND_RE.test(parts.join(' '))
}

// The bar an entry has to clear, now honouring the entry's own quality target
// (roadmap #48). `target` is one of:
//   'any'      — the original behaviour: lossless-with-tracks OR near-exact match
//   'lossless' — must be lossless with a real track count; a near-exact MP3 no
//                longer qualifies, because the user explicitly asked for lossless
//   'surround' — must be lossless AND carry a surround label; this is the
//                "only 5.1" case, and stereo lossless does not satisfy it
// An unknown/absent target falls back to 'any' so old {query, addedAt} entries
// keep behaving exactly as before.
function crossesThreshold(group, query, target) {
  if (!group) return false
  var t = target || 'any'
  var flac = losslessCount(group)
  if (t === 'surround') {
    return flac >= LOSSLESS_MIN_FILES && isSurround(group)
  }
  if (t === 'lossless') {
    return flac >= LOSSLESS_MIN_FILES
  }
  if (flac >= LOSSLESS_MIN_FILES) return true
  if (isExactishMatch(group.folderName, query)) return true
  return false
}

// Build the enqueue payload for a winning folder: every audio file in it, each
// carrying the peer as its one source. The scheduler takes it from there —
// spreading, retrying and re-sourcing — exactly as it would for a folder the
// user had clicked.
function enqueuePayload(group) {
  var files = (group.files || [])
  return files.map(function (f) {
    return {
      filename: f.filename,
      size: f.size || 0,
      sources: [{ username: group.username, filename: f.filename, size: f.size || 0 }],
    }
  })
}

// The sweep itself. Pure orchestration over injected effects:
//
//   entries        [{ query, addedAt }]         the wishlist
//   search(query)  -> Promise<responses[]>       one slskd search (raw responses)
//   enqueue(items) -> Promise<any>               hand a folder to the scheduler
//   onHit(hit)     -> void                        record + emit (optional)
//   alreadyHunted(normQuery) -> bool             dedupe against past hits
//   sleep(ms)      -> Promise                      the inter-entry gap (injectable)
//   gapMs          number                          how long that gap is
//   now()          -> number                       the clock (injectable)
//
// Entries run SEQUENTIALLY with a gap between them, because slskd rate-limits and
// firing every wishlist search at once is exactly what earns a 429. A thrown
// search tagged as throttling (err.throttled or err.code === 'SLSKD_THROTTLED')
// aborts the whole sweep — there is no point continuing into a daemon that has
// just told us to stop — and the caller reschedules further out.
async function runSweep(opts) {
  var entries = opts.entries || []
  var search = opts.search
  var enqueue = opts.enqueue
  var onHit = opts.onHit || function () {}
  var alreadyHunted = opts.alreadyHunted || function () { return false }
  var sleep = opts.sleep || function () { return Promise.resolve() }
  var gapMs = opts.gapMs == null ? 5000 : opts.gapMs
  var now = opts.now || Date.now

  var results = []
  var aborted = false
  var abortReason = null

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i]
    var query = entry && entry.query
    var norm = normalizeQuery(query)
    if (!norm) continue
    // Never chase a query we have already satisfied. Two entries can normalize
    // to the same query, and a hit recorded earlier in THIS sweep counts too.
    if (alreadyHunted(norm)) { results.push({ query: query, found: false, enqueued: false, skipped: 'duplicate' }); continue }

    // A gap before every entry except the first: the throttle guard is about the
    // spacing between searches, so the first one pays nothing.
    if (i > 0 && gapMs > 0) await sleep(gapMs)

    var responses
    try {
      responses = await search(query)
    } catch (e) {
      if (e && (e.throttled || e.code === 'SLSKD_THROTTLED')) {
        aborted = true
        abortReason = 'throttled'
        break
      }
      results.push({ query: query, found: false, enqueued: false, error: String((e && e.message) || e) })
      continue
    }

    // Per-entry quality target and notify-only mode (roadmap #48). Both are
    // optional and additive to the {query, addedAt} shape; absent means the old
    // behaviour (target 'any', auto-download).
    var target = entry && entry.target ? entry.target : 'any'
    var notifyOnly = !!(entry && entry.notifyOnly)

    var groups = groupResponses(responses)
    var best = pickBest(groups, query)
    var found = !!best
    var enqueued = false
    var notified = false

    if (best && crossesThreshold(best, query, target)) {
      var payload = enqueuePayload(best)
      if (payload.length) {
        var hit = {
          query: query,
          normalized: norm,
          folderName: best.folderName,
          username: best.username,
          fileCount: payload.length,
          target: target,
          notifyOnly: notifyOnly,
          at: now(),
        }
        if (notifyOnly) {
          // Notify-only: tell the user a match crossed the bar, but do not spend
          // their slots. The hit is still recorded so the entry is not re-hunted
          // to death, and so the UI can surface "found — your call".
          notified = true
          onHit(hit)
        } else {
          try {
            await enqueue(payload)
            enqueued = true
            onHit(hit)
          } catch (e2) {
            results.push({ query: query, found: found, enqueued: false, error: String((e2 && e2.message) || e2) })
            continue
          }
        }
      }
    }
    results.push({ query: query, found: found, enqueued: enqueued, notified: notified })
  }

  return { results: results, aborted: aborted, abortReason: abortReason }
}

var _PapaWishlistHunter = {
  normalizeQuery: normalizeQuery,
  queryWords: queryWords,
  groupResponses: groupResponses,
  scoreGroup: scoreGroup,
  losslessCount: losslessCount,
  pickBest: pickBest,
  isExactishMatch: isExactishMatch,
  isSurround: isSurround,
  crossesThreshold: crossesThreshold,
  enqueuePayload: enqueuePayload,
  runSweep: runSweep,
  LOSSLESS_MIN_FILES: LOSSLESS_MIN_FILES,
}

if (typeof module !== 'undefined' && module.exports) module.exports = _PapaWishlistHunter
if (typeof window !== 'undefined') window.PapaWishlistHunter = _PapaWishlistHunter
