'use strict'
// Which episodes you have seen, and where to pick up.
//
// The store has recorded a position for every episode since the engine work
// landed, and nothing ever showed it: opening a season looked identical whether
// you had watched none of it or all but one. These are the two answers read out
// of that record — a mark per episode, and one sentence about where you were.
//
// _epProgress lives in renderer.js, a browser script with no exports, so its
// source is lifted out and evaluated against a fake store. Binding to the real
// text rather than a copy is deliberate: a duplicate keeps passing after the
// original changes, which is exactly how the cast-photo bug survived its test.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function lift(names) {
  let code = ''
  for (const n of names) {
    const start = src.indexOf('function ' + n + '(')
    assert.ok(start > -1, n + ' must still exist in renderer.js')
    const end = src.indexOf('\nfunction ', start + 1)
    code += src.slice(start, end === -1 ? undefined : end) + '\n'
  }
  return code
}

// The real _watchKey, so a key written by the player is the key read back here.
const SETUP = lift(['_watchKey', '_epProgress', '_epMark', '_vDurText'])

function build(items) {
  const store = { get: k => items[k] || null }
  const fn = new Function('store', `
    var _EP_STARTED = 0.02
    function _vStore() { return store }
    ${SETUP}
    return { _epProgress: _epProgress, _epMark: _epMark, _vDurText: _vDurText, _watchKey: _watchKey }
  `)
  return fn(store)
}

const done = { watched: true, position: 1400, duration: 1440 }
const half = { watched: false, position: 700, duration: 1440 }
const barely = { watched: false, position: 8, duration: 1440 }   // 0.6%

// ── Where to pick up ────────────────────────────────────────────────────────

test('an untouched season suggests nothing at all', () => {
  const { _epProgress } = build({})
  const p = _epProgress('tv', 1396, 2, [1, 2, 3])
  assert.strictEqual(p.resume, null)
  assert.strictEqual(p.next, null, 'better silence than an empty promise')
  assert.strictEqual(p.watched, 0)
})

test('an episode left part way through is the one to resume', () => {
  const { _epProgress } = build({ 'tv:1396:s2e1': done, 'tv:1396:s2e2': half })
  const p = _epProgress('tv', 1396, 2, [1, 2, 3])
  assert.deepStrictEqual(p.resume, { episode: 2, position: 700, duration: 1440 })
  assert.strictEqual(p.next, null, 'resuming beats starting something new')
})

test('with the last one finished, the next one is offered', () => {
  const { _epProgress } = build({ 'tv:1396:s2e1': done, 'tv:1396:s2e2': done })
  const p = _epProgress('tv', 1396, 2, [1, 2, 3, 4])
  assert.strictEqual(p.resume, null)
  assert.deepStrictEqual(p.next, { episode: 3 })
  assert.strictEqual(p.watched, 2)
})

test('a finished season offers nothing more to watch', () => {
  const { _epProgress } = build({ 'tv:1396:s2e1': done, 'tv:1396:s2e2': done })
  const p = _epProgress('tv', 1396, 2, [1, 2])
  assert.strictEqual(p.next, null)
  assert.strictEqual(p.watched, 2)
})

// Ten seconds in is a mis-click or a moment of buffering. Offering to resume
// from there is worse than offering nothing.
test('a few seconds does not count as having started', () => {
  const { _epProgress } = build({ 'tv:1396:s2e1': barely })
  const p = _epProgress('tv', 1396, 2, [1, 2])
  assert.strictEqual(p.resume, null)
})

// Rewatching episode two of a season you are eight into must not move your
// place backwards — so it is the furthest one started, not the most recent.
test('a rewatch of an early episode does not drag your place back', () => {
  const { _epProgress } = build({
    'tv:1396:s2e2': { watched: false, position: 300, duration: 1440, updatedAt: 9999 },
    'tv:1396:s2e8': { watched: false, position: 900, duration: 1440, updatedAt: 1 },
  })
  const p = _epProgress('tv', 1396, 2, [1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.strictEqual(p.resume.episode, 8)
})

// A gap in the middle is the thing to fill, not the end of the run.
test('the first unwatched episode after the furthest watched is next', () => {
  const { _epProgress } = build({
    'tv:1396:s2e1': done, 'tv:1396:s2e2': done, 'tv:1396:s2e4': done,
  })
  const p = _epProgress('tv', 1396, 2, [1, 2, 3, 4, 5])
  assert.deepStrictEqual(p.next, { episode: 5 }, 'after the furthest, not the first hole')
})

// ── Anime keys ──────────────────────────────────────────────────────────────
// Anime has no season in its key. Passing one anyway must not produce a key
// that never matches what the player wrote.
test('anime progress is found under the key the player writes', () => {
  const { _epProgress, _watchKey } = build({ 'anime:120120:e5': half })
  assert.strictEqual(_watchKey('anime', 120120, null, 5), 'anime:120120:e5')
  const p = _epProgress('anime', 120120, null, [1, 2, 3, 4, 5, 6])
  assert.strictEqual(p.resume.episode, 5)
})

// ── Marks ───────────────────────────────────────────────────────────────────

test('each episode is marked as seen, started, or neither', () => {
  const { _epMark } = build({})
  assert.strictEqual(_epMark({ watched: true }).cls, ' seen')
  const started = _epMark({ watched: false, ratio: 0.5, position: 700, duration: 1440 })
  assert.strictEqual(started.cls, ' partial')
  assert.strictEqual(started.pct, 50, 'the bar is the fraction watched')
  assert.match(started.title, /left/)
  assert.strictEqual(_epMark({ watched: false, ratio: 0 }).cls, '')
  assert.strictEqual(_epMark(null).cls, '', 'an episode with no record is unmarked')
})

test('time remaining reads as a person would say it', () => {
  const { _vDurText } = build({})
  assert.strictEqual(_vDurText(1440), '24m')
  assert.strictEqual(_vDurText(3900), '1h 05m')
  assert.strictEqual(_vDurText(0), '0m')
  assert.strictEqual(_vDurText(-10), '0m', 'a negative remainder is none left')
})

// ── Degrading ───────────────────────────────────────────────────────────────
// Every other reader of the store degrades to "nothing saved" rather than
// throwing, and this must too or a corrupt entry takes the whole season list
// down with it.
test('a store that is absent or throwing costs the marks, not the page', () => {
  const noStore = new Function(`
    var _EP_STARTED = 0.02
    function _vStore() { return null }
    ${SETUP}
    return _epProgress
  `)()
  assert.deepStrictEqual(noStore('tv', 1, 1, [1, 2]).items, {})

  const angry = new Function(`
    var _EP_STARTED = 0.02
    function _vStore() { return { get: function () { throw new Error('corrupt') } } }
    ${SETUP}
    return _epProgress
  `)()
  assert.strictEqual(angry('tv', 1, 1, [1, 2]).resume, null)
})

test('no episodes is not a crash', () => {
  const { _epProgress } = build({})
  assert.strictEqual(_epProgress('tv', 1, 1, []).resume, null)
  assert.strictEqual(_epProgress('tv', 1, 1, null).resume, null)
})
