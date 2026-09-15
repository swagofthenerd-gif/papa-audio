'use strict'
// The now-playing quality badge, decided in one honest place (roadmap 093).
//
// The badge used to say LOSSLESS for any file that was not a URL — an MP3
// included — and BIT-PERFECT whenever the output was exclusive and ReplayGain
// happened to be off, without looking at the EQ, crossfade or volume, all of
// which rewrite samples on the way to the DAC. It also tested ReplayGain
// against 'off' while the setting's real values are 'no' | 'track' | 'album',
// so once a user had explicitly turned ReplayGain off the badge could never
// say BIT-PERFECT at all.
//
// Rules:
//   - A stream (http) gets no badge here; the format badge says Stream.
//   - Codec first: only a lossless codec can be LOSSLESS. The codec string
//     from music-metadata / ffprobe is preferred; the extension is the
//     fallback; a container that can hold either (m4a) with no codec is
//     unknown, and unknown gets no badge rather than a guess.
//   - BIT-PERFECT needs a lossless codec, exclusive output, and nothing in
//     the chain touching samples: no EQ, no ReplayGain, speed 1, no
//     crossfade, volume at exactly 100. Anything else is LOSSLESS with the
//     tooltip naming what is processing it.
//   - "Verified" is not claimed: we know what the app asked for, not what
//     the device did. The tooltip says so.
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.PapaQualityBadge = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  var LOSSLESS_CODEC = /\b(flac|alac|pcm|wav|aiff?|ape|monkey|wavpack|wv|truehd|mlp|tta|tak|dts ?hd ?ma|dsd|dsf)\b/i
  var LOSSY_CODEC = /\b(mp3|mpeg|aac|opus|vorbis|ogg|wma|ac-?3|eac3|e-ac-3|dts|mp2|musepack|mpc)\b/i
  var LOSSLESS_EXT = { flac: 1, wav: 1, alac: 1, aiff: 1, aif: 1, ape: 1, wv: 1, tta: 1, tak: 1, dsf: 1, dff: 1 }
  var LOSSY_EXT = { mp3: 1, aac: 1, ogg: 1, oga: 1, opus: 1, wma: 1, mpc: 1, ac3: 1, eac3: 1, dts: 1, mp2: 1 }

  function codecClass(track) {
    if (!track) return 'unknown'
    // ffprobe joins with underscores (pcm_s24le, dts_hd_ma); treat them as spaces.
    var codec = String(track.codec || '').replace(/[_-]+/g, ' ')
    if (codec) {
      if (LOSSLESS_CODEC.test(codec)) return 'lossless'
      if (LOSSY_CODEC.test(codec)) return 'lossy'
    }
    var ext = String(track.filePath || '').split('?')[0].split('.').pop().toLowerCase()
    if (LOSSLESS_EXT[ext]) return 'lossless'
    if (LOSSY_EXT[ext]) return 'lossy'
    return 'unknown'   // m4a/mka/mp4 with no codec: could be either
  }

  // What is altering samples right now, as short names for a tooltip.
  function processing(settings, speed, volume) {
    settings = settings || {}
    var list = []
    var eq = settings.eq
    if (eq && eq.enabled) list.push('EQ')
    var rg = String(settings.replaygain || 'no').toLowerCase()
    if (rg === 'track' || rg === 'album') list.push('ReplayGain (' + rg + ')')
    var sp = Number(speed)
    if (isFinite(sp) && sp > 0 && sp !== 1) list.push('Speed ' + sp + '×')
    if (settings.mode === 'crossfade') list.push('Crossfade')
    // null/undefined means "not known", which is not the same as 0%.
    var vol = volume == null || volume === '' ? NaN : Number(volume)
    if (isFinite(vol) && vol >= 0 && Math.round(vol) !== 100) list.push('Volume ' + Math.round(vol) + '%')
    return list
  }

  function isExclusive(settings) {
    settings = settings || {}
    return settings.bitPerfect === true || settings.bitperfect === true || settings.outputMode === 'exclusive'
  }

  // The verdict. `volume` is a percentage (100 = unity); pass null if unknown.
  function classify(opts) {
    opts = opts || {}
    var track = opts.track
    if (!track) return { label: null, codecClass: 'none', processing: [], reason: '' }
    if (typeof track.filePath === 'string' && /^https?:/i.test(track.filePath)) {
      return { label: null, codecClass: 'stream', processing: [], reason: '' }
    }
    var cls = codecClass(track)
    var proc = processing(opts.settings, opts.speed, opts.volume)
    if (cls !== 'lossless') {
      return { label: null, codecClass: cls, processing: proc,
        reason: cls === 'lossy' ? 'Lossy source.' : 'Format not identified.' }
    }
    var exclusive = isExclusive(opts.settings)
    if (exclusive && proc.length === 0) {
      return { label: 'BIT-PERFECT', codecClass: cls, processing: proc,
        reason: 'Lossless source, exclusive output, nothing processing the samples. ' +
          'This is what the app asked the engine for; the device itself is not measured.' }
    }
    var reason = 'Lossless source'
    if (proc.length) reason += ', processed by ' + proc.join(', ') + '.'
    else reason += '. Shared output: the system mixer may resample. Turn on Bit-perfect in Settings for untouched output.'
    return { label: 'LOSSLESS', codecClass: cls, processing: proc, reason: reason }
  }

  return { classify: classify, codecClass: codecClass, processing: processing, isExclusive: isExclusive }
})
