// Spreading an album download across peers.
//
// Soulseek throughput is not limited by our client: slskd's download slots are
// effectively unlimited. It is limited by each peer, who grants one or two
// upload slots and queues everything else. Requesting 98 files from one user
// means waiting in that user's queue 98 times.
//
// The same album is usually offered by many peers. Taking track 1 from one and
// track 2 from another turns one queue into several running at once, which is
// the only thing that actually makes it faster.

// Peers name the same track differently: "01 - Time.flac", "01. Time.flac",
// "Pink Floyd - 01 Time.flac". Match on a normalised form so alternates for
// one track can be recognised across folders.
function trackKey(filename) {
  const base = String(filename || '').replace(/\//g, '\\').split('\\').pop() || ''
  return base
    .replace(/\.[a-z0-9]+$/i, '')      // extension
    .toLowerCase()
    .replace(/[\[\](){}_,'"`!?.-]/g, ' ')
    .replace(/\b(cd|disc|disk)\s*\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// A leading track number is the most reliable anchor when titles differ.
function trackNumber(filename) {
  const base = String(filename || '').split(/[\\/]/).pop() || ''
  const m = base.match(/^\s*(\d{1,3})\b/)
  return m ? parseInt(m[1], 10) : null
}

const AUDIO_RE = /\.(flac|mp3|wav|aiff?|aif|m4a|m4b|aac|ogg|oga|opus|ape|wv|wma|dsf|dff|mka)$/i

// Two peers offering "the same album" often do not have the same release: one
// is the 5.1 mix, another the stereo remaster, another a lossy transcode.
// Sourcing track 1 from one and track 2 from another would silently assemble an
// album that is half surround and half not - and file size is the only signal
// available, since Soulseek never reports channel count. A 5.1 FLAC runs
// roughly three times the size of the same track in stereo, so a size window
// separates them reliably while still allowing for normal variation.
function sizeCompatible(a, b, tolerance) {
  if (!a || !b) return false
  const hi = Math.max(a, b), lo = Math.min(a, b)
  return lo / hi >= (1 - tolerance)
}

/**
 * Build a download plan that spreads tracks across peers.
 *
 * groups: [{ username, folderPath, files: [{ filename, size, isFlac }], uploadSpeed, freeUploadSlots }]
 * opts.anchor: the group the user actually chose. Alternates are only accepted
 *   when their file for a track is a similar size, which is what keeps a
 *   surround release from being completed with stereo copies.
 * Returns [{ username, filename, size, key }] — one entry per distinct track.
 */
function planSpread(groups, opts = {}) {
  const maxPerUser = opts.maxPerUser || 2
  const preferLossless = opts.preferLossless !== false
  const anchor = opts.anchor || (groups || [])[0]
  const tolerance = opts.sizeTolerance != null ? opts.sizeTolerance : 0.25

  // Collect every candidate source for every track.
  const tracks = new Map()   // key -> [{username, file, group}]
  for (const g of groups || []) {
    for (const f of g.files || []) {
      if (!AUDIO_RE.test(f.filename || '')) continue
      const n = trackNumber(f.filename)
      const key = n !== null ? 'n' + n : trackKey(f.filename)
      if (!tracks.has(key)) tracks.set(key, [])
      tracks.get(key).push({ username: g.username, file: f, group: g })
    }
  }

  // Rank peers: free slots first, then speed. A peer with a slot open starts
  // immediately; the fastest peer with no slots still means queueing.
  const rank = (c) => (c.group.freeUploadSlots > 0 ? 1e9 : 0) + (c.group.uploadSpeed || 0)

  const perUser = new Map()
  const plan = []
  // Deal tracks in order so an interrupted download still yields a playable run.
  const keys = [...tracks.keys()].sort((a, b) => {
    const na = a.startsWith('n') ? parseInt(a.slice(1)) : Infinity
    const nb = b.startsWith('n') ? parseInt(b.slice(1)) : Infinity
    return na - nb || String(a).localeCompare(String(b))
  })

  // Sizes from the chosen release, per track, define what an acceptable
  // alternate looks like.
  const anchorSize = new Map()
  for (const f of (anchor && anchor.files) || []) {
    if (!AUDIO_RE.test(f.filename || '')) continue
    const n = trackNumber(f.filename)
    anchorSize.set(n !== null ? 'n' + n : trackKey(f.filename), f.size || 0)
  }

  for (const key of keys) {
    let cands = tracks.get(key)
    if (preferLossless && cands.some(c => c.file.isFlac)) cands = cands.filter(c => c.file.isFlac)

    // Reject alternates that are the wrong size for this release - the stereo
    // copy of a 5.1 track, or a lossy stand-in for a lossless one.
    const want = anchorSize.get(key)
    if (want) {
      const compatible = cands.filter(c => sizeCompatible(want, c.file.size || 0, tolerance))
      if (compatible.length) cands = compatible
      else cands = cands.filter(c => anchor && c.username === anchor.username)
    }
    if (!cands.length) continue
    // Least-loaded peer wins, so the work spreads instead of piling on the best one.
    cands = cands.slice().sort((a, b) => {
      const la = perUser.get(a.username) || 0, lb = perUser.get(b.username) || 0
      if (la !== lb) return la - lb
      return rank(b) - rank(a)
    })
    const pick = cands.find(c => (perUser.get(c.username) || 0) < maxPerUser) || cands[0]
    if (!pick) continue
    perUser.set(pick.username, (perUser.get(pick.username) || 0) + 1)
    plan.push({ username: pick.username, filename: pick.file.filename, size: pick.file.size || 0, key })
  }
  return plan
}

// How many distinct peers a plan uses — the honest measure of parallelism.
function planPeers(plan) {
  return new Set((plan || []).map(p => p.username)).size
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { planSpread, planPeers, trackKey, trackNumber, sizeCompatible, AUDIO_RE }
}
if (typeof window !== 'undefined') {
  window.PapaSpread = { planSpread, planPeers }
}
