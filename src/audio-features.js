'use strict'
// Feature extraction and comparison for the local library.
//
// Pure on purpose: nothing here spawns ffmpeg or touches disk, so every
// decision the queue engine makes is testable without audio.

const FEATURE_KEYS = ['energy', 'brightness', 'dynamics', 'density', 'punch']
const FEATURE_VERSION = 1

// astats and aspectralstats print per-channel blocks BEFORE the Overall block.
// Taking the last match is what selects Overall; taking the first would report
// channel 1 and quietly mis-measure every multichannel file in the library.
function lastNumber(text, pattern) {
  const re = new RegExp(pattern, 'g')
  let m, found = null
  while ((m = re.exec(text)) !== null) found = m[1]
  return found === null ? null : Number(found)
}

function parseAnalysis(stderrText) {
  const t = String(stderrText || '')
  return {
    integratedLufs: lastNumber(t, 'I:\\s*(-?[\\d.]+)\\s*LUFS'),
    lra:            lastNumber(t, 'LRA:\\s*(-?[\\d.]+)\\s*LU'),
    truePeak:       lastNumber(t, 'Peak:\\s*(-?[\\d.]+)\\s*dBFS'),
    rms:            lastNumber(t, 'RMS level dB:\\s*(-?[\\d.]+)'),
    crest:          lastNumber(t, 'Crest factor:\\s*(-?[\\d.]+)'),
    zcr:            lastNumber(t, 'Zero crossings rate:\\s*(-?[\\d.]+)'),
    flatFactor:     lastNumber(t, 'Flat factor:\\s*(-?[\\d.]+)'),
    centroid:       lastNumber(t, 'mean centroid:\\s*(-?[\\d.]+)'),
    spread:         lastNumber(t, 'mean spread:\\s*(-?[\\d.]+)'),
    flatness:       lastNumber(t, 'mean flatness:\\s*(-?[\\d.]+)'),
    rolloff:        lastNumber(t, 'mean rolloff:\\s*(-?[\\d.]+)'),
    entropy:        lastNumber(t, 'mean entropy:\\s*(-?[\\d.]+)'),
  }
}

const DEFAULT_WEIGHTS = { energy: 1.0, brightness: 0.8, dynamics: 1.3, density: 0.8, punch: 0.5 }

const REQUIRED = ['rms', 'crest', 'lra', 'centroid', 'rolloff', 'flatness', 'entropy', 'zcr']

// Squash an open-ended measurement into roughly 0..1 before z-scoring. This is
// only to stop one wild outlier dominating the mean and standard deviation --
// the real scaling is the z-score in normalise().
function unit(value, lo, hi) {
  if (!Number.isFinite(value)) return 0
  const t = (value - lo) / (hi - lo)
  return t < 0 ? 0 : t > 1 ? 1 : t
}

function rawToVector(raw) {
  if (!raw) return null
  for (const k of REQUIRED) {
    if (!Number.isFinite(raw[k])) return null
  }
  const loudness = unit(raw.rms, -40, -5)
  const bright   = unit(raw.centroid, 400, 6000)
  const roll     = unit(raw.rolloff, 1000, 12000)
  const range    = unit(raw.lra, 0, 20)
  const crest    = unit(raw.crest, 2, 15)

  return {
    energy:     0.6 * loudness + 0.2 * crest + 0.2 * bright,
    brightness: 0.6 * bright + 0.4 * roll,
    dynamics:   0.7 * range + 0.3 * crest,
    density:    0.5 * unit(raw.flatness, 0, 0.5) + 0.5 * unit(raw.entropy, 0, 1),
    punch:      unit(raw.zcr, 0, 0.15),
  }
}

function buildNormaliser(vectors) {
  const list = (vectors || []).filter(Boolean)
  const mean = {}, sd = {}
  for (const k of FEATURE_KEYS) {
    if (!list.length) { mean[k] = 0; sd[k] = 1; continue }
    const m = list.reduce((s, v) => s + v[k], 0) / list.length
    const varc = list.reduce((s, v) => s + (v[k] - m) ** 2, 0) / list.length
    mean[k] = m
    // A constant dimension has no spread, but float error in the mean leaves
    // varc around 3e-33 rather than exactly 0 -- so `|| 1` never fires and the
    // z-score becomes 1.0, full-scale noise. Floor on a threshold instead, and
    // leave every real spread untouched so narrow dimensions still count.
    const s = Math.sqrt(varc)
    sd[k] = s < 1e-9 ? 1 : s
  }
  return { mean, sd }
}

function normalise(vec, norm) {
  const out = {}
  for (const k of FEATURE_KEYS) {
    const z = (vec[k] - norm.mean[k]) / norm.sd[k]
    // Floating point rounding can produce values very close to 0; zero them out
    out[k] = Math.abs(z) < 1e-14 ? 0 : z
  }
  return out
}

function distance(a, b, weights = DEFAULT_WEIGHTS) {
  let sum = 0
  for (const k of FEATURE_KEYS) {
    const d = (a[k] - b[k]) * (weights[k] ?? 1)
    sum += d * d
  }
  return Math.sqrt(sum)
}

module.exports = { FEATURE_KEYS, FEATURE_VERSION, parseAnalysis, rawToVector, buildNormaliser, normalise, distance, DEFAULT_WEIGHTS }
