'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  detectIntro,
  fingerprintFromPcm,
  findIntro,
  buildFfmpegArgs,
} = require('../skip/detect-intro')

// Deterministic pseudo-random energy buckets, 40..99. Realistic in that no
// short period repeats (a repeating pattern would correlate with itself at
// many lags and make the lag selection look wrong when it is the data).
function seq(n, seed) {
  const out = []
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out.push(40 + (s % 60))
  }
  return out
}

function makePcm(frames, samplesPerFrame = 80) {
  const buf = Buffer.alloc(frames.length * samplesPerFrame * 2)
  let off = 0
  for (const amp of frames) {
    for (let s = 0; s < samplesPerFrame; s++) { buf.writeInt16LE(amp, off); off += 2 }
  }
  return buf
}

// bucket * 128 → constant amplitude, so fingerprintFromPcm returns the bucket
// back exactly (rms = amplitude for a constant frame).
function pcmFor(buckets, samplesPerFrame = 800) {
  return makePcm(buckets.map(b => b * 128), samplesPerFrame)
}

test('buildFfmpegArgs decodes to mono 8kHz s16le over the first N seconds', () => {
  assert.deepStrictEqual(buildFfmpegArgs('http://x/movie.mkv', 300), [
    '-v', 'error', '-i', 'http://x/movie.mkv', '-t', '300', '-ac', '1', '-ar', '8000', '-f', 's16le', '-',
  ])
})

test('fingerprintFromPcm reduces PCM to one 8-bit energy bucket per frame', () => {
  const pcm = makePcm([1280, 2560, 0, 12800], 80)
  const fp = fingerprintFromPcm(pcm, { frameMs: 10 })
  assert.deepStrictEqual(fp, [10, 20, 0, 100])
})

test('fingerprintFromPcm clamps to 0..255 and ignores trailing partial frames', () => {
  const fp = fingerprintFromPcm(makePcm([32700], 80), { frameMs: 10 })
  assert.strictEqual(fp[0], 255)
  assert.strictEqual(fp.length, 1)
})

test('findIntro recovers a shared intro prefix', () => {
  const intro = seq(200, 42) // 20 s at 100 ms
  const fa = [...intro, 220, 220, 220]
  const fb = [...intro, 10, 10, 10]
  const match = findIntro(fa, fb, { frameMs: 100, minMatchSec: 2, maxLagSec: 30 })
  assert.ok(match, 'an intro must be found')
  assert.strictEqual(match.start, 0)
  assert.strictEqual(match.end, 20)
})

test('findIntro places the match in the current episode timebase when offset by a recap', () => {
  const intro = seq(200, 7)
  const fa = [...intro, 220, 220]
  const fb = [10, 10, ...intro, 10, 10]
  const match = findIntro(fa, fb, { frameMs: 100, minMatchSec: 1, maxLagSec: 30 })
  assert.ok(match)
  assert.strictEqual(match.start, 0.2)
  assert.strictEqual(match.end, 20.2)
})

test('findIntro returns null for unrelated audio', () => {
  assert.strictEqual(findIntro(seq(200, 42), seq(200, 999), { maxLagSec: 30, minMatchSec: 5 }), null)
})

test('findIntro ignores shared silence rather than calling it the intro', () => {
  const fa = [0, 0, 0, 0, 0, 100, 100]
  const fb = [0, 0, 0, 0, 0, 100, 100]
  const match = findIntro(fa, fb, { frameMs: 100, minMatchSec: 0.1, silenceFloor: 3 })
  assert.ok(match)
  assert.strictEqual(match.start, 0.5, 'the run starts where energy starts')
})

test('findIntro rejects a match shorter than the minimum', () => {
  assert.strictEqual(findIntro([60, 60, 60, 90, 90], [60, 60, 60, 80, 80], { frameMs: 100, minMatchSec: 5 }), null)
})

test('findIntro returns null for empty fingerprints', () => {
  assert.strictEqual(findIntro([], []), null)
  assert.strictEqual(findIntro(null, [1, 2]), null)
})

test('detectIntro decodes two URLs and returns a detected intro segment', async () => {
  const intro = seq(200, 42)
  const refPcm = pcmFor([...intro, 0, 0])
  const curPcm = pcmFor([...intro, 220, 220])
  const calls = []
  const execFn = (bin, args, opts, cb) => {
    calls.push(args)
    cb(null, calls.length === 1 ? refPcm : curPcm)
  }
  const seg = await detectIntro({ currentUrl: 'http://x/ep2.mkv', referenceUrl: 'http://x/ep1.mkv', execFn })
  assert.ok(seg, 'a segment must be detected')
  assert.strictEqual(seg.kind, 'intro')
  assert.strictEqual(seg.origin, 'detected')
  assert.strictEqual(seg.start, 0)
  assert.strictEqual(calls.length, 2)
  assert.deepStrictEqual(calls[0], buildFfmpegArgs('http://x/ep1.mkv'))
})

test('detectIntro returns null when either decode fails', async () => {
  const execFn = (bin, args, opts, cb) => cb(new Error('ffmpeg missing'))
  assert.strictEqual(await detectIntro({ currentUrl: 'x', referenceUrl: 'y', execFn }), null)
})

test('detectIntro returns null for a missing url or an already-aborted signal', async () => {
  assert.strictEqual(await detectIntro({ currentUrl: null, referenceUrl: 'y' }), null)
  let called = 0
  const execFn = () => { called++ }
  const seg = await detectIntro({ currentUrl: 'x', referenceUrl: 'y', execFn, signal: { aborted: true } })
  assert.strictEqual(seg, null)
  assert.strictEqual(called, 0, 'nothing may be decoded after an abort')
})
