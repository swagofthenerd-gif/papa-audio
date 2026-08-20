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

if (!fs.existsSync(STORE)) { console.error(`No preset store at ${STORE}`); process.exit(1) }
const store = JSON.parse(fs.readFileSync(STORE, 'utf8'))
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
// Summing five satellites' bass into one driver overloads a modest subwoofer
// long before it clips digitally — it simply runs out of excursion. Each
// contribution is attenuated; lower this if the sub distorts, raise it if the
// bass feels weak.
const SAT_MIX_GAIN = settings.subMixGain != null ? settings.subMixGain : 0.30
// Each section of a Linkwitz-Riley pair is a Butterworth section.
const LR_Q = 0.7071

const clamp = v => Math.max(-12, Math.min(12, v))
// Headroom must be reckoned per PATH, not per preset. The sink's volume applies
// to every channel, so taking the peak across all bands penalises the
// satellites for a boost that — after the crossover split — only ever reaches
// the subwoofer. On a bass-forward voicing that leaves the satellites several
// dB quieter than the sub and skews the whole balance bass-heavy.
//
// So: set the sink volume from the SATELLITE peak, then scale the sub mixer by
// the difference so the sub path keeps the same headroom without clipping.
const peakOf = vals => Math.max(0, ...vals)

function pathPeaks(gains) {
  if (!BASS_MGMT) { const p = peakOf(gains); return { sat: p, sub: p } }
  const sat = peakOf(gains.filter((_, i) => BANDS[i] >= XOVER))
  const sub = peakOf(gains.filter((_, i) => BANDS[i] <= XOVER))
  return { sat, sub }
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
  return ch === 'LFE' ? freq <= XOVER : freq >= XOVER
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

  // The source's own LFE, high-passed at the driver's floor.
  add(n('hp', 'LFE'), 'bq_highpass', `"Freq" = ${LFE_HP} "Q" = 0.7 "Gain" = 0`)
  inputs.LFE = `${n('hp', 'LFE')}:In`
  let lfeOut = `${n('hp', 'LFE')}:Out`
  if (BASS_MGMT) {
    links.push(`      { output = "${lfeOut}" input = "${subMixer}:In ${mixIn}" }`)
    lfeOut = `${subMixer}:Out`
  }
  outputs.LFE = chain(lfeOut, 'LFE', toneChain(key, 'LFE', voicing.gains))

  // The sink volume now only covers the satellite peak, so any extra boost on
  // the sub path has to come out of the mixer or it clips.
  const subTrim = Math.pow(10, -Math.max(0, peaks.sub - peaks.sat) / 20)
  const gains = BASS_MGMT
    ? Array.from({ length: mixIn }, (_, i) =>
        `"Gain ${i + 1}" = ${((i === mixIn - 1 ? 1.0 : SAT_MIX_GAIN) * subTrim).toFixed(4)}`).join(' ')
    : ''
  if (BASS_MGMT) {
    const idx = nodes.findIndex(x => x.includes(`name = ${subMixer} `))
    nodes[idx] = `      { type = builtin name = ${subMixer} label = mixer control = { ${gains} } }`
  }

  const preamp = peaks.sat > 0 ? -Math.round(peaks.sat) : 0
  return `  { name = libpipewire-module-filter-chain
    args = {
      node.description = "Papa EQ — ${voicing.label}"
      media.name       = "Papa EQ — ${voicing.label}"
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
        node.description = "Papa EQ — ${voicing.label}"
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
fs.writeFileSync(OUT, conf)
console.log('wrote', OUT)
console.log(`  presets: ${store.presets.length}  bass management: ${BASS_MGMT ? `ON (${XOVER} Hz, redirected)` : 'OFF'}  sub HP: ${LFE_HP} Hz`)
