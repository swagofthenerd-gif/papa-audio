'use strict'
// R18: the smart-queues banner reports the whole library, counting what was
// already analysed, so an already-analysed library never reads "0 of N (0%)".
//
// This used to assert only that four lines of main.js were spelled a certain
// way, which cannot tell whether the banner adds up. startAnalysisRun is lifted
// out of main.js and run against fakes, and the assertions are on the progress
// payloads it actually sends — the numbers a person reads off the screen. The
// real needsAnalysis from analysis-runner is injected, so "already analysed"
// means what the runner means by it and the two cannot drift apart.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const { needsAnalysis } = require('../analysis-runner')
const { FEATURE_VERSION } = require('../src/audio-features')

function liftAnalysisRun(deps) {
  const start = MAIN.indexOf('function startAnalysisRun()')
  assert.ok(start > -1, 'startAnalysisRun must still exist in main.js')
  const end = MAIN.indexOf('\nipcMain.handle(', start)
  assert.ok(end > start, 'and must still be followed by its ipc handler')
  const names = ['allLibraryTracks', 'featureMap', 'runnerNeedsAnalysis', 'runAnalysis',
    'safeSend', 'featureStore', 'analyseOne', 'player', 'app', 'ANALYSIS_RESUME_DELAY_MS']
  const make = new Function(...names, `
    let analysisRunning = false
    let analysisResumeTimer = null
    ${MAIN.slice(start, end)}
    return { run: startAnalysisRun, isRunning: () => analysisRunning }
  `)
  return make(...names.map(n => deps[n]))
}

// n tracks, the first `analysed` of which already have a current feature entry.
function library(n, analysed) {
  const tracks = Array.from({ length: n }, (_, i) => ({
    filePath: '/mnt/data/MUSIC/t' + i + '.flac', mtimeMs: 1000 + i, size: 500 + i,
  }))
  const features = new Map()
  for (const t of tracks.slice(0, analysed)) {
    features.set(t.filePath, {
      vector: [0.1, 0.2], featureVersion: FEATURE_VERSION,
      mtimeMs: t.mtimeMs, size: t.size,
    })
  }
  return { tracks, features }
}

// `steps` are the progress events the runner emits, over only the work it had
// to do — which is exactly the narrow view that produced the "0 of 2376" bug.
function setup({ total = 10, analysed = 6, steps = [], result = null } = {}) {
  const { tracks, features } = library(total, analysed)
  const sent = []
  const seen = {}
  const lifted = liftAnalysisRun({
    allLibraryTracks: () => tracks,
    featureMap: () => features,
    runnerNeedsAnalysis: needsAnalysis,
    safeSend: (channel, payload) => sent.push({ channel, payload }),
    featureStore: { update: fn => fn({ features: {} }) },
    analyseOne: async () => ({ ok: true, vector: [0], featureVersion: FEATURE_VERSION }),
    player: { isActuallyPlaying: () => false },
    app: { isQuitting: false },
    ANALYSIS_RESUME_DELAY_MS: 60000,
    runAnalysis: async opts => {
      seen.opts = opts
      for (const s of steps) opts.onProgress(s)
      return result || { results: new Map(), analysed: total - analysed, halted: false }
    },
  })
  return { lifted, sent, seen, tracks }
}

const progress = sent => sent.filter(s => s.channel === 'queue-analysis-progress').map(s => s.payload)

test('an already-analysed library does not report itself as untouched', async () => {
  // Six of ten already measured. The runner only ever knows about the four it
  // has to do, and its first event is "0 of 4" — which is what reached the
  // banner as "0 of 2376 (0%)" while it claimed to be analysing.
  const { lifted, sent } = setup({ total: 10, analysed: 6, steps: [{ done: 0, total: 4 }] })
  lifted.run()
  await new Promise(r => setImmediate(r))
  const first = progress(sent)[0]
  assert.strictEqual(first.done, 6, 'what was already measured still counts as done')
  assert.strictEqual(first.total, 10, 'and the total is the library, not this pass')
})

test('progress climbs across the whole library as the pass proceeds', async () => {
  const { lifted, sent } = setup({
    total: 10, analysed: 6,
    steps: [{ done: 0, total: 4 }, { done: 2, total: 4 }, { done: 4, total: 4 }],
  })
  lifted.run()
  await new Promise(r => setImmediate(r))
  assert.deepStrictEqual(progress(sent).slice(0, 3).map(p => [p.done, p.total]),
    [[6, 10], [8, 10], [10, 10]])
})

test('the finished banner is the whole library too, not just this pass', async () => {
  const { lifted, sent } = setup({ total: 10, analysed: 6 })
  lifted.run()
  await new Promise(r => setImmediate(r))
  const last = progress(sent).at(-1)
  assert.deepStrictEqual(last, { done: 10, total: 10, finished: true, halted: false })
})

test('a fully-analysed library reports complete, not zero', async () => {
  const { lifted, sent, seen } = setup({ total: 10, analysed: 10, steps: [{ done: 0, total: 0 }] })
  lifted.run()
  await new Promise(r => setImmediate(r))
  assert.deepStrictEqual(progress(sent)[0], { done: 10, total: 10 })
  assert.strictEqual(seen.opts.tracks.length, 10, 'the runner is still handed the whole library')
})

test('a library with nothing analysed yet starts honestly at zero', async () => {
  const { lifted, sent } = setup({ total: 10, analysed: 0, steps: [{ done: 3, total: 10 }] })
  lifted.run()
  await new Promise(r => setImmediate(r))
  assert.deepStrictEqual(progress(sent)[0], { done: 3, total: 10 })
})

// A stale entry (the file was re-tagged, so its size and mtime moved) is not
// analysed — counting it as done would show a library as finished while the
// smart queues were still running on numbers from the old file.
test('a stale feature entry counts as outstanding, not as done', async () => {
  const { tracks, features } = library(10, 10)
  features.get(tracks[0].filePath).mtimeMs = 1
  features.get(tracks[1].filePath).featureVersion = 'old-version'
  const sent = []
  const lifted = liftAnalysisRun({
    allLibraryTracks: () => tracks,
    featureMap: () => features,
    runnerNeedsAnalysis: needsAnalysis,
    safeSend: (channel, payload) => sent.push({ channel, payload }),
    featureStore: { update: fn => fn({ features: {} }) },
    analyseOne: async () => ({ ok: true }),
    player: { isActuallyPlaying: () => false },
    app: { isQuitting: false },
    ANALYSIS_RESUME_DELAY_MS: 60000,
    runAnalysis: async opts => { opts.onProgress({ done: 0, total: 2 }); return { results: new Map(), analysed: 2, halted: false } },
  })
  lifted.run()
  await new Promise(r => setImmediate(r))
  assert.deepStrictEqual(progress(sent)[0], { done: 8, total: 10 })
})

test('a halted run says so instead of claiming it finished', async () => {
  const { lifted, sent } = setup({
    total: 10, analysed: 6,
    result: { results: new Map(), analysed: 2, halted: true },
  })
  lifted.run()
  await new Promise(r => setImmediate(r))
  const last = progress(sent).at(-1)
  assert.strictEqual(last.halted, true)
  assert.strictEqual(last.finished, false, 'a paused run has not finished')
  assert.strictEqual(last.done, 8, 'and reports the ground it did cover')
})

test('a second start while one is running is ignored', async () => {
  const { lifted, sent } = setup({ total: 10, analysed: 6, steps: [{ done: 0, total: 4 }] })
  lifted.run()
  assert.strictEqual(lifted.isRunning(), true)
  lifted.run()
  await new Promise(r => setImmediate(r))
  assert.strictEqual(progress(sent).filter(p => p.done === 6 && !('finished' in p)).length, 1,
    'the second call started nothing')
})

// The lift above injects the runner's own needsAnalysis. That is only the truth
// if main really imports it rather than keeping a second opinion.
test('main counts "already analysed" with the runner\'s own rule', () => {
  assert.match(MAIN, /needsAnalysis: runnerNeedsAnalysis \} = require\('\.\/analysis-runner'\)/)
})
