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
// The 2026-09 honesty pass closed five more ways it lied. The rule the user
// set for that pass: where the truth is inconvenient, RELABEL — never change
// what he hears. Nothing below alters a single sample; it only stops the badge
// claiming things that are not true.
//
//   C1  It was blind to `replaygainApply` (the loudness-scan leveling, App #59)
//       and to mpv's real `volume` property, which main never relayed. Both are
//       gain paths. The badge now takes an optional `engineVolume` — mpv's own
//       volume, which already carries the slider, the boost AND the leveling —
//       and treats it as ground truth when it is there. Without it, it falls
//       back to the slider and names the parts the slider cannot see.
//   C5  DSD was matched as a lossless codec and could reach BIT-PERFECT. mpv
//       decodes DSD to PCM (nothing in this app asks for DoP or native DSD),
//       so the DAC never sees the DSD bitstream. It gets its own label now.
//   C4  mpv is spawned with --gapless-audio=yes, which holds one output stream
//       open across a track change and therefore RESAMPLES a queue that mixes
//       sample rates. The user's decision is to keep it seamless and disclose
//       it, so this module only names it.
//
// Rules:
//   - A stream (http) gets no badge here; the format badge says Stream.
//   - Codec first: only a lossless codec can be LOSSLESS. The codec string
//     from music-metadata / ffprobe is preferred; the extension is the
//     fallback; a container that can hold either (m4a) with no codec is
//     unknown, and unknown gets no badge rather than a guess.
//   - DSD is its own class: lossless as a file, but decoded to PCM to play.
//   - BIT-PERFECT needs a lossless (non-DSD) codec, exclusive output, and
//     nothing in the chain touching samples: no EQ, no ReplayGain, no loudness
//     leveling, speed 1, no crossfade, no gapless resample, and unity gain.
//     Anything else is LOSSLESS with the tooltip naming what is processing it.
//   - "Verified" is not claimed: we know what the app asked for, not what
//     the device did. The tooltip says so.
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.PapaQualityBadge = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  // DSD is tested first: 'dsd' also matches the lossless list, and the two
  // answers are different (see C5 above).
  var DSD_CODEC = /\b(dsd|dsf|dff|dst|dsd ?(lsbf|msbf)[a-z0-9]*)\b/i
  var DSD_EXT = { dsf: 1, dff: 1 }
  var LOSSLESS_CODEC = /\b(flac|alac|pcm|wav|aiff?|ape|monkey|wavpack|wv|truehd|mlp|tta|tak|dts ?hd ?ma)\b/i
  var LOSSY_CODEC = /\b(mp3|mpeg|aac|opus|vorbis|ogg|wma|ac-?3|eac3|e-ac-3|dts|mp2|musepack|mpc)\b/i
  var LOSSLESS_EXT = { flac: 1, wav: 1, alac: 1, aiff: 1, aif: 1, ape: 1, wv: 1, tta: 1, tak: 1 }
  var LOSSY_EXT = { mp3: 1, aac: 1, ogg: 1, oga: 1, opus: 1, wma: 1, mpc: 1, ac3: 1, eac3: 1, dts: 1, mp2: 1 }

  // C5: what actually happens to a DSD file here. mpv's dsd decoder converts to
  // PCM; this app never passes --audio-format or a DoP wrapper, so there is no
  // native-DSD path to the DAC and the badge must not imply one.
  var DSD_NOTE =
    'DSD source, decoded to PCM. mpv converts the DSD bitstream to PCM to play ' +
    'it — this app has no DoP or native-DSD output path — so what reaches the ' +
    'DAC is a conversion, not the file’s own bits.'

  // C4: --gapless-audio=yes (mpv-engine _args) keeps ONE output stream open
  // across a track change. When the next file’s rate differs it is resampled
  // to the rate the stream opened at, rather than the output being reopened.
  // Disclosed, never "fixed": seamless playback is the user’s explicit call.
  var GAPLESS_NOTE =
    'Gapless is on, so the output stream stays open across track changes: when ' +
    'the next track has a different sample rate mpv resamples it instead of ' +
    'reopening the device. That conversion is not bit-perfect. It is kept ' +
    'because seamless playback was chosen over reopening the output.'

  function codecClass(track) {
    if (!track) return 'unknown'
    // ffprobe joins with underscores (pcm_s24le, dts_hd_ma); treat them as spaces.
    var codec = String(track.codec || '').replace(/[_-]+/g, ' ')
    if (codec) {
      if (DSD_CODEC.test(codec)) return 'dsd'
      if (LOSSLESS_CODEC.test(codec)) return 'lossless'
      if (LOSSY_CODEC.test(codec)) return 'lossy'
    }
    var ext = String(track.filePath || '').split('?')[0].split('.').pop().toLowerCase()
    if (DSD_EXT[ext]) return 'dsd'
    if (LOSSLESS_EXT[ext]) return 'lossless'
    if (LOSSY_EXT[ext]) return 'lossy'
    return 'unknown'   // m4a/mka/mp4 with no codec: could be either
  }

  // mpv's softvol scale is CUBIC: the amplitude it applies is (volume/100)^3.
  // volume-map.js cube-ROOTS the renderer's linear slider on the way in, and
  // loudness.js cube-roots a requested dB before folding it into the volume.
  // Going the other way, the gain mpv is actually applying is
  //   20*log10((v/100)^3) = 60*log10(v/100).
  // Returns dB, or null when the value is not a usable number.
  function mpvVolumeToDb(mpvVolume) {
    var v = Number(mpvVolume)
    if (!isFinite(v) || v < 0) return null
    if (v === 0) return -Infinity
    return Math.round(60 * Math.log10(v / 100) * 10) / 10
  }

  function fmtDb(d) {
    if (d == null) return '?'
    if (d === -Infinity) return 'muted'
    return (d > 0 ? '+' : '') + d.toFixed(1) + ' dB'
  }

  function round1(x) { return Math.round(Number(x) * 10) / 10 }

  function sampleRateOf(track) {
    var r = Number(track && (track.sampleRate || track.maxSampleRate))
    return isFinite(r) && r > 0 ? r : null
  }

  function khz(rate) { return (Math.round(rate / 100) / 10) + ' kHz' }

  // C4. `track` is what is playing; `prevTrack` is what it followed (if the
  // handoff was gapless, THIS track is the one being resampled, to the rate the
  // stream opened at); `nextTrack` is what follows (it will be resampled to the
  // current rate). Pure, and returns nulls when the caller has not supplied the
  // neighbours — an unknown neighbour is never reported as a resample.
  function gaplessResampling(opts) {
    opts = opts || {}
    var settings = opts.settings || {}
    // The engine gets `gapless: cfg.mode === 'gapless'` (main.js), and
    // bit-perfect forces the mode to gapless, so anything but crossfade is it.
    var on = settings.mode !== 'crossfade'
    var cur = sampleRateOf(opts.track)
    var prev = sampleRateOf(opts.prevTrack)
    var next = sampleRateOf(opts.nextTrack)
    return {
      gapless: on,
      // What is happening to the samples right now.
      current: (on && cur && prev && prev !== cur) ? { from: cur, to: prev } : null,
      // What will happen at the next handoff.
      upcoming: (on && cur && next && next !== cur) ? { from: next, to: cur } : null,
      note: GAPLESS_NOTE,
    }
  }

  // What is altering samples right now, as short names for a tooltip.
  //
  // `volume` is the renderer's linear slider percentage (0-100). `engineVolume`
  // is mpv's own `volume` property (cubic, 0-130) — when main relays it, it is
  // ground truth and supersedes the slider, because it already includes the
  // boost multiplier and any ReplayGain/loudness gain folded in by
  // applyLoudnessGain.
  function processing(settings, speed, volume, engineVolume) {
    settings = settings || {}
    var list = []
    var eq = settings.eq
    if (eq && eq.enabled) list.push('EQ')
    // C2: `replaygain` is the user's stored CHOICE (what the dropdown shows).
    // `replaygainEffective` is what the engine was actually given once
    // bit-perfect had its say (bit-perfect.effectiveReplaygain). Prefer the
    // effective one when main supplies it, so the badge stops naming a
    // ReplayGain the engine suppressed — and keeps naming one it did not.
    var rg = String(
      settings.replaygainEffective != null ? settings.replaygainEffective : (settings.replaygain || 'no')
    ).toLowerCase()
    if (rg === 'track' || rg === 'album') list.push('ReplayGain (' + rg + ')')
    // C1: the loudness-scan leveling is a SECOND, independent gain path — main
    // folds each track's measured gain into mpv's volume (applyLoudnessGain).
    // The badge never looked at it and went on saying BIT-PERFECT while it was
    // scaling every track in the queue.
    if (settings.replaygainApply === true) list.push('Volume leveling (loudness scan)')
    var sp = Number(speed)
    if (isFinite(sp) && sp > 0 && sp !== 1) list.push('Speed ' + sp + '×')
    if (settings.mode === 'crossfade') list.push('Crossfade')
    // null/undefined means "not known", which is not the same as 0%.
    var eng = engineVolume == null || engineVolume === '' ? NaN : Number(engineVolume)
    if (isFinite(eng) && eng >= 0) {
      if (round1(eng) !== 100) {
        list.push('Output gain ' + fmtDb(mpvVolumeToDb(eng)) + ' (mpv volume ' + round1(eng) + ')')
      }
      return list
    }
    var vol = volume == null || volume === '' ? NaN : Number(volume)
    if (isFinite(vol) && vol >= 0 && Math.round(vol) !== 100) list.push('Volume ' + Math.round(vol) + '%')
    // C1 fallback: with no engine reading, the slider alone cannot see the
    // boost. Boost multiplies mpv's volume by 1.3, which is software gain above
    // unity — except in bit-perfect mode, where mpv-engine caps --volume-max at
    // 100 so the boost cannot lift anything. Mirror that cap exactly.
    if (settings.boost === true && settings.bitPerfect !== true) list.push('Volume boost (+30%)')
    return list
  }

  function isExclusive(settings) {
    settings = settings || {}
    return settings.bitPerfect === true || settings.bitperfect === true || settings.outputMode === 'exclusive'
  }

  // C3: the two controls are not the same thing, and the badge should be able
  // to say which one is in force. 'bit-perfect' is the mode that also strips
  // EQ / ReplayGain / crossfade and caps the volume at unity; 'exclusive' is
  // only the device being opened alone — everything that rewrites samples is
  // still free to run. See src/bit-perfect.js CONTROL_LABELS.
  function outputMode(settings) {
    settings = settings || {}
    if (settings.bitPerfect === true || settings.bitperfect === true) return 'bit-perfect'
    if (settings.outputMode === 'exclusive') return 'exclusive'
    return 'shared'
  }

  // The verdict. `volume` is the linear slider percentage (100 = unity); pass
  // null if unknown. `engineVolume` is mpv's real volume property when main
  // relays it. `prevTrack` / `nextTrack` are the gapless neighbours (C4).
  function classify(opts) {
    opts = opts || {}
    var track = opts.track
    if (!track) return { label: null, codecClass: 'none', processing: [], gapless: null, reason: '' }
    if (typeof track.filePath === 'string' && /^https?:/i.test(track.filePath)) {
      return { label: null, codecClass: 'stream', processing: [], gapless: null, reason: '' }
    }
    var cls = codecClass(track)
    var proc = processing(opts.settings, opts.speed, opts.volume, opts.engineVolume)
    var gap = gaplessResampling({
      settings: opts.settings, track: track,
      prevTrack: opts.prevTrack, nextTrack: opts.nextTrack,
    })
    // A resample happening to THIS track's samples is processing, not a note.
    if (gap.current) {
      proc.push('Gapless resample (' + khz(gap.current.from) + ' → ' + khz(gap.current.to) + ')')
    }
    // What the next handoff will do — a disclosure, not a change to this track.
    var upcoming = gap.upcoming
      ? ' Next track is ' + khz(gap.upcoming.from) + ' and will be resampled to ' +
        khz(gap.upcoming.to) + ' to keep the run seamless.'
      : ''

    if (cls !== 'lossless' && cls !== 'dsd') {
      return { label: null, codecClass: cls, processing: proc, gapless: gap,
        reason: cls === 'lossy' ? 'Lossy source.' : 'Format not identified.' }
    }

    // C5: DSD can never be bit-perfect here, however clean the rest of the
    // chain is, because the decode to PCM happens before anything else.
    if (cls === 'dsd') {
      var dr = DSD_NOTE
      if (proc.length) dr += ' It is also processed by ' + proc.join(', ') + '.'
      if (gap.gapless) dr += ' ' + gap.note
      return { label: 'DSD → PCM', codecClass: cls, processing: proc, gapless: gap, reason: dr + upcoming }
    }

    var exclusive = isExclusive(opts.settings)
    if (exclusive && proc.length === 0) {
      var r = 'Lossless source, exclusive output, nothing processing the samples. ' +
        'This is what the app asked the engine for; the device itself is not measured.'
      // C4: even a clean chain is only bit-perfect until the rate changes.
      if (gap.gapless) r += ' ' + gap.note
      return { label: 'BIT-PERFECT', codecClass: cls, processing: proc, gapless: gap, reason: r + upcoming }
    }
    var reason = 'Lossless source'
    if (proc.length) reason += ', processed by ' + proc.join(', ') + '.'
    else reason += '. Shared output: the system mixer may resample. Turn on Bit-perfect in Settings for untouched output.'
    return { label: 'LOSSLESS', codecClass: cls, processing: proc, gapless: gap, reason: reason + upcoming }
  }

  return {
    classify: classify,
    codecClass: codecClass,
    processing: processing,
    isExclusive: isExclusive,
    outputMode: outputMode,
    mpvVolumeToDb: mpvVolumeToDb,
    gaplessResampling: gaplessResampling,
    DSD_NOTE: DSD_NOTE,
    GAPLESS_NOTE: GAPLESS_NOTE,
  }
})
