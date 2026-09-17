'use strict'
// The documented gain policy (roadmap 096): every source of gain above unity
// in one place, summed, and turned into a clipping verdict a person can read.
// Boost lifts the volume ceiling to 130 % (software gain); an EQ curve adds
// its highest boost minus its preamp; ReplayGain can raise quiet tracks.
// Pure; tested in test/gain-policy.test.js.
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.PapaGainPolicy = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  function db(ratio) { return 20 * Math.log10(ratio) }
  function round1(x) { return Math.round(x * 10) / 10 }

  var MPV_MAX = 130       // mirrors volume-map.js MPV_MAX
  var BOOST_FACTOR = 1.3  // mirrors volume-map.js BOOST_FACTOR

  // mpv's softvol is CUBIC: amplitude = (volume/100)^3, so the gain it is
  // applying is 60*log10(volume/100). Same identity as quality-badge.js
  // mpvVolumeToDb and the inverse of volume-map.js linearToMpv; a test pins the
  // three together so they cannot drift.
  function mpvVolumeToDb(mpvVolume) {
    var v = Number(mpvVolume)
    if (!isFinite(v) || v <= 0) return null
    return round1(60 * Math.log10(v / 100))
  }

  // C1 (2026-09 honesty pass): `boost` was accepted by assess and then never
  // read. With boost on, the slider's own 100 % is mpv 130 — about +6.8 dB of
  // software gain — and the policy line cheerfully said "No gain above unity —
  // nothing can clip." This is what the boost is actually worth at a given
  // slider position, derived the same way volume-map.js derives the mpv value.
  // Bit-perfect caps --volume-max at 100 (mpv-engine _args), so the boost can
  // lift nothing while it is on.
  function boostGainDb(sliderPct) {
    var linear = Number(sliderPct) / 100
    if (!isFinite(linear) || linear <= 0) return null
    if (linear > 1) linear = 1
    var mpv = Math.min(Math.round(Math.cbrt(linear) * 100 * BOOST_FACTOR * 10) / 10, MPV_MAX)
    return mpvVolumeToDb(mpv)
  }

  // facts: { boost, bitPerfect, volumePct, mpvVolume,
  //          eq: { enabled, preamp, gains }, replaygain, replaygainApply }
  //
  // `volumePct` is the renderer's linear slider percentage. `mpvVolume` is
  // mpv's own volume property when main relays it — ground truth, because it
  // already carries the slider, the boost AND any loudness-scan gain folded in
  // by applyLoudnessGain.
  function assess(facts) {
    facts = facts || {}
    var parts = []
    var total = 0
    var eng = Number(facts.mpvVolume)
    var haveEngine = isFinite(eng) && eng > 0
    if (haveEngine) {
      var e = mpvVolumeToDb(eng)
      if (e > 0) {
        parts.push({ source: 'Output volume (mpv ' + round1(eng) + ')', db: e }); total += e
      }
    }
    var vol = Number(facts.volumePct)
    if (!haveEngine && isFinite(vol) && vol > 100) {
      var v = round1(db(vol / 100))
      parts.push({ source: 'Volume ' + Math.round(vol) + '%', db: v }); total += v
    } else if (!haveEngine && facts.boost === true && facts.bitPerfect !== true) {
      var b = boostGainDb(isFinite(vol) ? vol : 100)
      if (b != null && b > 0) {
        parts.push({ source: 'Volume boost (+30%)', db: b }); total += b
      }
    }
    var eq = facts.eq
    if (eq && eq.enabled) {
      var peak = 0
      ;(eq.gains || []).forEach(function (g) { g = Number(g) || 0; if (g > peak) peak = g })
      var net = round1(peak + (Number(eq.preamp) || 0))
      if (net > 0) { parts.push({ source: 'EQ (+' + peak + ' dB peak, preamp ' + (Number(eq.preamp) || 0) + ' dB)', db: net }); total += net }
      else if (peak > 0) parts.push({ source: 'EQ (preamp covers its +' + peak + ' dB)', db: 0 })
    }
    // C2: prefer what the engine was actually given over the stored choice.
    var rg = String(
      facts.replaygainEffective != null ? facts.replaygainEffective : (facts.replaygain || 'no')
    ).toLowerCase()
    var rgNote = (rg === 'track' || rg === 'album')
      ? 'ReplayGain may raise quiet tracks; a file\'s peak tag caps it when present.'
      : null
    // C1: the loudness-scan leveling is a second gain path — main folds each
    // track's measured gain into mpv's volume — and the policy never mentioned
    // it. It can only raise a track up to the mpv ceiling, but "up" is the
    // direction that clips.
    if (facts.replaygainApply === true) {
      var applyNote = 'Volume leveling from the loudness scan is on: it raises quiet ' +
        'tracks toward the target, capped at the mpv volume ceiling.'
      rgNote = rgNote ? rgNote + ' ' + applyNote : applyNote
    }
    total = round1(total)
    var risk = total > 3 ? 'likely' : total > 0 ? 'possible' : 'none'
    var text
    if (risk === 'none') text = rgNote ? 'No gain above unity. ' + rgNote : 'No gain above unity — nothing can clip.'
    else text = '+' + total + ' dB above unity from ' + parts.filter(function (p) { return p.db > 0 }).map(function (p) { return p.source }).join(' and ') +
      (risk === 'likely' ? ' — loud passages will clip.' : ' — loud passages may clip.') + (rgNote ? ' ' + rgNote : '')
    return { totalDb: total, risk: risk, parts: parts, text: text }
  }

  return { assess: assess, mpvVolumeToDb: mpvVolumeToDb, boostGainDb: boostGainDb }
})
