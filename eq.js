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

// The default parameter defends against `undefined` and not against `null` --
// and getPlayerSettings() spreads the persisted playerSettings over the
// defaults, so a stored `eq: null` wins and reaches here. buildAfGraph(null)
// then threw inside _args(), inside start(), surfacing as a confusing
// start-error with no audio at all. One hand-edit or one bad write and the app
// is silent, so it coerces rather than trusting the caller.
function normalize(settings) {
  settings = settings && typeof settings === 'object' ? settings : {}
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

// Preset curves, in the same band order as BANDS.
//
// The "voicing" group approximates the published tonal signatures of well-known
// speaker brands. It cannot turn one speaker into another — cabinet, drivers
// and amplifier decide that — but a house voicing IS a frequency curve, and
// that part transfers. These are ear-tuned approximations from published
// measurement tendencies, not licensed or measured clones.
//
// Everything stays inside +/-6 dB. Most published preset tables are cut from
// +/-12 and clip badly on already-loud masters; large low-end boosts also just
// buy distortion and excursion limiting on small drivers rather than depth.
const PRESETS = {
  flat:        { label: 'Flat',            group: 'Classic', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  rock:        { label: 'Rock',            group: 'Classic', gains: [5, 4, 2, -1, -2, 0, 2, 4, 5, 5] },
  pop:         { label: 'Pop',             group: 'Classic', gains: [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2] },
  jazz:        { label: 'Jazz',            group: 'Classic', gains: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
  classical:   { label: 'Classical',       group: 'Classic', gains: [4, 3, 2, 0, -1, -1, 0, 2, 3, 4] },
  'bass-boost':{ label: 'Bass Boost',      group: 'Classic', gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  treble:      { label: 'Treble Boost',    group: 'Classic', gains: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6] },
  vocal:       { label: 'Vocal',           group: 'Classic', gains: [-2, -2, 0, 2, 4, 4, 3, 1, 0, -1] },
  loudness:    { label: 'Loudness',        group: 'Classic', gains: [5, 4, 1, 0, -2, -1, 0, 2, 4, 5] },

  // Mid-forward and punchy, built for guitars: low-end thump, a dip where
  // small cabinets get boxy, and a presence lift for bite. Top end stays
  // tame — Marshall voices warm, not sparkly.
  marshall:    { label: 'Marshall',        group: 'Speaker voicings', gains: [4, 5, 3, 0, -1, 0, 3, 3, 1, -1] },
  // The classic "smiley": lifted extremes, scooped mids. Immediately
  // impressive, which is the entire design intent.
  bose:        { label: 'Bose',            group: 'Speaker voicings', gains: [5, 5, 3, 0, -3, -3, -1, 2, 4, 4] },
  // Sub-heavy with recessed mids and a bright top — the hip-hop voicing.
  beats:       { label: 'Beats',           group: 'Speaker voicings', gains: [6, 6, 4, 0, -3, -4, -2, 1, 4, 3] },
  // Deliberately restrained: gentle warmth, honest mids, smooth treble.
  sonos:       { label: 'Sonos',           group: 'Speaker voicings', gains: [2, 3, 2, 0, 0, 0, 0, 1, 2, 1] },
  // Airy and sculpted — B&O sells detail, with tight rather than deep bass.
  bang_olufsen:{ label: 'Bang & Olufsen',  group: 'Speaker voicings', gains: [2, 3, 1, -1, -1, 0, 1, 3, 5, 5] },
  // Party voicing: sub punch plus a vocal/presence push to cut through noise.
  jbl:         { label: 'JBL',             group: 'Speaker voicings', gains: [5, 5, 2, -1, -2, 0, 3, 3, 2, 1] },
  // Very deep bass under untouched mids, with an extended top.
  devialet:    { label: 'Devialet',        group: 'Speaker voicings', gains: [6, 5, 2, 0, 0, 0, 0, 1, 3, 4] },
  // The Harman target: the listener-preference curve from Olive and Toole's
  // research. A bass shelf easing to neutral by the mids, then a slight tilt.
  // The one curve here with actual published science behind it.
  harman:      { label: 'Harman Target',   group: 'Speaker voicings', gains: [5, 4, 2, 1, 0, 0, 0, -1, 1, 2] },
  // Near-flat with a touch of air — a monitor-style sanity check.
  studio:      { label: 'Studio Reference',group: 'Speaker voicings', gains: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1] },
}

// Boosting every band clips the output stage; a preamp of -(max boost) buys
// back exactly the headroom the curve consumes.
function suggestedPreamp(gains) {
  const peak = Math.max(0, ...normalize({ enabled: true, gains }).gains)
  // Guard the negative-zero case: -Math.round(0) is -0, which is not === 0.
  return peak > 0 ? -Math.round(peak) : 0
}

function presetSettings(name) {
  const preset = PRESETS[name]
  if (!preset) return null
  const gains = preset.gains
  return { enabled: true, preamp: suggestedPreamp(gains), gains: gains.slice() }
}

module.exports = { BANDS, BAND_COUNT, GAIN_LIMIT, PREAMP_LIMIT, buildAfGraph, normalize, defaultSettings, PRESETS, presetSettings, suggestedPreamp }
