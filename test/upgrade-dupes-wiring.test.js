'use strict'
// The removal panel must never arrive with anything already ticked.
//
// This list proposes deleting his music. A false positive costs him a
// recording he may not be able to find again, so the default state has to be
// "nothing happens". The existing redundant-lossy panel next to it ships every
// box `checked`; this one deliberately does not, and that difference is the
// thing most likely to be "tidied up" by someone later. Hence a test.
//
// _mgUpgradeDupesHtml lives in renderer.js, a browser script with no exports,
// so the real function is lifted and run against the real upgrade-dupes module.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const U = require('../src/upgrade-dupes.js')

function lift(name) {
  const start = src.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' must still exist in renderer.js')
  const end = src.indexOf('\nfunction ', start + 1)
  const alt = src.indexOf('\nasync function ', start + 1)
  const stop = [end, alt].filter(n => n > -1).sort((a, b) => a - b)[0]
  return src.slice(start, stop === undefined ? undefined : stop)
}

function build(library) {
  const state = { library }
  const _mgState = {}
  const fn = new Function('state', '_mgState', 'window', 'console', `
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])) }
    function _mgFmt(n) { return String(n) + ' B' }
    ${lift('_mgUpgradeDupesHtml')}
    return _mgUpgradeDupesHtml()
  `)
  return { html: fn(state, _mgState, { PapaUpgradeDupes: U }, { error() {} }), _mgState }
}

// One track he owns twice: a 320 kbps MP3 and a 24/96 FLAC. Unambiguous.
const clearUpgrade = [{
  name: 'Kid A', artist: 'Radiohead', tracks: [
    { filePath: '/m/old/01.mp3', title: 'Idioteque', codec: 'mp3', bitrate: 320000, duration: 251, size: 10e6 },
    { filePath: '/m/new/01.flac', title: 'Idioteque', codec: 'flac', bitDepth: 24, sampleRate: 96000, duration: 251, size: 90e6 },
  ],
}]

test('a real upgrade is offered', () => {
  const { html, _mgState } = build(clearUpgrade)
  assert.ok(_mgState.upgrades.plan.length > 0, 'the fixture must actually produce a plan')
  assert.match(html, /Upgrades of things you already have/)
  assert.match(html, /mg-upg-check/, 'with a checkbox to tick')
})

test('and NOTHING in it is ticked', () => {
  const { html } = build(clearUpgrade)
  const boxes = html.match(/<input[^>]*class="mg-upg-check"[^>]*>/g) || []
  assert.ok(boxes.length > 0, 'there must be boxes to check')
  for (const b of boxes) {
    assert.doesNotMatch(b, /\bchecked\b/,
      'a panel that proposes deleting his music must not preselect anything')
  }
})

test('the panel says so in words, not just in markup', () => {
  const { html } = build(clearUpgrade)
  assert.match(html, /Nothing is selected/i)
  assert.match(html, /Trash, not deleted/i, 'and that removal is recoverable')
})

test('the unsure list is hidden, and cannot be selected at all', () => {
  // Same title and duration, two lossless copies at identical depth and rate:
  // file size must never decide between them.
  const { html, _mgState } = build([{
    name: 'Amnesiac', artist: 'Radiohead', tracks: [
      { filePath: '/m/x/02.flac', title: 'Pyramid Song', codec: 'flac', bitDepth: 16, sampleRate: 44100, duration: 289, size: 30e6 },
      { filePath: '/m/y/02.flac', title: 'Pyramid Song', codec: 'flac', bitDepth: 16, sampleRate: 44100, duration: 289, size: 31e6 },
    ],
  }])
  assert.strictEqual(_mgState.upgrades.plan.length, 0, 'equal quality is not an upgrade')
  assert.ok(_mgState.upgrades.ambiguous.length > 0, 'but it is worth showing')
  assert.match(html, /id="mg-upg-unsure" hidden/, 'collapsed by default')
  const unsure = html.slice(html.indexOf('id="mg-upg-unsure"'))
  assert.doesNotMatch(unsure, /mg-upg-check/,
    'an unsure row must carry no checkbox at all, not merely an unticked one')
})

test('a library with no duplicates renders nothing', () => {
  const { html } = build([{
    name: 'In Rainbows', artist: 'Radiohead',
    tracks: [{ filePath: '/m/z/01.flac', title: 'Nude', codec: 'flac', bitDepth: 16, sampleRate: 44100, duration: 255, size: 30e6 }],
  }])
  assert.strictEqual(html, '', 'no section at all rather than an empty one')
})

test('a broken analysis is silent rather than wrong', () => {
  // If the module is missing the panel must disappear, never render an
  // empty-but-actionable list.
  const state = { library: clearUpgrade }
  const fn = new Function('state', '_mgState', 'window', 'console', `
    function esc(s) { return String(s) }
    function _mgFmt(n) { return String(n) }
    ${lift('_mgUpgradeDupesHtml')}
    return _mgUpgradeDupesHtml()
  `)
  assert.strictEqual(fn(state, {}, {}, { error() {} }), '')
})
