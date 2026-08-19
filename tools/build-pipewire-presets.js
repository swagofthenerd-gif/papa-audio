'use strict'
// Builds several 6-channel EQ sinks — one per preset — all fed from the same
// measured correction and all targeting the 5.1 hardware sink.
//
// Why one sink per preset rather than one sink that gets rewritten: a
// filter-chain is defined statically in config and only loads at daemon start,
// so changing a preset in place would mean restarting PipeWire and dropping
// every stream. Running them side by side makes switching a default-sink
// change, which is instant. Idle chains cost nothing while suspended.
const fs = require('fs')
const path = require('path')
const os = require('os')

const CAL = path.join(os.homedir(), '.cache/speakercal.json')
const OUT = path.join(os.homedir(), '.config/pipewire/pipewire.conf.d/60-papa-eq-51.conf')
const TARGET = 'alsa_output.pci-0000_2b_00.4.analog-surround-51'
const CHANNELS = ['FL', 'FR', 'FC', 'LFE', 'RL', 'RR']
let BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

const cal = fs.existsSync(CAL) ? JSON.parse(fs.readFileSync(CAL, 'utf8')) : {}
const corrections = cal.corrections || []
const hpFreq = cal.low_limit ? Math.max(28, Math.round(cal.low_limit * 0.9)) : 35

// Voicings live in ~/.config/papa-eq/presets.json so the GUI and this
// generator share one source of truth. The measured correction sits underneath
// every one of them.
const STORE = path.join(os.homedir(), '.config/papa-eq/presets.json')
if (!fs.existsSync(STORE)) {
  console.error(`No preset store at ${STORE}`)
  process.exit(1)
}
const store = JSON.parse(fs.readFileSync(STORE, 'utf8'))
if (Array.isArray(store.bands)) BANDS = store.bands
const VOICINGS = {}
for (const p of store.presets) VOICINGS[p.key] = { label: p.label, gains: p.gains }

const clamp = v => Math.max(-12, Math.min(12, v))
// Boosts eat headroom; give back exactly what the curve's peak consumes.
const preampFor = g => { const p = Math.max(0, ...g); return p > 0 ? -Math.round(p) : 0 }

// A generated LFE channel arrives about 10 dB quieter than it should. Real 5.1
// content records LFE 10 dB down and expects the decoder to add that back —
// it is headroom for cinema bass. PipeWire's upmix synthesises the channel but
// does not apply the convention, so the subwoofer is left barely audible.
// A low shelf restores it without touching anything above the crossover.
const LFE_BOOST_DB = 6
const LFE_SHELF_HZ = 120

// Bass management, as an AV receiver does it. Small satellites reproduce bass
// badly — diffuse and distorted — and the upmix COPIES low frequencies into
// the LFE channel without removing them from the fronts, so both play it. High
// passing the satellites at the crossover leaves bass solely to the subwoofer,
// which both cleans up the midrange and makes the sub the thing you feel.
const SAT_CROSSOVER_HZ = 100

// lfeBoost is applied only to the upmix variant. A synthesised LFE arrives
// about 10 dB below where the standard puts it; a native 5.1 mix already
// carries a properly-levelled LFE, so boosting that would just make real
// surround music boomy. The chain cannot tell the two apart once the audio
// reaches it — both are simply six channels — so each preset gets two sinks
// and the source decides which one to use.
function filtersFor(ch, gains, lfeBoost) {
  // The subwoofer is high-passed AT its measured limit, not below it. Feeding
  // it content it cannot reproduce buys cone excursion and distortion instead
  // of output — audible immediately on bass-heavy material like film trailers,
  // which carry far more low-frequency energy than music.
  const lfeHp = cal.low_limit ? Math.round(cal.low_limit) : hpFreq
  const satHp = ch === 'LFE' ? lfeHp : Math.max(hpFreq, SAT_CROSSOVER_HZ)
  const out = [{ label: 'bq_highpass', freq: satHp, gain: 0, q: 0.7, tag: 'hp' }]
  if (ch === 'LFE' && lfeBoost) {
    out.push({ label: 'bq_lowshelf', freq: LFE_SHELF_HZ, gain: LFE_BOOST_DB, q: 0.7, tag: 'lfeboost' })
  }
  gains.forEach((g, i) => {
    if (g === 0) return
    if (ch === 'LFE' && BANDS[i] > 300) return
    out.push({ label: 'bq_peaking', freq: BANDS[i], gain: clamp(g), q: 1.0, tag: `v${BANDS[i]}` })
  })
  for (const c of corrections) {
    if (ch === 'LFE' && c.freq > 300) continue
    out.push({ label: 'bq_peaking', freq: c.freq, gain: c.gain, q: c.q, tag: `c${c.freq}` })
  }
  return out
}

function moduleFor(key, voicing, lfeBoost) {
  const nodes = []; const links = []; const inputs = []; const outputs = []
  for (const ch of CHANNELS) {
    const chain = filtersFor(ch, voicing.gains, lfeBoost)
    const names = chain.map(f => `${key}_${f.tag}_${ch}`)
    chain.forEach((f, i) => {
      nodes.push(`      { type = builtin name = ${names[i]} label = ${f.label} ` +
                 `control = { "Freq" = ${f.freq} "Q" = ${f.q} "Gain" = ${f.gain} } }`)
      if (i > 0) links.push(`      { output = "${names[i - 1]}:Out" input = "${names[i]}:In" }`)
    })
    inputs.push(`"${names[0]}:In"`)
    outputs.push(`"${names[names.length - 1]}:Out"`)
  }
  const preamp = preampFor(voicing.gains)
  return `  { name = libpipewire-module-filter-chain
    args = {
      node.description = "Papa EQ — ${voicing.label}${lfeBoost ? '' : ' [5.1 direct]'}"
      media.name       = "Papa EQ — ${voicing.label}${lfeBoost ? '' : ' [5.1 direct]'}"
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
        node.name        = "papa_eq_${key}"
        node.description = "Papa EQ — ${voicing.label}${lfeBoost ? '' : ' [5.1 direct]'}"
        media.class      = Audio/Sink
        audio.channels   = 6
        audio.position   = [ FL FR FC LFE RL RR ]
        channelmix.normalize = false
        node.latency     = 1024/48000
        # Stereo sources have nothing in the centre or rears. Passive surround
        # decoding derives a centre from what the two channels share and rears
        # from what differs, so music and YouTube use all six speakers instead
        # of two. Without this, 'auto' simply pads the extra channels with
        # silence.
        channelmix.upmix        = true
        channelmix.upmix-method = psd
        channelmix.lfe-cutoff   = 120
        channelmix.fc-cutoff    = 12000
        channelmix.rear-delay   = 12.0
${preamp !== 0 ? `        # headroom for this curve's peak boost\n        volume = ${Math.pow(10, preamp / 20).toFixed(4)}` : ''}
      }
      playback.props = {
        node.name      = "papa_eq_${key}_out"
        node.passive   = true
        audio.channels = 6
        audio.position = [ FL FR FC LFE RL RR ]
        target.object  = "${TARGET}"
        # Without this, an unresolvable target makes a passive output
        # auto-connect to the CURRENT DEFAULT SINK — which is another preset.
        # The chains then daisy-chain into each other and audio never reaches
        # the hardware. The 5.1 sink does not exist yet when these load,
        # because the card profile is applied seconds later, so autoconnect is
        # disabled and papa-eq-relink asserts the links once it appears.
        node.dont-reconnect = true
        node.autoconnect    = false
      }
    }
  }`
}

const mods = []
for (const [k, v] of Object.entries(VOICINGS)) {
  mods.push(moduleFor(k, v, true))            // stereo sources: boost synthesised LFE
  mods.push(moduleFor(`${k}51`, v, false))    // native 5.1: leave its own LFE alone
}
const conf = `# Papa EQ — switchable 6-channel presets, generated by
# flac-player/tools/build-pipewire-presets.js from ~/.cache/speakercal.json
#
# Measured on this system:
#   low-frequency limit : ${cal.low_limit || '?'} Hz  -> high-pass at ${hpFreq} Hz
${corrections.map(c => `#   ${String(c.freq).padStart(5)} Hz  ${c.gain} dB  Q=${c.q}`).join('\n')}
#
# Every preset applies that correction underneath its voicing.
# Switch with:  eqmode <name>      List with:  eqmode

context.modules = [
${mods.join('\n')}
]
`
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, conf)
console.log('wrote', OUT)
for (const [k, v] of Object.entries(VOICINGS)) {
  console.log(`  papa_eq_${k.padEnd(7)} ${v.label}  (preamp ${preampFor(v.gains)} dB)`)
}
