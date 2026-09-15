'use strict'
// App #43 — per-title source overrides. The pure pick logic is exercised in
// video-binge.test.js; this pins the wiring in the renderer that promotes a
// manual pick to a stored preference and surfaces the clear chip.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')

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

test('the threshold is five minutes of real playback', () => {
  assert.match(SRC, /_SOURCE_PREF_AFTER_S = 300/)
})

test('a sources-panel pick is flagged manual with its row index', () => {
  // The play-click wiring moved into _renderVideoSourceRows so it can be
  // rebound whenever the sort chips re-render the rows; the index still points
  // into the ranked _videoStreams, so a manual pick is unchanged.
  const rows = fn('_renderVideoSourceRows')
  assert.match(rows, /_videoPlayResult\(_videoStreams\[idx\], \{ manual: true, index: idx \}\)/)
})

test('only a manual non-first pick becomes a candidate preference', () => {
  const play = fn('_videoPlayResult')
  // opts.manual AND a non-zero index AND the row actually names a source/quality.
  assert.match(play, /opts\.manual === true && Number\(opts\.index\) > 0 && \(result\.source \|\| result\.quality\)/)
  assert.match(play, /sourceCandidate:/)
})

test('the candidate is promoted only after the threshold, and fires once', () => {
  const tick = fn('_onVideoStateTick')
  assert.match(tick, /_watch\.sourceCandidate && st\.position >= _SOURCE_PREF_AFTER_S/)
  // Cleared before the write so it cannot fire twice.
  const clearAt = tick.indexOf('_watch.sourceCandidate = null')
  const callAt = tick.indexOf('_rememberPreferredSource(cand)')
  assert.ok(clearAt > -1 && callAt > -1 && clearAt < callAt, 'clear the candidate before remembering it')
})

test('remembering writes both source and quality to the show prefs', () => {
  const remember = fn('_rememberPreferredSource')
  assert.match(remember, /_showKeyOf\(\)/)
  assert.match(remember, /setPrefs\(key, \{ preferredSource: cand\.source \|\| null, preferredQuality: cand\.quality \|\| null, preferredGroup: cand\.group \|\| null \}\)/)
})

test('the clear chip removes the stored preference', () => {
  const clear = fn('_clearPreferredSource')
  assert.match(clear, /setPrefs\(key, \{ preferredSource: null, preferredQuality: null, preferredGroup: null \}\)/)
})

test('the preferred-source chip renders and binds its clear button', () => {
  const chip = fn('_renderPreferredSourceChip')
  assert.match(chip, /Preferred source:/)
  assert.match(chip, /video-pref-clear/)
  assert.match(chip, /addEventListener\('click', _clearPreferredSource\)/)
  // No preference → the chip is removed rather than shown empty.
  assert.match(chip, /if \(!pref \|\| \(!pref\.source && !pref\.group\)\)/)
})

test('the hero Play and the loading auto-play both honour the remembered source', () => {
  // Play now goes through _pickForPlay, which honours an explicitly chosen
  // quality first (2026-09-15) and otherwise delegates to the remembered
  // source pick — so the preference still decides whenever the viewer has not
  // asked for a particular quality.
  const bind = fn('_bindDetailActions')
  assert.match(bind, /_videoPlayResult\(_pickForPlay\(_videoStreams\)\)/)
  // The remembered source still decides when nothing outranks it. Two things
  // now do: a source debrid proved it can serve, and (failing that) one that
  // can actually stream at this connection's speed.
  const pick = fn('_pickForPlay')
  assert.match(pick, /const auto = _autoPickStream\(list\)/, 'the remembered source is still consulted')
  assert.match(pick, /if \(auto && _streamable\(auto, minutes\)\) return auto/, 'and wins when it can stream')
  const load = fn('_loadVideoSources')
  assert.match(load, /_videoPlayResult\(_autoPickStream\(streams\)\)/)
})

test('the chip has styling', () => {
  assert.match(CSS, /\.video-pref-source \{/)
  assert.match(CSS, /\.video-pref-clear/)
})
