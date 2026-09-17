'use strict'
// Switching tabs inside Movies & TV used to retain every card it had ever drawn
// (2026-09-17).
//
// The enrichment queue (src/video-enrich.js) keys its bookkeeping on the card
// ELEMENT, in a plain Map, holding an apply closure per card. Releasing them is
// what _releaseCardsIn exists for, and setContent() calls it on every page
// change — which is why the leak was thought to be closed.
//
// But a tab switch is not a page change. _renderVideoTab repaints #vrows,
// #vtaste-row and #vhero-mount in place, and did so without releasing anything.
// All → Movies → TV → Anime → My List → On device is six full shelf-sets of
// cards retained per lap, each holding a detached <img> poster, for the life of
// the session — reported as "extreeeeeemly laggy, slow".
//
// This drives the REAL enricher (injected observer, so retention is observable)
// through the REAL _renderVideoTab.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const { createEnricher } = require('../src/video-enrich')

function extractFn(source, name) {
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

// A mount that holds cards and drops them when its innerHTML is replaced, which
// is the whole shape of the bug: the elements go, the enricher's record stays.
function mount(id) {
  const el = {
    id: id,
    _cards: [],
    style: { display: '', removeProperty () { this.display = '' } },
    dataset: {},
    value: '',
    hidden: false,
    get innerHTML() { return '' },
    set innerHTML(_v) { this._cards = [] },
    querySelectorAll(sel) {
      if (sel === '.vcard[data-enrich-observed="1"]') return this._cards.slice()
      return []
    },
    querySelector() { return null },
    addEventListener () {},
  }
  return el
}
function card(key) { return { dataset: { enrichObserved: '1', video: key }, getAttribute: () => key } }

function harness(source) {
  const observed = new Set()
  const enricher = createEnricher({
    fetchDetail: () => new Promise(() => {}),   // never resolves: no I/O in this test
    observerFactory: () => ({
      observe: el => observed.add(el),
      unobserve: el => observed.delete(el),
      disconnect: () => observed.clear(),
    }),
  })

  const mounts = { 'vrows': mount('vrows'), 'vtaste-row': mount('vtaste-row'), 'vhero-mount': mount('vhero-mount') }
  const doc = { getElementById: id => mounts[id] || null }

  const sandbox = {
    document: doc,
    _enricher: enricher,
    state: { currentPage: 'video', currentVideoQuery: 'stale query' },
    _videoTab: 'device',
    _videoCatalogTicket: 1,
    hoverStops: 0,
    deviceRenders: 0,
    _stopVideoHero () {},
    _stopHoverTrailer () { sandbox.hoverStops++ },
    _bindDeviceEvents () {},
    _renderDeviceTab () { sandbox.deviceRenders++ },
    _renderMyList () {},
    _renderTasteRow () {},
  }
  vm.createContext(sandbox)
  vm.runInContext([
    extractFn(source, '_releaseCardsIn'),
    extractFn(source, '_wipeVideoMounts'),
    extractFn(source, '_renderVideoTab'),
  ].join('\n'), sandbox)

  // Fill the three mounts with cards and register them the way _observeCards
  // does: element, title key, apply callback.
  const fill = () => {
    for (const id of Object.keys(mounts)) {
      mounts[id]._cards = ['anime:30', 'anime:21311', 'movie:603'].map(k => {
        const c = card(id + '/' + k)
        enricher.observe(c, k, () => {})
        return c
      })
    }
  }
  return { sandbox, mounts, enricher, observed, fill }
}

test('a tab switch releases the cards it is throwing away', async () => {
  const h = harness(SRC)
  h.fill()
  assert.strictEqual(h.observed.size, 9, 'nine cards across the three mounts')
  await h.sandbox._renderVideoTab(2)
  assert.strictEqual(h.observed.size, 0,
    'every card the switch discarded has left the enrichment queue')
  assert.strictEqual(h.sandbox.deviceRenders, 1, 'and the tab actually rendered')
})

test('a tab switch stops a hover preview that is mid-play', async () => {
  const h = harness(SRC)
  h.fill()
  await h.sandbox._renderVideoTab(2)
  assert.strictEqual(h.sandbox.hoverStops, 1,
    'a detached <video> keeps its decoder and its buffer otherwise')
})

test('laps do not accumulate', async () => {
  const h = harness(SRC)
  for (let lap = 0; lap < 6; lap++) {
    h.fill()
    await h.sandbox._renderVideoTab(lap + 2)
    assert.ok(h.observed.size === 0, 'lap ' + lap + ' left ' + h.observed.size + ' cards behind')
  }
})

test('MUTATION: without the release, every lap retains another set', async () => {
  const broken = SRC.replace('  _wipeVideoMounts()\n\n  const tasteRow = document.getElementById',
                             '  \n\n  const tasteRow = document.getElementById')
  assert.notStrictEqual(broken, SRC, 'the mutation applied')
  const h = harness(broken)
  for (let lap = 0; lap < 6; lap++) {
    h.fill()
    await h.sandbox._renderVideoTab(lap + 2)
  }
  assert.strictEqual(h.observed.size, 54,
    'six laps of nine cards, all still held by the queue — this is the leak')
  assert.strictEqual(h.sandbox.hoverStops, 0)
})
