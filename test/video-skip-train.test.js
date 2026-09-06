'use strict'
// App #46 — skip-intro training wiring in the renderer. The detection maths is
// tested for real in skip-model.test.js; this pins the glue that feeds seeks in
// and writes the learned segment out.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function fn(name) {
  const start = SRC.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found')
  let depth = 0
  for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++
    else if (SRC[j] === '}') { depth--; if (!depth) return SRC.slice(start, j + 1) }
  }
  throw new Error('unbalanced ' + name)
}

test('a forward jump during playback is fed to the trainer, but not for films', () => {
  const tick = fn('_onVideoStateTick')
  assert.match(tick, /_videoDetail\.type !== 'movie'/)
  // The jump is measured from the previous position to the new one, before
  // lastPos advances.
  assert.match(tick, /_noteSeekForTraining\(_watch\.lastPos, st\.position\)/)
  const noteAt = tick.indexOf('_noteSeekForTraining(')
  const setAt = tick.indexOf('_watch.lastPos = st.position')
  assert.ok(noteAt > -1 && setAt > -1 && noteAt < setAt, 'measure the jump before lastPos moves')
})

test('the trainer records qualifying seeks and offers only when the model says so', () => {
  const note = fn('_noteSeekForTraining')
  assert.match(note, /isIntroSkipSeek\(from, to\)/)
  assert.match(note, /recordIntroSeek\(prefs\.introTraining, from, to\)/)
  assert.match(note, /setPrefs\(key, \{ introTraining: rec \}\)/)
  assert.match(note, /shouldOfferSkipTraining\(rec\)/)
  // Never offered twice in a session, and never if a manual skip already exists.
  assert.match(note, /_skipTrainOffered\[key\]/)
  assert.match(note, /s\.origin === model\.MANUAL/)
})

test('accepting the offer writes an averaged manual intro segment', () => {
  const offer = fn('_offerSkipTraining')
  assert.match(offer, /showActionToast\('Skip this intro automatically next time\?', 'Skip it'/)
  assert.match(offer, /skipSegmentFromTraining\(rec\)/)
  // Keeps the season's other segments, replacing only a prior learned intro.
  assert.match(offer, /!\(s && s\.kind === 'intro' && s\.origin === model\.MANUAL\)/)
  assert.match(offer, /setSkip\(key, kept\.concat\(\[seg\]\)\)/)
  // Reloads the segments if the trained season is the one on screen.
  assert.match(offer, /if \(_seasonKeyOf\(\) === key\) _loadSkipSegments\(\)/)
})

test('the season key matches what _loadSkipSegments builds', () => {
  const key = fn('_seasonKeyOf')
  assert.match(key, /'tv:' \+ d\.id \+ ':s' \+ _videoState\.season/)
  const load = fn('_loadSkipSegments')
  assert.match(load, /'tv:' \+ d\.id \+ ':s' \+ _videoState\.season/)
})
