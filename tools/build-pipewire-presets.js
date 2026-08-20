'use strict'
// Builds one 6-channel EQ sink per preset, with TRUE bass management.
//
// Each satellite is split: the high-passed part goes to its own speaker, the
// low-passed part is summed into the subwoofer along with the source's own LFE.
// That redirection is the whole point — an earlier version only high-passed the
// satellites, which DELETED their bass instead of moving it. On upmixed stereo
// that was masked (PipeWire builds LFE from the full-range mix beforehand), but
// on native 5.1 it threw away the bass from five channels and left the sound
// shallow.
//
// Preset switching is a default-sink change, which is instant, so every preset
// is its own sink. A filter graph is only built when the daemon starts.
const fs = require('fs')
const path = require('path')
const os = require('os')

const CAL = path.join(os.homedir(), '.cache/speakercal.json')
const STORE = path.join(os.homedir(), '.config/papa-eq/presets.json')
const OUT = path.join(os.homedir(), '.config/pipewire/pipewire.conf.d/60-papa-eq-51.conf')
const TARGET = 'alsa_output.pci-0000_2b_00.4.analog-surround-51'

const SATELLITES = ['FL', 'FR', 'FC', 'RL', 'RR']
const CHANNELS = ['FL', 'FR', 'FC', 'LFE', 'RL', 'RR']

if (!fs.existsSync(STORE)) {
  console.error(`No preset store at ${STORE}`)
  console.error('Restore it from ~/flac-player/tools/presets.default.json')
  process.exit(1)
}
let store
try {
  store = JSON.parse(fs.readFileSync(STORE, 'utf8'))
} catch (e) {
  // Fail loudly but leave the existing config alone — writes are atomic and
  // happen only on success, so the currently loaded graph keeps working.
  console.error(`${STORE} is not valid JSON: ${e.message}`)
  console.error('The existing config was left untouched.')
  console.error('Restore the store from ~/flac-player/tools/presets.default.json')
  process.exit(1)
}
if (!Array.isArray(store.presets) || store.presets.length === 0) {
  console.error(`${STORE} contains no presets`)
  process.exit(1)
}
const cal = fs.existsSync(CAL) ? JSON.parse(fs.readFileSync(CAL, 'utf8')) : {}
const BANDS = store.bands || [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
const corrections = cal.corrections || []
const settings = store.settings || {}

const XOVER = settings.crossover || 100
const LFE_BOOST_DB = settings.lfeBoost || 0
const BASS_MGMT = settings.bassManagement !== false
// The sub is high-passed at its measured floor: below that it produces no
// output while still consuming excursion and headroom.
// Sit just ABOVE the measured floor, not at it. A driver at its limit is
// already distorting; the last few Hz cost excursion and headroom while
// producing almost nothing audible.
const LFE_HP = settings.subHighPass || (cal.low_limit ? Math.round(cal.low_limit * 1.1) : 35)
// The low-pass branch MUST arrive at the mixer at unity.
//
// A Linkwitz-Riley pair only sums flat when both halves are complementary.
// Attenuating just the sub branch breaks that: below the crossover the sub is
// the ONLY source, so the branch gain becomes the bass level outright — at
// 0.30 that is 10.5 dB of missing bass, rising toward DC. That was the cause
// of the "shallow, hollow" sound, and lowering it further made it worse.
//
// Level matching between the satellites and a more efficient powered sub
// belongs on the subwoofer's own volume control, which sits AFTER the split
// and therefore cannot break the pair. Any digital trim must be applied to
// BOTH branches, which is what SINK_HEADROOM_DB below does.
const SAT_MIX_GAIN = settings.subMixGain != null ? settings.subMixGain : 1.0

// Extra attenuation on top of the voicing preamp. Default 0.
//
// An earlier version applied a blanket 6 dB here as "summing headroom", which
// was the wrong instrument: it made even the Flat preset 6 dB quiet, left
// presets differing by up to 5 dB (so any A/B between them was rigged toward
// the quieter-voiced one), and was still 3.5 dB short of what correlated bass
// actually sums to. The sub's level — and therefore its clipping margin — is
// what subMixGain is for, and that has to be set by ear against a real
// subwoofer's sensitivity. If bass distorts, lower subMixGain; do not
// attenuate the whole system to compensate.
const SINK_HEADROOM_DB = settings.subHeadroom != null ? settings.subHeadroom : 0
// Each section of a Linkwitz-Riley pair is a Butterworth section.
const LR_Q = 0.7071

// A label reaches the config as node.description. An unescaped quote or a
// newline makes the whole SPA-JSON file unparseable, and PipeWire then rejects
// it wholesale — every preset vanishes and the machine boots with no EQ. The
// GUI takes labels from free text, so this is one keystroke away.
const escLabel = v => String(v).replace(/[\\"]/g, '\\$&').replace(/[\r\n]+/g, ' ')

const clamp = v => Math.max(-12, Math.min(12, v))
// Headroom must be reckoned per PATH, not per preset. The sink's volume applies
// to every channel, so taking the peak across all bands penalises the
// satellites for a boost that — after the crossover split — only ever reaches
// the subwoofer. On a bass-forward voicing that leaves the satellites several
// dB quieter than the sub and skews the whole balance bass-heavy.
//
// So: set the sink volume from the SATELLITE peak, then scale the sub mixer by
// the difference so the sub path keeps the same headroom without clipping.
// The TRUE peak of the combined response, not the largest single band gain.
//
// Peaking filters at Q=1 are about an octave wide, so neighbours overlap and
// their gains sum. Marshall's +5 dB at 62 Hz actually reaches +5.9 dB once the
// 31 Hz and 125 Hz skirts are added, so a preamp derived from "+5" left the
// output 0.9 dB above full scale — hard digital clipping on bass, at every
// volume setting. Evaluating the real magnitude response removes the guess.
const FS = 48000
function biquadPeaking(f0, gain, Q) {
  const A = Math.pow(10, gain / 40)
  const w = 2 * Math.PI * f0 / FS
  const alpha = Math.sin(w) / (2 * Q)
  const c = Math.cos(w)
  const a0 = 1 + alpha / A
  return [(1 + alpha * A) / a0, (-2 * c) / a0, (1 - alpha * A) / a0,
          (-2 * c) / a0, (1 - alpha / A) / a0]
}
function magDb(co, f) {
  const w = -2 * Math.PI * f / FS
  const cr = Math.cos(w), ci = Math.sin(w)
  const c2r = Math.cos(2 * w), c2i = Math.sin(2 * w)
  const nr = co[0] + co[1] * cr + co[2] * c2r
  const ni = co[1] * ci + co[2] * c2i
  const dr = 1 + co[3] * cr + co[4] * c2r
  const di = co[3] * ci + co[4] * c2i
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di))
}

// Peak of the summed response of a set of {freq, gain, q} filters, swept on a
// fine log grid so a narrow peak between band centres is not missed.
function responsePeak(filters) {
  if (!filters.length) return 0
  let peak = 0
  for (let i = 0; i <= 480; i++) {
    const f = 20 * Math.pow(10, (i / 480) * Math.log10(20000 / 20))
    let db = 0
    for (const flt of filters) db += magDb(biquadPeaking(flt.freq, flt.gain, flt.q), f)
    if (db > peak) peak = db
  }
  return peak
}

const peakOf = vals => Math.max(0, ...vals)

function pathFilters(gains, which) {
  const out = []
  gains.forEach((g, i) => {
    if (!g) return
    const inPath = !BASS_MGMT ? true
      : (which === 'sub' ? BANDS[i] < XOVER : BANDS[i] >= XOVER)
    if (inPath) out.push({ freq: BANDS[i], gain: g, q: 1.0 })
  })
  for (const c of corrections) {
    const inPath = !BASS_MGMT ? true
      : (which === 'sub' ? c.freq < XOVER : c.freq >= XOVER)
    // Corrections count toward headroom too. All are cuts today, but a future
    // boost would otherwise be silently unaccounted.
    if (inPath) out.push({ freq: c.freq, gain: c.gain, q: c.q })
  }
  return out
}

function pathPeaks(gains) {
  return { sat: responsePeak(pathFilters(gains, 'sat')),
           sub: responsePeak(pathFilters(gains, 'sub')) }
}

// Voicing + measured correction for one channel, as a serial chain.
//
// Bands are split at the crossover: a filter only goes to the output that
// actually carries that frequency. Boosting 125 Hz on a subwoofer rated to
// 85 Hz buys cone excursion and no output — it was a direct cause of audible
// distortion — and a 62 Hz filter on a satellite high-passed at 80 Hz is
// equally pointless while lifting the crossover skirt.
function inBand(ch, freq) {
  if (!BASS_MGMT) return true
  // Exclusive on the sub side. With `<=` and `>=` a band sitting exactly on
  // the crossover is emitted on both paths and double-counted in pathPeaks.
  // The GUI crossover slider covers 60-160, and 62 and 125 are band centres,
  // so this is one drag away.
  return ch === 'LFE' ? freq < XOVER : freq >= XOVER
}

function toneChain(key, ch, gains) {
  const out = []
  gains.forEach((g, i) => {
    if (g === 0) return
    if (!inBand(ch, BANDS[i])) return
    out.push({ label: 'bq_peaking', freq: BANDS[i], gain: clamp(g), q: 1.0, tag: `v${BANDS[i]}` })
  })
  for (const c of corrections) {
    if (!inBand(ch, c.freq)) continue
    out.push({ label: 'bq_peaking', freq: c.freq, gain: c.gain, q: c.q, tag: `c${c.freq}` })
  }
  if (ch === 'LFE' && LFE_BOOST_DB > 0) {
    out.push({ label: 'bq_lowshelf', freq: 120, gain: LFE_BOOST_DB, q: 0.7, tag: 'lfeboost' })
  }
  return out
}

function moduleFor(key, voicing) {
  const peaks = pathPeaks(voicing.gains)
  const nodes = []; const links = []
  const inputs = {}; const outputs = {}
  const n = (t, ch) => `${key}_${t}_${ch}`
  const add = (name, label, control) =>
    nodes.push(`      { type = builtin name = ${name} label = ${label}` +
               (control ? ` control = { ${control} } }` : ' }'))
  const chain = (startPort, ch, filters) => {
    let prev = startPort
    for (const f of filters) {
      const name = n(f.tag, ch)
      add(name, f.label, `"Freq" = ${f.freq} "Q" = ${f.q} "Gain" = ${f.gain}`)
      links.push(`      { output = "${prev}" input = "${name}:In" }`)
      prev = `${name}:Out`
    }
    return prev
  }

  const subMixer = n('submix', 'LFE')
  if (BASS_MGMT) add(subMixer, 'mixer')
  let mixIn = 1

  for (const ch of SATELLITES) {
    if (BASS_MGMT) {
      // Split: the copy feeds both the speaker path and the sub path.
      add(n('split', ch), 'copy')
      inputs[ch] = `${n('split', ch)}:In`
      // Linkwitz-Riley 4th order: two cascaded Butterworth sections per side.
      // A single Butterworth section is -3 dB at the corner, so its high-pass
      // and low-pass halves sum to a +3 dB PEAK at the crossover. Cascading two
      // gives -6 dB, which sums flat. With five satellites feeding the sub that
      // bump sat right where the driver was already working hardest.
      const hpOut = chain(`${n('split', ch)}:Out`, ch, [
        { label: 'bq_highpass', freq: XOVER, gain: 0, q: LR_Q, tag: 'hp1' },
        { label: 'bq_highpass', freq: XOVER, gain: 0, q: LR_Q, tag: 'hp2' },
      ])
      const lpOut = chain(`${n('split', ch)}:Out`, ch, [
        { label: 'bq_lowpass', freq: XOVER, gain: 0, q: LR_Q, tag: 'lp1' },
        { label: 'bq_lowpass', freq: XOVER, gain: 0, q: LR_Q, tag: 'lp2' },
      ])
      links.push(`      { output = "${lpOut}" input = "${subMixer}:In ${mixIn}" }`)
      mixIn++
      outputs[ch] = chain(hpOut, ch, toneChain(key, ch, voicing.gains))
    } else {
      add(n('hp', ch), 'bq_highpass', `"Freq" = ${LFE_HP} "Q" = 0.7 "Gain" = 0`)
      inputs[ch] = `${n('hp', ch)}:In`
      outputs[ch] = chain(`${n('hp', ch)}:Out`, ch, toneChain(key, ch, voicing.gains))
    }
  }

  // The source's own LFE, band-limited to the crossover BEFORE the mixer.
  //
  // Without this the LFE channel reached the driver unfiltered: PipeWire's
  // upmix synthesises LFE up to channelmix.lfe-cutoff, and encoders band-limit
  // a native LFE track to ~120 Hz — both well above this subwoofer's 85 Hz
  // ceiling. That is excursion spent on frequencies it cannot reproduce, and a
  // direct cause of audible distortion.
  //
  // It goes BEFORE the mixer, matching the satellites' low-pass. Placing it
  // after would filter the satellite bass a second time and break the
  // crossover's complementarity.
  add(n('lfein', 'LFE'), 'copy')
  inputs.LFE = `${n('lfein', 'LFE')}:In`
  let lfeOut = `${n('lfein', 'LFE')}:Out`
  if (BASS_MGMT) {
    lfeOut = chain(lfeOut, 'LFE', [
      { label: 'bq_lowpass', freq: XOVER, gain: 0, q: LR_Q, tag: 'lfelp1' },
      { label: 'bq_lowpass', freq: XOVER, gain: 0, q: LR_Q, tag: 'lfelp2' },
    ])
    links.push(`      { output = "${lfeOut}" input = "${subMixer}:In ${mixIn}" }`)
    lfeOut = `${subMixer}:Out`
  }
  // Subsonic protection, 4th order, on the SUMMED sub signal.
  //
  // Previously this was a single 2nd-order section on the LFE INPUT only, so
  // the five satellite low-pass feeds reached the driver with no subsonic
  // filter at all — and on stereo music, where the LFE channel is empty, that
  // meant essentially none of the sub's content was protected. A 12 dB/oct
  // slope also merely cancels the rising excursion below port tuning rather
  // than reducing it; two cascaded sections give a real 24 dB/oct rumble
  // filter.
  lfeOut = chain(lfeOut, 'LFE', [
    { label: 'bq_highpass', freq: LFE_HP, gain: 0, q: LR_Q, tag: 'sub1' },
    { label: 'bq_highpass', freq: LFE_HP, gain: 0, q: LR_Q, tag: 'sub2' },
  ])
  outputs.LFE = chain(lfeOut, 'LFE', toneChain(key, 'LFE', voicing.gains))

  // Every mixer input at SAT_MIX_GAIN (1.0 by default). The native LFE track
  // always arrives at unity.
  const gains = BASS_MGMT
    ? Array.from({ length: mixIn }, (_, i) =>
        `"Gain ${i + 1}" = ${(i === mixIn - 1 ? 1.0 : SAT_MIX_GAIN).toFixed(4)}`).join(' ')
    : ''
  if (BASS_MGMT) {
    const idx = nodes.findIndex(x => x.includes(`name = ${subMixer} `))
    nodes[idx] = `      { type = builtin name = ${subMixer} label = mixer control = { ${gains} } }`
  }

  // One attenuation for the whole sink: the larger of the two path peaks plus
  // summing headroom. Trimming one path relative to the other would undo the
  // crossover's complementarity.
  const worstPeak = Math.max(peaks.sat, peaks.sub)
  const preamp = (worstPeak > 0 || SINK_HEADROOM_DB > 0)
    ? -(Math.ceil(worstPeak * 10) / 10 + SINK_HEADROOM_DB) : 0
  return `  { name = libpipewire-module-filter-chain
    args = {
      node.description = "Papa EQ — ${escLabel(voicing.label)}"
      media.name       = "Papa EQ — ${escLabel(voicing.label)}"
      filter.graph = {
        nodes = [
${nodes.join('\n')}
        ]
        links = [
${links.join('\n')}
        ]
        inputs  = [ ${CHANNELS.map(c => `"${inputs[c]}"`).join(' ')} ]
        outputs = [ ${CHANNELS.map(c => `"${outputs[c]}"`).join(' ')} ]
      }
      capture.props = {
        node.name        = "papa_eq_${key}"
        node.description = "Papa EQ — ${escLabel(voicing.label)}"
        media.class      = Audio/Sink
        audio.channels   = 6
        audio.position   = [ FL FR FC LFE RL RR ]
        channelmix.normalize = false
${preamp !== 0 ? `        volume = ${Math.pow(10, preamp / 20).toFixed(4)}` : ''}
      }
      playback.props = {
        node.name      = "papa_eq_${key}_out"
        node.passive   = true
        audio.channels = 6
        audio.position = [ FL FR FC LFE RL RR ]
        target.object  = "${TARGET}"
        node.dont-reconnect = true
        node.autoconnect    = false
      }
    }
  }`
}

const mods = store.presets.map(p => moduleFor(p.key, { label: p.label, gains: p.gains }))
const conf = `# Papa EQ — generated by flac-player/tools/build-pipewire-presets.js
#
# Measured: low-frequency limit ${cal.low_limit || '?'} Hz
${corrections.map(c => `#   ${String(c.freq).padStart(5)} Hz  ${c.gain} dB  Q=${c.q}`).join('\n')}
#
# Bass management: ${BASS_MGMT ? `ON — satellites crossed over at ${XOVER} Hz, their low
# frequencies SUMMED into the subwoofer (not discarded)` : 'OFF — satellites run full range'}
# Subwoofer high-pass: ${LFE_HP} Hz${LFE_BOOST_DB ? `, +${LFE_BOOST_DB} dB shelf` : ''}

context.modules = [
${mods.join('\n')}
]
`
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT + '.tmp', conf); fs.renameSync(OUT + '.tmp', OUT)

// Manifest of runtime-settable controls, consumed by papa-eq-apply.py.
// Generated here rather than re-derived there: the naming and band-split rules
// live in this file, and two implementations of them would drift.
const manifest = { generated: new Date().toISOString(), crossover: XOVER, presets: {} }
for (const p of store.presets) {
  const entry = { sink: `papa_eq_${p.key}`, gains: {}, mixer: {} }
  for (const ch of SATELLITES.concat(['LFE'])) {
    for (const f of toneChain(p.key, ch, p.gains)) {
      entry.gains[`${p.key}_${f.tag}_${ch}:Gain`] = f.gain
    }
    if (ch !== 'LFE') {
      // Node names differ by topology; advertising the wrong ones makes every
      // live apply report "missing" and fall back to a full rebuild.
      const tags = BASS_MGMT ? ['hp1','hp2','lp1','lp2'] : ['hp']
      const freq = BASS_MGMT ? XOVER : LFE_HP
      for (const t of tags) entry.gains[`${p.key}_${t}_${ch}:Freq`] = freq
    }
  }
  if (BASS_MGMT) {
    entry.gains[`${p.key}_lfelp1_LFE:Freq`] = XOVER
    entry.gains[`${p.key}_lfelp2_LFE:Freq`] = XOVER
  }
  entry.gains[`${p.key}_sub1_LFE:Freq`] = LFE_HP
  entry.gains[`${p.key}_sub2_LFE:Freq`] = LFE_HP
  if (BASS_MGMT) {
    for (let i = 1; i <= 5; i++) entry.mixer[`${p.key}_submix_LFE:Gain ${i}`] = +SAT_MIX_GAIN.toFixed(4)
    entry.mixer[`${p.key}_submix_LFE:Gain 6`] = 1.0
  }
  manifest.presets[p.key] = entry
}
const MANIFEST = path.join(os.homedir(), '.config/papa-eq/controls.json')
fs.writeFileSync(MANIFEST + '.tmp', JSON.stringify(manifest, null, 2))
fs.renameSync(MANIFEST + '.tmp', MANIFEST)
console.log('wrote', OUT)
console.log('wrote', path.join(os.homedir(), '.config/papa-eq/controls.json'))

// Validate what we just wrote. A malformed filter graph fails as SILENCE with
// no error anywhere, so catching it here — before PipeWire ever loads it — is
// the difference between a clear message and an evening of debugging.
try {
  const audit = path.join(__dirname, 'audit-eq.py')
  if (fs.existsSync(audit)) {
    const r = require('child_process').spawnSync('python3', [audit, '--quiet'],
                                                 { encoding: 'utf8' })
    if (r.status !== 0) {
      console.error('\nAUDIT FAILED on the config just written:')
      console.error((r.stdout || '') + (r.stderr || ''))
      process.exitCode = 1
    }
  }
} catch { /* audit is advisory; never block generation on it being unavailable */ }
console.log(`  presets: ${store.presets.length}  bass management: ${BASS_MGMT ? `ON (${XOVER} Hz, redirected)` : 'OFF'}  sub HP: ${LFE_HP} Hz`)
