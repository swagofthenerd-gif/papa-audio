'use strict'
// The hero spotlight's Play button opened the detail page and stopped there.
//
// This is the same defect the shelf cards' Play button was fixed for
// (test/card-play.test.js: "a Play button that only opens a page is a lie").
// The card handler arms `_playOnArrival`, which renderVideoDetail takes and
// turns into an auto-play as soon as the source list lands. The hero — the
// biggest control on the Movies & TV tab, and the first thing anyone presses —
// bound Play and Details to the SAME `go()` function, so pressing Play on the
// featured film did exactly what pressing Details did: it navigated, and
// nothing ever played.
//
// This test runs the REAL _paintVideoHero against a small DOM double, clicks
// the real listener it installed, and reads the real arm that renderVideoDetail
// consumes. Nothing here reads source text.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function extractFn (source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found')
  let i = source.indexOf('(', start)
  let paren = 0
  for (; i < source.length; i++) {
    if (source[i] === '(') paren++
    else if (source[i] === ')') { paren--; if (!paren) { i++; break } }
  }
  let depth = 0
  for (let j = source.indexOf('{', i); j < source.length; j++) {
    if (source[j] === '{') depth++
    else if (source[j] === '}') {
      depth--
      if (!depth) {
        const body = source.slice(start, j + 1)
        return (source.slice(Math.max(0, start - 6), start) === 'async ' ? 'async ' : '') + body
      }
    }
  }
  throw new Error('unbalanced braces in ' + name)
}

// The smallest DOM that _paintVideoHero actually touches: a mount whose
// innerHTML assignment creates the three buttons by id, and elements that
// remember the listeners bound to them so a click can be delivered for real.
function el (id) {
  return {
    id,
    dataset: {},
    classList: { add () {}, remove () {}, toggle () {}, contains: () => false },
    _listeners: {},
    addEventListener (type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn) },
    click () { for (const fn of this._listeners.click || []) fn({}) },
    getAttribute: () => null,
    remove () {},
    querySelector: () => null,
    querySelectorAll: () => [],
  }
}

function harness (source) {
  const byId = {}
  const mount = {
    id: 'vhero-mount',
    dataset: {},
    _html: '',
    classList: { add () {}, remove () {}, toggle () {}, contains: () => false },
    addEventListener () {},
    get innerHTML () { return this._html },
    set innerHTML (v) {
      this._html = v
      // Whatever ids that markup declared now exist, exactly as a browser
      // would make them reachable from document.getElementById.
      for (const m of String(v).matchAll(/id="([a-z0-9-]+)"/g)) byId[m[1]] = el(m[1])
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  byId['vhero-mount'] = mount

  const sandbox = {
    document: { getElementById: id => byId[id] || null, createElement: () => el('ghost') },
    window: {},
    navigated: [],
    toggled: [],
    _playOnArrival: null,
    // No watch store in this harness: the hero's My List face falls back to
    // "not saved", which is what an unloaded store has to mean.
    _vStore: () => null,
    _videoHero: { items: [], index: 0, timer: null, paused: false },
    _VICON: { play: '<svg/>', plus: '<svg/>', info: '<svg/>' },
    navigate (page, id) { sandbox.navigated.push([page, id]) },
    _toggleWatchlist (item) { sandbox.toggled.push(item) },
    _stopHeroTrailer () {},
    _prefersReducedMotion: () => true,
    _stripTags: s => String(s == null ? '' : s),
    _untilLabel: () => '',
    esc: s => String(s == null ? '' : s),
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext([extractFn(source, '_heroNum'), extractFn(source, '_inMyList'),
    extractFn(source, '_myListFace'), extractFn(source, '_paintVideoHero')].join('\n'), sandbox)
  return { sandbox, byId, mount }
}

function paint (h, item) {
  h.sandbox._videoHero.items = [item]
  h.sandbox._videoHero.index = 0
  h.sandbox._paintVideoHero()
}

const FILM = { type: 'movie', id: 27205, title: 'Inception', year: 2010, rating: 8.4, backdrop: 'bd.jpg' }

test('the hero Play button arms the play the detail page will take', () => {
  const h = harness(SRC)
  paint(h, FILM)
  h.byId['vhero-play'].click()
  assert.deepStrictEqual(h.sandbox.navigated, [['video-detail', 'movie:27205']],
    'it still opens the title — Play has to get you to the page too')
  assert.ok(h.sandbox._playOnArrival,
    'and it arms the auto-play, which is the half that was missing')
})

test('Details opens the page and starts nothing', () => {
  const h = harness(SRC)
  paint(h, FILM)
  h.byId['vhero-info'].click()
  assert.deepStrictEqual(h.sandbox.navigated, [['video-detail', 'movie:27205']])
  assert.strictEqual(h.sandbox._playOnArrival, null,
    'Details is the button for people who do not want it to start')
})

test('a film does not arrive claiming season 0', () => {
  // Number(null) is 0 and Number(undefined) is NaN. A film carries neither a
  // season nor an episode, and season 0 is TMDB's specials bucket — arming it
  // would open a film onto a season picker set to "Specials".
  const h = harness(SRC)
  paint(h, FILM)
  h.byId['vhero-play'].click()
  assert.strictEqual(h.sandbox._playOnArrival.season, null)
  assert.strictEqual(h.sandbox._playOnArrival.episode, null)
})

test('a featured episode carries its own numbers through', () => {
  const h = harness(SRC)
  paint(h, { type: 'tv', id: 1396, title: 'Breaking Bad', backdrop: 'bd.jpg', season: 3, episode: 7 })
  h.byId['vhero-play'].click()
  assert.strictEqual(h.sandbox._playOnArrival.episode, 7)
  assert.strictEqual(h.sandbox._playOnArrival.season, 3)
})

test('junk in the catalogue record is ignored rather than coerced to NaN', () => {
  const h = harness(SRC)
  paint(h, { type: 'tv', id: 1396, title: 'Breaking Bad', backdrop: 'bd.jpg', season: '', episode: 'x' })
  h.byId['vhero-play'].click()
  assert.strictEqual(h.sandbox._playOnArrival.episode, null)
  assert.strictEqual(h.sandbox._playOnArrival.season, null)
})

test('My List on the hero is still its own button', () => {
  const h = harness(SRC)
  paint(h, FILM)
  h.byId['vhero-list'].click()
  assert.strictEqual(h.sandbox.navigated.length, 0, 'saving does not navigate')
  assert.strictEqual(h.sandbox.toggled.length, 1)
  assert.strictEqual(h.sandbox._playOnArrival, null, 'and it certainly does not play')
})

test('MUTATION: sharing one handler between Play and Details is the bug', () => {
  const broken = SRC.replace(
    "  document.getElementById('vhero-play')?.addEventListener('click', function () {\n" +
    "    _playOnArrival = { episode: _heroNum(item.episode), season: _heroNum(item.season) }\n" +
    '    go()\n' +
    '  })',
    "  document.getElementById('vhero-play')?.addEventListener('click', go)")
  assert.notStrictEqual(broken, SRC, 'the mutation applied')
  const h = harness(broken)
  paint(h, FILM)
  h.byId['vhero-play'].click()
  assert.deepStrictEqual(h.sandbox.navigated, [['video-detail', 'movie:27205']])
  assert.strictEqual(h.sandbox._playOnArrival, null,
    'this is the defect: Play navigated and nothing ever started')
})
