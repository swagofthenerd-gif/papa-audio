'use strict'
// Playing a cached episode from On Device used to be an anonymous file open:
// no show, no season, no episode. So the position was never remembered, the
// resume offer never fired, finishing it never counted as watched, and it
// never reached Continue Watching. The rewatch cache existed; rewatching out
// of it did not count as watching.
//
// The card is the only thing on that page that knows what the file is — there
// is no detail page open behind it — so the identity rides on the card and the
// play rebuilds a detail/state pair from it.
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')
const fs = require('fs')
const path = require('path')

const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function liftFn(decl, extra) {
  const start = RENDERER.indexOf(decl)
  assert.ok(start > 0, 'not found: ' + decl)
  const end = RENDERER.indexOf('\n}', start) + 2
  const ctx = Object.assign({
    console: { warn() {}, log() {} },
    JSON, Number, String, Object, Array, Boolean, Math,
  }, extra || {})
  vm.createContext(ctx)
  vm.runInContext(RENDERER.slice(start, end), ctx)
  return ctx
}

const ESC = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const ENTRY = {
  key: 'tv:1396:s1e5', path: '/cache/tv_1396_s1e5.mkv', title: 'Breaking Bad',
  episode: 5, season: 1,
  meta: { type: 'tv', id: 1396, title: 'Breaking Bad', poster: 'p.jpg', season: 1, episode: 5 },
}

function cardHtml(entry, kind) {
  const ctx = liftFn('function _deviceCardHtml(e, kind) {', {
    esc: ESC,
    _deviceEpisodeLabel: e => (e.episode == null ? '' : 'Episode ' + e.episode),
    _deviceFactsHtml: () => '',
    _VICON: { play: '<svg></svg>' },
  })
  return ctx._deviceCardHtml(entry, kind || 'cache')
}

test('a cached card carries the whole identity of what the file is', () => {
  const html = cardHtml(ENTRY)
  const m = /data-device-meta="([^"]*)"/.exec(html)
  assert.ok(m, 'no identity on the card: ' + html.slice(0, 300))
  const meta = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
  assert.strictEqual(meta.type, 'tv')
  assert.strictEqual(meta.id, 1396)
  assert.strictEqual(meta.season, 1)
  assert.strictEqual(meta.episode, 5)
  assert.strictEqual(meta.title, 'Breaking Bad')
})

test('a card for a file with no identity carries none, rather than a made-up one', () => {
  const html = cardHtml({ key: 'x', path: '/a.mkv', title: 'Some File' })
  assert.ok(!/data-device-meta=/.test(html))
})

// The play itself: what context does it hand _videoPlayResult?
function playWithDataset(dataset) {
  let got = null
  const ctx = liftFn('function _playDeviceFile(card) {', {
    _videoPlayResult: (result, opts) => { got = { result, opts } },
  })
  ctx._playDeviceFile({ dataset: dataset, getAttribute: () => 'Breaking Bad' })
  return got
}

test('playing a cached episode plays it AS that episode, so the watch is recorded', () => {
  const got = playWithDataset({
    devicePath: '/cache/tv_1396_s1e5.mkv',
    deviceEp: 'Season 1 · Episode 5',
    deviceMeta: JSON.stringify(ENTRY.meta),
  })
  assert.ok(got, 'nothing played')
  assert.ok(got.opts.ctx.detail, 'the play had no idea what it was playing')
  assert.strictEqual(got.opts.ctx.detail.type, 'tv')
  assert.strictEqual(got.opts.ctx.detail.d.id, 1396)
  assert.strictEqual(got.opts.ctx.detail.d.title, 'Breaking Bad')
  assert.strictEqual(got.opts.ctx.state.season, 1)
  assert.strictEqual(got.opts.ctx.state.episode, 5)
  // The key the position store will use is the same one the cache filed it
  // under — the same episode, however it got here.
  const K = require('../src/watch-key')
  assert.strictEqual(
    K.watchKey(got.opts.ctx.detail.type, got.opts.ctx.detail.d.id,
      got.opts.ctx.state.season, got.opts.ctx.state.episode),
    ENTRY.key)
})

test('a card with no identity still plays, anonymously, exactly as before', () => {
  const got = playWithDataset({ devicePath: '/a.mkv', deviceEp: '' })
  assert.ok(got)
  assert.strictEqual(got.opts.ctx.detail, null)
  assert.strictEqual(got.opts.ctx.state, null)
  assert.strictEqual(got.result.url, '/a.mkv')
})

test('unreadable identity on a card never breaks the play', () => {
  const got = playWithDataset({ devicePath: '/a.mkv', deviceMeta: '{not json' })
  assert.ok(got)
  assert.strictEqual(got.opts.ctx.detail, null)
})

test('a card with no path plays nothing at all', () => {
  assert.strictEqual(playWithDataset({ deviceMeta: JSON.stringify(ENTRY.meta) }), null)
})
