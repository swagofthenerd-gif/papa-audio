'use strict'
// "Download for offline", then press Play — and it downloaded the whole thing
// again from strangers while the card said SAVED (2026-09-20 audit, confirmed
// by three independent readings of video-cache-get).
//
// Play probes for a local copy BY WATCH KEY, and that probe searched only the
// rewatch-cache index. A file saved for offline lives in the OTHER store
// (videoKeepIndex), so it was invisible to every play path at once: normal
// play, resume, next episode, and the warm — which probes the same handler.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const W = require('../src/watch-key')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

// What the download path actually writes (main.js _downloadFinish).
const downloaded = { id: 'a1', title: 'Ep 5', path: '/keep/s2e5.mkv', keptAt: 100, titleKey: 'tv:1399', season: 2, episode: 5, meta: { type: 'tv', id: '1399' } }
// What the keep-while-streaming path writes now that it stamps identity.
const keptLive = { id: 'b2', title: 'Ep 9', path: '/keep/e9.mkv', keptAt: 200, watchKey: 'anime:21:e9' }
// What it used to write, and what every pre-existing profile still holds.
const legacy = { id: 'c3', title: 'something', path: '/keep/old.mkv', keptAt: 50 }

test('a downloaded episode answers to the key Play actually probes with', () => {
  assert.equal(W.keepEntryKey(downloaded), 'tv:1399:s2e5')
  assert.equal(W.keepEntryKey(downloaded), W.watchKey('tv', '1399', 2, 5),
    'it must be the SAME spelling the renderer builds, or the probe misses')
})

test('a film keeps answering to its own title key', () => {
  assert.equal(W.keepEntryKey({ titleKey: 'movie:603', path: '/x' }), 'movie:603')
  assert.equal(W.keepEntryKey({ titleKey: 'movie:603', path: '/x' }), W.watchKey('movie', '603'))
})

test('anime ignores season, the way every other key for it does', () => {
  assert.equal(W.keepEntryKey({ titleKey: 'anime:21', season: 3, episode: 9 }), 'anime:21:e9')
})

test('season and episode are taken from meta when the flat fields are absent', () => {
  assert.equal(W.keepEntryKey({ titleKey: 'tv:1399', meta: { season: 3, episode: 2 } }), 'tv:1399:s3e2')
})

test('a stamped watch key beats anything reconstructed', () => {
  assert.equal(W.keepEntryKey(keptLive), 'anime:21:e9')
  assert.equal(W.keepEntryKey({ watchKey: 'anime:21:e4', titleKey: 'tv:9', season: 1, episode: 1 }), 'anime:21:e4')
})

test('an entry with no identity matches nothing rather than guessing', () => {
  // Playing the WRONG episode off disk is worse than falling through to the
  // network, so this must never fall back to "the only keep for this show".
  assert.equal(W.keepEntryKey(legacy), null)
  assert.equal(W.keepEntryKey({ titleKey: 'tv:1399' }), null, 'a series entry with no episode is unmatchable')
  assert.equal(W.keepEntryKey({ titleKey: 'tv:1399', episode: 'nine' }), null)
  assert.equal(W.keepEntryKey({ titleKey: 'nocolon', episode: 1 }), null)
  assert.equal(W.keepEntryKey({ titleKey: 'tv:', episode: 1 }), null)
})

test('junk cannot throw the probe', () => {
  for (const junk of [null, undefined, 'nope', 42, {}, []]) {
    assert.doesNotThrow(() => W.keepEntryKey(junk))
    assert.equal(W.keepEntryKey(junk), null)
  }
})

test('the search finds the saved file and ignores everything else', () => {
  const keeps = [legacy, downloaded, keptLive]
  assert.deepEqual(W.findKept(keeps, 'tv:1399:s2e5').map(k => k.id), ['a1'])
  assert.deepEqual(W.findKept(keeps, 'anime:21:e9').map(k => k.id), ['b2'])
  assert.deepEqual(W.findKept(keeps, 'tv:1399:s2e6'), [], 'a different episode is not a hit')
  assert.deepEqual(W.findKept(keeps, null), [])
  assert.deepEqual(W.findKept(null, 'tv:1399:s2e5'), [])
})

test('saved twice means the later save wins', () => {
  const older = Object.assign({}, downloaded, { id: 'old', keptAt: 10 })
  const newer = Object.assign({}, downloaded, { id: 'new', keptAt: 999 })
  assert.deepEqual(W.findKept([older, newer], 'tv:1399:s2e5').map(k => k.id), ['new', 'old'])
})

test('an entry with no path is never offered as a file', () => {
  assert.deepEqual(W.findKept([{ titleKey: 'tv:1399', season: 2, episode: 5 }], 'tv:1399:s2e5'), [])
})

// ── the wiring, in main ────────────────────────────────────────────────────
test('BOTH misses in the cache probe fall through to the keep library', () => {
  const at = MAIN.indexOf("ipcMain.handle('video-cache-get'")
  const body = MAIN.slice(at, MAIN.indexOf('\n})', at))
  assert.equal((body.match(/return _keptHitFor\(key\)/g) || []).length, 2,
    'the no-entry miss AND the file-vanished miss must both try the other store')
  // The `if (!key)` guard at the top is legitimate — with no key there is
  // nothing to look up in EITHER store. What must not exist is a bare
  // null-hit return AFTER the cache lookup has begun, because that is a miss,
  // and every miss has to try the keep library.
  const afterLookup = body.slice(body.indexOf('const entries = _videoCacheEntries()'))
  assert.doesNotMatch(afterLookup, /return \{ ok: true, hit: null \}/,
    'a cache miss must fall through to the keep library, never return empty')
})

test('a kept file is not treated as a cache entry', () => {
  const at = MAIN.indexOf('function _keptHitFor(key)')
  assert.ok(at > 0, 'the keep resolver must exist')
  const body = MAIN.slice(at, MAIN.indexOf('\n}\n', at))
  assert.match(body, /watchKeys\.findKept\(/, 'matching belongs to watch-key')
  assert.match(body, /fs\.existsSync\(k\.path\)/, 'and the file must really be there')
  assert.match(body, /kept: true/, 'the caller must be able to tell SAVED from CACHED')
  assert.doesNotMatch(body, /lastUsedAt/, 'a kept file has no eviction clock')
  assert.doesNotMatch(body, /videoCacheIndex\.set/, 'a keep miss must never prune the CACHE index')
  assert.doesNotMatch(body, /videoKeepIndex\.set/, 'and a read must never rewrite the keep index')
})

test('a finished download is marked for the episode, not just the whole series', () => {
  const at = MAIN.indexOf("_instantMark(_titleKeyOf(d.meta.detail), 'device')")
  assert.ok(at > 0)
  const after = MAIN.slice(at, at + 700)
  assert.match(after, /watchKeys\.keepEntryKey\(/)
  assert.match(after, /_instantMark\(epKey, 'device'\)/,
    'marking only the title made a whole series read SAVED off one episode')
})

test('keeping a file mid-play records the identity it already had', () => {
  const at = MAIN.indexOf("ipcMain.handle('video-keep-file'")
  const body = MAIN.slice(at, MAIN.indexOf('\n})', at))
  assert.match(body, /watchKey: _videoSession\.cacheKey \|\| null/,
    'without this the saved file can never be found again by key')
  assert.match(body, /titleKey: _titleKeyOf\(_videoSession\.cacheMeta\)/)
})
