'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function fn(name) {
  const at = R.indexOf('function ' + name + '(')
  assert.ok(at > 0, name + ' exists')
  let depth = 0, i = R.indexOf('{', at)
  for (let j = i; j < R.length; j++) {
    if (R[j] === '{') depth++
    else if (R[j] === '}') { depth--; if (!depth) return R.slice(at, j + 1) }
  }
  return R.slice(at)
}

// "Start over" set the flag on the OUTGOING watch state and then called
// startPlay(); _videoPlayResult replaced the whole _watch object a moment
// later, so the flag was gone by the time _offerResume read it — and the
// button resumed from exactly where Resume would have.
test('Start over survives the watch-state rebuild', () => {
  const body = fn('_videoPlayResult')
  assert.match(body, /const startFromZero = !!\(_watch && _watch\.startFromZero\)/,
    'the flag is read off the outgoing state before the rebuild')
  assert.match(body, /startFromZero: startFromZero,/,
    'and carried onto the new one, or _offerResume can never see it')
  const readAt = body.indexOf('const startFromZero =')
  const writeAt = body.indexOf('startFromZero: startFromZero,')
  assert.ok(readAt > 0 && writeAt > readAt, 'read before rebuild, not after')
})

test('Start over is consumed exactly once, never left sticky', () => {
  const body = fn('_videoPlayResult')
  assert.match(body, /if \(_watch\) _watch\.startFromZero = false/,
    'cleared on the outgoing state, so a play that errors before _offerResume '
    + 'cannot carry it into the next play and swallow a real resume offer')
  assert.match(fn('_offerResume'), /_watch\.startFromZero = false/,
    'and cleared again when it is acted on')
})

// _renderVideoControls('tv') rebuilds an EMPTY #video-episode-list; filling it
// is _refreshTvEpisodes's job. Every other caller pairs the two; the spoiler
// toggle did not, so ticking "Hide spoilers" wiped the season off the page and
// it stayed gone until the season changed.
test('the spoiler toggle refills the episode list it just emptied', () => {
  const at = R.indexOf("_bindSpoilerToggle(function () {\n      _renderVideoControls('tv')")
  assert.ok(at > 0, 'the TV binding is the paired, multi-line form')
  assert.match(R.slice(at, at + 260), /_refreshTvEpisodes\(_videoDetailTicket, \+\+_videoSeasonTicket\)/)
})

test('every caller of the TV controls repaint refills the list', () => {
  let from = 0, seen = 0
  while (true) {
    const at = R.indexOf("_renderVideoControls('tv')", from)
    if (at < 0) break
    // Skip mentions inside comments — the fix's own explanation names the call.
    const lineStart = R.lastIndexOf('\n', at) + 1
    if (R.slice(lineStart, at).trimStart().startsWith('//')) { from = at + 20; continue }
    seen++
    assert.match(R.slice(at, at + 200), /_refreshTvEpisodes\(/,
      `the repaint at offset ${at} leaves the episode list empty and never refills it`)
    from = at + 20
  }
  assert.ok(seen >= 3, `found ${seen} call sites`)
})

test('the anime branch is left alone — it paints its own grid', () => {
  assert.ok(R.includes("_bindSpoilerToggle(function () { _renderVideoControls('anime') })"),
    'adding a partner call there would repaint the grid twice')
})
