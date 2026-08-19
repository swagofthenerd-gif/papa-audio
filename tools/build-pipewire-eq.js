'use strict'
// Generates a PipeWire filter-chain that applies the by-ear calibration to a
// true 6-channel 5.1 stream.
//
// Why not EasyEffects: it is a stereo-only processor. Routing 5.1 through it
// downmixes to 2 channels, folding the rear channels into the fronts — you
// lose the surround entirely. PipeWire's native filter-chain handles arbitrary
// channel counts, so correction and discrete 5.1 can coexist.
const fs = require('fs')
const path = require('path')
const os = require('os')

const CAL = path.join(os.homedir(), '.cache/speakercal.json')
const OUT = path.join(os.homedir(), '.config/pipewire/pipewire.conf.d/60-papa-eq-51.conf')
// The ACP surround profile's sink. Changed from the raw playback node once
// PipeWire's own analog-surround-51 profile became available (it only appears
// after the codec's Channel Mode is set to 6ch).
const TARGET = 'alsa_output.pci-0000_2b_00.4.analog-surround-51'
const CHANNELS = ['FL', 'FR', 'FC', 'LFE', 'RL', 'RR']

const cal = fs.existsSync(CAL) ? JSON.parse(fs.readFileSync(CAL, 'utf8')) : {}
const STAGE = Number(process.env.EQ_STAGE || 3)
const allCorrections = cal.corrections || []
const corrections = STAGE === 1 ? []
  : STAGE === 2 ? allCorrections.filter(c => c.freq < 300)
  : allCorrections
const hpFreq = cal.low_limit ? Math.max(28, Math.round(cal.low_limit * 0.9)) : 35

// The LFE channel carries only low frequencies, so the treble notches are
// meaningless there — but the high-pass still matters, since it is what stops
// the sub being asked for output below what it can physically produce.
function filtersFor(ch) {
  const list = [{ label: 'bq_highpass', freq: hpFreq, gain: 0, q: 0.7, tag: 'hp' }]
  for (const c of corrections) {
    if (ch === 'LFE' && c.freq > 300) continue
    list.push({ label: 'bq_peaking', freq: c.freq, gain: c.gain, q: c.q, tag: `c${c.freq}` })
  }
  return list
}

const nodes = []
const links = []
const inputs = []
const outputs = []

for (const ch of CHANNELS) {
  const chain = filtersFor(ch)
  const names = chain.map(f => `${f.tag}_${ch}`)
  chain.forEach((f, i) => {
    nodes.push(`      { type = builtin name = ${names[i]} label = ${f.label} ` +
               `control = { "Freq" = ${f.freq} "Q" = ${f.q} "Gain" = ${f.gain} } }`)
    if (i > 0) links.push(`      { output = "${names[i - 1]}:Out" input = "${names[i]}:In" }`)
  })
  inputs.push(`"${names[0]}:In"`)
  outputs.push(`"${names[names.length - 1]}:Out"`)
}

const conf = `# Papa EQ — 6-channel speaker + room correction, generated from
# ~/.cache/speakercal.json by flac-player/tools/build-pipewire-eq.js
#
# Measured on this system:
#   usable low-frequency limit : ${cal.low_limit || 'unknown'} Hz  -> high-pass at ${hpFreq} Hz
${corrections.map(c => `#   ${String(c.freq).padStart(5)} Hz  ${c.gain > 0 ? '+' : ''}${c.gain} dB  Q=${c.q}  (${c.why})`).join('\n')}
#
# Regenerate with:  node ~/flac-player/tools/build-pipewire-eq.js
# Disable with:     rm this file && systemctl --user restart pipewire

context.modules = [
  { name = libpipewire-module-filter-chain
    args = {
      node.description = "Papa EQ 5.1"
      media.name       = "Papa EQ 5.1"
      filter.graph = {
        nodes = [
${nodes.join('\n')}
        ]
        links = [
${links.join('\n')}
        ]
        inputs  = [ ${inputs.join(' ')} ]
        outputs = [ ${outputs.join(' ')} ]
      }
      capture.props = {
        node.name      = "papa_eq_51"
        node.description = "Papa EQ 5.1"
        media.class    = Audio/Sink
        audio.channels = 6
        audio.position = [ FL FR FC LFE RL RR ]
      }
      playback.props = {
        node.name      = "papa_eq_51_output"
        node.passive   = true
        audio.channels = 6
        audio.position = [ FL FR FC LFE RL RR ]
        target.object  = "${TARGET}"
      }
    }
  }
]
`

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, conf)
console.log('wrote', OUT)
console.log(`  channels: ${CHANNELS.length}   filter nodes: ${nodes.length}   links: ${links.length}`)
console.log(`  high-pass: ${hpFreq} Hz`)
for (const c of corrections) console.log(`  correction: ${c.freq} Hz ${c.gain} dB Q=${c.q}`)
