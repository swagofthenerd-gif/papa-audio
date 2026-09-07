// The record shop: turns a Soulseek peer's browse tree into ALBUMS, then into
// shelves you can actually shop. slsk-tree.js already rebuilt the flat slskd
// listing into a navigable hierarchy; this walks that hierarchy and answers the
// only questions a collector really has — "what albums does this person have,
// which of them beat the copy I own, and which don't I have at all?"
//
// Everything here is pure: it takes a tree (or raw directories) and library
// data in, and returns plain objects out. No DOM, no window, no IPC — so it is
// unit-testable in Node, which matters because the path-parsing is the fiddly
// part and real-world folder names are a swamp.

// ── Audio / lossless vocabulary ───────────────────────────────────────────────
// Mirror slsk-tree's SH_AUDIO_RE deliberately rather than importing window state,
// so this module stands alone in a test process.
const SH_AUDIO_RE = /\.(flac|mp3|wav|aiff?|aif|m4a|m4b|aac|ogg|oga|opus|ape|wv|wma|dsf|dff|mka|ec3|ac3|alac|mpc|tta|shn|dts|spx|caf|w64)$/i
const SH_LOSSLESS_EXT = new Set(['flac', 'wav', 'aiff', 'aif', 'ape', 'wv', 'alac', 'dsf', 'dff', 'tta', 'shn', 'w64', 'caf'])

function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

function isAudioName(name) { return SH_AUDIO_RE.test(String(name || '')) }
function isLosslessName(name) { return SH_LOSSLESS_EXT.has(extOf(name)) }

// ── Folder-name parsing ───────────────────────────────────────────────────────
// The tags people bolt onto a folder name carry no artist/album/year signal and
// actively confuse the separators, so they are peeled off before we try to read
// structure. "[FLAC]", "[24-96]", "{WEB}", "(2019) [Vinyl]" and the like.
const TAG_RE = /[\[\{（(][^\]\}）)]*[\]\}）)]/g

// Quality / source noise that shows up bare (not bracketed) and would otherwise
// be mistaken for part of the album title.
const NOISE_WORDS = /\b(flac|mp3|wav|aac|alac|ape|wv|dsd|dsf|dff|24bit|16bit|24[\s._-]?96|24[\s._-]?192|16[\s._-]?44|96khz|192khz|44\.?1khz|48khz|88\.?2khz|vinyl|web|webflac|cd|cdrip|cdda|reissue|remaster(ed)?|remastered|hdtracks|qobuz|deluxe|edition|lossless|hi[\s._-]?res|hires|explicit|clean)\b/gi

// A leading track number that leaked into a folder name ("01 - Album").
const LEADING_NUM = /^\s*\d{1,3}\s*[-.]\s*/

// A trailing 4-digit year in parens/brackets or bare — captured before we strip.
function extractYear(text) {
  const s = String(text || '')
  // Prefer a bracketed/parenthesised year, then a bare 19xx/20xx anywhere.
  const bracket = s.match(/[\[\(（](19|20)\d{2}[\]\)）]/)
  if (bracket) return parseInt(bracket[0].replace(/\D/g, ''), 10)
  const bare = s.match(/\b(19|20)\d{2}\b/)
  if (bare) {
    const y = parseInt(bare[0], 10)
    // Sanity: not a future-nonsense or track-count year.
    if (y >= 1900 && y <= new Date().getFullYear() + 1) return y
  }
  return null
}

// Disc-subfolder detection: "CD1", "CD 2", "Disc 04", "Disk 3", "Disc One",
// "Vol. 2" when it is clearly a disc index and not a distinct release. Returns
// true when the folder is a disc container that should fold into its parent.
const DISC_RE = /^(cd|dis[ck]|disque|vol(?:ume)?)\b[\s._-]*(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)\s*$/i

function isDiscFolder(name) {
  const n = String(name || '').trim()
  // Also catches "CD01", "Disc04" (no separator) and a bare "CD".
  return DISC_RE.test(n) || /^(cd|dis[ck])\s*\d{1,3}$/i.test(n) || /^(cd|dis[ck])$/i.test(n)
}

// Clean a raw path segment down to human text: drop bracket tags, bare noise
// words, leading track numbers, and normalise whitespace/separators.
function cleanSegment(seg) {
  let s = String(seg || '')
  s = s.replace(TAG_RE, ' ')
  s = s.replace(NOISE_WORDS, ' ')
  s = s.replace(LEADING_NUM, '')
  s = s.replace(/[_]+/g, ' ')
  s = s.replace(/\s{2,}/g, ' ')
  // Trim stray separators/junk left at the ends after stripping.
  s = s.replace(/^[\s\-–—·.,]+|[\s\-–—·.,]+$/g, '')
  return s.trim()
}

// Split on the artist/album divider people actually use: " - ", " – ", " — ".
// A bare hyphen with no surrounding spaces ("Anti-Hero") is NOT a divider.
function splitDivider(text) {
  const parts = String(text || '').split(/\s+[-–—]\s+/)
  return parts.map(p => p.trim()).filter(Boolean)
}

// Parse {artist, album, year} from a leaf folder's path segments.
//
// The tree hands us the full segment list; we work from the leaf outward because
// the album folder is the leaf and its parent is usually the artist. The formats
// seen in the wild, in rough order of frequency:
//   "Artist - Year - Album"        (one segment, 3 divider parts)
//   "Artist - Album (Year)"        (one segment, 2 divider parts + year)
//   "Artist - Album"               (one segment, 2 divider parts)
//   "Artist/Album"                 (two segments: parent=artist, leaf=album)
//   "Artist/Year - Album"          (leaf has year prefix, parent=artist)
//   "Artist/Album/CD1"            (disc already folded away by the caller)
// plus every combination smothered in [FLAC][24-96] tags.
function parseAlbumFolder(pathSegments) {
  const segs = (pathSegments || []).slice()
  if (!segs.length) return { artist: '', album: '', year: null }

  const leafRaw = segs[segs.length - 1]
  const parentRaw = segs.length >= 2 ? segs[segs.length - 2] : ''

  const year = extractYear(leafRaw) || extractYear(parentRaw) || null
  const leaf = cleanSegment(leafRaw)
  const parent = cleanSegment(parentRaw)

  let artist = ''
  let album = ''

  const leafParts = splitDivider(leaf)

  if (leafParts.length >= 3) {
    // "Artist - Year - Album" or "Artist - Album - Subtitle". If the middle
    // part is a year, it's the classic 3-field form; otherwise treat the first
    // as artist and the remainder (rejoined) as album.
    if (/^(19|20)\d{2}$/.test(leafParts[1])) {
      artist = leafParts[0]
      album = leafParts.slice(2).join(' - ')
    } else {
      artist = leafParts[0]
      album = leafParts.slice(1).join(' - ')
    }
  } else if (leafParts.length === 2) {
    // "Artist - Album" — unless the first part is a bare year ("1996 - Album"),
    // in which case the album is the second part and the artist lives one level
    // up in the parent folder.
    if (/^(19|20)\d{2}$/.test(leafParts[0])) {
      album = leafParts[1]
      if (parent && !isGenericContainer(parent)) {
        const parentParts = splitDivider(parent)
        artist = parentParts.length ? parentParts[0] : parent
      }
    } else {
      artist = leafParts[0]
      album = leafParts[1]
    }
  } else {
    // Single-part leaf: album lives in the leaf, artist in the parent (if the
    // parent isn't itself a generic container like "Music" or "Albums").
    album = leafParts[0] || leaf
    if (parent && !isGenericContainer(parent)) {
      const parentParts = splitDivider(parent)
      artist = parentParts.length ? parentParts[0] : parent
    }
  }

  // Strip a year token that survived inside the album/artist text.
  album = stripYearToken(album)
  artist = stripYearToken(artist)

  return {
    artist: artist.trim(),
    album: album.trim(),
    year: year || null,
  }
}

function stripYearToken(s) {
  return String(s || '')
    .replace(/\s*[\[\(（]?(19|20)\d{2}[\]\)）]?\s*$/, '')
    .replace(/^\s*[\[\(（]?(19|20)\d{2}[\]\)）]?\s*[-–—]?\s*/, '')
    .trim()
}

// Folders that are shelving, not albums: don't let them stand in as an artist.
const GENERIC_CONTAINERS = new Set([
  'music', 'albums', 'album', 'discography', 'discografia', 'flac', 'mp3',
  'lossless', 'shared', 'share', 'downloads', 'complete', 'collection',
  'my music', 'audio', 'various', 'various artists', 'va', 'compilations',
])
function isGenericContainer(name) {
  return GENERIC_CONTAINERS.has(String(name || '').trim().toLowerCase())
}

// ── Fuzzy matching ────────────────────────────────────────────────────────────
// Normalise a title/artist to a comparison key: lowercase, strip punctuation and
// leading articles, collapse whitespace. "The Beatles" and "beatles" match;
// "Sgt. Pepper's" and "sgt peppers" match.
//
// MEMOISED. This is the hottest function in the shop: opening a 438-album shop on
// a 7k-album library ran normKey millions of times (once per album × library
// pair, both sides, twice over — see buildLibraryIndex/matchComparable). The
// profiler put 4.5s of self-time here alone. The results are pure functions of
// the input string, so a capped Map cache turns every repeat into a lookup. The
// cap keeps a pathological tree (100k unique folder names) from growing the map
// without bound; when full it clears wholesale rather than doing LRU bookkeeping
// (simpler, and the working set of a single shop open is far under the cap).
const _NORMKEY_CACHE = new Map()
const _NORMKEY_CAP = 20000
function _normKeyRaw(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^\s*(the|a|an)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}
function normKey(s) {
  const key = typeof s === 'string' ? s : String(s || '')
  const hit = _NORMKEY_CACHE.get(key)
  if (hit !== undefined) return hit
  const val = _normKeyRaw(key)
  if (_NORMKEY_CACHE.size >= _NORMKEY_CAP) _NORMKEY_CACHE.clear()
  _NORMKEY_CACHE.set(key, val)
  return val
}

// Tokenise a normalised key into a Set once. Used to build the pre-tokenised
// comparables so token-set overlap never re-splits a raw string per comparison.
const _TOKENSET_CACHE = new Map()
const _TOKENSET_CAP = 20000
function normTokenSet(s) {
  // Memoised like normKey: tokenScore(a,b) call sites that still pass raw
  // strings (profiled at 700ms/open on a 438-album shop) hit the cache
  // instead of re-splitting per comparison.
  const key = String(s || '')
  const hit = _TOKENSET_CACHE.get(key)
  if (hit !== undefined) return hit
  const set = new Set()
  const k = normKey(key)
  if (k) for (const t of k.split(' ')) if (t) set.add(t)
  if (_TOKENSET_CACHE.size >= _TOKENSET_CAP) _TOKENSET_CACHE.clear()
  _TOKENSET_CACHE.set(key, set)
  return set
}

// Token-set overlap ratio (Jaccard-ish) — robust to word order and to one side
// carrying an extra tag word. Returns 0..1. The Set-vs-Set core is factored out
// so the pre-tokenised matcher can share it without re-normalising.
function tokenScoreSets(ta, tb) {
  if (!ta || !tb || !ta.size || !tb.size) return 0
  // Iterate the smaller set for the intersection.
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta]
  let inter = 0
  for (const t of small) if (large.has(t)) inter++
  const union = ta.size + tb.size - inter
  return union ? inter / union : 0
}
function tokenScore(a, b) {
  return tokenScoreSets(normTokenSet(a), normTokenSet(b))
}

// A pre-tokenised comparable: parsed identity with its album/artist token Sets
// (and token counts) computed ONCE. albumsMatchComparable and the library index
// operate on these so a raw {artist,album} pair is normalised a single time no
// matter how many candidates it is compared against.
function albumComparable(x) {
  if (!x) return { artist: '', album: '', albumTokens: new Set(), artistTokens: new Set(), albumTokenCount: 0 }
  // Already a comparable? (idempotent — lets callers pass either shape.)
  if (x.albumTokens instanceof Set && x.artistTokens instanceof Set) return x
  const albumTokens = normTokenSet(x.album)
  const artistTokens = normTokenSet(x.artist)
  return {
    artist: x.artist || '',
    album: x.album || '',
    albumTokens,
    artistTokens,
    albumTokenCount: albumTokens.size,
    lossless: x.lossless,
    maxBitDepth: x.maxBitDepth,
    maxSampleRate: x.maxSampleRate,
    ref: x.ref,
  }
}

// The confident-match test over two pre-tokenised comparables. Identical logic
// to albumsMatch below, but reads the cached token Sets rather than re-splitting
// raw strings — this is what the O(peer × library) loop calls now.
function albumsMatchComparable(a, b, albumMin, artistMin) {
  const albumS = tokenScoreSets(a.albumTokens, b.albumTokens)
  if (albumS < albumMin) return false
  const distinctive = a.albumTokenCount >= 3
  const aHasArtist = a.artistTokens.size > 0
  const bHasArtist = b.artistTokens.size > 0
  if (!aHasArtist || !bHasArtist) return albumS >= 0.8 && distinctive
  const artistS = tokenScoreSets(a.artistTokens, b.artistTokens)
  return artistS >= artistMin || (albumS >= 0.9 && distinctive)
}

// A confident album match needs both the album titles and the artists to line
// up. Album carries the weight (people file the same album under slightly
// different artist spellings), but the artist is a strong tiebreaker/guard so
// "Live" by two different bands don't collapse together.
//
// Public entry point, unchanged in behaviour: it tokenises both sides on the fly
// (via the memoised normKey) and delegates to the pre-tokenised core. Callers in
// a hot loop should build comparables once and use the index / matchComparable
// instead of paying the per-call tokenisation.
function albumsMatch(a, b, { albumMin = 0.6, artistMin = 0.34 } = {}) {
  return albumsMatchComparable(albumComparable(a), albumComparable(b), albumMin, artistMin)
}

// ── Library index (bucketed matcher) ──────────────────────────────────────────
// The upgrade/missing classification and the shop's "In Library" marking both
// ask, for every peer album, "is this album already in the library?" — an
// O(peerAlbums × libraryAlbums) sweep. On a 7k-album library × a 438-album shop
// that is ~3M albumsMatch calls, each of which used to re-normalise both sides.
//
// This precomputes the library ONCE into comparables and buckets them by album
// TOKEN. A confident match needs the album titles to share ≥60% of their tokens
// (albumMin), so any library album that could match a peer album shares at least
// one album token with it — meaning it lives in a bucket the peer's own tokens
// point at. Each library comparable is therefore indexed under EVERY one of its
// album tokens (not just the first): that makes the bucketed scan find exactly
// the same matches a full scan would, even when the tokens are reordered
// ("Kind of Blue" vs "Blue, Kind of"), which is the property the snapshot-
// equality test locks in. A peer album unions the buckets for its own tokens,
// dedupes, and scans them in library order (so "first match wins" is preserved).
//
// The empty-album fallback bucket holds library albums with no usable album
// token; a peer album can still match one on the artist-carried distinctive
// path, so it is always scanned.
function buildLibraryIndex(library, { albumMin = 0.6, artistMin = 0.34 } = {}) {
  const buckets = new Map()     // albumToken → [{ comp, order }]
  const noKey = []              // comparables with no usable album token
  let order = 0
  for (const a of (library || [])) {
    const comp = albumComparable(a && a.albumTokens instanceof Set ? a : libAlbumToComparable(a))
    const entry = { comp, order: order++ }
    if (!comp.albumTokens.size) { noKey.push(entry); continue }
    for (const tok of comp.albumTokens) {
      let arr = buckets.get(tok)
      if (!arr) { arr = []; buckets.set(tok, arr) }
      arr.push(entry)
    }
  }
  // Find the first (library-order) library comparable that confidently matches a
  // peer comparable. Only buckets the peer's album tokens point at are scanned —
  // a handful of candidates instead of the whole library.
  const findMatch = (peerComp) => {
    const pc = albumComparable(peerComp)
    let match = null
    let matchOrder = Infinity
    const seen = new Set()
    const consider = (entry) => {
      if (entry.order >= matchOrder || seen.has(entry.order)) return
      seen.add(entry.order)
      if (albumsMatchComparable(pc, entry.comp, albumMin, artistMin)) {
        match = entry.comp; matchOrder = entry.order
      }
    }
    for (const tok of pc.albumTokens) {
      const arr = buckets.get(tok)
      if (arr) for (const entry of arr) consider(entry)
    }
    for (const entry of noKey) consider(entry)
    return match
  }
  return { findMatch, buckets, noKey }
}

// ── Album extraction from the tree ────────────────────────────────────────────
// Walk the slsk-tree hierarchy and emit one album object per leaf folder that
// holds >= minTracks audio files directly. Disc subfolders (CD1/CD2/Disc 04) are
// folded into their parent so a multi-disc album is ONE album, not three.
//
// `root` is the tree returned by slsk-tree.buildTree. It has the shape
// { name, path, dirs: Map, files: [{ name, fullPath, size, bitDepth, sampleRate,
// bitRate }] }.
function extractAlbums(root, { minTracks = 2 } = {}) {
  if (!root) return []
  const albums = []

  // Gather all audio files owned by a node AND by any disc-only subfolders of it.
  // Returns { files, discCount }.
  const gatherWithDiscs = (node) => {
    const files = node.files.filter(f => isAudioName(f.name || f.filename))
    let discCount = 0
    if (node.dirs && node.dirs.size) {
      for (const child of node.dirs.values()) {
        if (isDiscFolder(child.name)) {
          discCount++
          const inner = gatherWithDiscs(child)
          for (const f of inner.files) files.push(f)
        }
      }
    }
    return { files, discCount }
  }

  const walk = (node, segs) => {
    // Non-disc subfolders decide whether this node is a leaf album or a shelf.
    const realSubdirs = []
    if (node.dirs && node.dirs.size) {
      for (const child of node.dirs.values()) {
        if (!isDiscFolder(child.name)) realSubdirs.push(child)
      }
    }

    const gathered = gatherWithDiscs(node)
    const isAlbumLeaf = realSubdirs.length === 0 && gathered.files.length >= minTracks

    if (isAlbumLeaf && node.path) {
      albums.push(buildAlbum(node, segs, gathered))
    } else {
      // Recurse into the real (non-disc) subfolders only. If this node ALSO has
      // its own loose audio (a "shelf with a few stray tracks"), we still treat
      // it as an album when it clears the threshold and has no real subdirs —
      // handled above. Mixed nodes (subdirs + own audio meeting the bar) are
      // rare; prefer treating the subfolders as the albums.
      for (const child of realSubdirs) walk(child, segs.concat(child.name))
      // Edge case: a node with real subdirs but also enough of its own audio to
      // be an album in its own right (e.g. a "Singles" folder). Emit it too.
      if (realSubdirs.length && node.path && gathered.files.length >= minTracks) {
        albums.push(buildAlbum(node, segs, { files: node.files.filter(f => isAudioName(f.name || f.filename)), discCount: 0 }))
      }
    }
  }

  // Kick off from the root's children (root itself has an empty path).
  if (root.dirs && root.dirs.size) {
    for (const child of root.dirs.values()) walk(child, [child.name])
  }
  // Root-level loose files as a fallback album.
  const rootAudio = (root.files || []).filter(f => isAudioName(f.name || f.filename))
  if (rootAudio.length >= minTracks) {
    albums.push(buildAlbum(root, [root.name || ''], { files: rootAudio, discCount: 0 }))
  }

  return albums
}

// Build one album object from a tree node and the files gathered for it.
function buildAlbum(node, segs, gathered) {
  const files = gathered.files
  const parsed = parseAlbumFolder(segs)
  const totalSize = files.reduce((s, f) => s + (Number(f.size) || 0), 0)
  const losslessCount = files.filter(f => isLosslessName(f.name || f.filename) || f.isFlac).length
  const maxBitDepth = Math.max(0, ...files.map(f => Number(f.bitDepth) || 0))
  const maxSampleRate = Math.max(0, ...files.map(f => Number(f.sampleRate) || 0))
  // Representative format: majority extension.
  const counts = {}
  for (const f of files) {
    const e = extOf(f.name || f.filename)
    if (e) counts[e] = (counts[e] || 0) + 1
  }
  let topExt = '', topN = 0
  for (const k in counts) if (counts[k] > topN) { topN = counts[k]; topExt = k }

  const lossless = losslessCount > 0 && losslessCount >= files.length / 2
  const isHiRes = maxBitDepth >= 24 || maxSampleRate >= 88200

  return {
    // Fallback the display name to the raw folder when parsing yields nothing.
    artist: parsed.artist || '',
    album: parsed.album || node.name || '',
    year: parsed.year || null,
    folderName: node.name || '',
    folderPath: node.path || '',
    trackCount: files.length,
    totalSize,
    losslessCount,
    lossless,
    isHiRes,
    maxBitDepth,
    maxSampleRate,
    topExt,
    files,
  }
}

// A one-line quality label for a parsed album: "FLAC · 24/96", "MP3 · 320".
function albumQualityLabel(album) {
  if (!album) return ''
  const fmt = album.topExt === 'flac' ? 'FLAC' : String(album.topExt || '').toUpperCase()
  if (!fmt) return ''
  if (album.lossless || SH_LOSSLESS_EXT.has(album.topExt)) {
    if (album.maxBitDepth && album.maxSampleRate) {
      return `${fmt} · ${album.maxBitDepth}/${Math.round(album.maxSampleRate / 1000)}`
    }
    if (album.maxSampleRate) return `${fmt} · ${Math.round(album.maxSampleRate / 1000)} kHz`
    return fmt
  }
  // Lossy: bitrate if we have it.
  const kbps = Math.max(0, ...album.files.map(f => Number(f.bitRate) || 0))
  return kbps ? `${fmt} · ${kbps}` : fmt
}

// ── Library adaptation ────────────────────────────────────────────────────────
// The renderer's library albums have their own shape ({ name, artist, year,
// tracks:[{filePath,bitsPerSample,sampleRate}], isHiRes, maxBitsPerSample,
// maxSampleRate }). Reduce one to the comparable {artist, album, lossless,
// maxBitDepth, maxSampleRate} shape the upgrade logic needs.
function libAlbumToComparable(a) {
  const tracks = a.tracks || []
  const losslessCount = tracks.filter(t => isLosslessName(t.filePath || t.path || '')).length
  const maxBitDepth = a.maxBitsPerSample != null
    ? Number(a.maxBitsPerSample) || 0
    : Math.max(0, ...tracks.map(t => Number(t.bitsPerSample || t.bitDepth) || 0))
  const maxSampleRate = a.maxSampleRate != null
    ? Number(a.maxSampleRate) || 0
    : Math.max(0, ...tracks.map(t => Number(t.sampleRate) || 0))
  return {
    artist: a.artist || a.albumArtist || '',
    album: a.name || a.album || '',
    lossless: tracks.length ? losslessCount >= tracks.length / 2 : false,
    maxBitDepth,
    maxSampleRate,
    ref: a,
  }
}

// ── Upgrade detection ─────────────────────────────────────────────────────────
// The flagship comparison. Given a peer album and the matching library album,
// decide whether the peer's copy is genuinely better. "Better" means, in order:
//   1. peer is lossless where yours is lossy       (the big one)
//   2. peer has higher bit depth                    (16 → 24)
//   3. peer has a higher sample rate                (44.1 → 96)
// A peer copy that is only equal, or worse, is NOT an upgrade.
//
// Returns null when it is not an upgrade, otherwise a reason object with the
// human strings the card renders: { kind, yours, theirs }.
function upgradeReason(peer, mine) {
  if (!peer || !mine) return null

  const peerLossless = !!peer.lossless
  const mineLossless = !!mine.lossless

  // 1. Lossless beats lossy outright.
  if (peerLossless && !mineLossless) {
    return {
      kind: 'lossless',
      yours: qualityString(mine),
      theirs: qualityString(peer),
    }
  }
  // If yours is lossless and theirs is lossy, never an upgrade.
  if (!peerLossless && mineLossless) return null

  // Both same lossy/lossless class: compare depth then rate. Only meaningful for
  // lossless (lossy files rarely carry reliable depth/rate).
  if (peerLossless && mineLossless) {
    if (peer.maxBitDepth > mine.maxBitDepth && peer.maxBitDepth >= 24) {
      return { kind: 'bitdepth', yours: qualityString(mine), theirs: qualityString(peer) }
    }
    if (peer.maxBitDepth >= mine.maxBitDepth && peer.maxSampleRate > mine.maxSampleRate
        && peer.maxSampleRate >= 88200) {
      return { kind: 'samplerate', yours: qualityString(mine), theirs: qualityString(peer) }
    }
  }
  return null
}

function qualityString(x) {
  if (!x) return ''
  if (x.lossless) {
    if (x.maxBitDepth && x.maxSampleRate) return `FLAC ${x.maxBitDepth}/${Math.round(x.maxSampleRate / 1000)}`
    if (x.maxSampleRate) return `FLAC ${Math.round(x.maxSampleRate / 1000)}kHz`
    return 'FLAC'
  }
  return 'MP3'
}

// ── Shelf assembly ────────────────────────────────────────────────────────────
// Given the parsed peer albums and the user's library, build the shelves.
// Returns { upgrades, missing, surround, hires, everything, stats }.
//
// `detectSurround` is injected (window.PapaSlskFilters.detectSurround in the
// app, or a stub in tests) so this module carries no dependency on the filter
// module's window binding.
function buildShelves(peerAlbums, library, { detectSurround = null } = {}) {
  const albums = peerAlbums || []
  // Precompute the library ONCE into a bucketed index of pre-tokenised
  // comparables. Every peer album then compares only against its own first-token
  // bucket instead of the whole library — the fix for the open-freeze.
  const libIndex = buildLibraryIndex(library)

  const upgrades = []
  const missing = []

  for (const pa of albums) {
    // Pre-tokenise the peer side once (its Sets are reused by findMatch and
    // upgradeReason reads the quality fields off the same object).
    const peerComp = albumComparable({
      artist: pa.artist,
      album: pa.album,
      lossless: pa.lossless,
      maxBitDepth: pa.maxBitDepth,
      maxSampleRate: pa.maxSampleRate,
    })
    // Find the best library match through the bucketed index.
    const match = libIndex.findMatch(peerComp)
    if (match) {
      const reason = upgradeReason(peerComp, match)
      if (reason) upgrades.push({ ...pa, upgrade: reason, matchedLibId: match.ref && match.ref.id })
      // A match that's not an upgrade is simply "in library" — it lands only in
      // Everything, not in Missing.
    } else {
      missing.push(pa)
    }
  }

  const isSurround = (pa) => {
    if (!detectSurround) return false
    const names = pa.files.map(f => f.name || f.filename || '').join(' ')
    return !!detectSurround(`${pa.folderPath} ${pa.folderName} ${names}`)
  }

  const surround = albums.filter(isSurround)
  const hires = albums.filter(a => a.isHiRes)

  // Sort helpers. Quality rank: lossless hi-res > lossless > lossy; then size.
  const qualRank = (a) => (a.lossless ? (a.isHiRes ? 3 : 2) : 1)
  const byQualThenSize = (a, b) => qualRank(b) - qualRank(a) || (b.totalSize - a.totalSize)

  missing.sort(byQualThenSize)
  const everything = albums.slice().sort((a, b) => {
    const ak = (a.artist || a.album || '').toLowerCase()
    const bk = (b.artist || b.album || '').toLowerCase()
    return ak.localeCompare(bk) || (a.album || '').toLowerCase().localeCompare((b.album || '').toLowerCase())
  })

  return {
    upgrades,
    missing,
    surround: surround.sort(byQualThenSize),
    hires: hires.sort(byQualThenSize),
    everything,
    stats: computeStats(albums, { surroundCount: surround.length }),
  }
}

// ── Collection stats ──────────────────────────────────────────────────────────
// The hero header numbers: albums, tracks, size, % lossless, hi-res count,
// surround count.
function computeStats(albums, { surroundCount = 0 } = {}) {
  let tracks = 0
  let size = 0
  let losslessTracks = 0
  let hiResAlbums = 0
  for (const a of albums) {
    tracks += a.trackCount || 0
    size += a.totalSize || 0
    losslessTracks += a.losslessCount || 0
    if (a.isHiRes) hiResAlbums++
  }
  return {
    albums: albums.length,
    tracks,
    size,
    losslessPct: tracks ? Math.round((losslessTracks / tracks) * 100) : 0,
    hiRes: hiResAlbums,
    surround: surroundCount,
  }
}

// Group albums alphabetically by artist first-letter (for the Everything grid's
// sticky headers). Non-letters bucket under '#'. Returns an ordered array of
// { letter, albums }.
function groupByLetter(albums) {
  const buckets = new Map()
  for (const a of albums) {
    const key = normKey(a.artist || a.album || '#')
    let letter = (key[0] || '#').toUpperCase()
    if (!/[A-Z]/.test(letter)) letter = '#'
    if (!buckets.has(letter)) buckets.set(letter, [])
    buckets.get(letter).push(a)
  }
  return [...buckets.keys()].sort().map(letter => ({ letter, albums: buckets.get(letter) }))
}

// ── Size formatting ───────────────────────────────────────────────────────────
// One size formatter for the whole app so "6453.3 GB" never happens again: it
// rolls up to TB/PB and never shows a four-plus-digit unit. Bytes in, human
// string out. Kept here (a dependency-free, unit-tested module) so both the
// search hub and the record shop can share it.
function fmtSize(bytes) {
  let n = Number(bytes) || 0
  if (n < 0) n = 0
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  // Bytes and KB read cleaner as whole numbers; MB and up get one decimal, but
  // a value that rounds to a whole number drops the trailing ".0".
  let str
  if (i <= 1) str = String(Math.round(n))
  else {
    str = n.toFixed(1)
    if (str.endsWith('.0')) str = str.slice(0, -2)
  }
  return `${str} ${units[i]}`
}

// ── Source scoring (search results) ───────────────────────────────────────────
// Rank one search folder-group as a download source. Higher is better. This is
// the same signal set the search grid already ranks on (lossless, free slot,
// queue depth, upload speed, track count) distilled into a single comparable
// number so the merged card can pick its "best source" and order its expanded
// source list. Pure and self-contained: no window, no filters module.
function sourceScore(g) {
  if (!g) return -Infinity
  const files = g.files || []
  const flac = files.filter(f => f.isFlac || isLosslessName(f.name || f.filename)).length
  let s = 0
  s += flac * 8
  s += Math.min(files.length, 20) * 2
  if (g.hasFreeSlot) s += 25
  const q = Number(g.queueLength) || 0
  if (q > 0) s -= Math.min(Math.log2(q + 1) * 3, 30)
  const spd = Number(g.uploadSpeed) || 0
  if (spd > 0) s += Math.min(Math.log2(spd / 1024 + 1) * 2, 12)
  if (files.length === 1) s -= 5
  return s
}

// A representative-quality tuple for a source group, used to pick the highest
// quality across all people who hold an album. Ordered lossless-hi-res >
// lossless > lossy, then by depth, then rate.
function sourceQuality(g) {
  const files = (g && g.files) || []
  const lossless = files.some(f => f.isFlac || isLosslessName(f.name || f.filename))
  const maxBitDepth = Math.max(0, ...files.map(f => Number(f.bitDepth) || 0))
  const maxSampleRate = Math.max(0, ...files.map(f => Number(f.sampleRate) || 0))
  const hiRes = maxBitDepth >= 24 || maxSampleRate >= 88200
  return { lossless, hiRes, maxBitDepth, maxSampleRate }
}
function qualityRankTuple(q) {
  return [q.lossless ? (q.hiRes ? 2 : 1) : 0, q.maxBitDepth || 0, q.maxSampleRate || 0]
}

// ── Album-identity merge over search folder-groups ────────────────────────────
// The search grid renders one card per folder-group, so the same album held by
// 30 sharers is 30 cards. This collapses those into one card per album identity:
// folder-groups whose parsed {artist, album} match (via albumsMatch) join the
// same bucket. Each merged album carries every source group, sorted best-first,
// and precomputes the fields a merged card needs — best source, best quality,
// people count, year, size, surround/lossless/hi-res flags.
//
// `parse` lets a caller inject a folder-path→{artist,album,year} parser (the app
// splits paths on backslashes before handing them here); it defaults to reading
// folderPath/folderName with the module's own parser.
function mergeSourcesByAlbum(groups, { detectSurround = null, parse = null } = {}) {
  const doParse = parse || ((g) => {
    const raw = String(g.folderPath || g.folderName || '')
    const segs = raw.split(/[\\/]/).filter(Boolean)
    return parseAlbumFolder(segs.length ? segs : [g.folderName || ''])
  })

  // Buckets indexed by album token, mirroring buildLibraryIndex: a group can only
  // merge into a bucket sharing an album token with it (a match needs ≥60% token
  // overlap), so we scan only those buckets — the earliest-created matching bucket
  // wins, preserving the old "merge into the first matching bucket" behaviour even
  // when tokens are reordered. `order` keeps first-seen bucket order for a stable
  // output. Turns the merge from O(n²) to roughly O(n).
  const byToken = new Map()   // albumToken → [bucket]
  const order = []
  for (const g of (groups || [])) {
    const p = doParse(g)
    const ident = { artist: p.artist || '', album: p.album || g.folderName || '', year: p.year || null }
    const identComp = albumComparable(ident)
    // A parsed album is required to merge; when parsing yields nothing usable we
    // fall back to the folder name as the album so the group still forms a
    // (singleton) bucket rather than vanishing.
    let placed = null
    let placedSeq = Infinity
    const seen = new Set()
    for (const tok of identComp.albumTokens) {
      const candidates = byToken.get(tok)
      if (!candidates) continue
      for (const b of candidates) {
        if (b.seq >= placedSeq || seen.has(b.seq)) continue
        seen.add(b.seq)
        // Same album identity: album+artist agree. Reuse the shelf matcher so the
        // same fuzzy rules ("The Beatles" == "beatles") apply here.
        if (albumsMatchComparable(identComp, b.identComp, 0.6, 0.34)) { placed = b; placedSeq = b.seq }
      }
    }
    if (!placed) {
      placed = { ident, identComp, sources: [], seq: order.length }
      order.push(placed)
      for (const tok of identComp.albumTokens) {
        let arr = byToken.get(tok)
        if (!arr) { arr = []; byToken.set(tok, arr) }
        arr.push(placed)
      }
    }
    placed.sources.push(g)
    // Prefer the richest identity as the bucket label: keep a year/artist when a
    // later, sparser member lacks them.
    if (!placed.ident.artist && ident.artist) placed.ident.artist = ident.artist
    if (!placed.ident.year && ident.year) placed.ident.year = ident.year
  }
  const buckets = order

  return buckets.map(b => finalizeMergedAlbum(b, detectSurround))
}

function finalizeMergedAlbum(bucket, detectSurround) {
  const sources = bucket.sources.slice().sort((a, b) => {
    // Best quality first, then best availability/score.
    const qr = qualityRankTuple(sourceQuality(b)).join(',')
      .localeCompare(qualityRankTuple(sourceQuality(a)).join(','), undefined, { numeric: true })
    if (qr !== 0) return qr > 0 ? 1 : -1
    return sourceScore(b) - sourceScore(a)
  })
  // Best source = highest quality, then highest score (already sorted).
  const best = sources[0] || null
  // Best quality across ALL sources (a fast peer may hold a lesser rip than a
  // slow one; the headline quality is the best available, regardless of who).
  let bestQ = { lossless: false, hiRes: false, maxBitDepth: 0, maxSampleRate: 0 }
  for (const s of sources) {
    const q = sourceQuality(s)
    if (qualityRankTuple(q).join(',').localeCompare(
        qualityRankTuple(bestQ).join(','), undefined, { numeric: true }) > 0) bestQ = q
  }
  const surround = detectSurround
    ? sources.some(s => {
        const names = (s.files || []).map(f => f.name || f.filename || '').join(' ')
        return !!detectSurround(`${s.folderPath || ''} ${s.folderName || ''} ${names}`)
      })
    : false
  // Card size/track shown for the BEST source (what its DL button will grab).
  const bestFiles = (best && best.files) || []
  const totalSize = bestFiles.reduce((n, f) => n + (Number(f.size) || 0), 0)
  return {
    artist: bucket.ident.artist || '',
    album: bucket.ident.album || (best && best.folderName) || '',
    year: bucket.ident.year || null,
    peopleCount: sources.length,
    best,
    bestQuality: bestQ,
    lossless: bestQ.lossless,
    isHiRes: bestQ.hiRes,
    surround,
    trackCount: bestFiles.length,
    totalSize,
    sources,
  }
}

// Sort a list of merged albums by one of the shop keys. Descending "best first"
// for quality/size/year; ascending A–Z. Pure; returns a new array.
function sortMergedAlbums(albums, key) {
  const arr = (albums || []).slice()
  // Works for merged search albums (bestQuality/best) AND for shelf albums from
  // extractAlbums, which carry lossless/isHiRes/maxBitDepth/maxSampleRate flat.
  const qr = (a) => {
    if (a.bestQuality) return qualityRankTuple(a.bestQuality)
    if (a.best) return qualityRankTuple(sourceQuality(a.best))
    if (typeof a.lossless === 'boolean' || a.maxBitDepth != null) {
      return qualityRankTuple({
        lossless: !!a.lossless, hiRes: !!a.isHiRes,
        maxBitDepth: a.maxBitDepth || 0, maxSampleRate: a.maxSampleRate || 0,
      })
    }
    return qualityRankTuple(sourceQuality({ files: a.files || [] }))
  }
  switch (key) {
    case 'quality':
      return arr.sort((a, b) => {
        const c = qr(b).join(',').localeCompare(qr(a).join(','), undefined, { numeric: true })
        return c !== 0 ? c : (b.totalSize || 0) - (a.totalSize || 0)
      })
    case 'year':
      // Unknown years sink to the bottom rather than pretending to be year 0.
      return arr.sort((a, b) => (b.year || -1) - (a.year || -1))
    case 'size':
      return arr.sort((a, b) => (b.totalSize || 0) - (a.totalSize || 0))
    case 'az':
    default:
      return arr.sort((a, b) => {
        const ak = (a.artist || a.album || '').toLowerCase()
        const bk = (b.artist || b.album || '').toLowerCase()
        return ak.localeCompare(bk) ||
          (a.album || '').toLowerCase().localeCompare((b.album || '').toLowerCase())
      })
  }
}

const shApi = {
  extractAlbums, parseAlbumFolder, buildAlbum, buildShelves, computeStats,
  upgradeReason, albumsMatch, albumsMatchComparable, albumComparable,
  buildLibraryIndex, tokenScore, tokenScoreSets, normKey, normTokenSet,
  cleanSegment, extractYear,
  isDiscFolder, groupByLetter, albumQualityLabel, libAlbumToComparable,
  isAudioName, isLosslessName, qualityString, SH_AUDIO_RE, SH_LOSSLESS_EXT,
  fmtSize, sourceScore, sourceQuality, qualityRankTuple, mergeSourcesByAlbum,
  finalizeMergedAlbum, sortMergedAlbums,
}

if (typeof module !== 'undefined' && module.exports) module.exports = shApi
if (typeof window !== 'undefined') window.PapaSlskShelves = shApi
