'use strict'
// Choosing "Specials" from the season picker quietly gave you season one.
//
// TMDB files specials, OVAs and recap episodes as season 0. _renderVideoControls
// goes to real trouble over it: season 0 is sorted to the END of the list
// rather than first, and it is labelled "Specials" rather than "Season 0",
// because opening a show onto its recap episodes is never what anyone wants.
//
// And then the change handler read the choice as
//
//     _videoState.season = Number(e.target.value) || 1
//
// `Number('0') || 1` is 1. So picking Specials set the season to ONE. The
// episode list refetched season one, the source lookup asked for season one —
// and the dropdown carried on displaying "Specials", because nothing had
// re-rendered it. The page said one thing and did another.
//
// These drive the REAL _renderVideoControls, fire the REAL change listener it
// installs, and read the REAL _videoState the episode fetch and the stream
// request both take their season from.
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

function el (id) {
  return {
    id,
    dataset: {},
    value: '',
    _html: '',
    _listeners: {},
    get innerHTML () { return this._html },
    set innerHTML (v) {
      this._html = v
      for (const m of String(v).matchAll(/id="([a-z0-9-]+)"/g)) this._owner[m[1]] = el(m[1])
    },
    addEventListener (type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn) },
    fire (type, ev) { for (const fn of this._listeners[type] || []) fn(ev || {}) },
    querySelector: () => null,
    querySelectorAll: () => [],
  }
}

const SEASONS = [
  { seasonNumber: 0, name: 'Specials' },
  { seasonNumber: 1, name: 'Season 1' },
  { seasonNumber: 2, name: 'Season 2' },
]

function harness (source) {
  const byId = {}
  const box = el('video-controls')
  box._owner = byId
  byId['video-controls'] = box

  const sandbox = {
    document: { getElementById: id => byId[id] || null },
    window: {},
    refreshes: [],
    _videoDetail: { type: 'tv', id: '1396', d: { id: '1396', title: 'Breaking Bad', seasons: SEASONS } },
    _videoState: { season: 1, episode: 4, sub: true },
    _videoDetailTicket: 3,
    _videoSeasonTicket: 0,
    esc: s => String(s == null ? '' : s),
    console,
    _dubControl: () => '',
    _bindDubControl () {},
    _spoilerToggleHtml: () => '',
    _bindSpoilerToggle () {},
    _confirmMarkSeasonWatched (s) { sandbox.marked = s },
    _refreshTvEpisodes (t, st) { sandbox.refreshes.push({ season: sandbox._videoState.season, episode: sandbox._videoState.episode }) },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(extractFn(source, '_renderVideoControls'), sandbox)
  sandbox._renderVideoControls('tv')
  return { sandbox, byId, box }
}

function pick (h, value) {
  const sel = h.byId['video-season-select']
  assert.ok(sel, 'the season picker exists')
  sel.value = String(value)
  sel.fire('change', { target: sel })
}

test('picking Specials selects season zero, not season one', () => {
  const h = harness(SRC)
  pick(h, 0)
  assert.strictEqual(h.sandbox._videoState.season, 0,
    'the season the episode fetch and the source lookup both read')
})

test('and the episode refetch goes out for season zero', () => {
  const h = harness(SRC)
  pick(h, 0)
  assert.strictEqual(h.sandbox.refreshes.length, 1)
  assert.strictEqual(h.sandbox.refreshes[0].season, 0,
    'it asked TMDB for the specials, which is what was clicked')
  assert.strictEqual(h.sandbox.refreshes[0].episode, 1, 'starting at the first of them')
})

test('an ordinary season still works exactly as before', () => {
  const h = harness(SRC)
  pick(h, 2)
  assert.strictEqual(h.sandbox._videoState.season, 2)
  assert.strictEqual(h.sandbox.refreshes[0].season, 2)
})

test('a value that is not a number falls back to season one', () => {
  const h = harness(SRC)
  pick(h, 'nonsense')
  assert.strictEqual(h.sandbox._videoState.season, 1,
    'a broken option must not set the season to NaN')
})

test('Specials is still sorted last and named, not numbered', () => {
  const h = harness(SRC)
  const html = h.box.innerHTML
  const specials = html.indexOf('Specials')
  const s1 = html.indexOf('>Season 1<')
  assert.ok(specials > -1 && s1 > -1)
  assert.ok(specials > s1, 'season 0 belongs at the end of the list, not the front')
  assert.ok(!/Season 0/.test(html), 'and it is called what it is')
})

test('MUTATION: the zero-eating coercion sends you to season one', () => {
  const broken = SRC.replace(
    '      const picked = Number(e.target.value)\n' +
    '      _videoState.season = Number.isFinite(picked) ? picked : 1',
    '      _videoState.season = Number(e.target.value) || 1')
  assert.notStrictEqual(broken, SRC, 'the mutation applied')
  const h = harness(broken)
  pick(h, 0)
  assert.strictEqual(h.sandbox._videoState.season, 1,
    'this is the defect: Specials loaded season one and said nothing')
  assert.strictEqual(h.sandbox.refreshes[0].season, 1)
})
