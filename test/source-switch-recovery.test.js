'use strict'
// "source switch needs a lot of work, its laggy and filled with bugs man"
// (2026-09-20). These are the recovery bugs behind that: the ways a switch
// could make things worse than not switching at all.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

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

test('a switch does not feed the stall counter that fires more switches', () => {
  // While a switch is in flight mpv is still on the OLD stream, whose server
  // has just been torn down, so it stalls every time. Those stalls reached the
  // renderer's counter, which auto-switches at two — a switch causing the
  // stalls that triggered another switch on top of it, until the per-episode
  // cap was spent and the episode could never be rescued again.
  const at = MAIN.indexOf("engine.on('stalled'")
  assert.ok(at > 0)
  const body = MAIN.slice(at, MAIN.indexOf("engine.on('unstalled'", at))
  assert.match(body, /if \(_videoSession\.switching\) return/,
    'guarded like the ended emitter next to it, and for the same reason')
  // And the guard it mirrors is still there.
  const ended = MAIN.slice(MAIN.indexOf("engine.on('ended'"), MAIN.indexOf("engine.on('ended'") + 900)
  assert.match(ended, /if \(_videoSession\.switching\)/)
})

test('a source he moved away from is really recorded as tried', () => {
  // The line was conditional on _watch.tried already existing, and no _watch
  // constructor creates it — so on a fresh play it did nothing at all. Pick B
  // by hand, B dies, and _nextUntriedSource handed back A: straight back to
  // the source he had just deliberately left.
  const body = fn('_playerPickSource')
  assert.match(body, /_watch\.tried = _watch\.tried \|\| \{\}/,
    'it must create the record, not require one')
  assert.match(body, /_watch\.tried\[_sourceKey\(next\)\] = true/)
  assert.doesNotMatch(body, /if \(_watch && _watch\.tried\) _watch\.tried/,
    'the conditional form is the bug')
})

test('a switch that failed does not cost the source its place in the list', () => {
  // `tried` is written before the outcome is known and _nextUntriedSource
  // skips a tried source for the rest of the episode, so a transient failure
  // (a debrid back-off, an expired budget) hid a good release for good.
  const manual = fn('_playerPickSource')
  assert.match(manual, /delete _watch\.tried\[_sourceKey\(next\)\]/)
  const auto = fn('_autoSwitchSource')
  assert.match(auto, /delete _watch\.tried\[_sourceKey\(next\)\]/)
})

test('a failed automatic switch says so instead of going silent', () => {
  // It had no else branch at all: "Source stalled — switching to another…"
  // then permanent silence over a frozen frame, with one of the two allowed
  // auto-switches already spent.
  const body = fn('_autoSwitchSource')
  assert.match(body, /\} else \{[\s\S]{0,700}showToast\(_videoErrorText\(/,
    'the viewer must be told the recovery failed')
  assert.match(body, /_watch\.autoSwitches = Math\.max\(0, \(_watch\.autoSwitches \|\| 1\) - 1\)/,
    'and a switch that never happened must not spend the episode budget')
})

test('a source that never played does not become the title\'s remembered choice', () => {
  const body = fn('_playerPickSource')
  assert.match(body, /_watch\.sourceCandidate = \{ source: next\.source/,
    'a candidate, promoted only once it has actually played')
  assert.doesNotMatch(body, /_rememberPreferredSource\(\{ source: next\.source/,
    'writing it here wrote it on "the switch started", not "it played"')
  // The promotion rule it now goes through still exists and still waits.
  assert.match(SRC, /_watch\.sourceCandidate && st\.position >= _SOURCE_PREF_AFTER_S/)
})

test('two hiccups half an hour apart are not a dying source', () => {
  // stallEvents counted for the life of the episode and was zeroed only by a
  // successful switch, so a stream that had played perfectly for 38 minutes
  // was thrown away — warmed swarm and pack strip with it.
  assert.match(SRC, /_watch\.lastStallAt = Date\.now\(\)/, 'a stall must be stamped')
  assert.match(SRC, /if \(_watch\.stallEvents && _watch\.lastStallAt && now - _watch\.lastStallAt > 120000\) \{\s*\n\s*_watch\.stallEvents = 0/,
    'and steady playback since the last one wipes the slate')
})
