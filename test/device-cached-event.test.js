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
