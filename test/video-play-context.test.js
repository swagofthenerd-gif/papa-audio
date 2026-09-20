'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function bodyOf(name) {
  const at = R.indexOf('function ' + name + '(')
  assert.ok(at > 0, name + ' exists')
  let depth = 0
  const i = R.indexOf('{', at)
  for (let j = i; j < R.length; j++) {
    if (R[j] === '{') depth++
    else if (R[j] === '}') { depth--; if (!depth) return R.slice(at, j + 1) }
  }
  return R.slice(at)
}

// _videoDetail, _videoState and _videoStreams are PAGE-scoped: opening another
// title replaces all three, and the mini player deliberately keeps playing
// across that. Every deck control read them directly, so with a film minimised
// and another show's page open, Next advanced THAT show — marking its episode
// watched, writing its progress under the playing film's key — and an
// unattended stall could swap the running film for one of the browsed title's
// sources mid-scene.
const CONTROLS = ['_playPrevEpisode', '_playNextEpisode', '_playerPickSource', '_autoSwitchSource', '_playerSourceList', '_nextUntriedSource']

// The globals are permitted in exactly one place: the fallback that keeps these
// functions runnable inside the single-function vm harnesses the video tests
// use, where _playCtx is not in scope. In the real app _playCtx always is, so
// the fallback never runs. Anywhere else, reading them means reading the page
// the viewer happens to be browsing.
const HARNESS_FALLBACK = /\(typeof _playCtx === 'function' \? _playCtx\(\) : \{ detail: _videoDetail, state: _videoState, streams: Array\.isArray\(_videoStreams\) \? _videoStreams : \[\] \}\)/g

// Comment lines are stripped before the check, the way video-ipc does it for
// the same reason: the rule is about what the CODE reads, and a comment that
// names the hazard in order to explain it is not a violation. Without this the
// guard punishes documenting the very bug it exists to prevent — which it did,
// the moment the switch was fixed to stop reading _videoState for the episode.
function codeOf(name) {
  return bodyOf(name)
    .split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
}

test('no deck control reads the page-scoped globals as its source of truth', () => {
  for (const name of CONTROLS) {
    const body = codeOf(name).replace(HARNESS_FALLBACK, '«ctx»')
    for (const global of ['_videoDetail', '_videoState', '_videoStreams']) {
      assert.ok(!new RegExp('\\b' + global + '\\b').test(body),
        `${name} still reads ${global} outside the harness fallback — that is the page being browsed, not the film playing`)
    }
  }
})

test('the harness fallback prefers the real context and is never the primary path', () => {
  for (const name of CONTROLS) {
    const body = bodyOf(name)
    const uses = body.match(HARNESS_FALLBACK) || []
    assert.ok(uses.length >= 1, `${name} resolves a context`)
    for (const u of uses) {
      assert.ok(u.startsWith("(typeof _playCtx === 'function' ? _playCtx()"),
        `${name}: _playCtx must be tried first, the globals only as the harness fallback`)
    }
  }
})

test('each of them reads the pinned play context instead', () => {
  for (const name of CONTROLS) {
    assert.match(bodyOf(name), /_playCtx\(\)/, `${name} must read the play context`)
  }
})

test('the context is pinned on the watch state at play time', () => {
  const body = bodyOf('_videoPlayResult')
  assert.match(body, /const pctx = opts\.ctx \|\| \{ detail: _videoDetail, state: _videoState, streams: _videoStreams \}/,
    'a fresh Play takes the page; a continuation passes the pinned one back in')
  assert.match(body, /ctx: pctx,/, 'and it rides on _watch')
})

test('an advance hands the pin forward, so the next play stays with the same title', () => {
  for (const name of ['_playNextEpisode', '_playPrevEpisode']) {
    const body = bodyOf(name)
    const call = body.slice(body.indexOf('_videoPlayResult('))
    assert.match(call.slice(0, 200), /ctx: pctx/,
      `${name} must pass the context on, or the rebuilt watch state takes the browsed page`)
  }
})

test('the page behind the theatre is only repainted when it is the one playing', () => {
  for (const name of ['_playNextEpisode', '_playPrevEpisode']) {
    const body = bodyOf(name)
    assert.match(body, /if \(!_playCtxOnScreen\(\)\) return/,
      `${name} would otherwise overwrite the page the viewer is browsing`)
    const guardAt = body.indexOf('_playCtxOnScreen()')
    const repaintAt = body.indexOf('_renderVideoControls(')
    if (repaintAt > 0) {
      assert.ok(guardAt > 0 && guardAt < repaintAt, `${name}: the guard must come before the repaint`)
    }
  }
})

test('the accessor falls back to the page when nothing is playing', () => {
  const body = bodyOf('_playCtx')
  assert.match(body, /\(c && c\.detail\) \|\| _videoDetail/, 'a fresh Play from a page still works')
  assert.match(body, /_watch && _watch\.ctx/)
})

test('capturing references is deliberate, and opening a page replaces rather than mutates', () => {
  // The pin holds the objects themselves, and that is only correct because
  // opening a detail page REBINDS these variables to fresh objects. If that
  // ever became an in-place mutation, the pin would silently start tracking
  // the browsed page again and this whole fix would quietly undo itself.
  assert.match(R, /_videoDetail = \{ type, id, d: null \}/, 'a page open assigns a new object')
  assert.match(R, /_videoDetail = \{ type, id, d: res\.detail \}/)
  assert.ok(!/_videoDetail\.(type|d)\s*=[^=]/.test(R),
    'nothing may mutate the detail object in place, or the pin stops meaning anything')
})
