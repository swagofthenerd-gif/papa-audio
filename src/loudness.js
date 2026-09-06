'use strict'
// ReplayGain, the non-destructive way (App #59).
//
// We do NOT write ReplayGain tags into the user's files. Instead we measure each
// track's integrated loudness with ffmpeg's ebur128 filter, work out the gain in
// dB that would bring it to a common target (-18 LUFS by convention here), and
// store that gain in a SideStore keyed by file path. At play time the stored gain
// is folded into the mpv volume the player already sets — the same `volume`
// property the user's slider drives — so nothing about the file changes and the
// EQ ban (no Web Audio) is untouched: this is mpv-side pre-gain, not a filter.
//
// This module is the pure, testable core: parsing ffmpeg's loudness number,
// turning a measurement into a stored gain, folding that gain into an mpv volume,
// and rolling a whole map of measurements up into the album loudness spread the
// stats page shows. The main process owns the ffmpeg spawning and the SideStore;
// this file spawns nothing and reads no disk, so the numbers can be tested with a
// captured stderr string and a plain object.
//
// It is required() by main.js (CommonJS) and, for the album-spread readout, also
// exposed on window as PapaLoudness so the renderer can format the same numbers
// the tests pin.

;(function () {

  // The reference the whole map is normalised to. -18 LUFS is a middle-ground
  // target: quieter than streaming's -14 (so a loud master is not pushed into
  // clipping headroom) and a common choice for a personal library. A track
  // measured at exactly the target gets 0 dB of gain.
  var TARGET_LUFS = -18

  // Gains are clamped so one pathological measurement (a near-silent track, or a
  // mis-parse) can never ask mpv for a 40 dB boost that clips everything or a
  // cut that mutes a track. ±12 dB spans every real master.
  var MAX_GAIN_DB = 12
  var MIN_GAIN_DB = -12

  // ffmpeg's ebur128 filter prints a summary block at the end of stderr:
  //   Integrated loudness:
  //     I:         -14.2 LUFS
  //     Threshold: -24.7 LUFS
  // We want the LAST "I: <n> LUFS" — the final integrated figure, not any of the
  // per-window lines a verbose run might emit. Same pattern audio-features.js
  // already uses, kept here so the loudness scan does not depend on that module.
  var _I_RE = /I:\s*(-?[\d.]+)\s*LUFS/g

  // Pull the integrated LUFS out of a captured ffmpeg stderr string. Returns the
  // number, or null when the block is absent (ffmpeg failed, or the file had no
  // decodable audio). We take the last match so a multi-line run still yields the
  // final integrated value.
  function parseIntegratedLufs(stderrText) {
    var t = String(stderrText == null ? '' : stderrText)
    var last = null
    var m
    _I_RE.lastIndex = 0
    while ((m = _I_RE.exec(t)) !== null) {
      var v = Number(m[1])
      if (isFinite(v)) last = v
    }
    // ffmpeg prints "-inf" (or a huge negative) for pure silence. That is not a
    // measurement we can gain-correct — treat it as no result rather than
    // clamping to a -12 dB boost on silence.
    if (last == null || !isFinite(last) || last < -70) return null
    return last
  }

  // The gain, in dB, that brings a measured loudness to the target. A track
  // quieter than the target (more negative LUFS) gets a positive gain; a louder
  // one gets a cut. Clamped to the safe span. Returns null for an unusable input
  // so the caller stores nothing rather than a bogus 0.
  function gainForLufs(lufs, target) {
    var t = (target == null) ? TARGET_LUFS : Number(target)
    // null/undefined/'' are "no measurement", not loudness 0 — Number(null) is 0,
    // which would otherwise clamp to a real gain. Reject them explicitly.
    if (lufs == null || lufs === '') return null
    var l = Number(lufs)
    if (!isFinite(l) || !isFinite(t)) return null
    var gain = t - l
    if (gain > MAX_GAIN_DB) gain = MAX_GAIN_DB
    if (gain < MIN_GAIN_DB) gain = MIN_GAIN_DB
    // Round to a tenth of a dB — below that is inaudible and only bloats the map.
    return Math.round(gain * 10) / 10
  }

  // A gain in dB as a linear amplitude multiplier: 10^(dB/20). +6 dB ≈ 2x,
  // -6 dB ≈ 0.5x, 0 dB = 1x. This is what multiplies the mpv volume value.
  function dbToLinear(db) {
    var d = Number(db)
    if (!isFinite(d)) return 1
    return Math.pow(10, d / 20)
  }

  // Fold a track's stored ReplayGain into the mpv volume the player would set
  // anyway. `baseMpvVolume` is the value the volume slider already produces
  // (mpv's cubic 0..MPV_MAX scale, from volume-map.js). We scale it by the gain's
  // linear factor and clamp to the same ceiling the slider respects, so a boosted
  // quiet track cannot exceed mpv's headroom and a cut track cannot go negative.
  // gainDb of 0 (or missing) returns the base unchanged — application is a no-op
  // for a track measured at the target, and for any track not yet scanned.
  function applyGainToMpvVolume(baseMpvVolume, gainDb, mpvMax) {
    var base = Number(baseMpvVolume)
    if (!isFinite(base)) return baseMpvVolume
    var max = isFinite(Number(mpvMax)) ? Number(mpvMax) : 130
    if (gainDb == null || Number(gainDb) === 0) return Math.min(base, max)
    var scaled = base * dbToLinear(gainDb)
    if (scaled < 0) scaled = 0
    if (scaled > max) scaled = max
    return Math.round(scaled * 10) / 10
  }

  // Which of a batch's files still need measuring: every track path in the
  // library subset that has no entry in the stored map yet. Returns up to `limit`
  // file paths (default 20) so a run stays polite — the caller measures them
  // sequentially. `library` is the renderer's album array; `map` is the stored
  // loudness map keyed by filePath. Pure so the selection is testable without a
  // scan.
  function tracksNeedingScan(library, map, limit) {
    library = library || []
    map = map || {}
    var cap = (limit != null && Number(limit) > 0) ? Number(limit) : 20
    var out = []
    for (var i = 0; i < library.length && out.length < cap; i++) {
      var tracks = (library[i] && library[i].tracks) || []
      for (var j = 0; j < tracks.length && out.length < cap; j++) {
        var t = tracks[j]
        var fp = t && t.filePath
        // Only local files are measurable — a streamed http path has nothing to
        // run ffmpeg over.
        if (!fp || /^https?:\/\//.test(String(fp))) continue
        if (Object.prototype.hasOwnProperty.call(map, fp)) continue
        out.push(fp)
      }
    }
    return out
  }

  // How many of the library's local tracks are measurable, and how many of those
  // already have a stored measurement — the "N of M scanned" the UI shows.
  function scanCoverage(library, map) {
    library = library || []
    map = map || {}
    var total = 0
    var scanned = 0
    for (var i = 0; i < library.length; i++) {
      var tracks = (library[i] && library[i].tracks) || []
      for (var j = 0; j < tracks.length; j++) {
        var fp = tracks[j] && tracks[j].filePath
        if (!fp || /^https?:\/\//.test(String(fp))) continue
        total++
        if (Object.prototype.hasOwnProperty.call(map, fp)) scanned++
      }
    }
    return { scanned: scanned, total: total }
  }

  // Roll the per-track loudness map up to albums: each album's mean integrated
  // LUFS across the tracks that have a measurement, plus how many of its tracks
  // were measured. Albums with no measured track are omitted. Returns the list
  // sorted loudest first (least-negative LUFS), so the caller can take the head
  // for "loudest albums" and the tail for "quietest". Pure.
  function albumLoudness(library, map) {
    library = library || []
    map = map || {}
    var out = []
    for (var i = 0; i < library.length; i++) {
      var a = library[i]
      var tracks = (a && a.tracks) || []
      var sum = 0
      var n = 0
      for (var j = 0; j < tracks.length; j++) {
        var fp = tracks[j] && tracks[j].filePath
        if (!fp) continue
        var e = map[fp]
        var lufs = e && typeof e === 'object' ? e.lufs : e
        if (typeof lufs === 'number' && isFinite(lufs)) { sum += lufs; n++ }
      }
      if (n > 0) {
        out.push({
          album: a,
          lufs: Math.round((sum / n) * 10) / 10,
          measuredTracks: n,
          trackCount: tracks.length,
        })
      }
    }
    // Loudest (closest to 0) first.
    return out.sort(function (x, y) { return y.lufs - x.lufs })
  }

  // The loudness spread across measured albums: the loudest N and quietest N, and
  // the overall span in LU. Handy for the stats readout — a wide span is exactly
  // what ReplayGain exists to even out. `n` is how many to list at each end.
  function loudnessSpread(library, map, n) {
    var albums = albumLoudness(library, map)
    var take = (n != null && Number(n) > 0) ? Number(n) : 5
    if (!albums.length) {
      return { loudest: [], quietest: [], spanLu: 0, albumCount: 0 }
    }
    var loudest = albums.slice(0, take)
    // Quietest = tail, reversed so the quietest is first in its own list.
    var quietest = albums.slice(Math.max(0, albums.length - take)).slice().reverse()
    var span = albums[0].lufs - albums[albums.length - 1].lufs
    return {
      loudest: loudest,
      quietest: quietest,
      spanLu: Math.round(span * 10) / 10,
      albumCount: albums.length,
    }
  }

  var api = {
    TARGET_LUFS: TARGET_LUFS,
    MAX_GAIN_DB: MAX_GAIN_DB,
    MIN_GAIN_DB: MIN_GAIN_DB,
    parseIntegratedLufs: parseIntegratedLufs,
    gainForLufs: gainForLufs,
    dbToLinear: dbToLinear,
    applyGainToMpvVolume: applyGainToMpvVolume,
    tracksNeedingScan: tracksNeedingScan,
    scanCoverage: scanCoverage,
    albumLoudness: albumLoudness,
    loudnessSpread: loudnessSpread,
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (typeof window !== 'undefined') window.PapaLoudness = api

})()
