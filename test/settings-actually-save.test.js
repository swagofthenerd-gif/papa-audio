'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function whitelist() {
  const start = MAIN.indexOf('const VIDEO_SETTING_KEYS = new Set([')
  assert.ok(start > 0, 'the whitelist still exists')
  const end = MAIN.indexOf('])', start)
  assert.ok(end > start)
  return MAIN.slice(start, end)
}

// A key the renderer writes but the whitelist does not carry is silently
// dropped: the control moves, says nothing, and reverts on the next restart.
// This is the third time this list has lost a setting, so assert the property
// rather than one key — every key any settings control saves must be on it.
test('every video setting the UI saves is on the whitelist main enforces', () => {
  const list = whitelist()
  const saved = new Set()
  const re = /save\(\{\s*([A-Za-z0-9_]+)\s*:/g
  let m
  while ((m = re.exec(R))) saved.add(m[1])
  // Only consider keys the video settings panel owns.
  const videoKeys = [...saved].filter(k => /^(playerMode|preferSurround|preferredQuality|videoUpscale|downloadLimitMbps|seedWhileWatching|tmdbApiKey|openSubtitlesApiKey|debridProvider|debridToken|videoKeepQuotaGB|videoCacheGB|jackettUrl|jackettApiKey|sourceMirrors|torrentSources)$/.test(k))
  assert.ok(videoKeys.length >= 8, 'found the video settings the UI writes')
  const missing = videoKeys.filter(k => !list.includes(`'${k}'`))
  assert.deepStrictEqual(missing, [],
    `these settings are written by the UI but dropped by main: ${missing.join(', ')}`)
})

test('playerMode specifically is whitelisted, so the Smooth/Purist choice sticks', () => {
  assert.match(whitelist(), /'playerMode'/)
  // And the line that records a deliberate choice can now actually run.
  assert.match(MAIN, /if \(clean\.playerMode\) clean\.playerModeByUser = true/)
})

// Space toggled playback while a <select> had focus, and preventDefault stopped
// the dropdown opening at all — so a keyboard user could not use any settings
// dropdown. f/q/s/r/x fired their shortcuts there too.
test('keyboard shortcuts do not fire while a dropdown or field has focus', () => {
  assert.match(R, /const inInput = inInputNow\(e\)/,
    'the main keydown handler must use the helper that counts SELECT')
  assert.doesNotMatch(R, /const inInput = e\.target\.tagName === 'INPUT' \|\| e\.target\.tagName === 'TEXTAREA'/,
    'the narrow guard that missed SELECT must not come back')
})

test('the shared typing guard really does cover dropdowns', () => {
  const fn = R.slice(R.indexOf('function inInputNow'))
  const body = fn.slice(0, fn.indexOf('\n}') + 2)
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.ok(body.includes(`'${tag}'`), `${tag} counts as typing`)
  }
  assert.match(body, /isContentEditable/)
})
