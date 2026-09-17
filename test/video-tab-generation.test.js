'use strict'
// Pressing a tab while the previous tab was still loading let the OLD tab
// paint over the new one.
//
// _renderVideoTab is ticketed: every render takes _videoCatalogTicket++ and
// each of its fetches checks the ticket before writing to the page, so a slow
// answer belonging to a tab you have left is dropped. Every await had that
// check except one:
//
//     await _refreshInstantKeys()
//     ... rows.innerHTML = <every shell for this tab> ...
//
// _refreshInstantKeys asks main which titles will start instantly. It is
// cached for 30 seconds — but it is a real request on the first render of a
// session, and again every time that cache lapses, which is exactly when
// somebody is pressing along the tab strip. While it was in flight, the tab
// being left could come back, rebuild #vrows from ITS row list, and start its
// own fetches against a page that now belongs to another tab.
//
// This drives the real _renderVideoTab with a deferred instant-list call.
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

function mount (id, writes) {
  return {
    id,
    dataset: {},
    style: { display: '', removeProperty () { this.display = '' } },
    value: '',
    hidden: false,
    _html: '',
    get innerHTML () { return this._html },
    set innerHTML (v) { this._html = v; if (writes && v) writes.push({ id, v }) },
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener () {},
  }
}

function harness (source) {
  const writes = []
  const els = {}
  for (const id of ['vrows', 'vtaste-row', 'vhero-mount', 'video-search-results', 'vtab-hide-seen']) {
    els[id] = mount(id, writes)
  }
  let releaseInstant = null
  const instantPending = new Promise(res => { releaseInstant = res })

  const sandbox = {
    document: { getElementById: id => els[id] || null },
    window: { api: {} },
    state: { currentPage: 'video', currentVideoQuery: '' },
    writes,
    catalogCalls: [],
    _videoTab: 'movie',
    _videoCatalogTicket: 1,
    _videoRows: [
      { key: 'trending-movies', label: 'Trending Movies', tabs: ['all', 'movie'] },
      { key: 'trending-tv', label: 'Trending TV', tabs: ['all', 'tv'] },
    ],
    _hideSeen: false,
    esc: s => String(s == null ? '' : s),
    console,
    _refreshInstantKeys: () => instantPending,
    _curatedRows: () => [],
    _personalRows: () => [],
    _stopVideoHero: () => {},
    _wipeVideoMounts: () => {},
    _setVideoSearchHtml: () => null,
    _renderTasteRow: () => {},
    _renderMyList: () => {},
    _renderDeviceTab: () => {},
    _bindDeviceEvents: () => {},
    _hideSeenToggleHtml: () => '<label></label>',
    _animeGenreStripHtml: () => '',
    _bindAnimeGenreStrip: () => {},
    _fillAnimeHome: async () => [],
    _vRowShell: (key, label) => '<section data-row="' + key + '">' + label + '</section>',
    _vHeroSkeleton: () => '<div class="vskel-hero"></div>',
    _bindShelfExpanders: () => {},
    _fillRowHideSeen: () => {},
    _renderAiringRow: () => {},
    _renderBecauseRow: () => {},
    _rowError: () => {},
    _rowEmpty: () => {},
    _rowOutage: () => {},
    _rowCacheNote: () => {},
    _rowViaMalNote: () => {},
    _dropRow: () => {},
    _setRowHead: () => {},
    _startVideoHero: () => {},
    _renderTodayRow: () => {},
  }
  sandbox.window.api.videoCatalogGet = function (req) {
    sandbox.catalogCalls.push(req.section)
    return Promise.resolve({ ok: true, results: [{ type: 'movie', id: 1 }] })
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(extractFn(source, '_renderVideoTab'), sandbox)
  return { sandbox, els, writes, releaseInstant }
}

const settle = () => new Promise(r => setTimeout(r, 0))

test('the tab you left cannot paint over the tab you are on', async () => {
  const h = harness(SRC)

  // Press Movies. Its render reaches the instant-list await and stops there.
  const movies = h.sandbox._renderVideoTab(2)
  await settle()
  assert.strictEqual(h.writes.length, 0, 'nothing painted yet — it is still waiting')

  // Press TV. A new ticket, and the tab state moves with it.
  h.sandbox._videoCatalogTicket = 3
  h.sandbox._videoTab = 'tv'

  // Now the instant list finally answers, for both renders.
  h.releaseInstant()
  await movies
  await settle()

  const rowWrites = h.writes.filter(w => w.id === 'vrows')
  assert.strictEqual(rowWrites.length, 0,
    'the Movies render woke up on a page that is no longer its own and wrote nothing')
  assert.deepStrictEqual(h.sandbox.catalogCalls, [],
    'and it started no fetches on that page either')
})

test('the render that owns the page still paints normally', async () => {
  const h = harness(SRC)
  const p = h.sandbox._renderVideoTab(1)   // the live ticket
  h.releaseInstant()
  await p
  await settle()
  const rowWrites = h.writes.filter(w => w.id === 'vrows')
  assert.strictEqual(rowWrites.length, 1, 'the shells went up')
  assert.match(rowWrites[0].v, /data-row="trending-movies"/)
  assert.deepStrictEqual(h.sandbox.catalogCalls, ['trending-movies'],
    'and the Movies tab fetched the Movies row')
})

test('leaving the video page entirely also stops the paint', async () => {
  const h = harness(SRC)
  const p = h.sandbox._renderVideoTab(1)
  h.sandbox.state.currentPage = 'home'
  h.releaseInstant()
  await p
  await settle()
  assert.strictEqual(h.writes.filter(w => w.id === 'vrows').length, 0)
})

test('MUTATION: without the check, the stale tab repaints the page', async () => {
  const broken = SRC.replace(
    "  if (_videoCatalogTicket !== ticket || state.currentPage !== 'video') return\n\n" +
    '  const wanted = _videoRows.filter',
    '\n  const wanted = _videoRows.filter')
  assert.notStrictEqual(broken, SRC, 'the mutation applied')
  const h = harness(broken)
  const movies = h.sandbox._renderVideoTab(2)
  await settle()
  h.sandbox._videoCatalogTicket = 3
  h.sandbox._videoTab = 'tv'
  h.releaseInstant()
  await movies
  await settle()
  assert.strictEqual(h.writes.filter(w => w.id === 'vrows').length, 1,
    'this is the defect: the abandoned render rebuilt #vrows anyway')
})
