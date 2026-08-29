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

module.exports = { FEATURE_KEYS, FEATURE_VERSION, parseAnalysis }
