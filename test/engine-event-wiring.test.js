'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8')

const ENGINE = read('mpv-engine.js')
const CROSSFADE = read('mpv-crossfade.js')
const MAIN = read('main.js')
const SHIM = read('src/player-shim.js')
const RENDERER = read('src/renderer.js')

const names = (src, re) => new Set([...src.matchAll(re)].map(m => m[1]))

const emitted = names(ENGINE, /this\.emit\('([^']+)'/g)
const forwarded = names(MAIN, /p\.on\('([^']+)'\s*,[^\n]*sendPlayerEvent/g)
const mainHandles = names(MAIN, /p\.on\('([^']+)'/g)
const shimCases = names(SHIM, /case '([^']+)':/g)
// Everything main sends to the renderer, however it got there — including
// events main originates itself rather than relaying from the engine.
const sent = names(MAIN, /sendPlayerEvent\('([^']+)'/g)

// An engine event that main never subscribes to is dead on arrival. Anything
// listed here is deliberately consumed before the renderer, and the reason is
// the thing being asserted — not the absence.
const STOPS_AT_MAIN = {
  ready: 'main awaits start() instead; nothing in the UI needs the event',
  volume: 'the renderer owns the volume slider and sends the value, so echoing it back fights the user',
  diagnostic: 'written to the daily log by main; it is evidence, not UI state',
}

// An event main sends that the shim deliberately does not translate.
const STOPS_AT_SHIM = {
  mpvMissing: 'the renderer subscribes to player-event directly for the blocker; there is no audio-element analogue',
  trackUnplayable: 'a queue decision (skip this file, say why) rather than a playback state change — the renderer takes it straight off player-event; an audio element has no analogue for "this file kills the engine"',
}

test('every engine event is either forwarded to the renderer or documented as stopping at main', () => {
  const dropped = [...emitted].filter(e => !mainHandles.has(e) && !(e in STOPS_AT_MAIN))
  assert.deepStrictEqual(dropped, [],
    'the engine emits these and main never listens, so they go nowhere')
})

test('everything documented as stopping at main really is handled there', () => {
  for (const [ev, why] of Object.entries(STOPS_AT_MAIN)) {
    if (ev === 'diagnostic') {
      assert.match(MAIN, /p\.on\('diagnostic'/, why)
      continue
    }
    assert.ok(!forwarded.has(ev), `${ev} is documented as stopping at main but is forwarded: ${why}`)
  }
})

// This is the bug from the stability pass, as a test: the engine emitted
// engineDown, main forwarded it, and player-shim.js had no case for it — so
// during a respawn the UI went on claiming it was playing.
test('every event main sends to the renderer is translated by the shim or documented', () => {
  const dropped = [...sent].filter(e => !shimCases.has(e) && !(e in STOPS_AT_SHIM))
  assert.deepStrictEqual(dropped, [],
    'main sends these to the renderer and the shim silently discards them')
})

// Every engine event that has to reach the user, and the DOM event it becomes.
const CHAIN = [
  ['engineDown', 'enginedown'],
  ['engineRecovered', 'enginerecovered'],
  ['stopped', 'enginestopped'],
  ['engineFailed', 'enginefailed'],
  ['stalled', 'enginestalled'],
  ['audioDeviceLost', 'audiodevicelost'],
  ['audioDeviceFallback', 'audiodevicefallback'],
]

test('every engine lifecycle event is wired end to end', () => {
  for (const [engineEvent, domEvent] of CHAIN) {
    assert.ok(emitted.has(engineEvent), `mpv-engine.js does not emit ${engineEvent}`)
    assert.ok(forwarded.has(engineEvent), `main.js does not forward ${engineEvent}`)
    assert.ok(shimCases.has(engineEvent), `player-shim.js has no case for ${engineEvent}`)
    assert.match(SHIM, new RegExp(`new CustomEvent\\('${domEvent}'`),
      `the shim must dispatch ${domEvent}`)
    assert.match(RENDERER, new RegExp(`addEventListener\\('${domEvent}'`),
      `nothing in the renderer listens for ${domEvent}, which is how this went unnoticed`)
  }
})

test('engineRestored reaches the renderer even though the engine never emits it', () => {
  // main originates this one after it re-initialises a failed engine by itself.
  assert.ok(sent.has('engineRestored'))
  assert.ok(shimCases.has('engineRestored'))
  assert.match(RENDERER, /addEventListener\('enginerestored'/)
})

test('the lifecycle payloads are forwarded, not dropped on the floor', () => {
  // sendPlayerEvent('engineDown') with no second argument is what made the UI
  // unable to tell a recoverable crash from a fatal one. The relay may have a
  // block body — engineFailed also tears the engine down — but the payload has
  // to be passed either way.
  for (const [ev] of CHAIN) {
    assert.match(MAIN, new RegExp(`sendPlayerEvent\\('${ev}',\\s*d\\)`),
      `${ev} must carry its payload through to the renderer`)
    assert.match(MAIN, new RegExp(`p\\.on\\('${ev}'\\s*,\\s*d\\s*=>`),
      `${ev}'s relay must take the payload as an argument`)
  }
})

test('the crossfade wrapper forwards the same lifecycle events', () => {
  // It exposes the engine's surface, so anything it fails to re-emit is missing
  // for every user who has crossfade mode on.
  for (const ev of ['stopped', 'engineDown', 'engineFailed', 'engineRecovered', 'diagnostic']) {
    assert.match(CROSSFADE, new RegExp(`engine\\.on\\('${ev}'`),
      `crossfade mode drops ${ev}`)
  }
  for (const m of ['getFlightRecorder', 'getLogTail']) {
    assert.match(CROSSFADE, new RegExp(`${m}\\(\\)\\s*\\{`),
      `crossfade mode must expose ${m} like the engine does`)
  }
})

test('the blocker no longer blames a missing mpv for every failure', () => {
  // Item 7: one message for both mpvMissing and engineFailed told users to
  // install mpv after an audio-device loss on a machine where mpv was fine.
  assert.doesNotMatch(RENDERER, /if \(type === 'mpvMissing' \|\| type === 'engineFailed'\) showBlocker\(true\)/,
    'the single shared blocker message is the bug')
  assert.match(RENDERER, /ENGINE_FAIL_TEXT/, 'the message must be written from the reason')
  assert.match(MAIN, /mpvAvailable,/, 'the renderer needs to tell "missing" from "would not start"')
})
