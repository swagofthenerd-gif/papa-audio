'use strict'
// Upgrade duplicates — when the better copy lands next to the old one.
//
// The problem this exists for, in his words: Soulseek finds an upgrade of a
// song he already owns, the better copy downloads alongside the old one, and
// "it just adds duplicates in the same album man". This module finds those
// pairs and says, per copy, which file supersedes which and WHY.
//
// ── This module is ANALYSIS ONLY ──────────────────────────────────────────────
// It never touches the filesystem. It requires no `fs`, no `child_process`, no
// `electron`; it reads nothing, writes nothing, moves nothing, deletes nothing.
// It returns a removal PLAN as plain data. Every plan item ships
// `selected: false` and `action: 'trash'`, and `toRemovalPlan()` accepts ONLY
// ids that are in `plan` — an `ambiguous` entry can never become a deletion,
// and calling it with no ids returns an empty plan rather than "everything".
// A wrong delete here costs him music he may not find again, so the whole
// module is written to prefer "unsure" over a guess.
//
// ── What it reuses (no second vocabulary) ─────────────────────────────────────
//   smart-query.js   — the tokeniser. The ONLY one in this codebase that
//                      survives non-Latin script (\p{L}/\p{N}); slsk-shelves'
//                      normKey folds to [a-z0-9] and would turn 新しい日の誕生
//                      into an empty string, which would silently hide every
//                      duplicate with a non-Latin title.
//   quality-badge.js — codecClass(): lossless | lossy | dsd | unknown. The same
//                      classifier the now-playing badge uses, including its
//                      codec-string-first / extension-fallback rule.
//   format-badges.js — surroundLabel(), isHiRes(), DSD_TITLE. The surround and
//                      hi-res words the album/track badges already say.
//
// ── The ranking rule ──────────────────────────────────────────────────────────
//   1. lossless (or DSD) beats lossy — always, even FLAC 16/44 over MP3 320.
//   2. then bit depth      (24-bit over 16-bit)
//   3. then sample rate    (96 kHz over 44.1 kHz)
//   4. then bitrate        (lossy only, and only with a real margin)
//   5. then file size      (last resort, only when nothing else can decide)
// Quality comes from the metadata, never from the filename. The filename is
// read for one thing only — a VBR hint — and that hint can only make the module
// MORE cautious, never less.
//
// ── Where it refuses ──────────────────────────────────────────────────────────
// DSD is decoded to PCM for playback here (mpv has no DoP/native-DSD path in
// this app), so a DSD file is honestly lossless-tier but its 1-bit/2.8 MHz
// numbers are not commensurable with PCM depth/rate. DSD beats lossy; DSD vs
// PCM lossless is `unsure`, never a deletion.
// Also `unsure`, never a deletion: different channel layouts (a 5.1 mix is a
// different release, not a duplicate), Atmos vs not, tags that disagree with
// the file on disk, an unidentified format, two lossless copies at the same
// depth and rate, lossy copies whose bitrates are too close (or VBR vs CBR, or
// two different lossy codecs), a bit-depth and sample-rate that disagree about
// which copy is better, and any duration gap the tolerance cannot vouch for.
// A duration gap big enough to mean a different edit/live take/remix is not
// reported at all — it is not a duplicate.

var _PapaUpgradeDupes = (function () {

  // Shared globals in the renderer, require() in Node/tests — the same
  // resolution the other pure modules use (library-index.js), but resolved
  // LAZILY and memoised. The renderer loads these as classic scripts into one
  // shared scope, so resolving at load time would hard-depend on this file
  // sitting after smart-query.js / quality-badge.js / format-badges.js in
  // index.html. Resolving on first use makes the script order a non-issue.
  var _SQ = null, _QB = null, _FB = null

  function _missing(name, global) {
    throw new Error('upgrade-dupes: ' + name + ' is not loaded (expected window.' + global +
      ' in the renderer, or require("./' + name + '") in Node). Refusing to analyse ' +
      'duplicates without it — a half-resolved comparison could propose the wrong deletion.')
  }
  function SQ() {
    if (!_SQ) {
      _SQ = (typeof window !== 'undefined' && window.PapaSmartQuery) ? window.PapaSmartQuery
        : ((typeof module !== 'undefined' && module.exports) ? require('./smart-query') : null)
      if (!_SQ) _missing('smart-query', 'PapaSmartQuery')
    }
    return _SQ
  }
  function QB() {
    if (!_QB) {
      _QB = (typeof window !== 'undefined' && window.PapaQualityBadge) ? window.PapaQualityBadge
        : ((typeof module !== 'undefined' && module.exports) ? require('./quality-badge') : null)
      if (!_QB) _missing('quality-badge', 'PapaQualityBadge')
    }
    return _QB
  }
  function FB() {
    if (!_FB) {
      _FB = (typeof window !== 'undefined' && window.PapaFormat) ? window.PapaFormat
        : ((typeof module !== 'undefined' && module.exports) ? require('./format-badges') : null)
      if (!_FB) _missing('format-badges', 'PapaFormat')
    }
    return _FB
  }

  var DEFAULTS = {
    // Two copies are the same recording when their durations agree within
    // max(durationToleranceSec, durationTolerancePct × longer), capped at
    // durationToleranceMaxSec. A 3-second tagging/encoder difference passes; a
    // 3-minute difference is a different recording.
    durationToleranceSec: 5,
    durationTolerancePct: 0.02,
    durationToleranceMaxSec: 12,
    // Past tolerance but inside this band the answer is "unsure" (shown, never
    // preselected). Beyond it the two are different recordings and are not
    // reported at all.
    differentRecordingPct: 0.15,
    differentRecordingMinSec: 30,
    // 24-bit / hi-res replaces CD-spec lossless. Set false to treat a hi-res
    // copy as merely different.
    hiResSupersedesCd: true,
    // Lossy bitrate margins. Same codec needs +25%; anything VBR needs +50%
    // because a VBR bitrate understates quality (MP3 V0 ≈ 245 kbps is not
    // "worse than" 320 CBR in any way the tags can prove); two DIFFERENT lossy
    // codecs need 2× because 256 kbps AAC and 320 kbps MP3 are not the same
    // scale at all.
    sameCodecBitrateMargin: 1.25,
    vbrBitrateMargin: 1.5,
    crossCodecBitrateMargin: 2.0,
    // File size is only ever consulted when depth, rate and bitrate cannot
    // decide, and then only with the same kind of margin.
    sizeFallbackMargin: 1.25,
  }

  // ── Text normalisation ──────────────────────────────────────────────────────

  // Words that describe an EDITION of the same recording. Safe to drop: a
  // remaster or a deluxe reissue of a track is the thing he already owns.
  var EDITION_WORDS = _set([
    'remaster', 'remastered', 'remasters', 'remastering', 'remasterizado',
    'reissue', 'reissued', 'anniversary', 'deluxe', 'expanded', 'edition',
    'editions', 'bonus', 'digipak', 'digipack', 'collectors', 'collector',
    'limited', 'import', 'promo', 'retail', 'redux', 'reprint', 'restored',
  ])

  // Words that describe the FILE, not the music. Dropped from album names so
  // "Kind of Blue [FLAC 24-96]" and "Kind of Blue" are one album.
  var FORMAT_WORDS = _set([
    'flac', 'mp3', 'm4a', 'alac', 'aac', 'wav', 'wave', 'aiff', 'aif', 'ape',
    'wv', 'wavpack', 'dsd', 'dsf', 'dff', 'ogg', 'opus', 'vorbis', 'mpc',
    'web', 'webrip', 'cd', 'cdrip', 'cdda', 'vinyl', 'lp', 'ep', 'sacd',
    'hdtracks', 'qobuz', 'tidal', 'bandcamp', 'hi', 'res', 'hires', 'lossless',
    'bit', 'bits', 'bitrate', 'kbps', 'khz', 'hz', 'cbr', 'vbr', 'q', 'v0',
    'v1', 'v2', 'log', 'cue', 'scans', 'remux', 'disc', 'disk', 'discs',
  ])

  var ALBUM_STRIP = _merge(EDITION_WORDS, FORMAT_WORDS)

  // smart-query's tokeniser treats every non-letter/digit as a separator, so
  // "Don't Stop Me Now" would tokenise to don|t|stop|me|now and never match
  // "Dont Stop Me Now". Apostrophes are glued shut and "&" is spelled out
  // BEFORE the shared tokeniser runs — the same two repairs slsk-shelves makes,
  // done here as a pre-fold so the tokeniser itself stays the single one.
  function _tok(str) {
    var s = String(str == null ? '' : str)
      .replace(/[’'`´ʼ]/g, '')
      .replace(/&/g, ' and ')
    return SQ().tokenize(s)
  }

  function _set(list) {
    var o = Object.create(null)
    for (var i = 0; i < list.length; i++) o[list[i]] = true
    return o
  }
  function _merge(a, b) {
    var o = Object.create(null)
    var k
    for (k in a) o[k] = true
    for (k in b) o[k] = true
    return o
  }

  // Drop bracketed segments that say nothing about which recording this is.
  // A segment survives unless EVERY token in it is a known strip-word or a bare
  // number — so "(Remastered 2011)" and "[Deluxe Edition]" go, while "(Live)",
  // "(Acoustic)" and "(Chris Lake Remix)" stay and keep the two apart.
  function _dropBrackets(str, wordSet, allowBareYear) {
    var s = String(str == null ? '' : str)
    var out = s.replace(/[([{]([^)\]}]*)[)\]}]/g, function (whole, inner) {
      var toks = _tok(inner)
      if (!toks.length) return ' '
      var sawWord = false
      for (var i = 0; i < toks.length; i++) {
        var t = toks[i]
        if (/^\d+$/.test(t)) continue
        if (wordSet[t]) { sawWord = true; continue }
        return whole // an unrecognised word — this segment means something
      }
      if (sawWord) return ' '
      // "(1959)" on an album is the release year, not part of its identity.
      if (allowBareYear && toks.length === 1 && /^(19|20)\d{2}$/.test(toks[0])) return ' '
      return whole
    })
    return _tok(out).length ? out : s
  }

  // "Song (feat. Drake)", "Song feat. Drake" and "Song" are one recording filed
  // three ways.
  function _stripFeat(str) {
    var s = String(str == null ? '' : str)
    var out = s
      .replace(/[([{]\s*(?:feat\.?|featuring|ft\.?|w\/)\s+[^)\]}]*[)\]}]/gi, ' ')
      .replace(/\s+[-–—]?\s*(?:feat\.?|featuring|ft\.?)\s+.*$/i, ' ')
    return _tok(out).length ? out : s
  }

  // Leading track numbers, as rippers write them into the TITLE tag: "03 - Song",
  // "3. Song", "07) Song", "1-03 Song", "01.03 - Song". This is where zero
  // padding and disc prefixes actually bite.
  //
  // BOTH forms demand a separator AND whitespace before the title. That is what
  // keeps real titles intact: "99 Problems" (no separator), "1979" (no
  // separator) and "1-800-273-8255" (separator, but no whitespace after it)
  // all survive untouched. A title that loses its number is a title that can
  // never be matched to its duplicate, so the rule errs towards leaving it.
  function _stripTrackPrefix(str) {
    var s = String(str == null ? '' : str)
    // "1-03 Song", "01.03 - Song"
    var m = s.match(/^\s*\d{1,2}[-.]\d{1,3}[ \t]*[-–—.)_]*[ \t]+(.+)$/)
    if (m && m[1].trim()) return m[1]
    // "03 - Song", "3. Song", "07) Song"
    m = s.match(/^\s*\d{1,3}[ \t]*[-–—.)_]+[ \t]+(.+)$/)
    if (m && m[1].trim()) return m[1]
    return s
  }

  // The comparable form of a song title. Word ORDER is kept — "Love Me Do" and
  // "Do Me Love" are not the same song — but case, punctuation, diacritics,
  // "feat." spellings, edition brackets and track-number prefixes all fold away.
  function titleKey(track) {
    var raw = String((track && track.title) || '')
    var s = _stripTrackPrefix(raw)
    s = _stripFeat(s)
    s = _dropBrackets(s, EDITION_WORDS, false)
    var toks = _tok(s)
    if (!toks.length) toks = _tok(raw)
    return toks.join(' ')
  }

  // The comparable form of an album name. Same folding, plus the file-format
  // and disc tags rippers bolt on.
  function albumKey(track) {
    var raw = String((track && (track.album != null ? track.album : track.albumName)) || '')
    var s = _dropBrackets(raw, ALBUM_STRIP, true)
    s = s.replace(/\s+[-–—]\s*(?:disc|disk|cd)\s*\d+\s*$/i, ' ')
    s = s.replace(/\s+(?:disc|disk|cd)\s*\d+\s*$/i, ' ')
    var toks = _tok(s)
    if (!toks.length) toks = _tok(raw)
    return toks.join(' ')
  }

  // The comparable artist. Returns '' for the placeholders that mean "nobody
  // wrote this down" — those act as a wildcard inside an album rather than
  // splitting a real duplicate apart.
  var ARTIST_WILDCARD = _set([
    '', 'unknown', 'unknown artist', 'various', 'various artists', 'va', 'artist',
  ])
  function artistKey(track) {
    if (!track) return ''
    var raw = track.albumArtist || track.artist || ''
    var key = _tok(_stripFeat(raw)).join(' ')
    return ARTIST_WILDCARD[key] ? '' : key
  }

  // ── Quality ─────────────────────────────────────────────────────────────────

  function _num(x) {
    if (x === null || typeof x === 'undefined' || x === '') return null
    var n = Number(x)
    return isFinite(n) ? n : null
  }

  function _ext(filePath) {
    var p = String(filePath || '').split('?')[0]
    var i = p.lastIndexOf('.')
    if (i < 0 || i === p.length - 1) return ''
    return p.slice(i + 1).toLowerCase()
  }

  // A short display name for the codec. ffprobe joins with underscores
  // ("pcm_s24le"), so take the head token.
  function _codecName(track) {
    var c = String((track && track.codec) || '').replace(/[_\-]+/g, ' ').trim()
    if (c) return c.split(/\s+/)[0].toUpperCase()
    var e = _ext(track && track.filePath)
    return e ? e.toUpperCase() : ''
  }

  var VBR_HINT = /\b(v[0-9]|vbr|abr|aps|apx)\b/i
  function _isVbr(track, codecName) {
    if (track.vbr === true) return true
    if (track.vbr === false) return false
    var prof = String(track.codecProfile || track.encoderProfile || '')
    if (prof) {
      if (/\bcbr\b/i.test(prof)) return false
      if (VBR_HINT.test(prof)) return true
    }
    // Opus and Vorbis are VBR by construction.
    if (/^(OPUS|VORBIS|OGG)$/.test(codecName)) return true
    // The filename is NOT evidence of quality. It is read here for one thing:
    // a VBR marker, which can only make this module refuse a deletion it would
    // otherwise have proposed. It can never create one.
    var p = String(track.filePath || '').replace(/[^\w]+/g, ' ')
    return VBR_HINT.test(p)
  }
  function _vbrProfile(track) {
    var prof = String(track.codecProfile || track.encoderProfile || '')
    var m = /\b(v[0-9])\b/i.exec(prof)
    return m ? m[1].toUpperCase() : null
  }

  function _khz(rate) { return (Math.round(rate / 100) / 10) + ' kHz' }

  // Everything the ranking is allowed to look at, derived once per track.
  //
  //   cls       'lossless' | 'lossy' | 'dsd' | 'unknown' — quality-badge's own
  //             classifier, so this module cannot drift from the badge.
  //   conflict  the codec tag and the file extension disagree (a file named
  //             .mp3 whose tags claim FLAC). Nothing about such a file can be
  //             trusted, so it is never on either end of a deletion.
  function qualityOf(track) {
    var t = track || {}
    var codecName = _codecName(t)
    var cls = QB().codecClass(t)
    // codecClass prefers the codec string and falls back to the extension;
    // asking it twice, once with each, is how we catch a file whose tags lie.
    var byCodec = t.codec ? QB().codecClass({ codec: t.codec }) : 'unknown'
    var byExt = t.filePath ? QB().codecClass({ filePath: t.filePath }) : 'unknown'
    var conflict = byCodec !== 'unknown' && byExt !== 'unknown' && byCodec !== byExt

    var bits = _num(t.bitsPerSample != null ? t.bitsPerSample : t.bitDepth)
    var rate = _num(t.sampleRate)
    var bitrate = _num(t.bitrate)
    var size = _num(t.fileSize != null ? t.fileSize : t.size)
    var channels = _num(t.channels)

    // music-metadata reports bitrate in bits/second; some callers hand kbps.
    if (bitrate != null && bitrate > 5000) bitrate = bitrate / 1000
    if (bitrate != null) bitrate = Math.round(bitrate)
    if (bitrate != null && (bitrate < 1 || bitrate > 12000)) bitrate = null

    // A lossy codec has no meaningful bit depth; a tag claiming one is noise.
    if (cls === 'lossy' || cls === 'unknown') bits = null
    if (bits != null && (bits < 8 || bits > 64)) bits = null
    if (rate != null && (rate < 4000 || rate > 1e7)) rate = null
    if (size != null && size <= 0) size = null
    if (channels != null && (channels < 1 || channels > 64)) channels = null

    // DSD's own numbers (1 bit, 2.8 MHz) are not on the PCM scale. Keeping them
    // in `bits`/`rate` would let a DSD64 file "beat" FLAC 24/192 on arithmetic
    // that means nothing. They are parked in dsdRate and the comparison refuses.
    var dsdRate = null
    if (cls === 'dsd') {
      dsdRate = rate
      bits = null
      rate = null
    }

    var vbr = (cls === 'lossy') ? _isVbr(t, codecName) : false
    var hiRes = cls === 'lossless' && FB().isHiRes({ bitsPerSample: bits, sampleRate: rate })

    var q = {
      cls: cls,
      codec: codecName,
      conflict: conflict,
      conflictCodec: conflict ? byCodec : null,
      conflictExt: conflict ? byExt : null,
      bits: bits,
      rate: rate,
      dsdRate: dsdRate,
      bitrate: bitrate,
      size: size,
      channels: channels,
      atmos: t.atmos === true,
      vbr: vbr,
      vbrProfile: vbr ? _vbrProfile(t) : null,
      hiRes: hiRes,
      surround: FB().surroundLabel(channels || 0),
    }
    q.label = describeQuality(q)
    return q
  }

  // The one sentence the UI shows for a copy: "FLAC 24-bit/96 kHz",
  // "MP3 320 kbps", "MP3 V0 (~245 kbps)", "DSD — decoded to PCM for playback".
  // Accepts either a track or an already-computed quality object.
  function describeQuality(src) {
    var q = (src && src.cls) ? src : qualityOf(src)
    var name = q.codec || 'Unknown format'
    var main
    if (q.cls === 'dsd') {
      main = 'DSD — decoded to PCM for playback'
    } else if (q.cls === 'lossless') {
      if (q.bits && q.rate) main = name + ' ' + q.bits + '-bit/' + _khz(q.rate)
      else if (q.rate) main = name + ' ' + _khz(q.rate)
      else if (q.bits) main = name + ' ' + q.bits + '-bit'
      else main = name + ' lossless'
    } else if (q.cls === 'lossy') {
      if (q.vbrProfile && q.bitrate) main = name + ' ' + q.vbrProfile + ' (~' + q.bitrate + ' kbps)'
      else if (q.bitrate && q.vbr) main = name + ' ~' + q.bitrate + ' kbps VBR'
      else if (q.bitrate) main = name + ' ' + q.bitrate + ' kbps'
      else main = name + ' lossy'
    } else {
      main = name === 'Unknown format' ? name : name + ' (format not identified)'
    }
    if (q.atmos) main += ' Atmos'
    else if (q.surround) main += ' ' + q.surround
    return main
  }

  // Tier: the only cross-class ordering this module believes in.
  function _tier(cls) {
    if (cls === 'lossless' || cls === 'dsd') return 3
    if (cls === 'lossy') return 1
    return 0
  }

  // Which copy to KEEP. This only picks a candidate; nothing is proposed for
  // removal until supersedes() independently agrees, so a wrong keeper here
  // costs a missed duplicate, never a lost file.
  function compareQuality(a, b) {
    var qa = a && a.cls ? a : qualityOf(a)
    var qb = b && b.cls ? b : qualityOf(b)
    var d = _tier(qb.cls) - _tier(qa.cls)
    if (d) return d
    d = (qb.bits || 0) - (qa.bits || 0)
    if (d) return d
    d = (qb.rate || 0) - (qa.rate || 0)
    if (d) return d
    d = (qb.bitrate || 0) - (qa.bitrate || 0)
    if (d) return d
    d = (qb.size || 0) - (qa.size || 0)
    if (d) return d
    return 0
  }

  // ── The verdict ─────────────────────────────────────────────────────────────
  // Given the candidate keeper and one other copy, does the keeper GENUINELY
  // supersede it? Returns { verdict: 'supersedes' | 'unsure', kind, reason }.
  // Every path that cannot prove an upgrade from the metadata returns 'unsure'.
  function supersedes(keeperTrack, otherTrack, opts) {
    var o = _options(opts)
    var k = keeperTrack && keeperTrack.cls ? keeperTrack : qualityOf(keeperTrack)
    var l = otherTrack && otherTrack.cls ? otherTrack : qualityOf(otherTrack)
    var pair = k.label + ' vs ' + l.label

    if (k.conflict || l.conflict) {
      var bad = k.conflict ? k : l
      return _unsure('metadata',
        'The tags and the file disagree — ' + (bad.conflictCodec) +
        ' in the tags, ' + (bad.conflictExt) + ' by the file on disk (' + pair +
        '). Nothing about this file can be trusted, so neither copy is called a duplicate.')
    }
    if (k.cls === 'unknown' || l.cls === 'unknown') {
      return _unsure('metadata',
        'One copy’s format is not identified (' + pair + '), so there is no honest way to say which is better.')
    }
    // A surround mix and a stereo mix are different releases of the music, not
    // two copies of one file. Same for Atmos.
    if (k.atmos !== l.atmos) {
      return _unsure('layout',
        'One copy is Atmos and the other is not (' + pair + ') — a different mix, not a duplicate.')
    }
    if (k.channels != null && l.channels != null && k.channels !== l.channels) {
      return _unsure('layout',
        'Different channel layouts (' + _chan(k) + ' vs ' + _chan(l) +
        ') — a surround or mono mix is a different release, not a duplicate.')
    }
    if ((k.channels != null && k.channels > 2 && l.channels == null) ||
        (l.channels != null && l.channels > 2 && k.channels == null)) {
      return _unsure('layout',
        'One copy is multichannel and the other’s channel count was never read — ' +
        'a surround mix must not be confused with the stereo one.')
    }

    // DSD: lossless as a file, decoded to PCM to play. It beats lossy honestly;
    // against PCM lossless there is nothing in the tags to compare.
    if (k.cls === 'dsd' && l.cls === 'dsd') {
      return _unsure('quality',
        'Two DSD copies — both are decoded to PCM for playback here, so the tags do not say one is better.')
    }
    if (k.cls === 'dsd' && l.cls === 'lossless') {
      return _unsure('quality',
        'DSD is decoded to PCM for playback here, so it cannot be ranked against ' +
        l.label + ' from the tags.')
    }
    if (l.cls === 'dsd' && k.cls === 'lossless') {
      return _unsure('quality',
        'DSD is decoded to PCM for playback here, so ' + k.label +
        ' cannot be ranked against it from the tags.')
    }

    // The core case: lossless replaces lossy.
    if (_tier(k.cls) > _tier(l.cls)) {
      return _yes('format', k.label + ' supersedes ' + l.label + ' — ' +
        (k.cls === 'dsd'
          ? 'a lossless DSD source (decoded to PCM here) replaces lossy.'
          : 'lossless replaces lossy.'))
    }
    if (_tier(k.cls) < _tier(l.cls)) {
      return _unsure('quality',
        l.label + ' is the better copy — ' + k.label + ' does not supersede it.')
    }

    if (k.cls === 'lossless') {
      if (k.bits == null || l.bits == null || k.rate == null || l.rate == null) {
        return _unsure('quality',
          'Two lossless copies, but the bit depth or sample rate was never read for one of them (' +
          pair + ') — nothing proves an upgrade.')
      }
      if (k.bits === l.bits && k.rate === l.rate) {
        return _unsure('quality',
          'Two lossless copies at the same ' + k.bits + '-bit/' + _khz(k.rate) +
          ' — nothing in the tags says one is better than the other.')
      }
      // Depth and rate must agree about which copy is better. 16-bit/96 kHz vs
      // 24-bit/44.1 kHz is a trade, not an upgrade.
      if ((k.bits > l.bits && k.rate < l.rate) || (k.bits < l.bits && k.rate > l.rate)) {
        return _unsure('quality',
          'Bit depth and sample rate disagree (' + pair + ') — one copy is deeper, the other faster. That is a trade, not an upgrade.')
      }
      if (k.bits < l.bits || k.rate < l.rate) {
        return _unsure('quality', l.label + ' is the better copy — ' + k.label + ' does not supersede it.')
      }
      if (!o.hiResSupersedesCd && FB().isHiRes({ bitsPerSample: k.bits, sampleRate: k.rate }) &&
          !FB().isHiRes({ bitsPerSample: l.bits, sampleRate: l.rate })) {
        return _unsure('quality',
          'Hi-res is set not to supersede CD-spec lossless, so ' + pair + ' is left for you to decide.')
      }
      var why = k.bits > l.bits
        ? (k.rate > l.rate ? 'higher bit depth and sample rate' : 'higher bit depth')
        : 'higher sample rate'
      return _yes('spec', k.label + ' supersedes ' + l.label + ' — same lossless codec, ' + why + '.')
    }

    // Both lossy.
    var sameCodec = k.codec && l.codec && k.codec === l.codec
    if (k.bitrate == null || l.bitrate == null) {
      // Same duration bucket, so file size stands in for bitrate — but only as
      // a last resort and only with a real margin.
      if (k.size != null && l.size != null && k.size >= l.size * o.sizeFallbackMargin && sameCodec) {
        return _yes('size', k.label + ' supersedes ' + l.label + ' — same codec and the same song, ' +
          _ratio(k.size, l.size) + ' the file size and no bitrate recorded for either.')
      }
      return _unsure('quality',
        'Two lossy copies with no usable bitrate to compare (' + pair + ').')
    }
    var margin
    var marginWhy
    if (!sameCodec) {
      margin = o.crossCodecBitrateMargin
      marginWhy = 'two different lossy codecs, whose bitrates are not on the same scale'
    } else if (k.vbr || l.vbr) {
      margin = o.vbrBitrateMargin
      marginWhy = 'a VBR bitrate understates the quality it delivers'
    } else {
      margin = o.sameCodecBitrateMargin
      marginWhy = 'the bitrates are too close to call'
    }
    if (k.bitrate >= l.bitrate * margin) {
      return _yes('bitrate', k.label + ' supersedes ' + l.label + ' — ' +
        (sameCodec ? 'same codec, ' : '') + _ratio(k.bitrate, l.bitrate) + ' the bitrate.')
    }
    return _unsure('quality', pair + ' — ' + marginWhy + ', so this is not a clear upgrade.')
  }

  function _chan(q) {
    if (q.channels == null) return 'unknown'
    if (q.surround) return q.surround
    if (q.channels === 1) return 'mono'
    if (q.channels === 2) return 'stereo'
    return q.channels + ' channels'
  }
  function _ratio(a, b) {
    if (!b) return 'more'
    var r = a / b
    return (Math.round(r * 10) / 10) + '×'
  }
  function _yes(kind, reason) { return { verdict: 'supersedes', kind: kind, reason: reason } }
  function _unsure(kind, reason) { return { verdict: 'unsure', kind: kind, reason: reason } }

  // ── Duration ────────────────────────────────────────────────────────────────

  function _tolerance(a, b, o) {
    var longer = Math.max(a, b)
    var tol = Math.max(o.durationToleranceSec, longer * o.durationTolerancePct)
    return Math.min(tol, o.durationToleranceMaxSec)
  }

  // 'same' | 'unsure' | 'different' | 'missing'
  function durationRelation(a, b, opts) {
    var o = _options(opts)
    var da = _num(a)
    var db = _num(b)
    if (!da || !db || da <= 0 || db <= 0) return 'missing'
    var gap = Math.abs(da - db)
    if (gap <= _tolerance(da, db, o)) return 'same'
    var big = Math.max(o.differentRecordingMinSec, Math.max(da, db) * o.differentRecordingPct)
    return gap <= big ? 'unsure' : 'different'
  }

  function _fmtDur(sec) {
    var s = Math.round(Number(sec) || 0)
    var m = Math.floor(s / 60)
    var r = s % 60
    return m + ':' + (r < 10 ? '0' : '') + r
  }

  // ── Grouping ────────────────────────────────────────────────────────────────

  function _options(opts) {
    var o = {}
    for (var k in DEFAULTS) o[k] = DEFAULTS[k]
    if (opts) for (var j in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(opts, j) && opts[j] != null) o[j] = opts[j]
    }
    return o
  }

  // Accepts a flat track list, or the renderer's album array (objects with a
  // `.tracks` array) — album objects carry the album name as `.name` and the
  // artist as `.artist`, which the nested tracks do not, so they are inherited.
  function flattenInput(input) {
    var out = []
    var list = Array.isArray(input) ? input : []
    for (var i = 0; i < list.length; i++) {
      var it = list[i]
      if (!it || typeof it !== 'object') continue
      if (Array.isArray(it.tracks) && !it.filePath) {
        for (var j = 0; j < it.tracks.length; j++) {
          var t = it.tracks[j]
          if (!t || typeof t !== 'object') continue
          var copy = {}
          for (var k in t) if (Object.prototype.hasOwnProperty.call(t, k)) copy[k] = t[k]
          if (copy.album == null) copy.album = it.name != null ? it.name : it.album
          if (copy.albumArtist == null) copy.albumArtist = it.artist
          if (copy.albumId == null) copy.albumId = it.id
          out.push(copy)
        }
        continue
      }
      out.push(it)
    }
    return out
  }

  function _idOf(track, idx) {
    if (track && track.id) return String(track.id)
    if (track && track.filePath) return String(track.filePath)
    return 'idx:' + idx
  }

  function _summary(entry) {
    var t = entry.track
    return {
      id: entry.id,
      filePath: t.filePath || null,
      title: t.title || '',
      album: (t.album != null ? t.album : t.albumName) || '',
      artist: t.albumArtist || t.artist || '',
      trackNumber: _num(t.trackNumber),
      discNumber: _num(t.discNumber),
      duration: _num(t.duration),
      durationText: _fmtDur(t.duration),
      fileSize: entry.q.size,
      quality: entry.q,
      describe: entry.q.label,
    }
  }

  // ── The entry point ─────────────────────────────────────────────────────────
  //
  // Returns:
  //   {
  //     groups:    [{ key, title, album, artist, keeper, superseded[], ambiguous[] }],
  //     plan:      [{ id, groupKey, remove, keeper, reason, kind, bytes,
  //                   confidence:'high', selected:false, action:'trash' }],
  //     ambiguous: [{ id, groupKey, kind, reason, copies[], confidence:'unsure',
  //                   selected:false }],
  //     stats:     { ... }
  //   }
  // `plan` is the ONLY list a removal may ever be built from, and every item in
  // it is unselected. `ambiguous` is for showing, never for preselecting.
  function findSupersededCopies(input, opts) {
    var o = _options(opts)
    var tracks = flattenInput(input)
    var buckets = Object.create(null)
    var bucketOrder = []
    var i

    for (i = 0; i < tracks.length; i++) {
      var t = tracks[i]
      if (!t || typeof t !== 'object') continue
      var tk = titleKey(t)
      if (!tk) continue // no title — nothing can be identified
      var ak = albumKey(t)
      var key = ak + ' ' + tk
      if (!buckets[key]) { buckets[key] = []; bucketOrder.push(key) }
      buckets[key].push({
        id: _idOf(t, i),
        track: t,
        albumKey: ak,
        titleKey: tk,
        artistKey: artistKey(t),
        q: qualityOf(t),
        order: i,
      })
    }

    var groups = []
    var plan = []
    var ambiguous = []
    var stats = {
      tracksExamined: tracks.length,
      groupsWithCopies: 0,
      supersededCount: 0,
      ambiguousCount: 0,
      separatedByDuration: 0,
      bytesReclaimable: 0,
    }

    for (i = 0; i < bucketOrder.length; i++) {
      var entries = buckets[bucketOrder[i]]
      if (entries.length < 2) continue
      var clusters = _splitByArtist(entries, bucketOrder[i], ambiguous)
      for (var c = 0; c < clusters.length; c++) {
        _analyseCluster(clusters[c], bucketOrder[i], o, groups, plan, ambiguous, stats)
      }
    }

    for (i = 0; i < plan.length; i++) stats.bytesReclaimable += plan[i].bytes || 0
    stats.supersededCount = plan.length
    stats.ambiguousCount = ambiguous.length
    return { groups: groups, plan: plan, ambiguous: ambiguous, stats: stats }
  }

  // Inside one album+title bucket, copies must also agree on the artist. Two
  // different artists' songs of the same name on a compilation are not copies
  // of each other. When the bucket holds more than one real artist, a copy with
  // no artist at all cannot be placed and is reported as unsure.
  function _splitByArtist(entries, bucketKey, ambiguous) {
    var byArtist = Object.create(null)
    var order = []
    var wildcards = []
    var i
    for (i = 0; i < entries.length; i++) {
      var a = entries[i].artistKey
      if (!a) { wildcards.push(entries[i]); continue }
      if (!byArtist[a]) { byArtist[a] = []; order.push(a) }
      byArtist[a].push(entries[i])
    }
    if (order.length === 0) return [wildcards]
    if (order.length === 1) return [byArtist[order[0]].concat(wildcards)]
    var out = []
    for (i = 0; i < order.length; i++) out.push(byArtist[order[i]])
    if (wildcards.length) {
      ambiguous.push(_ambiguous(bucketKey, 'artist', wildcards.concat(byArtist[order[0]]),
        'Copies of this title sit under more than one artist, and one copy has no artist tagged — ' +
        'there is no safe way to say which recording it is.'))
    }
    return out
  }

  function _ambiguous(groupKey, kind, entries, reason) {
    var copies = []
    for (var i = 0; i < entries.length; i++) copies.push(_summary(entries[i]))
    return {
      id: 'unsure:' + groupKey + ':' + kind + ':' + copies.map(function (c) { return c.id }).join('|'),
      groupKey: groupKey,
      kind: kind,
      reason: reason,
      copies: copies,
      confidence: 'unsure',
      selected: false,
    }
  }

  function _analyseCluster(entries, bucketKey, o, groups, plan, ambiguous, stats) {
    if (!entries || entries.length < 2) return

    // Split by duration first. A different edit, a live take or a remix filed
    // under the same title is NOT a duplicate, and ranking across that gap is
    // exactly how a wrong delete happens.
    var timed = []
    var untimed = []
    var i
    for (i = 0; i < entries.length; i++) {
      var d = _num(entries[i].track.duration)
      if (d && d > 0) timed.push(entries[i])
      else untimed.push(entries[i])
    }
    timed.sort(function (a, b) {
      return (_num(a.track.duration) - _num(b.track.duration)) || (a.order - b.order)
    })

    var clusters = []
    for (i = 0; i < timed.length; i++) {
      var cur = timed[i]
      var placed = false
      for (var c = 0; c < clusters.length; c++) {
        if (durationRelation(clusters[c][0].track.duration, cur.track.duration, o) === 'same') {
          clusters[c].push(cur)
          placed = true
          break
        }
      }
      if (!placed) clusters.push([cur])
    }

    // Report the near-misses: gaps past tolerance but not wide enough to be
    // certain they are different recordings. Shown, never preselected.
    for (i = 0; i < clusters.length; i++) {
      for (var j = i + 1; j < clusters.length; j++) {
        var a = clusters[i][0]
        var b = clusters[j][0]
        var rel = durationRelation(a.track.duration, b.track.duration, o)
        if (rel === 'unsure') {
          ambiguous.push(_ambiguous(bucketKey, 'duration', [a, b],
            'Same album and title, but the two run ' + _fmtDur(a.track.duration) + ' and ' +
            _fmtDur(b.track.duration) + ' — ' +
            _fmtDur(Math.abs(_num(a.track.duration) - _num(b.track.duration))) +
            ' apart. That may be a different edit rather than a duplicate.'))
        } else {
          stats.separatedByDuration++
        }
      }
    }

    // A copy with no duration cannot be confirmed to be the same recording.
    if (untimed.length && (timed.length || untimed.length > 1)) {
      var withUnknown = untimed.concat(timed.length ? [timed[0]] : [])
      if (withUnknown.length > 1) {
        ambiguous.push(_ambiguous(bucketKey, 'duration', withUnknown,
          'One copy has no duration recorded, so there is no way to confirm it is the same recording.'))
      }
    }

    for (i = 0; i < clusters.length; i++) {
      _rankCluster(clusters[i], bucketKey, o, groups, plan, ambiguous, stats)
    }
  }

  function _rankCluster(entries, bucketKey, o, groups, plan, ambiguous, stats) {
    if (!entries || entries.length < 2) return
    var sorted = entries.slice().sort(function (a, b) {
      return compareQuality(a.q, b.q) ||
        String(a.track.filePath || a.id).localeCompare(String(b.track.filePath || b.id))
    })
    var keeper = sorted[0]
    var keeperSummary = _summary(keeper)
    var group = {
      key: bucketKey,
      title: keeper.track.title || '',
      album: (keeper.track.album != null ? keeper.track.album : keeper.track.albumName) || '',
      artist: keeper.track.albumArtist || keeper.track.artist || '',
      keeper: keeperSummary,
      superseded: [],
      ambiguous: [],
    }
    stats.groupsWithCopies++

    for (var i = 1; i < sorted.length; i++) {
      var other = sorted[i]
      var v = supersedes(keeper.q, other.q, o)
      if (v.verdict === 'supersedes') {
        var item = {
          id: 'remove:' + other.id,
          groupKey: bucketKey,
          kind: v.kind,
          reason: v.reason,
          remove: _summary(other),
          keeper: keeperSummary,
          bytes: other.q.size || 0,
          confidence: 'high',
          // Never preselected. Never unlink. The caller confirms per item and
          // moves the file to the trash.
          selected: false,
          action: 'trash',
        }
        plan.push(item)
        group.superseded.push(item)
      } else {
        var amb = _ambiguous(bucketKey, v.kind, [keeper, other], v.reason)
        ambiguous.push(amb)
        group.ambiguous.push(amb)
      }
    }
    groups.push(group)
  }

  // ── The funnel the UI must use ──────────────────────────────────────────────
  // Turn an explicit list of chosen plan ids into the removal request. It is
  // deliberately hostile: ids not in `plan` (an `ambiguous` id, a stale id, a
  // made-up id) are rejected, duplicates collapse, and NO ids means NO removals
  // — never "all of them".
  function toRemovalPlan(result, ids) {
    var plan = (result && Array.isArray(result.plan)) ? result.plan : []
    var byId = Object.create(null)
    var i
    for (i = 0; i < plan.length; i++) byId[plan[i].id] = plan[i]
    var wanted = Array.isArray(ids) ? ids : []
    var seen = Object.create(null)
    var items = []
    var paths = []
    var rejected = []
    var bytes = 0
    for (i = 0; i < wanted.length; i++) {
      var id = String(wanted[i])
      if (seen[id]) continue
      seen[id] = true
      var item = byId[id]
      if (!item || !item.remove || !item.remove.filePath) { rejected.push(id); continue }
      items.push(item)
      paths.push(item.remove.filePath)
      bytes += item.bytes || 0
    }
    return {
      action: 'trash',
      items: items,
      paths: paths,
      bytes: bytes,
      rejected: rejected,
    }
  }

  var API = {
    findSupersededCopies: findSupersededCopies,
    toRemovalPlan: toRemovalPlan,
    qualityOf: qualityOf,
    describeQuality: describeQuality,
    compareQuality: compareQuality,
    supersedes: supersedes,
    durationRelation: durationRelation,
    titleKey: titleKey,
    albumKey: albumKey,
    artistKey: artistKey,
    flattenInput: flattenInput,
    DEFAULTS: DEFAULTS,
  }

  return API
})()

if (typeof module !== 'undefined' && module.exports) module.exports = _PapaUpgradeDupes
if (typeof window !== 'undefined') window.PapaUpgradeDupes = _PapaUpgradeDupes
