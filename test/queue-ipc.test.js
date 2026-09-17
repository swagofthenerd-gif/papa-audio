'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')

const CHANNELS = ['queue-build', 'queue-analysis-status', 'queue-analysis-start', 'queue-mixes']

test('every queue channel has a handler in main', () => {
  for (const c of CHANNELS) {
    assert.ok(main.includes(`ipcMain.handle('${c}'`), `${c} has no handler`)
  }
})

test('every queue channel is exposed through preload', () => {
  for (const c of CHANNELS) {
    assert.ok(preload.includes(`'${c}'`), `${c} is not exposed in preload`)
  }
})

test('the feature store is a side store, never the shared config', () => {
  assert.ok(main.includes("name: 'audio-features'"), 'audio-features side store missing')
  assert.ok(!/store\.set\(\s*['"]audioFeatures/.test(main), 'features must not go into config.json')
})

test('analysis is gated on playback', () => {
  assert.ok(/isPlaying\s*:/.test(main), 'runAnalysis must be passed an isPlaying gate')
})

test('allLibraryTracks emits tracks the renderer can actually play', () => {
  // queue-build's output is assigned straight into state.queue, which renders
  // the now-playing bar and the queue panel. A track without title/artPath
  // shows as blank rather than failing loudly, so pin the shape here.
  for (const field of ['title', 'albumName', 'albumArtist', 'artPath', 'duration']) {
    assert.ok(
      new RegExp(`\\b${field}\\b`).test(main),
      `allLibraryTracks must carry ${field} through to queue-build`,
    )
  }
})

test('queue-build reports whether features were available for this build', () => {
  assert.ok(
    /featuresReady/.test(main),
    'queue-build must tell the renderer whether analysis has run, so a fresh install with no features can show an honest degraded-mode message instead of pretending'
  )
})

// Fix round 1: daily mixes must be named from real clusters, not five
// identical random draws labelled "Mix N". queue-mixes is the endpoint that
// makes that possible, and queue-build must accept an explicit mixIndex so a
// card can target the exact cluster it was named after.
test('queue-mixes returns an honest empty list without features', () => {
  const handler = main.slice(main.indexOf("ipcMain.handle('queue-mixes'"))
  const body = handler.slice(0, handler.indexOf("ipcMain.handle('queue-build'"))
  assert.ok(/featuresReady:\s*false,\s*mixes:\s*\[\]/.test(body), 'no-features case must report featuresReady:false and an empty mixes list')
  assert.ok(/clusterLibrary\(/.test(body), 'queue-mixes must actually cluster the library')
})

test('queue-build accepts an explicit mixIndex to target a specific mix', () => {
  const handler = main.slice(main.indexOf("ipcMain.handle('queue-build'"))
  assert.ok(/mixIndex/.test(handler.slice(0, 400)), 'queue-build must destructure mixIndex from its options')
  assert.ok(/Number\.isInteger\(mixIndex\)/.test(handler), 'an explicit mixIndex must be preferred over deriving one from the seed file')
})

test('a halted analysis run is reported as not finished, with halted flagged', () => {
  assert.ok(/finished:\s*!r\.halted/.test(main), 'finished must be derived from r.halted, not assumed true')
  assert.ok(/halted:\s*r\.halted/.test(main), 'the halted flag must be forwarded to the renderer')
})

test('a halted run schedules exactly one resume re-check, guarded against stacking and quit', () => {
  assert.ok(/analysisResumeTimer/.test(main), 'no resume-timer guard found')
  assert.ok(/!analysisResumeTimer/.test(main), 'must guard against a second pending re-check')
  assert.ok(/app\.isQuitting/.test(main.slice(main.indexOf('startAnalysisRun'))), 'resume must not fire once quitting')
})

// ── The quit-time flush, run rather than read ───────────────────────────────
// A whole-library analysis is hours of CPU. It is debounced in memory and only
// reaches disk when something flushes it, so a flush that quietly skips the
// feature store throws the whole run away on every quit. Asserting that the
// string `featureStore.flushSync()` appears somewhere in an 800-character
// window cannot see an early return placed above it, so the function is lifted
// and run.
function liftFlush(sideStores, featureStore) {
  const a = main.indexOf('function flushSideStores()')
  assert.ok(a > -1, 'flushSideStores must still exist in main.js')
  const b = main.indexOf('\n;(function migrateFolder()', a)
  assert.ok(b > a, 'and must still be followed by the folder migration')
  return new Function('sideStores', 'featureStore',
    main.slice(a, b) + '\nreturn flushSideStores')(sideStores, featureStore)
}

// A store that records being flushed; `boom` makes it throw like a corrupt one.
const recorder = (log, name, boom = false) => ({
  flushSync () { log.push(name); if (boom) throw new Error(name + ' is corrupt') },
})

test('quitting flushes every side store, the feature store included', () => {
  const log = []
  const sideStores = {
    playHistory: recorder(log, 'playHistory'),
    slskVerify: recorder(log, 'slskVerify'),
    slskOrganizeLog: recorder(log, 'slskOrganizeLog'),
  }
  liftFlush(sideStores, recorder(log, 'featureStore'))()
  assert.deepStrictEqual(log.sort(),
    ['featureStore', 'playHistory', 'slskOrganizeLog', 'slskVerify'],
    'hours of analysis and every side store must reach disk before the process goes')
})

test('one corrupt store does not take the rest of the flush down with it', () => {
  // Without the per-store try, the first thrower at quit silently discards
  // everything queued behind it — and quit is exactly when nothing is watching.
  const log = []
  const sideStores = {
    first: recorder(log, 'first', true),
    second: recorder(log, 'second'),
    third: recorder(log, 'third', true),
  }
  liftFlush(sideStores, recorder(log, 'featureStore'))()
  assert.ok(log.includes('second'), 'a store after the thrower still got written')
  assert.ok(log.includes('featureStore'), 'and so did the analysis results')
})

test('a feature store that throws is survivable too', () => {
  const log = []
  liftFlush({ a: recorder(log, 'a') }, recorder(log, 'featureStore', true))()
  assert.deepStrictEqual(log, ['a', 'featureStore'], 'quit must not become a crash')
})

test('the flush actually runs on the way out', () => {
  // The lift above proves the function is right; this proves it is called.
  assert.match(main, /flushSideStores\(\)/)
  const quit = main.slice(main.indexOf("app.on('will-quit'"))
  assert.match(quit.slice(0, 1500), /flushSideStores\(\)/, 'will-quit must flush')
})
