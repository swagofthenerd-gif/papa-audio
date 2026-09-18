'use strict'
// Three ways the My List controls lied about what the store actually held:
//
//   * the hero's button painted a plus and the word "My List" for a title
//     that was already saved, so pressing it read as "add" and removed it;
//   * a poster button's icon flipped on toggle but its aria-label did not,
//     so a screen reader was told "Remove from My List" about a title that
//     had just been removed;
//   * the My List page itself never repainted on a change, so a removed
//     card stayed on screen and the count stayed one too high until you
//     navigated away and back.
//
// All three are the same defect — a control that reports its own last paint
// instead of the store — so they are tested together, against the real
// painters and the real markup builders.
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

function button (id) {
  return {
    id,
    dataset: {},
    innerHTML: '',
    _aria: null,
    _on: false,
    classList: { toggle (c, v) { if (c === 'on') this._owner._on = v }, add () {}, remove () {}, contains () { return false } },
    setAttribute (k, v) { if (k === 'aria-label') this._aria = v },
    getAttribute (k) { return k === 'aria-label' ? this._aria : null },
  }
}
function mkButton (id) { const b = button(id); b.classList._owner = b; return b }

// A watchlist store with the one method every surface asks: is this saved?
function storeWith (saved) {
  const set = new Set(saved)
  return {
    _set: set,
    watchlist () { return [...set].map(k => ({ type: k.split(':')[0], id: k.split(':')[1], title: 'T' + k, addedAt: 1 })) },
    inWatchlist (type, id) { return set.has(type + ':' + id) },
    toggleWatchlist (item) {
      const k = (item.type || 'movie') + ':' + item.id
      set.has(k) ? set.delete(k) : set.add(k)
      return [...set]
    },
  }
}

function sandboxFor (source, fns, extra) {
  const s = Object.assign({
    console,
    window: {},
    document: { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null, createElement: () => ({}) },
    esc: v => String(v == null ? '' : v),
    showToast () {},
    _VICON: { plus: '<plus/>', check: '<check/>', play: '<play/>', info: '<info/>' },
    _videoTab: 'all',
  }, extra || {})
  s.globalThis = s
  vm.createContext(s)
  vm.runInContext(fns.map(n => extractFn(source, n)).join('\n'), s)
  return s
}

const FACE_FNS = ['_inMyList', '_myListFace', '_paintMyListButtons', '_toggleWatchlist']

function toggleHarness (saved, opts) {
  const o = opts || {}
  const store = storeWith(saved)
  const hero = mkButton('vhero-list')
  hero.dataset.key = o.heroKey || 'movie:27205'
  const posters = (o.posterKeys || ['movie:27205']).map(k => { const b = mkButton('p'); b.dataset.key = k; return b })
  const s = sandboxFor(SRC, FACE_FNS, {
    _vStore: () => store,
    _videoTab: o.tab || 'all',
    rendered: 0,
    _renderMyList () { s.rendered++ },
    document: {
      getElementById: id => (id === 'vhero-list' ? hero : id === 'vrows' ? { id: 'vrows' } : null),
      querySelectorAll (sel) {
        const m = /data-key="([^"]+)"/.exec(sel)
        return m ? posters.filter(p => p.dataset.key === m[1]) : []
      },
      querySelector: () => null,
      createElement: () => ({}),
    },
  })
  return { s, store, hero, posters }
}

test('the hero button shows the saved state it was painted with', () => {
  const store = storeWith(['movie:27205'])
  const byId = {}
  const mount = {
    id: 'vhero-mount', dataset: {}, _html: '',
    classList: { add () {}, remove () {}, toggle () {}, contains: () => false },
    addEventListener () {},
    get innerHTML () { return this._html },
    set innerHTML (v) { this._html = v },
    querySelector: () => null, querySelectorAll: () => [],
  }
  byId['vhero-mount'] = mount
  const s = sandboxFor(SRC, ['_heroNum', '_inMyList', '_myListFace', '_paintVideoHero'], {
    document: { getElementById: id => byId[id] || null, createElement: () => ({ addEventListener () {}, remove () {} }) },
    _vStore: () => store,
    _videoHero: { items: [{ type: 'movie', id: 27205, title: 'Inception', backdrop: 'bd.jpg' }], index: 0, timer: null, paused: false },
    navigate () {}, _toggleWatchlist () {}, _stopHeroTrailer () {},
    _prefersReducedMotion: () => true,
    _stripTags: v => String(v == null ? '' : v),
    _untilLabel: () => '',
    _playOnArrival: null,
  })
  s._paintVideoHero()
  const html = mount._html
  assert.match(html, /id="vhero-list"[^>]*aria-label="Remove from My List"/,
    'a saved title has to say so — it was "Add to My List" whatever the store held')
  assert.match(html, /<check\/>In My List/, 'tick and the saved word, not a plus')

  // ...and an unsaved title still reads as an invitation.
  store._set.clear()
  s._paintVideoHero()
  assert.match(mount._html, /<plus\/>My List/)
  assert.match(mount._html, /aria-label="Add to My List"/)
})

test('toggling repaints the hero, not only the posters', () => {
  const h = toggleHarness([])
  h.s._toggleWatchlist({ type: 'movie', id: 27205, title: 'Inception' })
  assert.strictEqual(h.store.inWatchlist('movie', 27205), true, 'it saved')
  assert.strictEqual(h.hero.innerHTML, '<check/>In My List', 'the hero followed the store')
  assert.strictEqual(h.hero._aria, 'Remove from My List')
  assert.strictEqual(h.hero._on, true)

  h.s._toggleWatchlist({ type: 'movie', id: 27205, title: 'Inception' })
  assert.strictEqual(h.hero.innerHTML, '<plus/>My List', 'and back again')
  assert.strictEqual(h.hero._aria, 'Add to My List')
})

test('a hero showing a different title is left alone', () => {
  const h = toggleHarness([], { heroKey: 'tv:1396' })
  h.s._toggleWatchlist({ type: 'movie', id: 27205, title: 'Inception' })
  assert.strictEqual(h.hero.innerHTML, '', 'saving a film must not repaint the spotlight for a series')
})

test('the poster button\'s label follows its icon', () => {
  const h = toggleHarness(['movie:27205'])
  h.s._toggleWatchlist({ type: 'movie', id: 27205 })
  assert.strictEqual(h.posters[0].innerHTML, '<plus/>', 'icon says removed')
  assert.strictEqual(h.posters[0]._aria, 'Add to My List',
    'and so does the label — it used to keep saying "Remove from My List"')
})

test('every poster for the same title repaints, and no other', () => {
  const h = toggleHarness([], { posterKeys: ['movie:27205', 'movie:27205', 'tv:1396'] })
  h.s._toggleWatchlist({ type: 'movie', id: 27205 })
  assert.strictEqual(h.posters[0]._aria, 'Remove from My List')
  assert.strictEqual(h.posters[1]._aria, 'Remove from My List')
  assert.strictEqual(h.posters[2]._aria, null, 'a different title is untouched')
})

test('removing a title from the My List page repaints the page', () => {
  const h = toggleHarness(['movie:27205'], { tab: 'list' })
  h.s._toggleWatchlist({ type: 'movie', id: 27205 })
  assert.strictEqual(h.s.rendered, 1,
    'the card and the count stayed put until you left the tab and came back')
})

test('saving from a catalogue tab does not rebuild My List behind it', () => {
  const h = toggleHarness([], { tab: 'all' })
  h.s._toggleWatchlist({ type: 'movie', id: 27205 })
  assert.strictEqual(h.s.rendered, 0)
})

test('the card markup and the live repaint agree on both faces', () => {
  // The bug class is two places describing the same state in their own words.
  const s = sandboxFor(SRC, ['_myListFace'])
  const on = s._myListFace(true)
  const off = s._myListFace(false)
  assert.strictEqual(on.aria, 'Remove from My List')
  assert.strictEqual(off.aria, 'Add to My List')
  assert.notStrictEqual(on.icon, off.icon)
  assert.notStrictEqual(on.text, off.text)
})

test('a store that is not ready yet reads as "not saved", never as a throw', () => {
  const s = sandboxFor(SRC, ['_inMyList'], { _vStore: () => null })
  assert.strictEqual(s._inMyList('movie', 1), false)
  const t = sandboxFor(SRC, ['_inMyList'], { _vStore: () => ({ inWatchlist () { throw new Error('cold') } }) })
  assert.strictEqual(t._inMyList('movie', 1), false)
})
