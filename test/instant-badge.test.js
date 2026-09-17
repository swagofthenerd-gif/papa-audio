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
