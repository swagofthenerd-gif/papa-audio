// Filtering and sorting for Soulseek search results.
//
// slskd reports filename, size, bitDepth, sampleRate and bitRate — but never a
// channel count. Surround therefore has to be read out of the folder and file
// text, which is how uploaders label it in practice. That makes detection
// best-effort: it finds what people actually write, and says so rather than
// pretending to be authoritative.

// Ordered: the first match wins, so the most specific pattern comes first.
// The separator in 5.1/7.1 is mandatory - making it optional matched "Album 51
// Greatest Hits", and track and album numbers are everywhere in these paths.
//
// But `\s` in that separator class reintroduced the same class of error it was
// written to prevent, and worse: "Beethoven Symphony 5 1st Movement",
// "Bach BWV 5 1 Aria" and "Disc 5 1 of 3" all came back as 5.1. That is not
// only a wrong badge -- the result is a SORT KEY for search results, it drives
// the surround-only filter and its count, and a falsely-surround anchor
// EXCLUDES genuinely matching folders from an album download group. It also
// runs on YouTube titles.
//
// So: no space. A real 5.1 label is written 5.1, 5_1, 5-1 or 5ch1 -- never with
// a space, because "5 1" is two numbers. And an ordinal suffix is rejected
// outright, since "5 1st" and "5.1st" are both a movement number.
const SURROUND_PATTERNS = [
  { kind: 'atmos',  label: 'ATMOS', re: /\b(dolby[\s._-]*)?atmos\b/i },
  { kind: 'ch71',   label: '7.1',   re: /(^|[^\d])7[._-]1(ch)?(?!st|nd|rd|th|\d)([^\d]|$)/i },
  { kind: 'ch51',   label: '5.1',   re: /(^|[^\d])5[._-]1(ch)?(?!st|nd|rd|th|\d)([^\d]|$)/i },
  { kind: 'quad',   label: 'QUAD',  re: /\b(quadraphonic|quadrophonic|quad)\b/i },
  { kind: 'mch',    label: 'MCH',   re: /\b(multi[\s._-]?channel|mch|surround)\b/i },
  { kind: 'sacd',   label: 'SACD',  re: /\bsacd\b/i },
  { kind: 'dvda',   label: 'DVD-A', re: /\bdvd[\s._-]?a(udio)?\b/i },
]

// SACD and DVD-Audio discs exist in stereo too, so on their own they are only a
// hint. Treat them as surround only when nothing stronger matched and the text
// also mentions multichannel — otherwise every stereo SACD rip is mislabelled.
const HINT_ONLY = new Set(['sacd', 'dvda'])

function detectSurround(text) {
  const s = String(text || '')
  for (const p of SURROUND_PATTERNS) {
    if (!p.re.test(s)) continue
    if (HINT_ONLY.has(p.kind)) {
      const stronger = SURROUND_PATTERNS.some(q => !HINT_ONLY.has(q.kind) && q.re.test(s))
      if (!stronger) continue
    }
    return { kind: p.kind, label: p.label }
  }
  return null
}


// Extra queries aimed squarely at surround releases.
//
// A plain search returns mostly stereo, because that is most of what exists.
// Uploaders label surround releases with a small, predictable vocabulary, so
// asking for those terms directly surfaces copies the base query never reaches
// - and, more usefully, surfaces the PEOPLE who hold them. Someone with one
// 5.1 album usually has more.
const SURROUND_TERMS = ['5.1', 'multichannel', 'SACD', 'DVD-Audio', 'atmos', '7.1']

function surroundQueries(query, limit = 4) {
  const base = String(query || '')
    .replace(/\s*[\(\[][^\)\]]{0,60}[\)\]]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (base.length < 2) return []
  // Skip any term the user already typed - re-asking for it wastes a slot.
  const lower = base.toLowerCase()
  return SURROUND_TERMS
    .filter(t => !lower.includes(t.toLowerCase()))
    .slice(0, limit)
    .map(t => `${base} ${t}`)
}

function folderText(g) {
  const names = (g.files || []).map(f => f.filename || '').join(' ')
  return `${g.folderPath || ''} ${g.folderName || ''} ${names}`
}

function groupSurround(g) { return detectSurround(folderText(g)) }

function isHiResGroup(g) {
  return (g.files || []).some(f =>
    (Number(f.bitDepth) || 0) > 16 || (Number(f.sampleRate) || 0) > 48000)
}

function isLosslessGroup(g) { return (g.files || []).some(f => f.isFlac) }

const FILTERS = {
  all:      () => true,
  surround: g => !!groupSurround(g),
  hires:    isHiResGroup,
  lossless: isLosslessGroup,
}

function bestOf(g, key) {
  return Math.max(0, ...(g.files || []).map(f => Number(f[key]) || 0))
}

// Every comparator sorts descending (best first); relevance keeps input order,
// which the caller has already scored.
// Queue position sorts ASCENDING (shortest line first) — unlike every other
// sort here, "best" is the smallest number. A peer with a free upload slot has
// effectively no queue, so it is treated as position 0 and floats to the top.
function _queuePos(g) {
  if (g && g.hasFreeSlot) return 0
  return Number(g && g.queueLength) || 0
}
const SORTS = {
  relevance:  null,
  sampleRate: (a, b) => bestOf(b, 'sampleRate') - bestOf(a, 'sampleRate'),
  bitDepth:   (a, b) => bestOf(b, 'bitDepth')   - bestOf(a, 'bitDepth'),
  tracks:     (a, b) => (b.files || []).length  - (a.files || []).length,
  speed:      (a, b) => (b.uploadSpeed || 0)    - (a.uploadSpeed || 0),
  size:       (a, b) => bestOf(b, 'size')       - bestOf(a, 'size'),
  queue:      (a, b) => _queuePos(a)            - _queuePos(b),
}

function applyFilterSort(groups, { filter = 'all', sort = 'relevance' } = {}) {
  const pred = FILTERS[filter] || FILTERS.all
  const out = (groups || []).filter(pred)
  const cmp = SORTS[sort]
  return cmp ? out.slice().sort(cmp) : out
}

// ── Record-shop shelf filtering & sorting ─────────────────────────────────────
// The shop deals in PARSED albums ({artist, album, year, lossless, isHiRes,
// totalSize, files}) rather than raw search folder-groups, so it needs its own
// small predicate/comparator set. Session-only view state, applied to the
// "Everything" grid and to search-within-library results. Surround is read from
// the album's own `surround` flag when present, else re-derived from its text so
// the same detector drives both.
function albumIsSurround(a) {
  if (a && typeof a.surround === 'boolean') return a.surround
  const names = ((a && a.files) || []).map(f => f.name || f.filename || '').join(' ')
  return !!detectSurround(`${(a && a.folderPath) || ''} ${(a && a.folderName) || ''} ${names}`)
}

// Every chip the explorer offers. Keys that need context (what is new since the
// last visit, which albums beat mine) read it from the `ctx` argument so the
// predicates stay pure. Groups are exclusive within a row (one format at a
// time) and combine across rows.
const SHELF_FILTER_GROUPS = [
  { id: 'format',   label: 'Format',   keys: ['flac', 'mp3', 'otherfmt'] },
  { id: 'depth',    label: 'Depth',    keys: ['bd16', 'bd24'] },
  { id: 'rate',     label: 'Rate',     keys: ['sr44', 'sr48', 'sr88', 'sr176'] },
  { id: 'channels', label: 'Channels', keys: ['stereo', 'surround'] },
  { id: 'size',     label: 'Size',     keys: ['small', 'medium', 'large'] },
  { id: 'mine',     label: 'Mine',     keys: ['notinlib', 'inlib', 'better', 'new'] },
]
const SHELF_FILTER_LABELS = {
  lossless: 'Lossless', hires: 'Hi-Res', flac: 'FLAC', mp3: 'MP3', otherfmt: 'Other',
  bd16: '16-bit', bd24: '24-bit', sr44: '44.1k', sr48: '48k', sr88: '88.2–96k', sr176: '176k+',
  stereo: 'Stereo', surround: 'Surround', small: '< 300 MB', medium: '300 MB – 1 GB', large: '> 1 GB',
  notinlib: 'Not in my library', inlib: 'In my library', better: 'Better than mine', new: 'New since last visit',
}
const ext = a => String((a && a.topExt) || '').toLowerCase()
const sr = a => Number(a && a.maxSampleRate) || 0
const bd = a => Number(a && a.maxBitDepth) || 0
const sz = a => Number(a && a.totalSize) || 0
const SHELF_FILTERS = {
  lossless: a => !!(a && a.lossless),
  hires:    a => !!(a && a.isHiRes),
  surround: albumIsSurround,
  stereo:   a => !albumIsSurround(a),
  flac:     a => ext(a) === 'flac',
  mp3:      a => ext(a) === 'mp3',
  otherfmt: a => { const e = ext(a); return !!e && e !== 'flac' && e !== 'mp3' },
  bd16:     a => bd(a) === 16,
  bd24:     a => bd(a) >= 24,
  sr44:     a => sr(a) > 0 && sr(a) <= 44100,
  sr48:     a => sr(a) === 48000,
  sr88:     a => sr(a) >= 88200 && sr(a) < 176400,
  sr176:    a => sr(a) >= 176400,
  small:    a => sz(a) > 0 && sz(a) < 300e6,
  medium:   a => sz(a) >= 300e6 && sz(a) < 1e9,
  large:    a => sz(a) >= 1e9,
  inlib:    a => !!(a && a.inLibrary),
  notinlib: a => !(a && a.inLibrary),
  better:   (a, ctx) => !!(ctx && ctx.upgradePaths && a && ctx.upgradePaths.has(a.folderPath)),
  new:      (a, ctx) => !!(ctx && ctx.newPaths && a && (ctx.newPaths.has(a.folderPath) || ctx.newPaths.has(a.folderName))),
}
// Search within a library: every query token must appear in artist or album.
function shelfQueryMatch(a, query) {
  const q = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!q.length) return true
  const hay = ((a && a.artist) || '') + ' ' + ((a && (a.album || a.folderName)) || '')
  const h = hay.toLowerCase()
  return q.every(t => h.includes(t))
}

// Build the decade dropdown options from the years actually present, newest
// first. "2010s", "1990s"… Albums with no parsed year are excluded (they can't
// be placed on a decade shelf). Returns [{ value:'2010', label:'2010s' }].
function shelfDecades(albums) {
  const decades = new Set()
  for (const a of (albums || [])) {
    const y = Number(a && a.year) || 0
    if (y >= 1900) decades.add(Math.floor(y / 10) * 10)
  }
  return [...decades].sort((x, y) => y - x)
    .map(d => ({ value: String(d), label: `${d}s` }))
}

// Apply the active shelf filters (a Set of filter keys) plus an optional decade
// (the decade's start year as a string/number) and sort key. Pure — new array.
function applyShelfFilterSort(albums, { filters = null, decade = null, sort = 'az', query = '', ctx = null } = {}) {
  const active = filters instanceof Set ? [...filters] : (Array.isArray(filters) ? filters : [])
  let out = (albums || []).slice()
  for (const key of active) {
    const pred = SHELF_FILTERS[key]
    if (pred) out = out.filter(a => pred(a, ctx))
  }
  if (query) out = out.filter(a => shelfQueryMatch(a, query))
  if (decade != null && decade !== '') {
    const start = Number(decade) || 0
    out = out.filter(a => {
      const y = Number(a && a.year) || 0
      return y >= start && y < start + 10
    })
  }
  const SH = (typeof window !== 'undefined' && window.PapaSlskShelves) ||
    (typeof require === 'function' ? (() => { try { return require('./slsk-shelves') } catch (_) { return null } })() : null)
  if (sort === 'artist') return out.sort((x, y) => String(x.artist || '').localeCompare(String(y.artist || '')) || String(x.album || '').localeCompare(String(y.album || '')))
  if (sort === 'tracks') return out.sort((x, y) => (Number(y.trackCount) || 0) - (Number(x.trackCount) || 0))
  return SH && SH.sortMergedAlbums ? SH.sortMergedAlbums(out, sort) : out
}

// The results header, in one voice with every unit named (R5). The merged
// view shows ALBUMS (one card per album, several sharers behind it) while the
// filter chips and the uploader view count SOURCES (one sharer's folder), and
// the two numbers used to sit side by side with no unit on either — "3779"
// next to "4267" reading as a contradiction. Now: "12 albums from 40 sources
// · 30 lossless · 5 match the filter · showing 20 of 40".
function summaryLine(p) {
  p = p || {}
  const n = (v) => Number(v) || 0
  const plural = (k, w) => k + ' ' + w + (k === 1 ? '' : 's')
  const parts = []
  if (p.merged) {
    parts.push(plural(n(p.albums), 'album') + ' from ' + plural(n(p.sources), 'source'))
  } else {
    parts.push(plural(n(p.sources), 'source'))
  }
  if (n(p.lossless)) parts.push(n(p.lossless) + ' lossless')
  if (p.filter && p.filter !== 'all') parts.push(n(p.filterMatches) + ' match' + (n(p.filterMatches) === 1 ? '' : 'es') + ' the filter')
  if (n(p.total) > n(p.shown)) parts.push('showing ' + n(p.shown) + ' of ' + n(p.total) + ' ' + (p.merged ? 'album' : 'source') + (n(p.total) === 1 ? '' : 's'))
  return parts.join(' · ')
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { detectSurround, groupSurround, isHiResGroup, isLosslessGroup, applyFilterSort, surroundQueries, SURROUND_TERMS, FILTERS, SORTS, SHELF_FILTERS, SHELF_FILTER_GROUPS, SHELF_FILTER_LABELS, shelfQueryMatch, shelfDecades, applyShelfFilterSort, albumIsSurround, summaryLine }
}
if (typeof window !== 'undefined') {
  // The shelf filter/sort/decade helpers were missing here, so in the app the
  // shop fell back to unfiltered, unsorted shelves and never showed a decade.
  window.PapaSlskFilters = { detectSurround, groupSurround, isHiResGroup, isLosslessGroup, applyFilterSort, summaryLine, SHELF_FILTERS, SHELF_FILTER_GROUPS, SHELF_FILTER_LABELS, shelfQueryMatch, shelfDecades, applyShelfFilterSort, albumIsSurround }
  // The same detector serves YouTube titles: both are uploader-written text,
  // and the failure modes ("Album 51", stereo SACD rips) are identical.
  window.PapaSurround = { detectSurround, surroundQueries }
}
