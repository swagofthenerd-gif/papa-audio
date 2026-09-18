'use strict'
// The "plays instantly" badge on posters (2026-09-15). RealDebrid disabled
// its bulk availability endpoint (403 disabled_endpoint), so there is no way
// to ask "is this arbitrary title cached?" without a torrent search plus
// registering a magnet on the user's account, per poster. So the badge shows
// only what the app KNOWS: a file already on this device, or a debrid link
// already resolved. Nothing here is a guess, and a stale claim must expire.
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')
const fs = require('fs')
const path = require('path')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')

test('a title key is the poster, not the episode', () => {
  const ctx = {}
  vm.createContext(ctx)
  vm.runInContext(MAIN.slice(MAIN.indexOf('function _titleKeyOf('), MAIN.indexOf('function _videoCacheRoot(')), ctx)
  assert.strictEqual(ctx._titleKeyOf({ type: 'anime', id: 21, season: null, episode: 7 }), 'anime:21')
  assert.strictEqual(ctx._titleKeyOf({ type: 'movie', id: 603 }), 'movie:603')
  assert.strictEqual(ctx._titleKeyOf(null), null)
  assert.strictEqual(ctx._titleKeyOf({ type: 'movie' }), null, 'no id, no claim')
})

test('the memory is written only where the app really learned something', () => {
  // A saved cache entry, a finished download, and a resolved debrid link.
  assert.ok(/function _videoCacheIndexAdd\(entry\) \{\n  _instantMark\(_titleKeyOf\(entry && entry\.meta\), 'device'\)/.test(MAIN))
  assert.ok(/_instantMark\(_titleKeyOf\(d\.meta\.detail\), 'device'\)/.test(MAIN))
  assert.ok(/if \(url\) _instantMark\(titleKey, 'debrid'\)/.test(MAIN), 'only a link that actually resolved')
  // And when a source is proved servable by trying candidates in turn.
  assert.ok(/if \(titleKey\) _instantMark\(titleKey, 'debrid'\)/.test(MAIN))
  // The warm call carries the title so there is something to key on.
  assert.ok(/ipcMain\.handle\('video-warm', async \(_, \{ magnet, titleKey \} = \{\}\) =>/.test(MAIN))
  // Warming follows the source Play would actually start, not merely the
  // first listed one.
  assert.ok(/videoWarm\(\{ magnet: warmPick\.magnet, titleKey:/.test(RENDERER))
})

test('a deleted file stops claiming to be instant, and a debrid claim expires', () => {
  const start = MAIN.indexOf("ipcMain.handle('video-instant-list'")
  const body = MAIN.slice(start, MAIN.indexOf("ipcMain.handle('video-cache-list'", start))
  assert.ok(/if \(v\.via === 'device'\) \{ if \(live\.has\(k\)\) out\[k\] = v\.via; continue \}/.test(body),
    'a device claim is re-proved against what is actually on disk')
  assert.ok(/now - \(v\.at \|\| 0\) < INSTANT_DEBRID_TTL_MS/.test(body), 'a debrid claim ages out')
  assert.ok(/const INSTANT_DEBRID_TTL_MS = 1000 \* 60 \* 60 \* 12/.test(MAIN))
  // V121: on disk is instant regardless — and SAVED (kept) is told apart from CACHED (evictable).
  assert.ok(/for \(const k of live\) out\[k\] = kept\.has\(k\) \? 'saved' : 'cached'/.test(body), 'a file on disk is instant regardless, with its promise named')
})

test('the card badges from the memory, distinguishing on-device from debrid, and never asks per card', () => {
  const card = RENDERER.slice(RENDERER.indexOf('function _videoCard(item)'), RENDERER.indexOf('// ── Folder management'))
  // Read tolerantly: a badge must never be able to throw a card away.
  assert.ok(/const instant = \(typeof _instantKeys !== 'undefined' && _instantKeys\) \? _instantKeys\[key\] : null/.test(card))
  assert.ok(/'SAVED'/.test(card) && /'CACHED'/.test(card) && /'INSTANT'/.test(card), 'three different truths read differently (V121)')
  assert.ok(!/videoInstantList/.test(card), 'a card must never make its own request')
  // The map is fetched once per catalogue render, before the cards are built.
  // The ticket check that sits between the two is the guard against a tab you
  // have left painting over the one you are on (test/video-tab-generation).
  assert.ok(/await _refreshInstantKeys\(\)[\s\S]{0,900}?\n  const wanted = _videoRows\.filter/.test(RENDERER),
    'the instant map is still awaited before the row list is built')
  assert.ok(PRELOAD.includes('videoInstantList'))
})

test('the badge memory is capped so it cannot grow without end', () => {
  const ctx = { sideStores: { videoInstantIndex: { update(fn) { this.v = fn(this.v) }, v: {} } }, Date, Object }
  vm.createContext(ctx)
  vm.runInContext(MAIN.slice(MAIN.indexOf('const INSTANT_CAP'), MAIN.indexOf('// The title key a piece of watch metadata')), ctx)
  for (let i = 0; i < 700; i++) ctx._instantMark('movie:' + i, 'debrid')
  const held = Object.keys(ctx.sideStores.videoInstantIndex.v).length
  assert.ok(held <= 600, 'capped, got ' + held)
  assert.ok(ctx.sideStores.videoInstantIndex.v['movie:699'], 'the newest is kept')
  assert.ok(!ctx.sideStores.videoInstantIndex.v['movie:0'], 'the oldest went')
})

// ── the refresher itself, lifted and run ─────────────────────────────────────
// The line above ("the instant map is still awaited before the row list is
// built") is a regex over renderer.js: it sees the CALL, not what the call
// does. Emptying the body of _refreshInstantKeys left all five tests green
// while no badge was ever fetched again. These run it.

function liftRefresher (source, opts) {
  opts = opts || {}
  const at = source.indexOf('function _refreshInstantKeys(')
  assert.ok(at > -1, '_refreshInstantKeys must still exist')
  let depth = 0
  let end = -1
  for (let j = source.indexOf('{', at); j < source.length; j++) {
    if (source[j] === '{') depth++
    else if (source[j] === '}') { depth--; if (!depth) { end = j + 1; break } }
  }
  assert.ok(end > at, 'unbalanced braces in _refreshInstantKeys')
  const asks = []
  const ctx = {
    _instantKeys: {},
    _instantAt: opts.lastAt == null ? 0 : opts.lastAt,
    Date,
    Promise,
    window: {
      api: opts.noApi ? {} : {
        videoInstantList () {
          asks.push(1)
          return opts.answer || Promise.resolve({ ok: true, instant: { 'anime:21': 'cached' } })
        },
      },
    },
  }
  vm.createContext(ctx)
  vm.runInContext(source.slice(at, end) + '\nglobalThis.__call = _refreshInstantKeys', ctx)
  return { ctx, asks, call: f => ctx.__call(f) }
}

test('refreshing the badges actually asks main and keeps the answer', async () => {
  const h = liftRefresher(RENDERER)
  await h.call()
  assert.strictEqual(h.asks.length, 1, 'it asks')
  assert.strictEqual(h.ctx._instantKeys['anime:21'], 'cached', 'and remembers what it was told')
})

test('a second refresh inside the 30-second window does not re-ask', async () => {
  const h = liftRefresher(RENDERER, { lastAt: Date.now() })
  await h.call()
  assert.strictEqual(h.asks.length, 0, 'the throttle is the point of the unforced call')
})

test('a forced refresh ignores the window — that is what force is for', async () => {
  const h = liftRefresher(RENDERER, { lastAt: Date.now() })
  await h.call(true)
  assert.strictEqual(h.asks.length, 1)
})

test('a failed fetch leaves the badges as they were instead of throwing', async () => {
  const h = liftRefresher(RENDERER, { answer: Promise.reject(new Error('ipc closed')) })
  h.ctx._instantKeys = { 'movie:603': 'saved' }
  await h.call()
  assert.strictEqual(h.ctx._instantKeys['movie:603'], 'saved')
})

test('MUTATION: emptying the refresher is caught', async () => {
  const at = RENDERER.indexOf('function _refreshInstantKeys(')
  let depth = 0
  let end = -1
  for (let j = RENDERER.indexOf('{', at); j < RENDERER.length; j++) {
    if (RENDERER[j] === '{') depth++
    else if (RENDERER[j] === '}') { depth--; if (!depth) { end = j + 1; break } }
  }
  const broken = RENDERER.slice(0, at) +
    'function _refreshInstantKeys(force) {\n  return Promise.resolve()\n}' +
    RENDERER.slice(end)
  assert.notStrictEqual(broken, RENDERER, 'the mutation applied')
  const h = liftRefresher(broken)
  await h.call()
  assert.strictEqual(h.asks.length, 0,
    'this is the bug: every badge on every poster silently frozen')
})
