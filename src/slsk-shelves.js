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

// The trailing extension, lowercased — `/\.([a-z0-9]+)$/` over the lowercased
// name, and nothing else.
//
// This is called twice for every file in a share (once through isLosslessName,
// once for the majority-extension count), so on a 64,000-file peer it ran
// ~128,000 times and allocated a lowercased copy of the whole filename plus a
// match array on each one. That was 16% of album extraction and a large share
// of its garbage. The fast path walks back from the end over ASCII
// alphanumerics instead and lowercases nothing but the extension itself.
//
// The slow path is not decoration. Two non-ASCII characters lowercase INTO the
// a-z range — the Kelvin sign U+212A ("K" → "k") and the long s U+017F ("ſ" →
// "s") — so a filename ending in one of those really would be matched by the
// original regex and missed by an ASCII-only scan. Any non-ASCII byte in the
// tail therefore falls back to the exact original expression.
const EXT_RE = /\.([a-z0-9]+)$/
function extOf(name) {
  const s = String(name || '')
  let i = s.length
  while (i > 0) {
    const c = s.charCodeAt(i - 1)
    if (c >= 48 && c <= 57) { i--; continue }              // 0-9
    if (c >= 97 && c <= 122) { i--; continue }             // a-z
    if (c >= 65 && c <= 90) { i--; continue }              // A-Z
    if (c >= 128) { const m = s.toLowerCase().match(EXT_RE); return m ? m[1] : '' }
    break
  }
  // Needs a dot immediately before a non-empty run of alphanumerics.
  if (i === s.length || i === 0 || s.charCodeAt(i - 1) !== 46) return ''
  return s.slice(i).toLowerCase()
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

// A leaf segment that is ONLY a quality/source label: "44.1", "FLAC", "16-44",
// "24bit", "WEB". People file these as the last folder of a path
// ("…\In Rainbows\FLAC\"), and the shop rendered each one as its own
// one-person album sitting beside the real merged card. It is not an album
// name — it is the same album, one folder deeper.
//
// Deliberately strict: the whole segment must be the label and nothing else, so
// "24 Carat Black" and "1999" stay albums.
const QUALITY_LEAF_RE = new RegExp(
  '^[\\s._-]*(?:' +
  '(?:16|24|32)[\\s._-]*(?:bit)?[\\s._-]*(?:44(?:[._]1)?|48|88(?:[._]2)?|96|176(?:[._]4)?|192)?' +
  '|(?:44[._]1|88[._]2|176[._]4|48|96|192)(?:[\\s._-]*k?hz)?' +
  '|flac|mp3|wav|aiff?|alac|ape|wv|dsd|dsf|dff|opus|ogg|m4a' +
  '|lossless|hi[\\s._-]?res|hires|vinyl|web|webflac|cd|cdrip|cdda|scans?|artwork|covers?' +
  ')[\\s._-]*(?:bit|khz|hz|kbps)?[\\s._-]*$', 'i')

function isQualityLeaf(name) {
  const n = String(name || '').trim()
  if (!n) return false
  // A bare number on its own is a disc or a year, not a quality label; the
  // alternation above would otherwise swallow "48" and "96" as sample rates in
  // isolation, which is right for "…\96\" beside "…\FLAC\" and wrong for
  // nothing else we have seen. Keep it: the guard here is only against the
  // empty-ish cases.
  return QUALITY_LEAF_RE.test(n)
}

// Peel trailing noise segments off a folder path before parsing it as an album.
// "…\In Rainbows\Disc 1" and "…\In Rainbows\FLAC" are both the SAME album as
// "…\In Rainbows"; parsing the raw leaf made three albums out of one. Never
// strips down to nothing — a path that is only noise keeps its last segment.
//
// Cost is O(segments) once per group, not per comparison, so the merge stays
// linear.
function stripLeafNoise(segs) {
  const out = (segs || []).slice()
  while (out.length > 1) {
    const leaf = out[out.length - 1]
    if (isDiscFolder(leaf) || isQualityLeaf(leaf)) out.pop()
    else break
  }
  return out
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
// slskd can serve a share behind an anonymised ALIAS: the top path segment
// becomes a literal "@@" plus a short random token ("@@aeylt", "@@agaud",
// "@@papvf"). It is not a folder the peer named and it is certainly not an
// artist — but it sits exactly where the artist folder would, so the parser
// below read it as one. On one real peer that put "@@aeylt" on the artist line
// of 109 of 439 cards (24.8%).
//
// Treating it as a generic container is the whole fix: the artist falls back to
// empty, which is the truth (the alias replaced the artist folder, so the path
// carries no artist), and every deeper path — "@@papvf\Music\3 Speed\…", where
// the real artist folder is still there — is untouched. Anchored and strict on
// purpose: no whitespace, alphanumerics only, so a folder a human actually
// named "@@ my rips" is not swallowed by it.
const SHARE_ALIAS_RE = /^@@[a-z0-9]+$/i
function isShareAlias(name) {
  return SHARE_ALIAS_RE.test(String(name || '').trim())
}
function isGenericContainer(name) {
  const s = String(name || '').trim()
  return GENERIC_CONTAINERS.has(s.toLowerCase()) || isShareAlias(s)
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
    // Channel truth rides along so upgradeReason can see it. `channels` is a
    // count (the library side knows one); `surround` is a boolean (the peer
    // side has only folder/file text to read, never a channel count).
    channels: x.channels,
    surround: x.surround,
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
    _libIndexInsert(buckets, noKey, a, order++)
  }
  return { findMatch: _libIndexFinder(buckets, noKey, albumMin, artistMin), buckets, noKey }
}

// One library album into the token buckets. Shared by the sync builder above and
// the chunked builder below so the two can never drift.
// `n` (the album-token count) and `g` (a scan-generation stamp) ride on the
// entry so the finder's gates below cost two integer compares and allocate
// nothing per lookup.
function _libIndexInsert(buckets, noKey, a, order) {
  const comp = albumComparable(a && a.albumTokens instanceof Set ? a : libAlbumToComparable(a))
  const entry = { comp, order, n: comp.albumTokens.size, g: 0 }
  if (!entry.n) { noKey.push(entry); return }
  for (const tok of comp.albumTokens) {
    let arr = buckets.get(tok)
    if (!arr) { arr = []; buckets.set(tok, arr) }
    arr.push(entry)
  }
}

// ── Two exact gates that let the finder skip candidates without reading them ──
//
// Bucketing by token already beat the full O(peer × library) sweep, but it left
// one pathology: a token like "the" is carried by hundreds of albums (measured
// on a real 4,128-album share: "the" ×486, "of" ×370, "hits" ×195), so every
// peer album whose title contains it drags that whole bucket into the scan. The
// two gates below cut those buckets out WITHOUT changing a single answer.
//
// Both fall out of the same algebra. tokenScoreSets is inter/(na+nb-inter),
// strictly increasing in `inter`, with inter <= min(na, nb); and
// albumsMatchComparable rejects outright unless that score reaches albumMin (m).
//
//   (1) TOKEN-COUNT BAND. The best score two token sets of sizes na and nb could
//       ever reach is min(na,nb)/max(na,nb) — take inter = min, which also makes
//       the union max. If that is below m the matcher WILL reject the pair, so
//       it can be skipped unread.
//
//   (2) PREFIX FILTER. Rearranging inter/(na+nb-inter) >= m gives
//       inter >= m(na+nb)/(1+m); and every candidate that survives gate (1) has
//       nb >= m·na, so inter >= m·na. A matching library album therefore shares
//       at least r = ceil(m·na) of the peer's na album tokens — it is ABSENT
//       from at most na - r of them. Let F be the peer tokens whose bucket is
//       empty (no library album carries them): every candidate is absent from
//       all F, so among the na - F non-empty buckets it is absent from at most
//       (na - F) - r. Pigeonhole: scanning any (na - F) - r + 1 of those buckets
//       is GUARANTEED to contain every album that could match. We scan the
//       rarest that many, which is what stops "the" from costing anything.
//
// The +1 is the whole proof and is easy to drop by accident; without it the
// filter silently loses real matches. test/slsk-shelves-equivalence.test.js
// checks findMatch against a full frozen scan for every album in a 5,000-album
// corpus, at four different albumMin settings, which is what catches that.
//
// Both gates are NECESSARY conditions only: anything they let through is still
// put to the full albumsMatchComparable test, so the answer is unchanged.
//
// All of it is conditional on m > 0. At albumMin <= 0 a score of 0 passes, so
// nothing can be excluded and the finder falls back to the original scan —
// including the no-album-token bucket, which at m > 0 provably cannot match
// (its score against anything is 0) and is skipped.
function _countsCanMatch(na, nb, albumMin) {
  if (na <= 0 || nb <= 0) return albumMin <= 0
  return (na <= nb ? na / nb : nb / na) >= albumMin
}
function _minSharedTokens(na, albumMin) {
  if (!(albumMin > 0)) return 1
  // Biased LOW on purpose (0.6 * 5 can land at 3.0000000000000004, and ceil of
  // that would be 4). A smaller floor only ever means scanning more buckets.
  return Math.max(1, Math.ceil(albumMin * na - 1e-9))
}
// The band as an integer interval, derived by asking _countsCanMatch itself
// rather than by re-deriving the inequality — so the two cannot disagree on a
// floating-point edge. _countsCanMatch(na, ·, m) is monotone either side of na
// (nb/na rises up to nb = na, na/nb falls after it), so the accepting nb form
// one contiguous run and walking outwards from na finds both ends exactly.
// Memoised per na; the per-entry test is then two integer compares, no division.
function _countBand(cache, na, albumMin) {
  let band = cache[na]
  if (band) return band
  if (!(albumMin > 0)) { band = cache[na] = [1, Infinity]; return band }
  if (na < 1 || !_countsCanMatch(na, na, albumMin)) { band = cache[na] = [1, 0]; return band }
  let lo = na
  while (lo > 1 && _countsCanMatch(na, lo - 1, albumMin)) lo--
  let hi = na
  // Bounded: na/hi falls monotonically and crosses albumMin at hi = na/albumMin.
  const ceiling = na / albumMin + 2
  while (hi < ceiling && _countsCanMatch(na, hi + 1, albumMin)) hi++
  band = cache[na] = [lo, hi]
  return band
}
function _byBucketLength(x, y) { return x.length - y.length }

// The ungated scan, kept verbatim from before the gates went in. It is what runs
// when albumMin <= 0, where a score of 0 counts as a match and therefore nothing
// — not even a library album sharing no tokens at all — can be ruled out ahead
// of time. Nobody calls the shop that way, but buildLibraryIndex takes albumMin
// as an option, so the branch has to be right rather than merely unreachable.
function _scanEveryBucket(buckets, noKey, pc, albumMin, artistMin) {
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

// The finder over a finished bucket index — factored out of buildLibraryIndex so
// buildLibraryIndexChunked returns the identical closure.
function _libIndexFinder(buckets, noKey, albumMin, artistMin) {
  // A monotonically rising stamp so a library album reachable through several of
  // the peer's tokens is tested only once per lookup — the job the old `seen`
  // Set did, without allocating a Set per peer album.
  let gen = 0
  const arrs = []          // scratch, reused across lookups
  const bandCache = []

  // Find the first (in library order) library comparable that confidently
  // matches a peer comparable.
  const findMatch = (peerComp) => {
    const pc = albumComparable(peerComp)
    if (!(albumMin > 0)) return _scanEveryBucket(buckets, noKey, pc, albumMin, artistMin)

    let match = null
    let matchOrder = Infinity
    const na = pc.albumTokens.size
    arrs.length = 0
    let free = 0                 // peer tokens no library album carries at all
    for (const tok of pc.albumTokens) {
      const arr = buckets.get(tok)
      if (arr) arrs.push(arr)
      else free++
    }
    // (na - free) - r + 1 buckets, rarest first. <= 0 means no album can clear
    // the token floor, so there is nothing to scan.
    const need = (na - free) - _minSharedTokens(na, albumMin) + 1
    if (need <= 0 || !arrs.length) return null
    if (need < arrs.length) {
      arrs.sort(_byBucketLength)
      arrs.length = need
    }
    const g = ++gen
    const band = _countBand(bandCache, na, albumMin)
    const nLo = band[0]
    const nHi = band[1]
    for (const arr of arrs) {
      // Entries were appended in library order, so `order` rises along a bucket:
      // the first entry that cannot beat the current best means none of the rest
      // can either.
      for (let i = 0; i < arr.length; i++) {
        const entry = arr[i]
        if (entry.order >= matchOrder) break
        const nb = entry.n
        if (nb < nLo || nb > nHi) continue
        if (entry.g === g) continue
        entry.g = g
        if (albumsMatchComparable(pc, entry.comp, albumMin, artistMin)) {
          match = entry.comp; matchOrder = entry.order
          break
        }
      }
    }
    return match
  }
  return findMatch
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

  // The same count gatherWithDiscs would report, without building the array. A
  // node with real subfolders is a shelf, and the only thing the walk asks of
  // its gathered files is whether there are at least `minTracks` of them — so
  // the array the old code built for every shelf in the tree was allocated,
  // filled and thrown away. (The mixed-node album below is built from the
  // node's OWN audio, never from the gathered list, so nothing needs it.)
  const countWithDiscs = (node) => {
    let n = 0
    for (const f of node.files) if (isAudioName(f.name || f.filename)) n++
    if (node.dirs && node.dirs.size) {
      for (const child of node.dirs.values()) {
        if (isDiscFolder(child.name)) n += countWithDiscs(child)
      }
    }
    return n
  }

  const walk = (node, segs) => {
    // Non-disc subfolders decide whether this node is a leaf album or a shelf.
    const realSubdirs = []
    if (node.dirs && node.dirs.size) {
      for (const child of node.dirs.values()) {
        if (!isDiscFolder(child.name)) realSubdirs.push(child)
      }
    }

    if (realSubdirs.length === 0) {
      const gathered = gatherWithDiscs(node)
      if (gathered.files.length >= minTracks && node.path) {
        albums.push(buildAlbum(node, segs, gathered))
        return
      }
      // No real subfolders and not enough audio: nothing to recurse into and
      // nothing to emit. (The old code fell through to a loop over an empty
      // realSubdirs list and a guard that required realSubdirs.length.)
      return
    }
    {
      // Recurse into the real (non-disc) subfolders only. If this node ALSO has
      // its own loose audio (a "shelf with a few stray tracks"), we still treat
      // it as an album when it clears the threshold and has no real subdirs —
      // handled above. Mixed nodes (subdirs + own audio meeting the bar) are
      // rare; prefer treating the subfolders as the albums.
      for (const child of realSubdirs) walk(child, segs.concat(child.name))
      // Edge case: a node with real subdirs but also enough of its own audio to
      // be an album in its own right (e.g. a "Singles" folder). Emit it too.
      // Note the gate is on the GATHERED count while the album is built from the
      // node's own audio — faithfully odd, and kept that way on purpose.
      if (node.path && countWithDiscs(node) >= minTracks) {
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
  // One walk of the file list for all five roll-ups. It used to be five walks,
  // three of which allocated a throwaway array, and two of which spread that
  // array into Math.max as ARGUMENTS. That last part was not merely slow: a
  // folder holding one flat pile of ~125,000 files — an ordinary shape on
  // Soulseek, and the shape extractAlbums produces for a peer who shares
  // everything loose in one directory — overflows the argument limit and throws
  // RangeError outright, so the album never builds at all.
  let totalSize = 0
  let losslessCount = 0
  let maxBitDepth = 0
  let maxSampleRate = 0
  // Representative format: majority extension.
  const counts = {}
  for (const f of files) {
    totalSize += Number(f.size) || 0
    const nm = f.name || f.filename
    // extOf ONCE per file. isLosslessName(nm) is by definition
    // SH_LOSSLESS_EXT.has(extOf(nm)), and the majority-extension count needs the
    // same value, so calling both was extracting the extension twice.
    const e = extOf(nm)
    if (SH_LOSSLESS_EXT.has(e) || f.isFlac) losslessCount++
    const bd = Number(f.bitDepth) || 0
    if (bd > maxBitDepth) maxBitDepth = bd
    const sr = Number(f.sampleRate) || 0
    if (sr > maxSampleRate) maxSampleRate = sr
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
  // Lossy: bitrate if we have it. Plain loop, no argument spread — see buildAlbum.
  let kbps = 0
  for (const f of album.files) { const b = Number(f.bitRate) || 0; if (b > kbps) kbps = b }
  return kbps ? `${fmt} · ${kbps}` : fmt
}

// ── Library adaptation ────────────────────────────────────────────────────────
// The renderer's library albums have their own shape ({ name, artist, year,
// tracks:[{filePath,bitsPerSample,sampleRate,channels}], isHiRes,
// maxBitsPerSample, maxSampleRate, maxChannels }). Reduce one to the comparable
// {artist, album, lossless, maxBitDepth, maxSampleRate, channels} shape the
// upgrade logic needs.
//
// `channels` is not decoration. Its absence is what let the shop offer a STEREO
// hi-res rip as an "upgrade" over a 5.1 master — see upgradeReason. A library
// album that carries maxChannels is believed; otherwise the widest track wins,
// and 0 means "we do not know", which is treated as no claim either way.
function libAlbumToComparable(a) {
  const tracks = a.tracks || []
  // One walk, no argument spread — same reasons as buildAlbum. A library album
  // with a six-figure track list is rarer than a peer folder with one, but the
  // RangeError is the same RangeError.
  let losslessCount = 0
  let depthFallback = 0
  let rateFallback = 0
  let chanFallback = 0
  for (const t of tracks) {
    if (isLosslessName(t.filePath || t.path || '')) losslessCount++
    const bd = Number(t.bitsPerSample || t.bitDepth) || 0
    if (bd > depthFallback) depthFallback = bd
    const sr = Number(t.sampleRate) || 0
    if (sr > rateFallback) rateFallback = sr
    const ch = Number(t.channels) || 0
    if (ch > chanFallback) chanFallback = ch
  }
  const maxBitDepth = a.maxBitsPerSample != null ? Number(a.maxBitsPerSample) || 0 : depthFallback
  const maxSampleRate = a.maxSampleRate != null ? Number(a.maxSampleRate) || 0 : rateFallback
  const channels = a.maxChannels != null ? Number(a.maxChannels) || 0 : chanFallback
  return {
    artist: a.artist || a.albumArtist || '',
    album: a.name || a.album || '',
    lossless: tracks.length ? losslessCount >= tracks.length / 2 : false,
    maxBitDepth,
    maxSampleRate,
    channels,
    ref: a,
  }
}

// ── Upgrade detection ─────────────────────────────────────────────────────────
// The flagship comparison. Given a peer album and the matching library album,
// decide whether the peer's copy is genuinely better. "Better" means, in order:
//   0. CHANNELS, before anything else                (5.1 → stereo is a LOSS)
//   1. peer is lossless where yours is lossy         (the big one)
//   2. peer has higher bit depth                     (16 → 24)
//   3. peer has a higher sample rate                 (44.1 → 96)
// A peer copy that is only equal, or worse, is NOT an upgrade.
//
// Gate 0 is the one this comparison shipped without, and it is the one that
// matters most. Depth and rate said a peer's stereo FLAC 24/192 beat a 6-channel
// 24/88.2 master, so the shop listed nine of his surround albums under "better
// than your copies" and "Grab all" would have replaced them with stereo. No
// sample rate buys back a discrete rear channel: a stereo copy of a surround
// album is a DIFFERENT, smaller record, never an upgrade of it.
//
// The two sides know different things. The library knows a channel COUNT (from
// the tags); the peer side has only folder and file text, because slskd never
// reports channels — so the peer carries a `surround` boolean from
// detectSurround instead. Unknown on either side (0 / undefined) makes no claim
// and falls through to the quality ladder exactly as before.
//
// Returns null when it is not an upgrade, otherwise a reason object with the
// human strings the card renders: { kind, yours, theirs }.
function upgradeReason(peer, mine) {
  if (!peer || !mine) return null

  const mineChannels = Number(mine.channels) || 0
  const mineSurround = mineChannels >= 5
  const peerSurround = !!peer.surround

  // 0a. Never sell stereo as an upgrade over a surround master. This is the
  //     guard the 5.1 scar is named after; deleting it puts the scar back.
  if (mineSurround && !peerSurround) return null
  // 0b. The honest opposite: they have the surround mix and yours is stereo.
  //     Requires a KNOWN stereo/mono count — an album whose channels we never
  //     read is not evidence of anything.
  if (peerSurround && mineChannels > 0 && !mineSurround) {
    return {
      kind: 'surround',
      yours: qualityString(mine),
      theirs: qualityString(peer),
    }
  }

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

// The card's "Yours: … → Theirs: …" strings. A channel layout is appended when
// we know one, because "FLAC 24/88" beside "FLAC 24/192" is exactly the reading
// that made a stereo rip look like the better record.
function qualityString(x) {
  if (!x) return ''
  let s
  if (x.lossless) {
    if (x.maxBitDepth && x.maxSampleRate) s = `FLAC ${x.maxBitDepth}/${Math.round(x.maxSampleRate / 1000)}`
    else if (x.maxSampleRate) s = `FLAC ${Math.round(x.maxSampleRate / 1000)}kHz`
    else s = 'FLAC'
  } else s = 'MP3'
  return s + channelSuffix(x)
}

// " · 5.1" / " · 7.1" / " · surround" / "" — never a guess. The peer side has
// only a boolean, so it says "surround" rather than inventing a count.
function channelSuffix(x) {
  const ch = Number(x && x.channels) || 0
  if (ch >= 8) return ' · 7.1'
  if (ch >= 6) return ' · 5.1'
  if (ch >= 5) return ' · 5.0'
  if (ch >= 4) return ' · quad'
  if (!ch && x && x.surround) return ' · surround'
  return ''
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

  // Surround is decided BEFORE the upgrade sweep now, because upgradeReason
  // needs it (see gate 0 there). It is the same single detectSurround call per
  // album the Surround shelf already paid for — read once, used twice — so this
  // adds no work, and the flags are kept beside the albums rather than stamped
  // on them so a caller's objects are not mutated.
  const isSurroundAlbum = (pa) => {
    if (!detectSurround) return false
    const names = pa.files.map(f => f.name || f.filename || '').join(' ')
    return !!detectSurround(`${pa.folderPath} ${pa.folderName} ${names}`)
  }
  const surroundFlags = albums.map(isSurroundAlbum)

  for (let i = 0; i < albums.length; i++) {
    const pa = albums[i]
    // Pre-tokenise the peer side once (its Sets are reused by findMatch and
    // upgradeReason reads the quality fields off the same object).
    const peerComp = albumComparable({
      artist: pa.artist,
      album: pa.album,
      lossless: pa.lossless,
      maxBitDepth: pa.maxBitDepth,
      maxSampleRate: pa.maxSampleRate,
      surround: surroundFlags[i] || !!pa.surround,
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

  const surround = albums.filter((_a, i) => surroundFlags[i])
  const hires = albums.filter(a => a.isHiRes)

  // Sort helpers. Quality rank: lossless hi-res > lossless > lossy; then size.
  const qualRank = (a) => (a.lossless ? (a.isHiRes ? 3 : 2) : 1)
  const byQualThenSize = (a, b) => qualRank(b) - qualRank(a) || (b.totalSize - a.totalSize)

  missing.sort(byQualThenSize)
  // Decorate-sort-undecorate: the two keys were lowercased on both sides of
  // every comparison, so a 5,000-album shelf lowercased ~250,000 strings to
  // order 5,000 rows. Same ordering — _shelfCollator is a plain Intl.Collator,
  // which is exactly what localeCompare with no options bag uses.
  const decorated = albums.map(a => ({
    a,
    k1: (a.artist || a.album || '').toLowerCase(),
    k2: (a.album || '').toLowerCase(),
  }))
  decorated.sort(_shCmpShelfKeys)
  const everything = decorated.map(d => d.a)

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
  let flac = 0
  for (const f of files) if (f.isFlac || isLosslessName(f.name || f.filename)) flac++
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
  // One pass, no argument spread: this walked the file list three times and the
  // two Math.max spreads threw RangeError on a folder with ~125k files in it.
  let lossless = false
  let maxBitDepth = 0
  let maxSampleRate = 0
  for (const f of files) {
    if (!lossless && (f.isFlac || isLosslessName(f.name || f.filename))) lossless = true
    const bd = Number(f.bitDepth) || 0
    if (bd > maxBitDepth) maxBitDepth = bd
    const sr = Number(f.sampleRate) || 0
    if (sr > maxSampleRate) maxSampleRate = sr
  }
  const hiRes = maxBitDepth >= 24 || maxSampleRate >= 88200
  return { lossless, hiRes, maxBitDepth, maxSampleRate }
}
function qualityRankTuple(q) {
  return [q.lossless ? (q.hiRes ? 2 : 1) : 0, q.maxBitDepth || 0, q.maxSampleRate || 0]
}

// Every quality ordering in this module compares `qualityRankTuple(…).join(',')`
// strings under NUMERIC collation, and
// `String.prototype.localeCompare(x, undefined, { numeric: true })` constructs a
// fresh Intl.Collator on every single call. Inside a sort comparator that is
// most of the cost of the sort: sorting a real peer's 4,128 albums by quality
// measured 178 ms, almost all of it collator construction plus re-deriving the
// key on both sides of every comparison. One cached collator performs the
// identical comparison — localeCompare with an options bag is DEFINED as
// new Intl.Collator(undefined, opts).compare — at a fraction of the cost.
//
// The plain A–Z compare stays inline on purpose: localeCompare with no options
// bag already hits the engine's own cached default collator, so pre-keying it
// buys nothing.
const _shNumCollator = (typeof Intl !== 'undefined' && Intl.Collator)
  ? new Intl.Collator(undefined, { numeric: true }) : null
const _shCmpQualKey = _shNumCollator
  ? (a, b) => _shNumCollator.compare(a, b)
  : (a, b) => a.localeCompare(b, undefined, { numeric: true })
function _shQualKey(q) { return qualityRankTuple(q).join(',') }

// The Everything grid's A–Z ordering, over rows pre-keyed to lowercase artist
// (k1) and lowercase album (k2). Shared by buildShelves and its chunked twin so
// the two can never drift; the collator is the engine's default one, which is
// what a bare `localeCompare(x)` uses anyway.
const _shelfCollator = (typeof Intl !== 'undefined' && Intl.Collator) ? new Intl.Collator() : null
const _shCmpShelfKeys = _shelfCollator
  ? (x, y) => _shelfCollator.compare(x.k1, y.k1) || _shelfCollator.compare(x.k2, y.k2)
  : (x, y) => x.k1.localeCompare(y.k1) || x.k2.localeCompare(y.k2)

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
    // Trailing disc and bare-quality segments are peeled off first, so
    // "…\In Rainbows\Disc 1", "…\In Rainbows\CD1", "…\In Rainbows\44.1" and
    // "…\In Rainbows" all parse to the same album and land in one bucket. The
    // shelves walker has folded disc folders since day one; the search-side
    // merge never did, which is why "Disc 1", "CD1", "disc 1" and "flac" showed
    // up as their own one-person albums beside the merged card.
    const trimmed = stripLeafNoise(segs)
    return parseAlbumFolder(trimmed.length ? trimmed : [g.folderName || ''])
  })

  // Buckets indexed by album token, mirroring buildLibraryIndex: a group can only
  // merge into a bucket sharing an album token with it (a match needs ≥60% token
  // overlap), so we scan only those buckets — the earliest-created matching bucket
  // wins, preserving the old "merge into the first matching bucket" behaviour even
  // when tokens are reordered. `order` keeps first-seen bucket order for a stable
  // output. Turns the merge from O(n²) to roughly O(n).
  const byToken = new Map()   // albumToken → [bucket]
  const order = []
  // The same two exact gates the library index uses (see _countsCanMatch and
  // _minSharedTokens): a token-count band and a rarest-buckets prefix filter.
  // Without them a search whose results all contain "live" or "greatest hits"
  // drags every bucket holding that word into every single comparison, which is
  // the quadratic behaviour the token index was supposed to remove.
  const scratch = []
  let gen = 0
  const bandCache = []
  for (const g of (groups || [])) {
    const p = doParse(g)
    const ident = { artist: p.artist || '', album: p.album || g.folderName || '', year: p.year || null }
    const identComp = albumComparable(ident)
    // A parsed album is required to merge; when parsing yields nothing usable we
    // fall back to the folder name as the album so the group still forms a
    // (singleton) bucket rather than vanishing.
    let placed = null
    let placedSeq = Infinity
    const na = identComp.albumTokens.size
    scratch.length = 0
    let free = 0
    for (const tok of identComp.albumTokens) {
      const candidates = byToken.get(tok)
      if (candidates) scratch.push(candidates)
      else free++
    }
    const need = (na - free) - _minSharedTokens(na, 0.6) + 1
    if (need > 0 && scratch.length) {
      if (need < scratch.length) { scratch.sort(_byBucketLength); scratch.length = need }
      const mark = ++gen
      const band = _countBand(bandCache, na, 0.6)
      const nLo = band[0]
      const nHi = band[1]
      for (const candidates of scratch) {
        // Buckets are appended in creation order, so `seq` rises along the list:
        // once an entry cannot beat the current best, none of the rest can.
        for (let i = 0; i < candidates.length; i++) {
          const b = candidates[i]
          if (b.seq >= placedSeq) break
          const nb = b.identComp.albumTokens.size
          if (nb < nLo || nb > nHi) continue
          if (b.g === mark) continue
          b.g = mark
          // Same album identity: album+artist agree. Reuse the shelf matcher so
          // the same fuzzy rules ("The Beatles" == "beatles") apply here.
          if (albumsMatchComparable(identComp, b.identComp, 0.6, 0.34)) {
            placed = b; placedSeq = b.seq
            break
          }
        }
      }
    }
    if (!placed) {
      placed = { ident, identComp, sources: [], seq: order.length, g: 0 }
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
  // Decorate-sort-undecorate. sourceQuality walks a group's whole file list and
  // sourceScore walks it again, and both used to be recomputed on BOTH sides of
  // every comparison — so ordering the 30 people who hold one album cost ~300
  // file walks and ~300 collator constructions. Each source is now measured
  // exactly once. Array.prototype.sort is stable and the decoration is built in
  // input order, so equal sources keep the order they had.
  const decorated = bucket.sources.map(s => {
    const q = sourceQuality(s)
    return { s, q, qk: _shQualKey(q), score: sourceScore(s) }
  })
  decorated.sort((a, b) => {
    // Best quality first, then best availability/score.
    const qr = _shCmpQualKey(b.qk, a.qk)
    if (qr !== 0) return qr > 0 ? 1 : -1
    return b.score - a.score
  })
  const sources = decorated.map(d => d.s)
  // Best source = highest quality, then highest score (already sorted).
  const best = sources[0] || null
  // Best quality across ALL sources (a fast peer may hold a lesser rip than a
  // slow one; the headline quality is the best available, regardless of who).
  let bestQ = { lossless: false, hiRes: false, maxBitDepth: 0, maxSampleRate: 0 }
  let bestQKey = _shQualKey(bestQ)
  for (const d of decorated) {
    if (_shCmpQualKey(d.qk, bestQKey) > 0) { bestQ = d.q; bestQKey = d.qk }
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
    case 'quality': {
      // Keys derived ONCE per album instead of twice per comparison. qr() walks
      // every file of a source group, so the old form did O(n log n) file walks
      // and as many implicit collator constructions. This is the sort behind the
      // shop's quality chip and behind every re-render of the Everything grid,
      // so it was the visible stutter: 178 ms on a real 4,128-album share.
      const d = arr.map(a => ({ a, k: qr(a).join(','), size: a.totalSize || 0 }))
      d.sort((x, y) => {
        const c = _shCmpQualKey(y.k, x.k)
        return c !== 0 ? c : y.size - x.size
      })
      for (let i = 0; i < d.length; i++) arr[i] = d[i].a
      return arr
    }
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

// ── Big-library cooperative building (the peer-library speed wave) ────────────
// A 140k-file peer library made every build step a single multi-second
// main-thread block: buildTree ~2.8s on open, paid AGAIN by the background
// refresh, and every keystroke in the in-library search re-lowercased the whole
// tree (~2.4s per debounce pass). The fixes, all pure and Node-testable here:
//
//   1. *Chunked* variants of the tree/album/shelf builders. Each does the same
//      work as its sync twin (golden-tested to identical output) but checks a
//      time budget (default 24ms) as it goes and yields the main thread between
//      slices, so the UI stays interactive for the whole build.
//   2. A cheap browse-payload fingerprint so an unchanged background refresh
//      can skip the rebuild entirely instead of paying it twice.
//   3. Precomputed search indexes (lowercased once per library load) so a
//      keystroke pass is a linear scan over ready strings, not a fresh
//      toLowerCase walk of 140k names.
//
// A Web Worker was considered and rejected: the tree/album structures would
// have to cross the worker boundary by structured clone (itself seconds at this
// size), and worker wiring lives in renderer/preload territory. Cooperative
// chunking keeps everything in this module.

function _now() {
  return (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now()
}

// Yield the main thread between slices. scheduler.yield() where the runtime has
// it (Chromium's purpose-built primitive: resumes promptly, still lets input
// and paint through), else setImmediate (Node), else setTimeout(0).
function _coopYield() {
  const g = typeof globalThis !== 'undefined' ? globalThis : {}
  if (g.scheduler && typeof g.scheduler.yield === 'function') return g.scheduler.yield()
  if (typeof setImmediate === 'function') return new Promise(r => setImmediate(r))
  return new Promise(r => setTimeout(r, 0))
}

// Per-run budget state. `tick` is awaited inside the hot loop: it is a no-op
// until the slice budget is spent, then yields and restarts the clock. `opts.
// yieldFn` lets tests inject a recorder (to measure real slice lengths) and
// `opts.shouldAbort` lets the caller drop a build that no longer matters (modal
// closed, newer build started) — an aborted run resolves null.
function _budget(opts) {
  const budgetMs = (opts && opts.budgetMs > 0) ? opts.budgetMs : 24
  const yieldFn = (opts && opts.yieldFn) || _coopYield
  const shouldAbort = (opts && opts.shouldAbort) || null
  let sliceStart = _now()
  return {
    aborted: () => !!(shouldAbort && shouldAbort()),
    tick: async () => {
      if (_now() - sliceStart < budgetMs) return false
      await yieldFn()
      sliceStart = _now()
      return true
    },
  }
}

// ── Browse-payload fingerprint ────────────────────────────────────────────────
// FNV-1a over every directory name, file name and file size. Linear, no
// allocation, order-sensitive (slskd returns a stable listing, so identical
// content means an identical payload). Two payloads with the same fingerprint
// are treated as unchanged and the refresh rebuild is skipped.
function _fnvStr(h, s) {
  const str = String(s || '')
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h
}
function _fnvNum(h, n) {
  const v = Number(n) || 0
  h ^= v & 0xffff
  h = Math.imul(h, 16777619)
  h ^= (v / 65536) & 0xffffffff
  h = Math.imul(h, 16777619)
  return h
}
function _fingerprintDir(h, d, counts) {
  h = _fnvStr(h, d && d.name)
  const files = (d && d.files) || []
  h = _fnvNum(h, files.length)
  for (const f of files) {
    h = _fnvStr(h, f.filename || f.name)
    h = _fnvNum(h, f.size)
    counts.files++
  }
  return h
}
function fingerprintBrowse(directories) {
  const dirs = directories || []
  const counts = { files: 0 }
  let h = 0x811c9dc5 | 0
  for (const d of dirs) h = _fingerprintDir(h, d, counts)
  return (h >>> 0).toString(36) + ':' + dirs.length + ':' + counts.files
}
async function fingerprintBrowseChunked(directories, opts) {
  const b = _budget(opts)
  const dirs = directories || []
  const counts = { files: 0 }
  let h = 0x811c9dc5 | 0
  for (const d of dirs) {
    h = _fingerprintDir(h, d, counts)
    if (await b.tick() && b.aborted()) return null
  }
  return (h >>> 0).toString(36) + ':' + dirs.length + ':' + counts.files
}

// ── Chunked tree build ────────────────────────────────────────────────────────
// Mirrors slsk-tree's buildTree deliberately (same node shape, same casing
// rules) rather than importing its window binding, so this module still stands
// alone in a test process — and the golden test asserts the two stay
// byte-identical in output. The per-directory insertion is the natural chunk
// unit; the count/size rollup at the end is a cheap arithmetic walk done in one
// final slice.
const TREE_SEP = '\\'
function _treeSplitPath(p) {
  const s = String(p || '')
  return (s.indexOf('/') < 0 ? s : s.replace(/\//g, TREE_SEP)).split(TREE_SEP).filter(Boolean)
}
// Mirrors slsk-tree's _tBasename (see the note there); duplicated rather than
// imported so this module still stands alone in a test process.
function _treeBasename(p) {
  const s = String(p || '')
  let end = s.length
  while (end > 0) {
    const c = s.charCodeAt(end - 1)
    if (c === 92 || c === 47) end--
    else break
  }
  if (end === 0) return ''
  let start = end
  while (start > 0) {
    const c = s.charCodeAt(start - 1)
    if (c === 92 || c === 47) break
    start--
  }
  return s.slice(start, end)
}
function _treeMakeNode(name, path) {
  return { name, path, dirs: new Map(), files: [], fileCount: 0, totalSize: 0 }
}

// ONE definition of "insert this directory entry into this tree", shared by the
// chunked builder and the streaming builder below so the three tree builds in
// this codebase cannot drift apart in casing, path or fullPath handling.
function _treeInsertDir(root, d) {
  const parts = _treeSplitPath(d.name)
  let node = root
  const acc = []
  for (const part of parts) {
    acc.push(part)
    const key = part.toLowerCase()
    let next = node.dirs.get(key)
    if (!next) { next = _treeMakeNode(part, acc.join(TREE_SEP)); node.dirs.set(key, next) }
    node = next
    // Walk on using the casing we first saw, so node.path stays self-consistent.
    acc[acc.length - 1] = node.name
  }
  for (const f of d.files || []) {
    const base = _treeBasename(f.filename) || f.filename || ''
    // fullPath must use the peer's own casing for this entry — it is what we
    // send back to request the download — not the merged display casing.
    node.files.push({ ...f, name: base, fullPath: (d.name ? d.name + TREE_SEP : '') + base })
  }
}

// Roll counts and sizes up so a folder can show what it contains without the UI
// having to walk it. Cheap arithmetic; done once, at the end.
function _treeRoll(n) {
  let count = n.files.length
  let size = 0
  for (const f of n.files) size += Number(f.size) || 0
  for (const c of n.dirs.values()) { const r = _treeRoll(c); count += r.count; size += r.size }
  n.fileCount = count; n.totalSize = size
  return { count, size }
}

async function buildTreeChunked(directories, opts) {
  const b = _budget(opts)
  const onProgress = (opts && opts.onProgress) || null
  const dirs = directories || []
  const root = _treeMakeNode('', '')
  for (let i = 0; i < dirs.length; i++) {
    _treeInsertDir(root, dirs[i])
    if (await b.tick()) {
      if (b.aborted()) return null
      if (onProgress) { try { onProgress(i + 1, dirs.length) } catch (_) {} }
    }
  }
  _treeRoll(root)
  return root
}

// ── Streaming tree build (for a chunked browse payload) ───────────────────────
// buildTreeChunked keeps the MAIN THREAD interactive, but it still needs the
// whole directory array in hand before it starts — and getting that array into
// the renderer is the actual freeze on a big peer. `slsk-browse-user` returns
// the entire listing from one ipcRenderer.invoke, so the payload crosses by
// structured clone in a single uninterruptible step on each side. Measured on a
// deep-copied 485,000-file payload (114 MB): 594 ms to serialise in main, 1,208
// ms to deserialise in the renderer, 1.8 s of dead UI behind a static
// "Loading…" with no cancel. Nothing in this module can shorten that, because
// the cost is paid before any of this code is reached.
//
// The fix is to stop moving it in one piece — and that needs a builder that can
// be fed the listing a slice at a time. This is it. Feed it whatever arrives,
// in order, then call finish():
//
//   const tb = SH.createTreeBuilder()
//   for await (const slice of browseSlices(username)) tb.add(slice)
//   const tree = tb.finish()
//
// The result is byte-identical to buildTree() over the concatenation of the
// slices — the golden test asserts exactly that, at several slice sizes and
// against a payload whose folders deliberately straddle slice boundaries.
// `dirCount`/`fileCount` are exposed so the caller can render honest progress
// without walking anything, and finish() is idempotent so a late slice arriving
// after a cancel cannot corrupt a tree already handed to the UI.
function createTreeBuilder() {
  const root = _treeMakeNode('', '')
  let dirCount = 0
  let fileCount = 0
  let done = false
  return {
    get dirCount() { return dirCount },
    get fileCount() { return fileCount },
    get finished() { return done },
    // One slice of the browse listing. Directories may be split across slices in
    // any way at all: the tree is keyed by path, so a folder whose files arrive
    // in two slices simply gets both.
    add(directories) {
      if (done) return this
      for (const d of (directories || [])) {
        _treeInsertDir(root, d)
        dirCount++
        fileCount += (d.files || []).length
      }
      return this
    },
    // Roll the counts up and hand back the tree. Calling it twice returns the
    // same tree without re-rolling.
    finish() {
      if (!done) { _treeRoll(root); done = true }
      return root
    },
  }
}

// ── Chunked album extraction ──────────────────────────────────────────────────
// The same walk extractAlbums does, but with an explicit stack so the budget
// check can interleave anywhere in the traversal. Emission order is preserved
// exactly (children in Map order, a mixed node's own album AFTER its children,
// root loose files last) — the golden test locks deep equality against
// extractAlbums.
async function extractAlbumsChunked(root, opts) {
  const b = _budget(opts)
  const minTracks = (opts && opts.minTracks != null) ? opts.minTracks : 2
  if (!root) return []
  const albums = []

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

  // Stack of { node, segs } visits and { post } emissions. LIFO with children
  // pushed reversed reproduces the recursive order.
  const stack = []
  if (root.dirs && root.dirs.size) {
    const kids = [...root.dirs.values()]
    for (let i = kids.length - 1; i >= 0; i--) {
      stack.push({ node: kids[i], segs: [kids[i].name] })
    }
  }
  while (stack.length) {
    const it = stack.pop()
    if (it.post) {
      // The mixed-node case: a shelf with real subfolders AND enough of its own
      // loose audio to be an album in its own right — emitted after its children,
      // exactly as the recursive walk does.
      const { node, segs } = it.post
      albums.push(buildAlbum(node, segs, {
        files: node.files.filter(f => isAudioName(f.name || f.filename)), discCount: 0,
      }))
    } else {
      const node = it.node
      const segs = it.segs
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
        // Mixed node: real subfolders plus enough gathered audio to also be an
        // album in its own right. Pushed first so it pops (emits) AFTER the
        // children — the recursive walk's exact order. Note it is gated on the
        // GATHERED count but built from the node's OWN audio, faithfully
        // mirroring extractAlbums.
        if (realSubdirs.length && node.path && gathered.files.length >= minTracks) {
          stack.push({ post: { node, segs } })
        }
        for (let i = realSubdirs.length - 1; i >= 0; i--) {
          stack.push({ node: realSubdirs[i], segs: segs.concat(realSubdirs[i].name) })
        }
      }
    }
    if (await b.tick() && b.aborted()) return null
  }
  const rootAudio = (root.files || []).filter(f => isAudioName(f.name || f.filename))
  if (rootAudio.length >= minTracks) {
    albums.push(buildAlbum(root, [root.name || ''], { files: rootAudio, discCount: 0 }))
  }
  return albums
}

// ── Chunked library index + shelves ───────────────────────────────────────────
async function buildLibraryIndexChunked(library, opts) {
  const b = _budget(opts)
  const albumMin = (opts && opts.albumMin) || 0.6
  const artistMin = (opts && opts.artistMin) || 0.34
  const buckets = new Map()
  const noKey = []
  let order = 0
  for (const a of (library || [])) {
    _libIndexInsert(buckets, noKey, a, order++)
    if (await b.tick() && b.aborted()) return null
  }
  return { findMatch: _libIndexFinder(buckets, noKey, albumMin, artistMin), buckets, noKey }
}

// Chunked buildShelves. Identical output to buildShelves (golden-tested); two
// extras for the shop: `markInLibrary` also stamps a.inLibrary on every peer
// album from the SAME index lookup (the shop used to pay a second full
// findMatch sweep just for that), and every loop, including the surround file-
// name joins and the sort-key precompute, runs under the slice budget. The
// Everything sort uses _shCmpShelfKeys — the same cached-collator comparator
// over the same precomputed lowercase keys the sync builder now uses, so the
// two orderings cannot drift.
async function buildShelvesChunked(peerAlbums, library, opts) {
  const b = _budget(opts)
  const detectSurround = (opts && opts.detectSurround) || null
  const markInLibrary = !!(opts && opts.markInLibrary)
  const albums = peerAlbums || []
  const libIndex = await buildLibraryIndexChunked(library, opts)
  if (!libIndex) return null

  // Surround detection joins every file name per album — the heaviest string
  // work in here, so it sits inside the budget loop. It runs BEFORE the upgrade
  // sweep because upgradeReason's channel gate needs it (see gate 0 there), and
  // the same flags then feed the Surround shelf, so it is still exactly one
  // detectSurround call per album.
  const surround = []
  const surroundFlags = new Array(albums.length)
  for (let i = 0; i < albums.length; i++) {
    const pa = albums[i]
    let sur = false
    if (detectSurround) {
      const names = pa.files.map(f => f.name || f.filename || '').join(' ')
      sur = !!detectSurround(`${pa.folderPath} ${pa.folderName} ${names}`)
    }
    surroundFlags[i] = sur
    if (sur) surround.push(pa)
    if (await b.tick() && b.aborted()) return null
  }

  const upgrades = []
  const missing = []
  for (let i = 0; i < albums.length; i++) {
    const pa = albums[i]
    const peerComp = albumComparable({
      artist: pa.artist,
      album: pa.album,
      lossless: pa.lossless,
      maxBitDepth: pa.maxBitDepth,
      maxSampleRate: pa.maxSampleRate,
      surround: surroundFlags[i] || !!pa.surround,
    })
    const match = libIndex.findMatch(peerComp)
    if (markInLibrary) pa.inLibrary = !!match
    if (match) {
      const reason = upgradeReason(peerComp, match)
      if (reason) upgrades.push({ ...pa, upgrade: reason, matchedLibId: match.ref && match.ref.id })
    } else {
      missing.push(pa)
    }
    if (await b.tick() && b.aborted()) return null
  }

  const hires = []
  const decorated = []
  for (const pa of albums) {
    if (pa.isHiRes) hires.push(pa)
    decorated.push({
      a: pa,
      k1: (pa.artist || pa.album || '').toLowerCase(),
      k2: (pa.album || '').toLowerCase(),
    })
    if (await b.tick() && b.aborted()) return null
  }

  const qualRank = (a) => (a.lossless ? (a.isHiRes ? 3 : 2) : 1)
  const byQualThenSize = (a, b2) => qualRank(b2) - qualRank(a) || (b2.totalSize - a.totalSize)
  missing.sort(byQualThenSize)
  surround.sort(byQualThenSize)
  hires.sort(byQualThenSize)
  decorated.sort(_shCmpShelfKeys)
  const everything = decorated.map(d => d.a)

  return {
    upgrades,
    missing,
    surround,
    hires,
    everything,
    stats: computeStats(albums, { surroundCount: surround.length }),
  }
}

// ── Precomputed search indexes ────────────────────────────────────────────────
// searchTree lowercases every directory path and file name on EVERY call — that
// is the whole per-keystroke freeze. This walks the tree once (chunked), stores
// the lowercase haystacks flat in traversal order, and a query is then a single
// linear scan with the same early-stop semantics searchTree has. The result
// objects are shaped identically to searchTree's, golden-tested against it.
async function buildTreeSearchIndexChunked(root, opts) {
  const b = _budget(opts)
  const entries = []
  if (!root) return { entries }
  // Emission order must equal searchTree's: for each dir — the dir itself, then
  // its whole subtree, then (after all subdirs) the node's own files.
  const stack = [{ node: root, emitSelf: false }]
  while (stack.length) {
    const it = stack.pop()
    if (it.files) {
      const n = it.files
      for (const f of n.files) {
        entries.push({ type: 'file', name: f.name, path: n.path, file: f, hay: f.name.toLowerCase() })
      }
    } else {
      const n = it.node
      if (it.emitSelf) {
        entries.push({ type: 'dir', name: n.name, path: n.path, fileCount: n.fileCount, hay: n.path.toLowerCase() })
      }
      stack.push({ files: n })
      const kids = [...n.dirs.values()]
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i], emitSelf: true })
    }
    if (await b.tick() && b.aborted()) return null
  }
  return { entries }
}

// Query the index. Same contract as searchTree(root, query, limit): the first
// `limit` matches in traversal order, same object shapes (no hay leaks out).
function searchTreeIndex(index, query, limit = 300) {
  const q = String(query || '').trim().toLowerCase()
  if (!q || !index || !index.entries) return []
  const out = []
  for (const e of index.entries) {
    if (!e.hay.includes(q)) continue
    out.push(e.type === 'dir'
      ? { type: 'dir', name: e.name, path: e.path, fileCount: e.fileCount }
      : { type: 'file', name: e.name, path: e.path, file: e.file })
    if (out.length >= limit) break
  }
  return out
}

// Per-album search haystacks for the shop's search-within-library, plus a
// folderPath(lowercase) → album map so a filename hit resolves to its owning
// album in O(1) instead of an O(albums) scan per hit.
async function buildAlbumSearchIndexChunked(albums, opts) {
  const b = _budget(opts)
  const list = albums || []
  const hays = new Array(list.length)
  const byFolderLower = new Map()
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    hays[i] = `${a.artist} ${a.album} ${a.folderName}`.toLowerCase()
    const fp = String(a.folderPath || '').toLowerCase()
    // First album wins, matching the old shFlat.find semantics.
    if (!byFolderLower.has(fp)) byFolderLower.set(fp, a)
    if (await b.tick() && b.aborted()) return null
  }
  return { hays, byFolderLower }
}

const shApi = {
  extractAlbums, parseAlbumFolder, buildAlbum, buildShelves, computeStats,
  upgradeReason, albumsMatch, albumsMatchComparable, albumComparable,
  buildLibraryIndex, tokenScore, tokenScoreSets, normKey, normTokenSet,
  cleanSegment, extractYear,
  isDiscFolder, isQualityLeaf, stripLeafNoise,
  groupByLetter, albumQualityLabel, libAlbumToComparable,
  isAudioName, isLosslessName, qualityString, channelSuffix,
  SH_AUDIO_RE, SH_LOSSLESS_EXT,
  fmtSize, sourceScore, sourceQuality, qualityRankTuple, mergeSourcesByAlbum,
  finalizeMergedAlbum, sortMergedAlbums,
  // Big-library cooperative building (peer-library speed wave)
  fingerprintBrowse, fingerprintBrowseChunked, buildTreeChunked, createTreeBuilder,
  extractAlbumsChunked, buildLibraryIndexChunked, buildShelvesChunked,
  buildTreeSearchIndexChunked, searchTreeIndex, buildAlbumSearchIndexChunked,
}

if (typeof module !== 'undefined' && module.exports) module.exports = shApi
if (typeof window !== 'undefined') window.PapaSlskShelves = shApi
