'use strict'

// Ten-band graphic EQ rendered into an mpv --af / af-property string.
//
// Each band is an lavfi `equalizer` peaking biquad. Bands sitting at 0 dB are
// omitted rather than emitted with g=0: an identity biquad still costs a
// filter instance per sample, and a 10-band chain on a flat curve is pure
// waste. An empty result clears mpv's filter chain entirely, which is what we
// want when the EQ is off — no filter, not a transparent one.

const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
const BAND_COUNT = BANDS.length
const GAIN_LIMIT = 12
const PREAMP_LIMIT = 12
// Q of 1.0 puts each band's -3dB points roughly at its neighbours' centres,
// so adjacent sliders blend instead of leaving notches between them.
const BAND_Q = 1.0

function clamp(n, limit) {
  const v = Number(n)
  if (!Number.isFinite(v)) return 0
  return Math.max(-limit, Math.min(limit, v))
}

// mpv splits filter arguments on ':' and ',', so a gain must never render in
// exponential notation or with a stray sign it can't parse.
function fmt(n) {
  return String(Math.round(n * 100) / 100)
}

function defaultSettings() {
  return { enabled: false, preamp: 0, gains: new Array(BAND_COUNT).fill(0) }
}

function normalize(settings = {}) {
  const gains = Array.isArray(settings.gains) ? settings.gains : []
  return {
    enabled: Boolean(settings.enabled),
    preamp: clamp(settings.preamp, PREAMP_LIMIT),
    gains: BANDS.map((_, i) => clamp(gains[i], GAIN_LIMIT)),
  }
}

// Returns an mpv af string, or '' meaning "no filters at all".
function buildAfGraph(settings) {
  const { enabled, preamp, gains } = normalize(settings)
  if (!enabled) return ''

  const parts = []
  if (preamp !== 0) parts.push(`volume=volume=${fmt(preamp)}dB`)
  gains.forEach((g, i) => {
    if (g === 0) return
    parts.push(`equalizer=f=${BANDS[i]}:t=q:w=${fmt(BAND_Q)}:g=${fmt(g)}`)
  })

  if (parts.length === 0) return ''
  return `lavfi=[${parts.join(',')}]`
}

// Preset curves, in the same band order as BANDS. Kept deliberately gentle —
// most published EQ presets are cut from +/-12 tables that clip badly on
// already-loud masters, so these stay inside +/-6 and lean on cuts.
const PRESETS = {
  flat:        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  rock:        [5, 4, 2, -1, -2, 0, 2, 4, 5, 5],
  pop:         [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2],
  jazz:        [3, 2, 1, 2, -1, -1, 0, 1, 2, 3],
  classical:   [4, 3, 2, 0, -1, -1, 0, 2, 3, 4],
  'bass-boost':[6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  treble:      [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  vocal:       [-2, -2, 0, 2, 4, 4, 3, 1, 0, -1],
  loudness:    [5, 4, 1, 0, -2, -1, 0, 2, 4, 5],
}

// Boosting every band clips the output stage; a preamp of -(max boost) buys
// back exactly the headroom the curve consumes.
function suggestedPreamp(gains) {
  const peak = Math.max(0, ...normalize({ enabled: true, gains }).gains)
  // Guard the negative-zero case: -Math.round(0) is -0, which is not === 0.
  return peak > 0 ? -Math.round(peak) : 0
}

function presetSettings(name) {
  const gains = PRESETS[name]
  if (!gains) return null
  return { enabled: true, preamp: suggestedPreamp(gains), gains: gains.slice() }
}

module.exports = { BANDS, BAND_COUNT, GAIN_LIMIT, PREAMP_LIMIT, buildAfGraph, normalize, defaultSettings, PRESETS, presetSettings, suggestedPreamp }
