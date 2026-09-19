'use strict'
// Rip verification: turns ffprobe/ffmpeg text into one honest verdict about a
// file the peer claims is lossless. Pure — nothing here spawns anything, so
// every verdict rule is testable without audio. main.js owns the download,
// the ffmpeg calls and the cleanup (slsk-verify-rip).

const AUDIO_RE = /\.(flac|wav|aiff?|aif|ape|wv|alac|dsf|dff|mp3|m4a|aac|ogg|opus)$/i
const MAX_SAMPLE_BYTES = 80 * 1024 * 1024
// Bands the ceiling probe measures (Hz). main runs one highpass+volumedetect
// per band; parseCeiling reads the highest band still carrying real signal.
const BANDS = [16000, 18000, 20000, 22000, 24000, 30000, 40000]
// Below this the band is silence as far as a rip is concerned.
const FLOOR_DB = -85

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null }

function parseProbe(text) {
  const s = String(text || '')
  const get = k => { const m = s.match(new RegExp('^' + k + '=(.+)$', 'm')); return m ? m[1].trim() : null }
  return {
    sampleRate: num(get('sample_rate')),
    bitDepth: num(get('bits_per_raw_sample')) || num(get('bits_per_sample')),
    codec: get('codec_name'),
  }
}

// astats prints per-channel blocks BEFORE Overall; take the LAST match so the
// figure is the whole file, not channel 1.
function last(text, re) {
  let m, found = null
  const g = new RegExp(re.source, 'g')
  while ((m = g.exec(text)) !== null) found = m[1]
  return found
}

function parseAstats(text) {
  const s = String(text || '')
  const bits = last(s, /Bit depth: (\d+)\/\d+/)
  const dr = last(s, /Dynamic range: ([\d.]+)/)
  return { measuredBits: num(bits), dynamicRange: num(dr) }
}

function parseCeiling(text) {
  const s = String(text || '')
  let ceiling = null
  const re = /band=(\d+)[^\n]*mean_volume: (-?[\d.]+) dB/g
  let m
  while ((m = re.exec(s)) !== null) {
    const band = Number(m[1]), db = Number(m[2])
    if (db > FLOOR_DB && (ceiling === null || band > ceiling)) ceiling = band
  }
  return ceiling
}

function fmt(bits, rate) {
  return (bits || '?') + '/' + (rate ? Math.round(rate / 1000) : '?')
}

function verdict({ declaredRate, declaredBits, measuredBits, ceilingHz, ext }) {
  const lossless = /^(flac|wav|aiff?|aif|ape|wv|alac|dsf|dff)$/i.test(String(ext || ''))
  const rate = num(declaredRate), bits = num(declaredBits), mbits = num(measuredBits), ceil = num(ceilingHz)
  if (ceil === null || rate === null) return { kind: 'unknown', text: 'could not measure this file' }
  // Declared hi-res but nothing above the CD band: an upsample.
  if (rate >= 88200 && ceil <= 22000) {
    return { kind: 'upsampled', text: 'upsampled, really ~' + fmt(mbits && mbits <= 16 ? 16 : bits, 44100) }
  }
  if (bits !== null && bits >= 24 && mbits !== null && mbits <= 16) {
    return { kind: 'padded', text: 'padded 16-bit, labelled ' + bits + '-bit' }
  }
  if (lossless && ceil <= 16000) {
    return { kind: 'transcoded', text: 'likely transcoded from lossy (nothing above ' + Math.round(ceil / 1000) + ' kHz)' }
  }
  return { kind: 'genuine', text: 'genuine ' + fmt(bits, rate) }
}

function pickTrack(files) {
  const audio = (files || []).filter(f => AUDIO_RE.test(f.name || f.filename || ''))
  if (!audio.length) return null
  const small = audio.filter(f => (Number(f.size) || 0) <= MAX_SAMPLE_BYTES)
  if (small.length) return small.slice().sort((a, b) => (Number(b.length) || 0) - (Number(a.length) || 0))[0]
  return audio.slice().sort((a, b) => (Number(a.size) || 0) - (Number(b.size) || 0))[0]
}

module.exports = { parseProbe, parseAstats, parseCeiling, verdict, pickTrack, BANDS, FLOOR_DB, MAX_SAMPLE_BYTES }
