'use strict'
// Merges a by-ear calibration (~/.cache/speakercal.json) into the EasyEffects
// preset suite, so every preset sits on top of YOUR room+speaker correction
// rather than a generic assumption.
//
// Correction philosophy — cuts, not boosts. A resonant peak is energy the room
// or cabinet is ADDING; removing it is free and always sounds cleaner. A
// suckout is usually cancellation or a driver running out of ability, and
// boosting it just burns headroom and adds distortion without fixing the
// cause. So peaks get cut properly; dips get at most a token lift.
const fs = require('fs')
const path = require('path')
const os = require('os')
const { BANDS } = require('../eq')

const CAL = path.join(os.homedir(), '.cache/speakercal.json')
const OUT_DIR = path.join(os.homedir(), '.local/share/easyeffects/output')

const CUT_PER_HIT = -4      // a peak the ear flagged as boomy/honky/harsh
const LIFT_PER_HIT = 1      // a dip — deliberately timid, see above
const MAX_CORRECTION = 6

function nearestBand(freq) {
  let best = 0
  for (let i = 1; i < BANDS.length; i++) {
    if (Math.abs(Math.log2(BANDS[i] / freq)) < Math.abs(Math.log2(BANDS[best] / freq))) best = i
  }
  return best
}

// Several flagged tones often land on one band — a broad peak reported across
// neighbouring test tones is still ONE resonance. Summing per hit would turn
// three adjacent reports into a -12 dB gouge, which sounds far worse than the
// problem it removes. So a band is counted once, deepened slightly when
// multiple tones agree it is a wide peak.
function buildCorrection(cal) {
  const hits = BANDS.map(() => ({ loud: 0, weak: 0 }))
  if (!cal) return BANDS.map(() => 0)
  for (const group of ['bass', 'mid', 'high']) {
    const g = cal[group]
    if (!g) continue
    for (const f of g.loud || []) hits[nearestBand(f)].loud++
    for (const f of g.weak || []) hits[nearestBand(f)].weak++
  }
  return hits.map(({ loud, weak }) => {
    let v = 0
    if (loud > 0) v += loud > 1 ? CUT_PER_HIT - 1 : CUT_PER_HIT
    if (weak > 0) v += LIFT_PER_HIT
    return Math.max(-MAX_CORRECTION, Math.min(MAX_CORRECTION, v))
  })
}

// The measured low-frequency limit sets the high-pass. Asking a driver for
// output below what it can actually produce wastes excursion and
// intermodulates into the midrange as mud, so we simply stop asking.
function highPassFreq(cal, fallback) {
  const limit = cal && cal.low_limit
  if (!limit) return fallback
  return Math.max(28, Math.round(limit * 0.9))
}

const clamp = v => Math.max(-12, Math.min(12, v))
const merge = (voicing, correction) => voicing.map((v, i) => clamp(v + correction[i]))
const preampFor = gains => { const p = Math.max(0, ...gains); return p > 0 ? -Math.round(p) : 0 }

module.exports = { buildCorrection, highPassFreq, merge, preampFor, nearestBand, CAL, OUT_DIR }

if (require.main === module) {
  const cal = fs.existsSync(CAL) ? JSON.parse(fs.readFileSync(CAL, 'utf8')) : null
  if (!cal) {
    console.log(`No calibration found at ${CAL}`)
    console.log('Run  speakercal  first, then re-run this.')
    process.exit(1)
  }
  const correction = buildCorrection(cal)
  console.log('Measured low limit:', cal.low_limit, 'Hz  ->  high-pass at', highPassFreq(cal, 35), 'Hz')
  console.log('\nCorrection curve derived from your ears:')
  BANDS.forEach((hz, i) => {
    const v = correction[i]
    if (v !== 0) console.log(`  ${String(hz).padStart(6)} Hz  ${v > 0 ? '+' : ''}${v} dB`)
  })
  if (correction.every(v => v === 0)) console.log('  (flat — nothing flagged)')
}
