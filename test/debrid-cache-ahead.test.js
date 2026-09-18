'use strict'
// "The next episode doesn't cache at all."
//
// Every caching mechanism in main needs a WebTorrent streamer. RealDebrid is
// tried FIRST whenever an account is configured and never builds one — it
// resolves an HTTPS link and plays it. So for anyone with a debrid account
// nothing was cached: not the next episode, and not even the episode being
// watched for a later rewatch.
//
// _debridCacheAhead pulls the next episode of the pack down over HTTP on the
// same tick the torrent path uses. The "don't cache the same episode from
// another source" rule is a key comparison and nothing else: the cache is
// keyed by WHAT the episode is, never by which release served it.
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')
const fs = require('fs')
const path = require('path')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const videoCache = require('../src/video-cache')
const watchKeys = require('../src/watch-key')

const FILES = [
  { index: 11, name: 'S01E05.mkv', episode: 5, length: 1000, current: true },
  { index: 12, name: 'S01E06.mkv', episode: 6, length: 1000 },
  { index: 13, name: 'S01E07.mkv', episode: 7, length: 1000 },
]

function harness(opts = {}) {
  const calls = []
  const written = []
  const renamed = []
  const added = []
  const existing = opts.entries || []
  const partsOnDisk = new Set(opts.parts || [])

  const chunks = opts.chunks === undefined ? [Buffer.from('abcd')] : opts.chunks
  let readAt = 0

  const ctx = {
    console: { warn() {}, error() {}, log() {} },
    Promise, Date, Number, String, Boolean, Math, JSON, Array, Object, Error, Buffer,
    setTimeout, clearTimeout, AbortController,
    DRY_RUN: opts.dryRun === true,
    videoCache, watchKeys,
    _videoSession: opts.session,
    _videoSettings: () => ({ videoCacheGB: opts.capGB === undefined ? 15 : opts.capGB }),
    _videoCacheRoot: () => '/cache',
    _videoCacheEntries: () => existing,
    _videoCacheIndexAdd: e => { added.push(e); return opts.indexAdd === false ? false : true },
    debrid: () => ({
      packFiles: async (magnet, want) => { calls.push('packFiles'); return opts.files || FILES },
      linkForFile: async (magnet, index) => {
        calls.push('linkForFile:' + index)
        return opts.noLink ? null : 'https://rd.example/' + index
      },
    }),
    _rdFetch: async (url, init) => {
      calls.push('fetch:' + url)
      if (opts.fetchFails) throw new Error('boom')
      return {
        ok: true, status: 200,
        body: { getReader: () => ({
          read: async () => {
            if (opts.readDelayMs) await new Promise(r => setTimeout(r, opts.readDelayMs))
            return readAt < chunks.length ? { done: false, value: chunks[readAt++] } : { done: true }
          },
          cancel: () => {},
        }) },
      }
    },
    path: { join: (...a) => a.join('/') },
    fs: {
      existsSync: p => partsOnDisk.has(p),
      unlinkSync: p => { calls.push('unlink:' + p) },
      createWriteStream: p => {
        written.push(p)
        return {
          write: b => { written.push('bytes:' + b.length); return true },
          once() {},
          end: cb => cb(null),
        }
      },
      promises: {
        mkdir: async () => { calls.push('mkdir') },
        rename: async (a, b) => { renamed.push([a, b]) },
      },
    },
  }
  vm.createContext(ctx)
  const start = MAIN.indexOf('let _debridAhead = null')
  assert.ok(start > 0, '_debridAhead not found in main.js')
  const end = MAIN.indexOf('function _videoTeardown()')
  vm.runInContext(MAIN.slice(start, end), ctx)
  // `let` at the top level of a vm script is lexical, not a property of the
  // sandbox object, so the in-flight slot is read the way the code itself sees
  // it rather than off ctx.
  const ahead = () => vm.runInContext('_debridAhead', ctx)
  return { ctx, calls, written, renamed, added, ahead }
}

const session = (over = {}) => Object.assign({
  streamer: null,
  debrid: { magnet: 'magnet:?xt=urn:btih:abc', want: { season: 1, episode: 5 } },
  cacheKey: 'tv:1396:s1e5',
  cacheMeta: { type: 'tv', id: 1396, title: 'Breaking Bad', poster: null, season: 1, episode: 5 },
  cacheSaved: false, cacheSaving: false,
}, over)

const settle = () => new Promise(r => setTimeout(r, 20))

test('one tick pulls the NEXT episode down and files it under that episode', async () => {
  const h = harness({ session: session() })
  h.ctx._debridCacheAhead()
  await settle()
  assert.deepStrictEqual(h.calls.filter(c => c.startsWith('linkForFile')), ['linkForFile:12'],
    'exactly the episode after the one playing')
  assert.ok(h.written.includes('/cache/tv_1396_s1e6.mkv.part'), 'written to a .part first: ' + h.written)
  assert.deepStrictEqual(h.renamed, [['/cache/tv_1396_s1e6.mkv.part', '/cache/tv_1396_s1e6.mkv']],
    'and only named when whole')
  assert.strictEqual(h.added.length, 1)
  assert.strictEqual(h.added[0].key, 'tv:1396:s1e6')
  assert.strictEqual(h.added[0].meta.episode, 6, 'the entry says which episode it is')
  assert.strictEqual(h.added[0].sizeBytes, 4)
})

test('the key it files under is the app-wide watch key, not a source-specific name', () => {
  assert.strictEqual(watchKeys.watchKey('tv', 1396, 1, 6), 'tv:1396:s1e6')
})

test('an episode already in the cache is never fetched again, whatever source it came from', async () => {
  // The held entry says "a different release entirely" — same episode.
  const h = harness({
    session: session(),
    entries: [{ key: 'tv:1396:s1e6', path: '/cache/from-a-torrent.mkv', sizeBytes: 900 }],
  })
  h.ctx._debridCacheAhead()
  await settle()
  assert.deepStrictEqual(h.calls.filter(c => c.startsWith('linkForFile')), [],
    'it already has episode 6; the source is irrelevant')
  assert.deepStrictEqual(h.renamed, [])
  assert.strictEqual(h.added.length, 0)
})

test('a pull already in flight is not started twice', async () => {
  const h = harness({ session: session() })
  h.ctx._debridCacheAhead()
  h.ctx._debridCacheAhead()
  h.ctx._debridCacheAhead()
  await settle()
  assert.strictEqual(h.calls.filter(c => c === 'packFiles').length, 1)
  assert.strictEqual(h.added.length, 1)
})

test('a .part left on disk means someone is already pulling it', async () => {
  const h = harness({ session: session(), parts: ['/cache/tv_1396_s1e6.mkv.part'] })
  h.ctx._debridCacheAhead()
  await settle()
  assert.deepStrictEqual(h.calls.filter(c => c.startsWith('linkForFile')), [])
})

test('a dry run makes no RealDebrid call and writes nothing', async () => {
  const h = harness({ session: session(), dryRun: true })
  h.ctx._debridCacheAhead()
  await settle()
  assert.deepStrictEqual(h.calls, [], 'a dry run touches nothing at all')
  assert.deepStrictEqual(h.written, [])
  assert.deepStrictEqual(h.renamed, [])
})

test('the cache being switched off means nothing is pulled', async () => {
  const h = harness({ session: session(), capGB: 0 })
  h.ctx._debridCacheAhead()
  await settle()
  assert.deepStrictEqual(h.calls, [])
})

test('an episode that could never fit in the cache is refused before the download', async () => {
  const h = harness({
    session: session(),
    capGB: 0.0000001,   // smaller than the file
    files: [FILES[0], Object.assign({}, FILES[1], { length: 900 * 1024 * 1024 })],
  })
  h.ctx._debridCacheAhead()
  await settle()
  assert.deepStrictEqual(h.calls.filter(c => c.startsWith('linkForFile')), [])
})

test('the last episode of a pack has nothing after it', async () => {
  const h = harness({
    session: session(),
    files: [{ index: 11, name: 'a.mkv', episode: 5, length: 10 },
      { index: 12, name: 'b.mkv', episode: 6, length: 10, current: true }],
  })
  h.ctx._debridCacheAhead()
  await settle()
  assert.deepStrictEqual(h.calls.filter(c => c.startsWith('linkForFile')), [])
})

test('a play with no identity cannot name the next episode, so it does not guess', async () => {
  const h = harness({ session: session({ cacheMeta: null }) })
  h.ctx._debridCacheAhead()
  await settle()
  assert.deepStrictEqual(h.calls, [])
})

test('a failed fetch cleans up its half-written file and lets the next tick retry', async () => {
  const h = harness({ session: session(), fetchFails: true })
  h.ctx._debridCacheAhead()
  await settle()
  assert.ok(h.calls.some(c => c.startsWith('unlink:/cache/tv_1396_s1e6.mkv.part')),
    'the .part is removed: ' + h.calls.join(','))
  assert.strictEqual(h.ahead(), null, 'and the slot is free for the next tick')
})

test('teardown aborts a pull in progress and leaves no half-written file behind', async () => {
  // A slow body, so the pull is genuinely mid-flight when the watch ends.
  const h = harness({
    session: session(),
    chunks: [Buffer.from('ab'), Buffer.from('cd'), Buffer.from('ef')],
    readDelayMs: 40,
  })
  h.ctx._debridCacheAhead()
  await new Promise(r => setTimeout(r, 60))
  const partBefore = (h.ahead() || {}).part
  assert.strictEqual(partBefore, '/cache/tv_1396_s1e6.mkv.part', 'a pull really is in flight')
  h.ctx._debridCacheAheadStop()
  assert.strictEqual(h.ahead(), null, 'the slot is free, so the next watch can pull again')
  assert.ok(h.calls.some(c => c === 'unlink:' + partBefore),
    'the half-written file is removed, never left posing as a cached episode')
  await new Promise(r => setTimeout(r, 200))
  assert.deepStrictEqual(h.renamed, [], 'an aborted pull never becomes a cached episode')
  assert.strictEqual(h.added.length, 0)
})

// ── the tick reaches this at all ────────────────────────────────────────────

test('the pack-chain tick routes a debrid play to the cache-ahead', () => {
  const reached = []
  const ctx = {
    console: { warn() {} },
    _videoSession: { streamer: null, debrid: { magnet: 'm' } },
    _debridCacheAhead: () => reached.push('ahead'),
    _maybeCacheCurrentFile: () => reached.push('current'),
  }
  vm.createContext(ctx)
  const start = MAIN.indexOf('const PACK_CHAIN_TICK_MS')
  const end = MAIN.indexOf('\n}', MAIN.indexOf('function _maybeChainPackDownloads()')) + 2
  vm.runInContext(MAIN.slice(start, end), ctx)
  ctx._maybeChainPackDownloads()
  assert.deepStrictEqual(reached, ['ahead'])
})

test('a debrid play starts the tick that does the caching', () => {
  // Both debrid play paths — the in-page one and the mpv one — have to arm it,
  // or the whole mechanism never runs for a debrid watch.
  const hits = MAIN.split('_startPackChainTick()').length - 1
  assert.ok(hits >= 3, 'expected the tick to be armed by the torrent path and both debrid paths, saw ' + hits)
})

// ── and the payoff: clicking that episode opens the local file ──────────────

const { runHandler } = require('./helpers/lift-ipc')

test('switching to an episode already cached plays the file on disk, with no RealDebrid call', async () => {
  const session = {
    token: 1, cacheKey: 'tv:1396:s1e5', cacheMeta: { type: 'tv', id: 1396, season: 1, episode: 5 },
    cacheSaved: true, cacheSaving: false,
    streamer: null, debrid: { magnet: 'magnet:?xt=urn:btih:abc', want: { season: 1, episode: 5 } },
  }
  const loaded = []
  const rd = []
  const { result } = await runHandler('video-pack-select', {
    args: { index: 12, cacheKey: 'tv:1396:s1e6', cacheMeta: { type: 'tv', id: 1396, season: 1, episode: 6 } },
    globals: {
      _videoSession: session,
      safeSend() {},
      _videoCacheEntries: () => [{ key: 'tv:1396:s1e6', path: '/cache/tv_1396_s1e6.mkv', sizeBytes: 10 }],
      fs: { existsSync: () => true },
      _loadIntoActivePlayer: async url => { loaded.push(url); return true },
      debrid: () => ({
        packFiles: async () => FILES.map(f => Object.assign({}, f, { current: f.index === 11 })),
        linkForFile: async i => { rd.push(i); return 'https://rd.example/' + i },
      }),
      createDebridProxy: () => { rd.push('proxy'); return { serve: async () => 'http://relay' } },
    },
  })
  assert.deepStrictEqual(rd, [], 'nothing was asked of RealDebrid — the file is right here')
  assert.deepStrictEqual(loaded, ['/cache/tv_1396_s1e6.mkv'])
  assert.strictEqual(result && result.ok, true)
  assert.strictEqual(result.local, true)
})
