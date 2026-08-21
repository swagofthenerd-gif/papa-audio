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
const SURROUND_PATTERNS = [
  { kind: 'atmos',  label: 'ATMOS', re: /\b(dolby[\s._-]*)?atmos\b/i },
  { kind: 'ch71',   label: '7.1',   re: /(^|[^\d])7[\s._-]1(ch)?([^\d]|$)/i },
  { kind: 'ch51',   label: '5.1',   re: /(^|[^\d])5[\s._-]1(ch)?([^\d]|$)/i },
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

function isHiRes(g) {
  return (g.files || []).some(f =>
    (Number(f.bitDepth) || 0) > 16 || (Number(f.sampleRate) || 0) > 48000)
}

function isLossless(g) { return (g.files || []).some(f => f.isFlac) }

const FILTERS = {
  all:      () => true,
  surround: g => !!groupSurround(g),
  hires:    isHiRes,
  lossless: isLossless,
}

function bestOf(g, key) {
  return Math.max(0, ...(g.files || []).map(f => Number(f[key]) || 0))
}

// Every comparator sorts descending (best first); relevance keeps input order,
// which the caller has already scored.
const SORTS = {
  relevance:  null,
  sampleRate: (a, b) => bestOf(b, 'sampleRate') - bestOf(a, 'sampleRate'),
  bitDepth:   (a, b) => bestOf(b, 'bitDepth')   - bestOf(a, 'bitDepth'),
  tracks:     (a, b) => (b.files || []).length  - (a.files || []).length,
  speed:      (a, b) => (b.uploadSpeed || 0)    - (a.uploadSpeed || 0),
  size:       (a, b) => bestOf(b, 'size')       - bestOf(a, 'size'),
}

function applyFilterSort(groups, { filter = 'all', sort = 'relevance' } = {}) {
  const pred = FILTERS[filter] || FILTERS.all
  const out = (groups || []).filter(pred)
  const cmp = SORTS[sort]
  return cmp ? out.slice().sort(cmp) : out
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { detectSurround, groupSurround, isHiRes, isLossless, applyFilterSort, surroundQueries, SURROUND_TERMS, FILTERS, SORTS }
}
if (typeof window !== 'undefined') {
  window.PapaSlskFilters = { detectSurround, groupSurround, isHiRes, isLossless, applyFilterSort }
  // The same detector serves YouTube titles: both are uploader-written text,
  // and the failure modes ("Album 51", stereo SACD rips) are identical.
  window.PapaSurround = { detectSurround, surroundQueries }
}
