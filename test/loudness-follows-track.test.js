'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

function handlerBody(channel) {
  const start = MAIN.indexOf(`ipcMain.handle('${channel}'`)
  assert.ok(start > 0, `${channel} handler exists`)
  const end = MAIN.indexOf('\nipcMain.handle(', start + 10)
  return MAIN.slice(start, end > 0 ? end : start + 2000)
}

// A gapless advance and a crossfade change the playing file without going
// through player-load, so the gain stayed on the track BEFORE the one playing
// for the rest of the album — defeating loudness matching in the one mode where
// it matters most. It also left _loudnessCurrentPath stale, so nudging the
// volume slider mid-album re-applied the previous track's correction.
test('the loudness gain follows a track change mpv made on its own', () => {
  const build = MAIN.slice(MAIN.indexOf('function buildPlayer('))
  const body = build.slice(0, build.indexOf("\n  p.on('ended'"))
  const auto = body.slice(body.indexOf("p.on('autoAdvanced'"))
  assert.match(auto.slice(0, 200), /applyLoudnessGain\(d\)/,
    'a gapless advance must re-apply the gain for the track that is now playing')
  const changed = body.slice(body.indexOf("p.on('trackChanged'"))
  assert.match(changed.slice(0, 300), /applyLoudnessGain\(d\)/,
    'so must any other change of file mpv reports')
})

// mpv keeps its volume across a loadfile, so applying the gain after the load
// meant the opening moment of every track played at the previous track's level
// and then snapped — loudest exactly where two tracks differ most.
test('the gain is set before the file is loaded, not after', () => {
  for (const channel of ['player-load', 'player-switch']) {
    const body = handlerBody(channel)
    const gainAt = body.indexOf('applyLoudnessGain')
    const loadAt = body.indexOf('player.load(')
    assert.ok(gainAt > 0, `${channel} applies the gain`)
    assert.ok(loadAt > 0, `${channel} loads the file`)
    assert.ok(gainAt < loadAt,
      `${channel}: the gain must be set before the loadfile, or the first moment of the track is audible at the wrong level`)
  }
})

test('the gain is awaited, so the volume is in force before audio starts', () => {
  for (const channel of ['player-load', 'player-switch']) {
    assert.match(handlerBody(channel), /await applyLoudnessGain\(/,
      `${channel} must await it — fire-and-forget gives no ordering guarantee at all`)
  }
})
