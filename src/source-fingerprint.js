// The quality contract for alternate-source substitution.
//
// A previous attempt at redistributing downloads across peers judged "the same
// file" by name and size, and it corrupted a curated collection in the field:
// a 5.1 track was silently replaced with a stereo copy from another user,
// because the two shared a name and were close enough in size to pass. This
// module exists so that can never happen again. Nothing substitutes one source
// for another unless `compatible()` says the substitute is at least as good on
// every axis that matters — surround layout first and foremost.
//
// It is deliberately pure and conservative: when a fact is unknown it says so
// (null), and `compatible` treats "unknown vs known" as a mismatch rather than
// a match, because guessing is exactly what caused the disaster.

// The surround label is read out of uploader-written text, which is the ONLY
// signal Soulseek gives before a file is on disk (it never reports a channel
// count). `detectSurround` in src/slsk-filters.js is the single source of truth
// for that text-to-label mapping — its regexes have been tuned in the field to
// reject "Album 51", "Symphony 5 1st Movement" and stereo SACD rips — so this
// module requires it rather than re-deriving the rules and letting the two
// drift. src/slsk-filters.js is UI-owned; this only reads its exported detector.
var _detectSurround = null
try {
  // Prefer the shared detector. In the renderer it is on window; under Node it
  // is the module export.
  if (typeof window !== 'undefined' && window.PapaSurround && window.PapaSurround.detectSurround) {
    _detectSurround = window.PapaSurround.detectSurround
  } else if (typeof require !== 'undefined') {
    _detectSurround = require('./slsk-filters').detectSurround
  }
} catch (_) {
  _detectSurround = null
}

// A file or a folder-group can carry the text that labels its surround layout in
// several places: a group has folderPath/folderName plus per-file names, a bare
// file has just its filename. Gather all of them so the detector sees the same
// text a person reading the listing would.
function _surroundText(x) {
  if (!x) return ''
  var parts = []
  if (x.folderPath) parts.push(String(x.folderPath))
  if (x.folderName) parts.push(String(x.folderName))
  if (x.filename) parts.push(String(x.filename))
  var files = x.files || []
  for (var i = 0; i < files.length; i++) {
    if (files[i] && files[i].filename) parts.push(String(files[i].filename))
  }
  return parts.join(' ')
}

// The canonical surround label, or null for plain stereo/mono. Null is a real
// value here — it means "no surround claim" — and it only ever matches another
// null, never a positive label.
function surroundLabelOf(x) {
  var text = _surroundText(x)
  if (!text) return null
  if (typeof _detectSurround !== 'function') return null
  var hit = _detectSurround(text)
  return hit && hit.label ? hit.label : null
}

var LOSSLESS_EXTS = { flac: 1, wav: 1, alac: 1, ape: 1, wv: 1, aiff: 1, aif: 1 }

function _extOf(filename) {
  var s = String(filename == null ? '' : filename)
  var i = s.lastIndexOf('.')
  return i >= 0 ? s.slice(i + 1).toLowerCase() : ''
}

// Lossless when any representative file is a lossless format. A group is
// lossless if any file in it is; a bare file is judged on its own extension.
function losslessOf(x) {
  if (!x) return false
  var files = x.files || (x.filename != null ? [x] : [])
  for (var i = 0; i < files.length; i++) {
    if (LOSSLESS_EXTS[_extOf(files[i].filename)]) return true
  }
  return false
}

// Bit depth as a coarse class rather than a raw number: uploaders and taggers
// are inconsistent about the exact value, but the meaningful distinction is
// 16-bit CD quality vs 24-bit hi-res. Anything else (unreported, or an odd
// value) is null, which `compatible` refuses to guess about.
function bitDepthClassOf(x) {
  var best = 0
  var files = x && (x.files || (x.filename != null ? [x] : [])) || []
  for (var i = 0; i < files.length; i++) {
    var d = Number(files[i].bitDepth) || 0
    if (d > best) best = d
  }
  if (best >= 24) return '24'
  if (best === 16) return '16'
  return null
}

// Sample rate as a coarse class: 44.1 kHz (CD), 48 kHz (video/DAT), and
// 88.2 kHz-and-up (hi-res) are the bands worth telling apart. slskd reports the
// rate in Hz. Unknown -> null.
function sampleRateClassOf(x) {
  var best = 0
  var files = x && (x.files || (x.filename != null ? [x] : [])) || []
  for (var i = 0; i < files.length; i++) {
    var r = Number(files[i].sampleRate) || 0
    if (r > best) best = r
  }
  if (best >= 88000) return '88+'
  if (best >= 47000) return '48'
  if (best >= 44000) return '44'
  return null
}

// The full fingerprint of a file or group: everything `compatible` needs, and
// nothing it does not. Pure — no I/O, no mutation.
function fingerprint(fileOrGroup) {
  return {
    surroundLabel: surroundLabelOf(fileOrGroup),
    lossless: losslessOf(fileOrGroup),
    bitDepthClass: bitDepthClassOf(fileOrGroup),
    sampleRateClass: sampleRateClassOf(fileOrGroup),
  }
}

// Order the coarse quality classes so "equal or better" has a meaning. A higher
// index is strictly better. null is below everything: an unknown quality is
// never accepted as a substitute for a known one.
var BITDEPTH_ORDER = { '16': 1, '24': 2 }
var SAMPLERATE_ORDER = { '44': 1, '48': 2, '88+': 3 }

function _rank(order, cls) {
  if (cls == null) return 0
  return order[cls] || 0
}

// Is `candidate` an acceptable substitute for `original`?
//
// The rules, strictest first — a single failure is a rejection:
//
//   1. Surround label must match EXACTLY. 5.1 is not 7.1, is not ATMOS, is not
//      stereo. null (no surround) matches only null. This is the rule the field
//      failure violated, and it is absolute: there is no tolerance, no
//      "close enough", no size fallback.
//   2. Lossless must match. A lossy stand-in for a lossless track is a
//      downgrade the user did not ask for.
//   3. Bit depth must be equal or better, when the original's is known. A 24-bit
//      original is never completed with a 16-bit substitute; a 16-bit original
//      may be upgraded to 24-bit. An unknown candidate depth cannot satisfy a
//      known original depth (its rank is 0).
//   4. Sample rate, same rule as bit depth.
//
// "candidate is compatible with original" is intentionally NOT symmetric on the
// depth/rate axes: better is allowed, worse is not.
function compatible(original, candidate) {
  if (!original || !candidate) return false
  var a = original
  var b = candidate

  // 1. Surround: exact, no exceptions.
  if ((a.surroundLabel || null) !== (b.surroundLabel || null)) return false

  // 2. Lossless: exact match on the boolean.
  if (!!a.lossless !== !!b.lossless) return false

  // 3. Bit depth: equal-or-better, only enforced when the original's is known.
  if (a.bitDepthClass != null) {
    if (_rank(BITDEPTH_ORDER, b.bitDepthClass) < _rank(BITDEPTH_ORDER, a.bitDepthClass)) return false
  }

  // 4. Sample rate: equal-or-better, only enforced when the original's is known.
  if (a.sampleRateClass != null) {
    if (_rank(SAMPLERATE_ORDER, b.sampleRateClass) < _rank(SAMPLERATE_ORDER, a.sampleRateClass)) return false
  }

  return true
}

var _PapaSourceFingerprint = {
  fingerprint: fingerprint,
  compatible: compatible,
  surroundLabelOf: surroundLabelOf,
  losslessOf: losslessOf,
  bitDepthClassOf: bitDepthClassOf,
  sampleRateClassOf: sampleRateClassOf,
}

if (typeof module !== 'undefined' && module.exports) module.exports = _PapaSourceFingerprint
if (typeof window !== 'undefined') window.PapaSourceFingerprint = _PapaSourceFingerprint
