'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const VP = fs.readFileSync(path.join(__dirname, '..', 'src', 'video-player.js'), 'utf8')
const KM = require('../src/video-keymap')

// Press Play and the stage said "Starting…", then immediately "Downloading…" —
// while the debrid pick was still racing (up to 7s) and no source had been
// committed to at all. The first word a viewer saw after pressing Play was
// untrue, at the exact moment they are deciding whether the app works.
test('the first message after Play does not claim a download that has not started', () => {
  for (const m of R.matchAll(/_handleVideoEvent\(\{ kind: 'buffering'([^}]*)\}\)/g)) {
    assert.match(m[1], /phase:/,
      'a synthetic buffering event with no phase falls through to "Downloading"')
  }
})

test('there is a phase that means "still choosing a source", and it says so', () => {
  assert.match(R, /payload\.phase === 'finding'\s*\n\s*\? 'Finding the best copy'/,
    'the honest label for the moment before a source is picked')
})

// The keymap has resolved '?' since it was written, but the theatre's switch
// had no case for it and the renderer's global handler stands down while the
// theatre is open — so the help key was dead exactly where help is needed.
test('the help key works inside the theatre', () => {
  assert.strictEqual(KM.resolve({ key: '?' }).action, KM.ACTIONS.SHORTCUTS,
    'the keymap still resolves it')
  assert.match(VP, /case 'shortcuts':/, 'and the theatre now has a case for it')
  assert.match(VP, /papa-video-shortcuts/, 'raised as an event, since the list is the renderer\'s')
  assert.match(R, /addEventListener\('papa-video-shortcuts'/, 'which the renderer answers')
})

// Listing a shortcut that does nothing is worse than not listing it: it makes
// the viewer doubt the ones that do work.
test('no shortcut is advertised that the theatre cannot perform', () => {
  const start = R.indexOf('function _videoShortcutRows')
  const rows = R.slice(start, R.indexOf('\n}', start))
  const advertised = [...rows.matchAll(/\{ a: A\.([A-Z_]+),/g)].map(m => m[1])
  // Everything the theatre's key switch can actually do.
  const handled = new Set([...VP.matchAll(/case '([a-zA-Z]+)':/g)].map(m => m[1]))
  const deadOnes = []
  for (const name of advertised) {
    const action = KM.ACTIONS[name]
    if (!action) continue
    if (!handled.has(action)) deadOnes.push(name + ' (' + action + ')')
  }
  assert.deepStrictEqual(deadOnes, [],
    `these keys are advertised in the shortcut list but the theatre has no case for them: ${deadOnes.join(', ')}`)
})
