'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')

const CHANNELS = ['queue-build', 'queue-analysis-status', 'queue-analysis-start']

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
