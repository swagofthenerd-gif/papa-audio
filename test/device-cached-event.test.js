'use strict'
// A newly cached episode has to appear in On Device without leaving the tab.
//
// main sends `video-event { kind: 'cached' }` (main.js:12683). The device tab
// only ever subscribed to the DOWNLOAD channel, so an episode he had just
// watched did not show up until he navigated away and back — which reads as the
// page being broken rather than merely late, especially on a page where nothing
// else worked either.
//
// The real _bindDeviceEvents is lifted and run against fake channels.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function lift() {
  const start = SRC.indexOf('function _bindDeviceEvents()')
  assert.ok(start > -1, '_bindDeviceEvents must still exist')
  const end = SRC.indexOf('\nfunction ', start + 1)
  return SRC.slice(start, end === -1 ? undefined : end)
}
const BODY = lift()

function harness({ tab = 'device', page = 'video', hasOnVideoEvent = true } = {}) {
  const renders = []
  let videoCb = null
  let downloadCb = null
  const api = {
    onVideoDownloadEvent(cb) { downloadCb = cb },
  }
  if (hasOnVideoEvent) api.onVideoEvent = cb => { videoCb = cb }

  const doc = { getElementById: id => (id === 'vrows' ? { id } : null), querySelector: () => null }
  const fn = new Function('window', 'document', 'state', '_videoTab', 'record', `
    var _deviceEventsBound = false
    var _videoCatalogTicket = 7
    function _renderDeviceTab(rows, ticket) { record({ rows: rows && rows.id, ticket }) }
    function showSnackbar() {}
    function _shortQ(s) { return s }
    function _deviceFactsHtml() { return '' }
    ${BODY}
    _bindDeviceEvents()
  `)
  fn({ api }, doc, { currentPage: page }, tab, r => renders.push(r))
  return { renders, fire: e => videoCb && videoCb(e), fireDownload: e => downloadCb && downloadCb(e), hasVideo: () => !!videoCb }
}

test('a cached episode repaints the visible On Device tab', () => {
  const h = harness()
  assert.ok(h.hasVideo(), 'the shared video-event channel must be subscribed')
  h.fire({ kind: 'cached', key: 'tv:1', title: 'Evangelion' })
  assert.strictEqual(h.renders.length, 1, 'the list must refresh in place')
  assert.strictEqual(h.renders[0].rows, 'vrows')
})

test('other video events do not cause a repaint', () => {
  const h = harness()
  for (const kind of ['position', 'started', 'stopped', 'progress']) h.fire({ kind })
  assert.deepStrictEqual(h.renders, [], 'only a new cache entry changes this list')
})

test('nothing repaints when On Device is not the visible tab', () => {
  const onAnother = harness({ tab: 'anime' })
  onAnother.fire({ kind: 'cached' })
  assert.deepStrictEqual(onAnother.renders, [])

  const offPage = harness({ page: 'library' })
  offPage.fire({ kind: 'cached' })
  assert.deepStrictEqual(offPage.renders, [], 'repainting a hidden page is wasted work')
})

test('a build without the channel still binds the download events', () => {
  const h = harness({ hasOnVideoEvent: false })
  assert.strictEqual(h.hasVideo(), false)
  h.fireDownload({ kind: 'done', title: 'x' })   // must not throw
})

// ── The wiring: does anything in the app ever call _bindDeviceEvents? ─────────
// Every test above lifts the binder and calls it directly, so all 113 device
// tests stayed green when the one call in the app — inside _renderVideoTab's
// `device` branch — was deleted and the tab stopped hearing a thing. This
// section opens the tab the way the app opens it and then fires the event.

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

function fakeEl (id) {
  return {
    id,
    _html: '',
    style: { display: '', removeProperty () { this.display = '' } },
    get innerHTML () { return this._html },
    set innerHTML (v) { this._html = v },
    querySelector: () => null,
    querySelectorAll: () => [],
  }
}

// Opens the On Device tab through the real page renderer, with nothing but
// _renderDeviceTab itself stubbed out.
function openDeviceTab (source, tab) {
  const renders = []
  let videoCb = null
  const els = {
    vrows: fakeEl('vrows'),
    'vhero-mount': fakeEl('vhero-mount'),
    'vtaste-row': fakeEl('vtaste-row'),
  }
  const sandbox = {
    document: { getElementById: id => els[id] || null, querySelector: () => null },
    window: {
      api: {
        onVideoEvent (cb) { videoCb = cb },
        onVideoDownloadEvent () {},
      },
    },
    state: { currentPage: 'video', currentVideoQuery: '' },
    _videoTab: tab || 'device',
    _deviceEventsBound: false,
    _videoCatalogTicket: 7,
    _renderDeviceTab: (rows, ticket) => { renders.push({ rows: rows && rows.id, ticket }) },
    _renderMyList: () => {},
    _renderTasteRow: () => {},
    _setVideoSearchHtml: () => {},
    _stopVideoHero: () => {},
    _wipeVideoMounts: () => {},
    _refreshInstantKeys: () => Promise.resolve(),
    showSnackbar: () => {},
    _shortQ: x => x,
    _deviceFactsHtml: () => '',
  }
  vm.createContext(sandbox)
  vm.runInContext([
    extractFn(source, '_bindDeviceEvents'),
    extractFn(source, '_renderVideoTab'),
  ].join('\n'), sandbox)
  return { sandbox, renders, fire: e => { if (videoCb) videoCb(e) }, bound: () => !!videoCb }
}

test('opening the On Device tab subscribes it to the cached-episode channel', async () => {
  const h = openDeviceTab(SRC)
  await h.sandbox._renderVideoTab(7)
  assert.ok(h.bound(),
    'nothing else in the app binds these events — without this call the tab is deaf')
  h.renders.length = 0
  h.fire({ kind: 'cached', key: 'tv:1', title: 'Evangelion' })
  assert.strictEqual(h.renders.length, 1, 'and a newly cached episode repaints it')
})

test('a tab that is not On Device does not subscribe', async () => {
  // My List is the neighbouring early-return branch, so it exercises the same
  // stretch of _renderVideoTab without needing the whole catalogue world.
  const h = openDeviceTab(SRC, 'list')
  await h.sandbox._renderVideoTab(7)
  assert.strictEqual(h.bound(), false, 'the binder belongs to the device branch only')
})

test('MUTATION: deleting the _bindDeviceEvents() call leaves the tab deaf', async () => {
  const broken = SRC.replace('    _bindDeviceEvents()\n    _renderDeviceTab(rows, ticket)',
    '    _renderDeviceTab(rows, ticket)')
  assert.notStrictEqual(broken, SRC, 'the mutation applied')
  const h = openDeviceTab(broken)
  await h.sandbox._renderVideoTab(7)
  assert.strictEqual(h.bound(), false)
  h.renders.length = 0
  h.fire({ kind: 'cached' })
  assert.strictEqual(h.renders.length, 0, 'this is the bug: the event reaches nobody')
})
