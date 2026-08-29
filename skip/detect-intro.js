'use strict'
// Layer 3 skip source: cross-episode audio correlation for TV intros.
//
// A series intro is the same audio in every episode of a season. Decode the
// first minutes of two episodes, reduce each to a compact energy fingerprint in
// Node (no native dependency — fpcalc/chromaprint is NOT installed, §6), and
// cross-correlate: the longest matching run is the intro.
//
// This is the enhancement layer (Layers 1, 2 and 4 cover most real cases), so
// it is deliberately conservative and never allowed to block playback: the
// caller runs it in the background and discards it on a deadline or an abort.

const { execFile } = require('child_process')

// First five minutes, mono, downsampled to 8kHz. Enough for an intro, and the
// fingerprint stays ~3 KB (one 8-bit bucket per 100 ms).
const DEFAULT_MAX_SECONDS = 300
const SAMPLE_RATE = 8000

function buildFfmpegArgs(url, maxSeconds = DEFAULT_MAX_SECONDS) {
  return [
    '-v', 'error',
    '-i', url,
    '-t', String(maxSeconds),
    '-ac', '1',
    '-ar', String(SAMPLE_RATE),
    '-f', 's16le',
    '-',
  ]
}

// s16le mono PCM → one 8-bit energy bucket per `frameMs` frame. A full-scale
// 16-bit sample has amplitude 32768, so rms/128 maps [0, 32768] onto [0, 255].
function fingerprintFromPcm(pcm, { frameMs = 100 } = {}) {
  const bytes = (pcm && pcm.length) || 0
  const samplesPerFrame = Math.max(1, Math.round(SAMPLE_RATE * frameMs / 1000))
  const frames = []
  for (let off = 0; off + samplesPerFrame * 2 <= bytes; off += samplesPerFrame * 2) {
    let sumSq = 0
    for (let i = 0; i < samplesPerFrame; i++) {
      const s = pcm.readInt16LE(off + i * 2)
      sumSq += s * s
    }
    const rms = Math.sqrt(sumSq / samplesPerFrame)
    frames.push(Math.max(0, Math.min(255, Math.round(rms / 128))))
  }
  return frames
}

// Cross-correlates two fingerprints. The intro is the longest contiguous run of
// near-identical frames; a run must carry real energy (not just shared silence,
// which would otherwise make the whole five minutes "match").
function findIntro(fa, fb, opts = {}) {
  const frameMs = opts.frameMs ?? 100
  const minMatchSec = opts.minMatchSec ?? 20
  const maxLagSec = opts.maxLagSec ?? 120
  const tolerance = opts.tolerance ?? 6
  const silenceFloor = opts.silenceFloor ?? 3

  if (!Array.isArray(fa) || !Array.isArray(fb) || !fa.length || !fb.length) return null
  const minFrames = Math.max(1, Math.ceil(minMatchSec * 1000 / frameMs))
  const maxLag = Math.max(0, Math.round(maxLagSec * 1000 / frameMs))

  // Best alignment: the lag that maximises the sum of products of the buckets.
  // Sum, not mean: a tiny overlap with one loud frame must not outscore a full
  // alignment of the real intro. A recap or cold open shifts the intro by only
  // seconds, so the search is bounded and cheap.
  let bestLag = 0
  let bestScore = -Infinity
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let sum = 0
    let count = 0
    for (let i = 0; i < fa.length; i++) {
      const j = i + lag
      if (j < 0 || j >= fb.length) continue
      sum += fa[i] * fb[j]
      count++
    }
    if (!count) continue
    if (sum > bestScore) { bestScore = sum; bestLag = lag }
  }

  // Longest contiguous aligned run. `runStart` is recorded in fb's frame index
  // so the result is in the current episode's own timebase.
  let best = { start: -1, len: 0 }
  let runStart = -1
  let runLen = 0
  for (let i = 0; i < fa.length; i++) {
    const j = i + bestLag
    if (j < 0 || j >= fb.length) { runLen = 0; continue }
    const a = fa[i]
    const b = fb[j]
    const match = Math.abs(a - b) <= tolerance && Math.max(a, b) >= silenceFloor
    if (match) {
      if (runLen === 0) runStart = j
      runLen++
      if (runLen > best.len) best = { start: runStart, len: runLen }
    } else {
      runLen = 0
    }
  }

  if (best.len < minFrames) return null
  return {
    start: Number((best.start * frameMs / 1000).toFixed(3)),
    end: Number(((best.start + best.len) * frameMs / 1000).toFixed(3)),
    lagFrames: bestLag,
  }
}

// Decodes a URL to raw PCM via ffmpeg. Resolves null rather than throwing: an
// unreadable stream is "no intro found", not a playback fault.
function decodeToPcm(url, execFn, { maxSeconds = DEFAULT_MAX_SECONDS, timeoutMs = 60000, signal } = {}) {
  return new Promise(resolve => {
    const run = execFn || execFile
    const args = buildFfmpegArgs(url, maxSeconds)
    try {
      run('ffmpeg', args, { encoding: null, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, signal }, (err, stdout) => {
        if (err || !stdout || !stdout.length) return resolve(null)
        resolve(stdout)
      })
    } catch (_) {
      resolve(null)
    }
  })
}

// Decodes two episodes in parallel, fingerprints both, correlates. Returns a
// detected intro segment or null. `signal` aborts the decode; the caller owns
// the low-priority, background execution so this never sits on the playback
// path.
async function detectIntro({ currentUrl, referenceUrl, execFn, maxSeconds, timeoutMs, signal } = {}) {
  if (!currentUrl || !referenceUrl) return null
  if (signal && signal.aborted) return null
  const [refPcm, curPcm] = await Promise.all([
    decodeToPcm(referenceUrl, execFn, { maxSeconds, timeoutMs, signal }),
    decodeToPcm(currentUrl, execFn, { maxSeconds, timeoutMs, signal }),
  ])
  if (signal && signal.aborted) return null
  if (!refPcm || !curPcm) return null
  const match = findIntro(fingerprintFromPcm(refPcm), fingerprintFromPcm(curPcm))
  if (!match) return null
  return { kind: 'intro', start: match.start, end: match.end, origin: 'detected', confidence: 0.6 }
}

module.exports = {
  detectIntro,
  decodeToPcm,
  fingerprintFromPcm,
  findIntro,
  buildFfmpegArgs,
  DEFAULT_MAX_SECONDS,
  SAMPLE_RATE,
}
