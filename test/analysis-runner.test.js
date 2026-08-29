'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { buildFfmpegArgs, analyseOne } = require('../analysis-runner')

const GOOD = `
    I:         -14.2 LUFS
    LRA:        11.4 LU
    Peak:        -0.3 dBFS
[astats] RMS level dB: -18.372
[astats] Crest factor: 6.221
[astats] Zero crossings rate: 0.041270
[astats] Flat factor: 0.000000
[Parsed_ametadata_5 @ 0x4] lavfi.aspectralstats.1.centroid=1800.00
[Parsed_ametadata_5 @ 0x4] lavfi.aspectralstats.1.flatness=0.128
[Parsed_ametadata_5 @ 0x4] lavfi.aspectralstats.1.rolloff=4820.50
[Parsed_ametadata_5 @ 0x4] lavfi.aspectralstats.1.entropy=0.712
[Parsed_ametadata_5 @ 0x4] lavfi.aspectralstats.2.centroid=1884.62
[Parsed_ametadata_5 @ 0x4] lavfi.aspectralstats.2.flatness=0.128
[Parsed_ametadata_5 @ 0x4] lavfi.aspectralstats.2.rolloff=4820.50
[Parsed_ametadata_5 @ 0x4] lavfi.aspectralstats.2.entropy=0.712
`

function fakeSpawn({ stderr = '', code = 0, delay = 0 }) {
  return () => {
    const proc = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = () => { proc.emit('close', null) }
    setTimeout(() => {
      if (stderr) proc.stderr.emit('data', Buffer.from(stderr))
      proc.emit('close', code)
    }, delay)
    return proc
  }
}

test('args downmix to mono 22050 and request all three filter sets', () => {
  const args = buildFfmpegArgs('/music/a.flac')
  const af = args[args.indexOf('-af') + 1]
  assert.ok(args.includes('/music/a.flac'))
  assert.ok(af.includes('aresample=22050'))
  assert.ok(af.includes('channel_layouts=mono'))
  assert.ok(af.includes('ebur128'))
  assert.ok(af.includes('astats'))
  assert.ok(af.includes('aspectralstats'))
  assert.ok(args.includes('-nostats'))
})

test('a clean run returns a vector', async () => {
  const r = await analyseOne('/a.flac', { spawnFn: fakeSpawn({ stderr: GOOD }) })
  assert.strictEqual(r.ok, true)
  assert.ok(Number.isFinite(r.vector.energy))
})

test('a non-zero exit is reported, not thrown', async () => {
  const r = await analyseOne('/a.flac', { spawnFn: fakeSpawn({ stderr: 'boom', code: 1 }) })
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /exit|1/)
})

test('output that parses to nothing usable is a failure, not a null vector', async () => {
  const r = await analyseOne('/a.flac', { spawnFn: fakeSpawn({ stderr: 'nothing here', code: 0 }) })
  assert.strictEqual(r.ok, false)
})

test('a hung ffmpeg is killed and reported rather than hanging forever', async () => {
  const r = await analyseOne('/a.flac', { spawnFn: fakeSpawn({ delay: 5000 }), timeoutMs: 30 })
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /timed out/i)
})

test('a spawn error is reported', async () => {
  const spawnFn = () => {
    const proc = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = () => {}
    setTimeout(() => proc.emit('error', new Error('ENOENT')), 0)
    return proc
  }
  const r = await analyseOne('/a.flac', { spawnFn })
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /ENOENT/)
})

const { runAnalysis, needsAnalysis } = require('../analysis-runner')
const { FEATURE_VERSION } = require('../src/audio-features')

const V = { energy: 1, brightness: 1, dynamics: 1, density: 1, punch: 1 }
const okFn = async () => ({ ok: true, vector: V, featureVersion: FEATURE_VERSION })

function trk(i, mtimeMs = 100, size = 10) {
  return { filePath: `/t${i}.flac`, mtimeMs, size }
}

test('a track with a current entry is skipped', () => {
  const t = trk(1)
  const entry = { vector: V, featureVersion: FEATURE_VERSION, mtimeMs: 100, size: 10 }
  assert.strictEqual(needsAnalysis(t, entry), false)
})

test('a changed file, a resized file, or a stale version is re-analysed', () => {
  const t = trk(1, 100, 10)
  const base = { vector: V, featureVersion: FEATURE_VERSION, mtimeMs: 100, size: 10 }
  assert.strictEqual(needsAnalysis(t, { ...base, mtimeMs: 99 }), true)
  assert.strictEqual(needsAnalysis(t, { ...base, size: 11 }), true)
  assert.strictEqual(needsAnalysis(t, { ...base, featureVersion: FEATURE_VERSION - 1 }), true)
  assert.strictEqual(needsAnalysis(t, undefined), true)
})

test('only unanalysed tracks are processed', async () => {
  const tracks = [trk(1), trk(2), trk(3)]
  const existing = new Map([['/t1.flac', { vector: V, featureVersion: FEATURE_VERSION, mtimeMs: 100, size: 10 }]])
  const seen = []
  const r = await runAnalysis({
    tracks, existing, concurrency: 2,
    analyseFn: async fp => { seen.push(fp); return { ok: true, vector: V, featureVersion: FEATURE_VERSION } },
  })
  assert.deepStrictEqual(seen.sort(), ['/t2.flac', '/t3.flac'])
  assert.strictEqual(r.analysed, 2)
  assert.strictEqual(r.skipped, 1)
})

test('concurrency is never exceeded', async () => {
  let inFlight = 0, peak = 0
  const analyseFn = async () => {
    inFlight++; peak = Math.max(peak, inFlight)
    await new Promise(r => setTimeout(r, 5))
    inFlight--
    return { ok: true, vector: V, featureVersion: FEATURE_VERSION }
  }
  await runAnalysis({ tracks: Array.from({ length: 12 }, (_, i) => trk(i)), existing: new Map(), concurrency: 3, analyseFn })
  assert.ok(peak <= 3, `peak concurrency was ${peak}`)
})

test('analysis stops while audio is playing', async () => {
  let calls = 0
  const r = await runAnalysis({
    tracks: Array.from({ length: 10 }, (_, i) => trk(i)),
    existing: new Map(), concurrency: 2,
    isPlaying: () => true,
    analyseFn: async () => { calls++; return { ok: true, vector: V, featureVersion: FEATURE_VERSION } },
  })
  assert.strictEqual(calls, 0, 'analysis ran while audio was playing')
  assert.strictEqual(r.analysed, 0)
})

test('one failure does not abort the batch', async () => {
  const r = await runAnalysis({
    tracks: [trk(1), trk(2), trk(3)], existing: new Map(), concurrency: 2,
    analyseFn: async fp => fp === '/t2.flac'
      ? { ok: false, error: 'bad file' }
      : { ok: true, vector: V, featureVersion: FEATURE_VERSION },
  })
  assert.strictEqual(r.analysed, 2)
  assert.strictEqual(r.failed, 1)
  assert.ok(r.results.has('/t1.flac') && r.results.has('/t3.flac'))
})

test('progress is reported and shouldStop halts cleanly', async () => {
  const seenProgress = []
  const r = await runAnalysis({
    tracks: Array.from({ length: 20 }, (_, i) => trk(i)), existing: new Map(), concurrency: 1,
    analyseFn: okFn,
    onProgress: p => seenProgress.push(p),
    shouldStop: () => seenProgress.length >= 3,
  })
  assert.ok(seenProgress.length >= 3)
  assert.ok(r.analysed < 20, 'shouldStop did not halt the run')
})

test('an empty track list resolves rather than hanging', async () => {
  const r = await runAnalysis({ tracks: [], existing: new Map(), analyseFn: okFn })
  assert.strictEqual(r.analysed, 0)
})
