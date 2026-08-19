'use strict'
// Generates EasyEffects output presets for system-wide playback.
//
// Schema note: every key below was verified empirically against EasyEffects
// 8.2.8 by loading a probe preset and reading the state it flushed on exit.
// EasyEffects silently ignores keys it does not recognise and silently clamps
// out-of-range values, so guessing at this schema produces a preset that
// "loads fine" while sounding nothing like intended. Known traps:
//   - equalizer bands use `q`, NOT `quality`
//   - bass_enhancer `harmonics` clamps at 10
//   - limiter `release` clamps at 20 ms
//   - loudness `clipping-range` clamps at >= 0
const fs = require('fs')
const path = require('path')
const os = require('os')
const { BANDS } = require('../eq')

const OUT_DIR = path.join(os.homedir(), '.local/share/easyeffects/output')

const eqBand = (freq, gain) => ({
  type: 'Bell', mode: 'RLC (BT)', slope: 'x1',
  solo: false, mute: false, frequency: freq, gain, q: 1.0, width: 4.0,
})

// Voicing and correction are different jobs and must not share filters.
// Voicing is broad and musical (Q=1 on the ISO grid); correction is surgical —
// a narrow filter parked exactly on a measured resonance. Snapping a measured
// peak onto the nearest ISO band would force a wide cut that removes the music
// either side of the problem, which is how naive 'auto EQ' ends up sounding
// worse than none.
function equalizer(gains, preamp) {
  const corr = loadCorrections()
  const bands = {}
  BANDS.forEach((hz, i) => { bands[`band${i}`] = eqBand(hz, gains[i]) })
  corr.forEach((c, i) => {
    bands[`band${BANDS.length + i}`] = { ...eqBand(c.freq, c.gain), q: c.q }
  })
  const total = BANDS.length + corr.length
  // Correction eats headroom the voicing preamp did not account for; only the
  // boosts matter, and these corrections are all cuts, so preamp is unchanged.
  return {
    bypass: false, 'input-gain': 0.0, 'output-gain': preamp,
    mode: 'IIR', 'num-bands': total, 'split-channels': false,
    left: bands, right: JSON.parse(JSON.stringify(bands)),
  }
}

let _corrCache = null
function loadCorrections() {
  if (_corrCache) return _corrCache
  const calPath = path.join(os.homedir(), '.cache/speakercal.json')
  if (!fs.existsSync(calPath)) { _corrCache = []; return _corrCache }
  const cal = JSON.parse(fs.readFileSync(calPath, 'utf8'))
  _corrCache = cal.corrections || []
  return _corrCache
}

// Rolls off below the point the drivers can actually reproduce. Small cones
// still try to move at 20-30 Hz, which wastes excursion and intermodulates
// into the midrange as audible mud — cutting it makes the bass you CAN hear
// cleaner and lets the amp work less hard.
function measuredHighPass(fallback) {
  const calPath = path.join(os.homedir(), '.cache/speakercal.json')
  if (!fs.existsSync(calPath)) return fallback
  const cal = JSON.parse(fs.readFileSync(calPath, 'utf8'))
  if (!cal.low_limit) return fallback
  // Sit just below the lowest note the system genuinely reproduces.
  return Math.max(28, Math.round(cal.low_limit * 0.9))
}

const highPass = freq => ({
  bypass: false, 'input-gain': 0.0, 'output-gain': 0.0,
  type: 'High-pass', mode: 'RLC (BT)', frequency: freq,
  quality: 0.7, width: 4.0, gain: 0.0, slope: 'x2',
})

// Synthesises harmonics of the bass that IS present. The ear infers a missing
// fundamental from its harmonic series, so this buys perceived depth without
// asking the driver to move further — the one honest way to get low end out of
// a cabinet that cannot produce it.
const bassEnhancer = (amount, scope) => ({
  bypass: false, 'input-gain': 0.0, 'output-gain': 0.0,
  amount, harmonics: 8.0, scope, floor: 30.0, 'floor-active': true, blend: 1.0,
})

// Narrows the gap between explosions and whispered dialogue.
const compressor = ({ threshold, ratio, attack, release, makeup }) => ({
  bypass: false, 'input-gain': 0.0, 'output-gain': 0.0,
  mode: 'Downward', threshold, ratio, attack, release, knee: -6.0, makeup,
  'boost-threshold': -72.0, 'boost-amount': 6.0, 'release-threshold': -60.0,
  sidechain: { type: 'Feed-forward', mode: 'RMS', source: 'Middle', preamp: 0.0, reactivity: 10.0, lookahead: 0.0 },
})

// Widening increases the L-R difference signal. A 5.1 set fed over stereo aux
// derives its surround channels from exactly that difference, so this pushes
// more content to the rears. It also smears a centre image, which is why the
// dialogue preset leaves it at zero.
const stereoTools = base => ({
  bypass: false, 'input-gain': 0.0, 'output-gain': 0.0,
  'middle-level': 0.0, 'side-level': 0.0, 'stereo-base': base,
  balance_in: 0.0, softclip: false,
})

// Catches the peaks the makeup gain would otherwise clip. Always last.
const limiter = () => ({
  bypass: false, 'input-gain': 0.0, 'output-gain': 0.0,
  mode: 'Herm Thin', threshold: -1.5, lookahead: 5.0,
  release: 20.0, attack: 3.0, 'stereo-link': 100.0, alr: false,
})

// Compensates for the ear's reduced bass and treble sensitivity at low SPL
// (the equal-loudness contours) — so quiet playback keeps its body.
const loudness = volume => ({
  bypass: false, 'input-gain': 0.0, 'output-gain': 0.0,
  'fft-size': '2048', std: 'Flat', volume, clipping: true, 'clipping-range': 0.0,
})

const deesser = () => ({
  bypass: false, 'input-gain': 0.0, 'output-gain': 0.0,
  detection: 'RMS', mode: 'Wide', threshold: -24.0, ratio: 3.0,
  laxity: 15, makeup: 0.0, 'f1-freq': 1800.0, 'f2-freq': 6000.0,
  'f1-level': 0.0, 'f2-level': 0.0, 'f2-q': 1.0, 'sc-listen': false,
})

function preset(chain) {
  const order = chain.map(([name]) => `${name}#0`)
  const out = { blocklist: [], plugins_order: order }
  for (const [name, cfg] of chain) out[`${name}#0`] = cfg
  return { output: out }
}


// Dynamic excursion protection. A small driver distorts because the cone runs
// out of physical travel on intense low-frequency passages — a static bass cut
// "fixes" that by making quiet music thin too, which is the wrong trade. This
// compresses ONLY the band below the split, so bass plays at full weight
// normally and is pulled back automatically the moment it would exceed what
// the driver can do. Bands above the split run at ratio 1:1 = transparent.
//
// EasyEffects requires ALL EIGHT bands to be defined. Supplying only the two
// you care about makes it reject the entire preset with "one or more
// parameters have a wrong format" — and because validation is per-preset, that
// silently disables every other plugin in the chain too.
const MB_BANDS = 8

function mbBand(over = {}) {
  return {
    'enable-band': false, 'compression-mode': 'Downward',
    'attack-threshold': -12.0, 'release-threshold': -60.0, ratio: 1.0,
    'attack-time': 20.0, 'release-time': 100.0, makeup: 0.0,
    mute: false, solo: false, ...over,
  }
}

function bassGuard(split = 160, threshold = -20, ratio = 4.0) {
  const mb = {
    bypass: false, 'input-gain': 0.0, 'output-gain': 0.0,
    mode: 'Modern', 'envelope-boost': 'None',
  }
  mb.band0 = mbBand({ 'enable-band': true, 'attack-threshold': threshold, ratio,
                      'attack-time': 10.0, 'release-time': 200.0 })
  mb.band1 = mbBand({ 'enable-band': true, 'split-frequency': split })
  for (let i = 2; i < MB_BANDS; i++) {
    mb[`band${i}`] = mbBand({ 'split-frequency': split * Math.pow(2, i - 1) })
  }
  return mb
}

const MARSHALL = [0, 5, 3, 0, -1, 0, 3, 3, 1, -1]

const PRESETS = {
  // The Marshall voicing — mid-forward, built for guitars — now sitting on top
  // of the measured correction, so its presence lift survives while the
  // resonances underneath it do not.
  'Music': preset([
    ['filter', highPass(measuredHighPass(35))],
    ['equalizer', equalizer(MARSHALL, -5)],
    ['bass_enhancer', bassEnhancer(4.0, 100.0)],
    ['multiband_compressor', bassGuard()],
    ['stereo_tools', stereoTools(0.2)],
    ['limiter', limiter()],
  ]),

  // Everyday film and TV. Demud, lift dialogue, protect the drivers, widen a
  // little for the matrix surround, and gently narrow the dynamic range.
  'Cinema': preset([
    ['filter', highPass(measuredHighPass(35))],
    ['equalizer', equalizer([1, 3, 2, -1, -2, 0, 2, 2, 1, 0], -3)],
    ['bass_enhancer', bassEnhancer(4.0, 100.0)],
    ['multiband_compressor', bassGuard()],
    ['compressor', compressor({ threshold: -20, ratio: 2.5, attack: 20, release: 250, makeup: 2 })],
    ['stereo_tools', stereoTools(0.2)],
    ['limiter', limiter()],
  ]),

  // Late night. Heavy compression so dialogue stays audible without the
  // explosions carrying through the house, bass pulled back because low
  // frequencies travel through walls, and loudness compensation so quiet
  // playback does not sound thin.
  'Cinema-Night': preset([
    ['filter', highPass(measuredHighPass(50))],
    ['equalizer', equalizer([-3, -1, 0, 0, -1, 1, 3, 3, 1, 0], -3)],
    ['bass_enhancer', bassEnhancer(6.0, 120.0)],
    ['multiband_compressor', bassGuard()],
    ['compressor', compressor({ threshold: -32, ratio: 6, attack: 10, release: 150, makeup: 6 })],
    ['loudness', loudness(-20)],
    ['limiter', limiter()],
  ]),

  // When you cannot make out what they are saying. Cuts everything masking
  // speech, boosts the presence band intelligibility actually lives in, keeps
  // the image centred, and de-esses the harshness that boost would introduce.
  'Dialogue': preset([
    ['filter', highPass(measuredHighPass(70))],
    ['equalizer', equalizer([-6, -4, -2, 0, -2, 2, 4, 3, 0, -2], -4)],
    ['compressor', compressor({ threshold: -26, ratio: 4, attack: 15, release: 200, makeup: 4 })],
    ['deesser', deesser()],
    ['stereo_tools', stereoTools(0.0)],
    ['limiter', limiter()],
  ]),

  // Blockbusters. Maximum impact the cabinet can take: light compression to
  // keep transients alive, strong harmonic bass, wide for surround pull.
  'Action': preset([
    ['filter', highPass(measuredHighPass(32))],
    ['equalizer', equalizer([3, 5, 3, -1, -3, -1, 2, 3, 2, 1], -5)],
    ['bass_enhancer', bassEnhancer(7.0, 90.0)],
    ['multiband_compressor', bassGuard()],
    ['compressor', compressor({ threshold: -18, ratio: 2, attack: 30, release: 300, makeup: 1.5 })],
    ['stereo_tools', stereoTools(0.3)],
    ['limiter', limiter()],
  ]),

  // YouTube and streaming. Lossy codecs discard high-frequency detail, levels
  // swing wildly between videos, and a lot of the audio is speech recorded on
  // poor microphones. So: compress for consistency, lift presence for
  // intelligibility, de-ess the harshness cheap mics add, and use the exciter
  // to regenerate some of the top end the codec threw away.
  'YouTube': preset([
    ['filter', highPass(measuredHighPass(40))],
    ['equalizer', equalizer([-2, 0, 1, 0, -2, 1, 3, 2, 1, 0], -3)],
    ['compressor', compressor({ threshold: -24, ratio: 3.5, attack: 15, release: 200, makeup: 4 })],
    ['deesser', deesser()],
    ['exciter', { bypass: false, 'input-gain': 0.0, 'output-gain': 0.0,
                  amount: 4.0, harmonics: 7.0, scope: 7000.0, ceil: 16000.0,
                  'ceil-active': true, blend: 0.5 }],
    ['limiter', limiter()],
  ]),

  // Concert films and musicals — closest to the Marshall voicing, with the
  // dynamics left largely alone so music breathes.
  'Concert': preset([
    ['filter', highPass(measuredHighPass(32))],
    ['equalizer', equalizer([3, 4, 2, 0, -1, 0, 2, 3, 2, 1], -4)],
    ['bass_enhancer', bassEnhancer(3.0, 100.0)],
    ['multiband_compressor', bassGuard()],
    ['stereo_tools', stereoTools(0.25)],
    ['limiter', limiter()],
  ]),
}

let n = 0
for (const [name, data] of Object.entries(PRESETS)) {
  fs.writeFileSync(path.join(OUT_DIR, `${name}.json`), JSON.stringify(data, null, 2))
  console.log('wrote', name)
  n++
}
console.log(`\n${n} presets written to ${OUT_DIR}`)
