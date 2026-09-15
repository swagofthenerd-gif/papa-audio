'use strict'
// Wiring checks for the Wave-6 music features, in the same source-assertion
// style as queue-ui.test.js: prove the renderer emits what the CSS styles and
// that the new surfaces are reachable, without standing up a DOM.
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const p = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const renderer = p('src/renderer.js')
const html = p('src/index.html')
const css = p('src/styles.css')

test('music-tools is loaded in the renderer before renderer.js', () => {
  assert.ok(html.includes('music-tools.js'), 'music-tools.js is not loaded in index.html')
  const mtAt = html.indexOf('music-tools.js')
  const rAt = html.indexOf('renderer.js')
  assert.ok(mtAt < rAt, 'music-tools.js must load before renderer.js so the global exists')
})

test('every new class the renderer emits has a CSS rule', () => {
  for (const c of ['queue-clear-row', 'queue-clear-played-btn', 'stats-month-chart',
    'stats-month-bar', 'stats-dupes', 'dupe-group', 'dupe-file', 'sleep-label']) {
    assert.ok(renderer.includes(c), `${c} is not emitted by the renderer`)
    assert.ok(new RegExp(`\\.${c}\\s*[{,]`).test(css), `.${c} has no CSS rule`)
  }
})

test('the sleep timer offers 90 minutes and end-of-track', () => {
  assert.ok(/data-mins="90"/.test(html), 'no 90-minute preset in the sleep panel')
  assert.ok(/data-mins="0"[^>]*>\s*End of track/.test(html), 'no end-of-track option')
  // Cancel must not collide with the end-of-track (mins 0) entry.
  assert.ok(/sleep-cancel[^>]*data-mins="-1"/.test(html), 'cancel must use a distinct data-mins')
})

test('the sleep timer fades and restores volume rather than hard-cutting', () => {
  assert.ok(renderer.includes('_sleepFadeAndPause'), 'no fade path on the sleep timer')
  assert.ok(renderer.includes('sleepFadeSteps'), 'the fade does not use the tested pure curve')
  assert.ok(/audio\.volume\s*=\s*startVol/.test(renderer), 'the volume is never restored after pausing')
})

test('end-of-track sleep is honoured at the track boundary', () => {
  assert.ok(renderer.includes('_sleepAtTrackEnd'), 'no end-of-track hook')
  assert.ok(/_sleepAtTrackEnd\(\)\)\s*return/.test(renderer), 'playNext does not consult the end-of-track hook')
})

test('the queue panel wires a clear-played action to the tested helper', () => {
  assert.ok(renderer.includes('clearPlayedQueue'), 'clear-played does not call the tested helper')
  assert.ok(renderer.includes("'Clear played'"), 'no Clear played button label')
})

// Roadmap 004: clearing upcoming and stopping are separate, explicit actions.
test('the queue panel separates Clear upcoming from Stop and clear', () => {
  assert.ok(renderer.includes('clearUpcomingQueue'), 'clear-upcoming does not call the tested helper')
  assert.ok(renderer.includes("'Clear upcoming'"), 'no Clear upcoming button label')
  assert.ok(renderer.includes("'Stop and clear'"), 'no Stop and clear button label')
  assert.ok(!renderer.includes("'Clear queue'"), 'the ambiguous Clear queue label is gone')
  // The upcoming path never touches playback: no pause between its helper call and its undo.
  const start = renderer.indexOf("clearUpcomingBtn.addEventListener('click'")
  const end = renderer.indexOf('const clearBtn = document.createElement', start)
  const body = renderer.slice(start, end)
  assert.ok(start > 0 && end > start)
  assert.ok(!/audio\.pause\(|isPlaying = false|updateNowPlaying\(null\)/.test(body), 'Clear upcoming stops nothing')
  assert.ok(renderer.includes("cmd === 'clear-upcoming'"), 'the extension can ask for the safe clear too')
})

test('the stats page registers under navigate and gains the new sections', () => {
  assert.ok(/page === 'stats'\s*\)\s*renderStats\(\)/.test(renderer), 'stats page is not registered in navigate')
  assert.ok(renderer.includes('topAlbumsByPlays'), 'stats page does not compute top albums')
  assert.ok(renderer.includes('playsPerMonth'), 'stats page does not compute plays-per-month')
  assert.ok(renderer.includes('>Top Albums'), 'no Top Albums heading rendered')
  assert.ok(renderer.includes('>Plays per Month'), 'no Plays per Month heading rendered')
})

test('the duplicate finder is reachable from the stats page', () => {
  assert.ok(renderer.includes('find-dupes-btn'), 'no Find duplicates button')
  assert.ok(renderer.includes('renderDupeFinder'), 'no duplicate finder render function')
  assert.ok(renderer.includes('findDuplicateTracks'), 'the finder does not use the tested helper')
})
