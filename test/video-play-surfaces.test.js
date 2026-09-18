'use strict'
// Three different buttons on the Movies & TV side all say "play this now", and
// all three have been shipped at some point doing nothing of the kind:
//
//   1. the shelf card's Play         — fixed in b0e436c
//   2. the hero spotlight's Play     — fixed in 0186501
//   3. the "Continue episode N · Resume" banner — fixed here
//
// Each was found separately, because no test covered the *class* of defect:
// a control that navigates or refetches and never reaches the player. This
// file covers all three at once, against the real handlers.
//
// The shared truth every surface has to satisfy is the arm that the source
// load consumes. Two of them arm it indirectly (`_playOnArrival`, which
// renderVideoDetail turns into `_autoPlayTicket`); the resume banner arms it
// directly. The consumption itself is the real `_takeAutoPlayArm`, lifted
// here — so the test asserts the actual handoff rather than a copy of it.
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

// ── the smallest DOM these handlers touch ───────────────────────────────────
function el (tag, attrs) {
  const e = {
    tag: tag || 'div',
    dataset: (attrs && attrs.dataset) || {},
    className: (attrs && attrs.className) || '',
    textContent: (attrs && attrs.textContent) || '',
    _attrs: (attrs && attrs.attrs) || {},
    _kids: [],
    _listeners: {},
    classList: {
      _set: new Set(String((attrs && attrs.className) || '').split(' ').filter(Boolean)),
      add (c) { this._set.add(c) },
      remove (c) { this._set.delete(c) },
      toggle (c, on) { on ? this._set.add(c) : this._set.delete(c) },
      contains (c) { return this._set.has(c) },
    },
    addEventListener (t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn) },
    getAttribute (k) { return this._attrs[k] != null ? this._attrs[k] : null },
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    remove () {},
    // A click carries its own target, the way a real event does, so the
    // handlers' `e.target.closest('[data-act]')` branch is exercised rather
    // than stubbed around.
    fire (type, ev) { for (const fn of this._listeners[type] || []) fn(ev || { target: e, closest: () => null }) },
  }
  e.closest = function (sel) { return matches(e, sel) ? e : (e._parent ? e._parent.closest(sel) : null) }
  e.querySelector = function (sel) { return e._kids.find(k => matches(k, sel)) || null }
  e.querySelectorAll = function (sel) { return e._kids.filter(k => matches(k, sel)) }
  e.append = function (k) { k._parent = e; e._kids.push(k); return k }
  return e
}

function matches (node, sel) {
  if (!node) return false
  if (sel.startsWith('.')) return node.classList.contains(sel.slice(1))
  if (sel.startsWith('[')) {
    const key = sel.slice(1, -1).split('=')[0]
    const prop = key.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    return node.dataset[prop] != null
  }
  return node.tag === sel
}

function sandboxFor (source, fns, extra) {
  const s = Object.assign({
    document: {
      getElementById: () => null,
      createElement: () => el('div'),
      addEventListener () {},
      querySelectorAll: () => [],
      querySelector: () => null,
    },
    window: {},
    console,
    _playOnArrival: null,
    _autoPlayTicket: 0,
    _videoDetailTicket: 0,
    _videoSeasonTicket: 0,
    _videoState: { season: 1, episode: 1, sub: true },
    esc: v => String(v == null ? '' : v),
  }, extra || {})
  s.globalThis = s
  vm.createContext(s)
  vm.runInContext(fns.map(n => extractFn(source, n)).join('\n'), s)
  return s
}

// ── surface 1: a shelf card's Play ──────────────────────────────────────────
function cardHarness (source) {
  const card = el('div', { className: 'vcard', dataset: { video: 'tv:1396', season: '3', episode: '7' } })
  const play = card.append(el('button', { className: 'vcard-play', dataset: { act: 'play' } }))
  card.append(el('div', { className: 'vcard-title', textContent: 'Breaking Bad' }))
  const s = sandboxFor(source, ['_bindVideoCards'], {
    navigated: [],
    navigate (page, id) { s.navigated.push([page, id]) },
    _observeCards () {},
    _bindHoverTrailer () {},
    _bindVideoCardContextMenu () {},
    _toggleWatchlist () {},
    _removeFromContinueWatching () {},
  })
  s._bindVideoCards({ querySelectorAll: sel => (sel === '.vcard' ? [card] : []) })
  return { s, card, play }
}

// ── surface 2: the hero spotlight's Play ────────────────────────────────────
function heroHarness (source, item) {
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
      for (const m of String(v).matchAll(/id="([a-z0-9-]+)"/g)) byId[m[1]] = el('button')
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  byId['vhero-mount'] = mount
  const s = sandboxFor(source, ['_heroNum', '_inMyList', '_myListFace', '_paintVideoHero'], {
    document: { getElementById: id => byId[id] || null, createElement: () => el('img') },
    navigated: [],
    navigate (page, id) { s.navigated.push([page, id]) },
    _videoHero: { items: [item], index: 0, timer: null, paused: false },
    _VICON: { play: '<svg/>', plus: '<svg/>', info: '<svg/>' },
    _toggleWatchlist () {},
    _vStore: () => null,
    _stopHeroTrailer () {},
    _prefersReducedMotion: () => true,
    _stripTags: v => String(v == null ? '' : v),
    _untilLabel: () => '',
  })
  s._paintVideoHero()
  return { s, byId }
}

// ── surface 3: the Continue/Resume banner ───────────────────────────────────
function resumeHarness (source) {
  const go = el('button', { className: 'video-resume-go' })
  const banner = el('div', { className: 'video-resume', dataset: { ep: '7' } })
  banner.append(go)
  const root = el('div')
  root.append(banner)
  const s = sandboxFor(source, ['_bindEpResume', '_takeAutoPlayArm'], {
    _videoDetailTicket: 5,
    loads: [],
    _loadVideoSources (ticket, seasonTicket) { s.loads.push([ticket, seasonTicket]) },
    _syncEpisodeSelection (n) { s.synced = n },
  })
  s._bindEpResume(root)
  return { s, go }
}

// The step renderVideoDetail performs on arrival: it takes `_playOnArrival`
// and converts it into the same `_autoPlayTicket` arm the resume banner sets
// directly. Modelled here (it lives inside a 200-line async page render) so
// the card and hero surfaces can be followed to the same finish line.
function armFromArrival (s, ticket) {
  const arrival = s._playOnArrival
  s._playOnArrival = null
  s._videoDetailTicket = ticket
  if (arrival) s._autoPlayTicket = ticket
}

const STREAMS = [{ title: 'A source', magnet: 'magnet:?x' }]

test('all three Play surfaces reach the player, not just a page', () => {
  // 1. the shelf card
  const c = cardHarness(SRC)
  c.card.fire('click', { target: c.play, stopPropagation () {} })
  assert.deepStrictEqual(c.s.navigated, [['video-detail', 'tv:1396']], 'the card still opens the title')
  assert.ok(c.s._playOnArrival, 'card Play: it armed the play, not just the navigation')
  armFromArrival(c.s, 11)
  // The real consumption, run against the arm the card actually produced.
  const consume = sandboxFor(SRC, ['_takeAutoPlayArm'])
  consume._videoDetailTicket = 11
  consume._autoPlayTicket = c.s._autoPlayTicket
  assert.strictEqual(consume._takeAutoPlayArm(STREAMS), true,
    'card Play: the source load hands over to the player')

  // 2. the hero spotlight
  const h = heroHarness(SRC, { type: 'tv', id: 1396, title: 'Breaking Bad', backdrop: 'bd.jpg', season: 3, episode: 7 })
  h.byId['vhero-play'].fire('click')
  assert.deepStrictEqual(h.s.navigated, [['video-detail', 'tv:1396']], 'the hero still opens the title')
  armFromArrival(h.s, 12)
  const consume2 = sandboxFor(SRC, ['_takeAutoPlayArm'])
  consume2._videoDetailTicket = 12
  consume2._autoPlayTicket = h.s._autoPlayTicket
  assert.strictEqual(consume2._takeAutoPlayArm(STREAMS), true,
    'hero Play: the source load hands over to the player')

  // 3. the resume banner — already on the detail page, so it arms directly and
  // the real _takeAutoPlayArm lives in the same sandbox.
  const r = resumeHarness(SRC)
  r.go.fire('click')
  assert.strictEqual(r.s._videoState.episode, 7, 'it selects the episode it named')
  assert.strictEqual(r.s.loads.length, 1, 'and refetches that episode\'s sources')
  assert.strictEqual(r.s._takeAutoPlayArm(STREAMS), true,
    'Resume: the source load hands over to the player')
})

test('Resume arms before the load, so a cached source list is not missed', () => {
  // The order matters. If the arm were set after _loadVideoSources, a list
  // that is already in hand would be consumed by a load that ran before the
  // arm existed, and Resume would silently do nothing on exactly the titles
  // the viewer returns to most.
  const r = resumeHarness(SRC)
  let armedAtLoad = null
  r.s._loadVideoSources = function () { armedAtLoad = r.s._autoPlayTicket }
  r.go.fire('click')
  assert.strictEqual(armedAtLoad, 5, 'the arm was already set when the load started')
})

test('nothing plays when no surface asked for it', () => {
  const s = sandboxFor(SRC, ['_takeAutoPlayArm'])
  s._videoDetailTicket = 9
  s._autoPlayTicket = 0
  assert.strictEqual(s._takeAutoPlayArm(STREAMS), false,
    'opening a page must not start it by itself')
})

test('an arm from a page you have left is not honoured', () => {
  const s = sandboxFor(SRC, ['_takeAutoPlayArm'])
  s._autoPlayTicket = 8
  s._videoDetailTicket = 9
  assert.strictEqual(s._takeAutoPlayArm(STREAMS), false)
})

test('the arm is taken exactly once', () => {
  const s = sandboxFor(SRC, ['_takeAutoPlayArm'])
  s._videoDetailTicket = 9
  s._autoPlayTicket = 9
  assert.strictEqual(s._takeAutoPlayArm(STREAMS), true)
  assert.strictEqual(s._takeAutoPlayArm(STREAMS), false, 'a second source list must not replay it')
})

test('an empty source list leaves the arm standing for the next list', () => {
  const s = sandboxFor(SRC, ['_takeAutoPlayArm'])
  s._videoDetailTicket = 9
  s._autoPlayTicket = 9
  assert.strictEqual(s._takeAutoPlayArm([]), false)
  assert.strictEqual(s._takeAutoPlayArm(STREAMS), true, 'the ask survives an empty first answer')
})
