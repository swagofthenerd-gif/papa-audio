'use strict'
const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const { EventEmitter } = require('node:events')
const { Readable } = require('node:stream')
const { TorrentStreamer } = require('../torrent-stream')

function fakeTorrent({ name = 'Movie (2010) 1080p.mp4', length = 1000 } = {}) {
  const torrent = new EventEmitter()
  torrent.files = [{
    name,
    length,
    createReadStream: () => new Readable(),
  }]
  torrent.length = length
  torrent.downloaded = 0
  torrent.downloadSpeed = 0
  torrent.createServer = () => http.createServer()
  // WebTorrent's real signature is destroy(opts, cb) — the streamer passes
  // { destroyStore: true } — but destroy(cb) alone must keep working too.
  torrent.destroy = (opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = null }
    torrent.destroyed = true
    torrent.destroyOpts = opts
    torrent.destroyCalls = (torrent.destroyCalls || 0) + 1
    torrent.emit('close')
    if (cb) cb()
  }
  return torrent
}

function readyClient(torrent) {
  return {
    // WebTorrent's real signature is add(magnet, opts, cb); the streamer now
    // passes an explicit store path, so the callback is the third argument.
    add(magnet, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      this.opts = opts
      this.magnet = magnet
      queueMicrotask(() => cb(torrent))
      return torrent
    },
  }
}

test('buildFileUrl encodes the file name', () => {
  assert.strictEqual(
    TorrentStreamer.buildFileUrl(8080, 0, 'Movie (2010) 1080p.mp4'),
    'http://127.0.0.1:8080/0/Movie%20(2010)%201080p.mp4'
  )
})

test('start() resolves with a servable URL', async () => {
  const torrent = fakeTorrent()
  const client = readyClient(torrent)
  const streamer = new TorrentStreamer({ client })
  const result = await streamer.start({ magnet: 'magnet:?xt=urn:btih:AAA', fileIndex: 0 })
  assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+\/0\//)
  streamer.stop()
})

test('start() forwards torrent download to progress events', async () => {
  const torrent = fakeTorrent()
  torrent.downloaded = 500
  torrent.length = 1000
  torrent.downloadSpeed = 100
  const client = readyClient(torrent)
  const streamer = new TorrentStreamer({ client })
  const progress = []
  streamer.on('progress', (p) => progress.push(p))
  await streamer.start({ magnet: 'magnet:?xt=urn:btih:AAA' })
  torrent.emit('download', 100)
  assert.strictEqual(progress.length, 1)
  assert.deepStrictEqual(progress[0], {
    phase: 'download', downloaded: 500, total: 1000, speed: 100, percent: 0.5, peers: 0,
  })
  streamer.stop()
})

// 'download' fires once per received chunk — hundreds a second on a healthy
// swarm — and every progress emit crosses the IPC bridge to the renderer. A
// progress bar needs ~4/s. Trailing-edge: the last chunk of a burst always
// reports, with values read fresh from the torrent at emit time, so the bytes
// shown are exact even though most chunks are swallowed.
test('a burst of chunks is thinned to one leading and one trailing report', async () => {
  const torrent = fakeTorrent()
  torrent.length = 1000
  const client = readyClient(torrent)
  const streamer = new TorrentStreamer({ client, progressThrottleMs: 50 })
  const progress = []
  streamer.on('progress', p => progress.push(p))
  await streamer.start({ magnet: 'magnet:?xt=urn:btih:AAA' })
  torrent.downloaded = 100
  for (let i = 0; i < 300; i++) torrent.emit('download', 1)
  assert.strictEqual(progress.length, 1, 'three hundred chunks in one tick is one report')
  // The trailing emit carries the bytes at fire time, not at the first chunk.
  torrent.downloaded = 700
  await new Promise(r => setTimeout(r, 120))
  assert.strictEqual(progress.length, 2, 'the end of the burst still reports')
  assert.strictEqual(progress[1].downloaded, 700, 'with the accounting exact')
  streamer.stop()
})

test('stop() during a burst does not leave the trailing report armed', async () => {
  const torrent = fakeTorrent()
  const client = readyClient(torrent)
  const streamer = new TorrentStreamer({ client, progressThrottleMs: 50 })
  const progress = []
  streamer.on('progress', p => progress.push(p))
  await streamer.start({ magnet: 'magnet:?xt=urn:btih:AAA' })
  torrent.emit('download', 1)
  torrent.emit('download', 1)
  streamer.stop()
  assert.strictEqual(streamer._progressTimer, null)
  const before = progress.length
  await new Promise(r => setTimeout(r, 120))
  assert.strictEqual(progress.length, before, 'nothing reports after stop()')
})

test('start() rejects and emits NO_SEEDERS when the client never calls back', async () => {
  const torrent = fakeTorrent()
  const client = { add: () => torrent }
  const streamer = new TorrentStreamer({ client, timeoutMs: 10 })
  const errors = []
  streamer.on('error', (e) => errors.push(e))
  await assert.rejects(
    streamer.start({ magnet: 'magnet:?xt=urn:btih:AAA' }),
    { code: 'NO_SEEDERS' }
  )
  assert.strictEqual(errors.length, 1)
  assert.strictEqual(errors[0].code, 'NO_SEEDERS')
  assert.strictEqual(torrent.destroyed, true)
})

test('start() rejects NO_SEEDERS with no error listener (no crash)', async () => {
  const torrent = fakeTorrent()
  const client = { add: () => torrent }
  const streamer = new TorrentStreamer({ client, timeoutMs: 10 })
  await assert.rejects(
    streamer.start({ magnet: 'magnet:?xt=urn:btih:AAA' }),
    { code: 'NO_SEEDERS' }
  )
})

test('stop() before ready settles the pending start() with STOPPED, no ready', async () => {
  const torrent = fakeTorrent()
  let readyCb
  const client = {
    // WebTorrent's real signature is add(magnet, opts, cb); the streamer now
    // passes an explicit store path, so the callback is the third argument.
    add(magnet, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      this.opts = opts
      readyCb = cb
      return torrent
    },
  }
  const streamer = new TorrentStreamer({ client, timeoutMs: 50 })
  let ready = false
  streamer.on('ready', () => { ready = true })
  const p = streamer.start({ magnet: 'magnet:?xt=urn:btih:AAA' })
  streamer.stop()
  await assert.rejects(p, { code: 'STOPPED' })
  // The late 'ready' callback must be swallowed by the _settled guard.
  readyCb(torrent)
  await new Promise((r) => setTimeout(r, 80))
  assert.strictEqual(ready, false)
  assert.strictEqual(torrent.destroyCalls, 1)
})

// ── Re-adding the same magnet ───────────────────────────────────────────────
// destroy() is asynchronous, and a dying torrent stays in client.torrents
// until its 'close' fires. Adding the same magnet in that window raises
// WebTorrent's duplicate error — which surfaces much later, dressed up as a
// torrent that found nobody. Play, stop, play the same film again quickly and
// a release with hundreds of seeders read "Nobody is sharing this".
test('re-adding a magnet whose destroy is in flight waits for the close', async () => {
  const dying = new EventEmitter()
  dying.destroyed = true
  const fresh = fakeTorrent()
  let added = 0
  const client = {
    get: () => dying,
    add(magnet, opts, cb) {
      added++
      queueMicrotask(() => cb(fresh))
      return fresh
    },
  }
  const streamer = new TorrentStreamer({ client, timeoutMs: 500 })
  const p = streamer.start({ magnet: 'magnet:?xt=urn:btih:AAA' })
  await new Promise(r => setTimeout(r, 20))
  assert.strictEqual(added, 0, 'must not add while the old torrent is still dying')
  dying.emit('close')
  const { url } = await p
  assert.strictEqual(added, 1)
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\//)
  streamer.stop()
})

// A live torrent for the same magnet — added by another part of the app — is
// already connected to the swarm, so reusing it is the fastest start there is.
test('a live torrent for the same magnet is reused, never re-added', async () => {
  const torrent = fakeTorrent()
  torrent.ready = true
  let added = 0
  const client = { get: () => torrent, add() { added++ } }
  const streamer = new TorrentStreamer({ client })
  const { url } = await streamer.start({ magnet: 'magnet:?xt=urn:btih:AAA' })
  assert.strictEqual(added, 0, 'the duplicate error must never be provoked')
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/0\//)
  streamer.stop()
})

// A reused torrent belongs to whoever added it. Destroying it — let alone with
// destroyStore — on our stop() would delete another consumer's downloaded data.
test('stop() on a REUSED torrent never destroys it or its store', async () => {
  const torrent = fakeTorrent()
  torrent.ready = true
  const client = { get: () => torrent, add() { throw new Error('must not add') } }
  const streamer = new TorrentStreamer({ client })
  await streamer.start({ magnet: 'magnet:?xt=urn:btih:AAA' })
  assert.strictEqual(streamer._ownsTorrent, false, 'a reused torrent is not owned')
  assert.strictEqual(torrent.listenerCount('download'), 1, 'our download listener is attached')
  streamer.stop()
  assert.strictEqual(torrent.destroyed, undefined, 'a reused torrent is never destroyed')
  assert.strictEqual(torrent.listenerCount('download'), 0, 'only our listener is removed')
})

// The mirror of the above: a torrent this streamer created IS ours to destroy,
// store and all.
test('stop() on an OWNED torrent destroys it with destroyStore', async () => {
  const torrent = fakeTorrent()
  const client = readyClient(torrent)
  const streamer = new TorrentStreamer({ client })
  await streamer.start({ magnet: 'magnet:?xt=urn:btih:AAA' })
  assert.strictEqual(streamer._ownsTorrent, true, 'a created torrent is owned')
  streamer.stop()
  assert.strictEqual(torrent.destroyCalls, 1, 'an owned torrent is destroyed')
  assert.deepStrictEqual(torrent.destroyOpts, { destroyStore: true }, 'store destroyed too')
})

// A reused torrent stopped before it ever fired 'ready' must have its pending
// once('ready') handler removed, or the closure (and the torrent) leaks.
test('stop() before a reused torrent is ready removes the ready handler', async () => {
  const torrent = fakeTorrent()
  torrent.ready = false
  const client = { get: () => torrent, add() { throw new Error('must not add') } }
  const streamer = new TorrentStreamer({ client, timeoutMs: 500 })
  const p = streamer.start({ magnet: 'magnet:?xt=urn:btih:AAA' })
  assert.strictEqual(torrent.listenerCount('ready'), 1, 'a ready handler is pending')
  streamer.stop()
  await assert.rejects(p, { code: 'STOPPED' })
  assert.strictEqual(torrent.listenerCount('ready'), 0, 'the pending ready handler is removed')
  assert.strictEqual(torrent.destroyed, undefined, 'the reused torrent is not destroyed')
})

test('stop() while waiting on a dying torrent never adds at all', async () => {
  const dying = new EventEmitter()
  dying.destroyed = true
  let added = 0
  const client = { get: () => dying, add() { added++ } }
  const streamer = new TorrentStreamer({ client, timeoutMs: 500 })
  const p = streamer.start({ magnet: 'magnet:?xt=urn:btih:AAA' })
  streamer.stop()
  await assert.rejects(p, { code: 'STOPPED' })
  dying.emit('close')
  assert.strictEqual(added, 0, 'a settled start must not resurrect')
})

test("start() emits 'ready' with { url }", async () => {
  const torrent = fakeTorrent()
  const client = readyClient(torrent)
  const streamer = new TorrentStreamer({ client })
  const events = []
  streamer.on('ready', (e) => events.push(e))
  const result = await streamer.start({ magnet: 'magnet:?xt=urn:btih:AAA' })
  assert.strictEqual(events.length, 1)
  assert.deepStrictEqual(events[0], { url: result.url })
  streamer.stop()
})

test('stop() is idempotent and does not throw', async () => {
  const torrent = fakeTorrent()
  const client = readyClient(torrent)
  const streamer = new TorrentStreamer({ client })
  await streamer.start({ magnet: 'magnet:?xt=urn:btih:AAA' })
  assert.doesNotThrow(() => streamer.stop())
  assert.doesNotThrow(() => streamer.stop())
})

test('stop() closes the server, destroys the torrent and removes the download listener', async () => {
  const torrent = fakeTorrent()
  let closed = 0
  const server = {
    once() {},
    listen(port, host, cb) { cb() },
    address() { return { port: 1234 } },
    close(cb) { closed++; if (cb) cb() },
  }
  torrent.createServer = () => server
  const client = readyClient(torrent)
  const streamer = new TorrentStreamer({ client })
  await streamer.start({ magnet: 'magnet:?xt=urn:btih:AAA' })
  assert.strictEqual(torrent.listenerCount('download'), 1, 'download listener attached on ready')
  streamer.stop()
  assert.strictEqual(closed, 1, 'server closed exactly once')
  assert.strictEqual(streamer._server, null, 'server reference dropped')
  assert.strictEqual(torrent.listenerCount('download'), 0, 'download listener removed')
  assert.strictEqual(torrent.destroyCalls, 1, 'torrent destroyed once')
  streamer.stop()
  assert.strictEqual(torrent.destroyCalls, 1, 'second stop() does not re-destroy')
  assert.strictEqual(closed, 1, 'second stop() does not re-close')
})

// ── Streaming performance: file choice, selection, prebuffer ────────────────
{
  const { pickVideoFile, headBytesReady } = require('../torrent-stream')

  // Index 0 was hardcoded. In a real release pack index 0 is very often a
  // .txt or .nfo, so playback either failed or streamed the wrong file.
  test('pickVideoFile takes the largest real video, not index 0', () => {
    assert.strictEqual(pickVideoFile([
      { name: 'RARBG.txt', length: 30 },
      { name: 'Movie.2010.1080p.mkv', length: 9e9 },
      { name: 'Movie.nfo', length: 100 },
    ]), 1)
  })

  // A "sample" is a real video file, just not the one anybody wants — and it
  // is small enough to look like a fast start while playing the wrong thing.
  test('pickVideoFile skips samples, trailers and extras', () => {
    assert.strictEqual(pickVideoFile([
      { name: 'sample.mkv', length: 5e7 },
      { name: 'Movie.1080p.mkv', length: 9e9 },
    ]), 1)
    assert.strictEqual(pickVideoFile([
      { name: 'Movie-trailer.mp4', length: 1e8 },
      { name: 'Movie.mp4', length: 8e9 },
    ]), 1)
  })

  test('pickVideoFile falls back to the largest file when nothing looks like video', () => {
    assert.strictEqual(pickVideoFile([{ name: 'a.nfo', length: 10 }, { name: 'b.bin', length: 500 }]), 1)
  })

  test('pickVideoFile returns -1 for an empty list', () => {
    assert.strictEqual(pickVideoFile([]), -1)
    assert.strictEqual(pickVideoFile(null), -1)
  })

  test('a sample-only pack still yields the sample rather than nothing', () => {
    assert.strictEqual(pickVideoFile([{ name: 'sample.mkv', length: 5e7 }]), 0)
  })

  test('headBytesReady counts only contiguous pieces from the head', () => {
    const torrent = {
      pieceLength: 1000,
      bitfield: { get: i => i === 0 || i === 1 || i === 5 },
    }
    const file = { _startPiece: 0, _endPiece: 9 }
    // Pieces 0 and 1 are contiguous; piece 5 is useless to a sequential reader.
    assert.strictEqual(headBytesReady(torrent, file), 2000)
  })

  test('headBytesReady is 0 when progress cannot be measured', () => {
    assert.strictEqual(headBytesReady(null, null), 0)
    assert.strictEqual(headBytesReady({ pieceLength: 0 }, { _startPiece: 0, _endPiece: 1 }), 0)
    assert.strictEqual(headBytesReady({ pieceLength: 100 }, { _startPiece: 0, _endPiece: 1 }), 0)
  })

  function packTorrent(files, { pieceLength = 1000, have = () => false } = {}) {
    const torrent = new EventEmitter()
    torrent.files = files.map(f => Object.assign({
      createReadStream: () => new Readable(),
      select () { this.selected = true },
      deselect () { this.deselected = true },
    }, f))
    torrent.length = files.reduce((n, f) => n + f.length, 0)
    torrent.downloaded = 0
    torrent.downloadSpeed = 0
    torrent.numPeers = 4
    torrent.pieceLength = pieceLength
    torrent.bitfield = { get: have }
    torrent.selectCalls = []
    torrent.criticalCalls = []
    torrent.select = (s, e, p) => torrent.selectCalls.push([s, e, p])
    torrent.critical = (s, e) => torrent.criticalCalls.push([s, e])
    torrent.deselectCalls = []
    torrent.deselect = (s, e, p) => torrent.deselectCalls.push([s, e, p])
    torrent.pieces = new Array(Math.max(1, Math.ceil(torrent.length / pieceLength)))
    torrent.createServer = () => http.createServer()
    torrent.destroy = cb => { torrent.destroyed = true; if (cb) cb() }
    return torrent
  }

  test('the streamer serves the picked file, not the requested index', async () => {
    const torrent = packTorrent([
      { name: 'RARBG.txt', length: 30 },
      { name: 'Movie.1080p.mkv', length: 9000, _startPiece: 0, _endPiece: 8 },
    ])
    const streamer = new TorrentStreamer({ client: readyClient(torrent), prebufferBytes: 0 })
    const { url } = await streamer.start({ magnet: 'magnet:?xt=urn:btih:A', fileIndex: 0 })
    assert.match(url, /\/1\/Movie\.1080p\.mkv$/, 'the URL must point at the video, not the .txt')
    streamer.stop()
  })

  // A season pack would otherwise download every other episode in parallel
  // with the one being watched, splitting the connection for no benefit.
  test('every other file in the pack is deselected', async () => {
    const torrent = packTorrent([
      { name: 'E01.mkv', length: 100 },
      { name: 'E02.mkv', length: 9000, _startPiece: 0, _endPiece: 8 },
      { name: 'E03.mkv', length: 100 },
    ])
    const streamer = new TorrentStreamer({ client: readyClient(torrent), prebufferBytes: 0 })
    await streamer.start({ magnet: 'magnet:?xt=urn:btih:A', fileIndex: 1 })
    assert.strictEqual(torrent.files[0].deselected, true)
    assert.strictEqual(torrent.files[2].deselected, true)
    assert.strictEqual(torrent.files[1].selected, true)
    assert.ok(!torrent.files[1].deselected, 'the file being watched must stay selected')
    streamer.stop()
  })

  // Found live: WebTorrent's own constructor -- unless given a BEP53 `so`
  // option, which this client never passes -- makes its own selection
  // covering the WHOLE torrent at priority 0 before this class ever runs
  // (webtorrent/lib/torrent.js: "start off selecting the entire torrent with
  // low priority", torrent.select(0, pieces.length - 1, false)). Deselecting
  // individual files does not touch that entry -- it only matches an exact
  // (from, to, priority) triple, and the default one spans the whole torrent,
  // not any single file's range. Left alone, it does two things at once: (1)
  // silently downloads the entire pack in the background regardless of what
  // is playing, and (2) sits ahead of prefetchFile()'s own low-priority
  // selection in the scheduler (same priority, pushed first), so the swarm
  // works through the whole torrent from piece 0 before it ever reaches the
  // next episode's window. Confirmed against a live season pack: with the
  // current episode fully downloaded and idle peers holding the next
  // episode's data, prefetchFile() still pulled zero bytes in two minutes.
  test('the torrent-wide default selection is cancelled, not just per-file ones', async () => {
    const torrent = packTorrent([
      { name: 'E01.mkv', length: 100 },
      { name: 'E02.mkv', length: 9000, _startPiece: 0, _endPiece: 8 },
      { name: 'E03.mkv', length: 100 },
    ])
    const streamer = new TorrentStreamer({ client: readyClient(torrent), prebufferBytes: 0 })
    await streamer.start({ magnet: 'magnet:?xt=urn:btih:A', fileIndex: 1 })
    assert.deepStrictEqual(
      torrent.deselectCalls,
      [[0, torrent.pieces.length - 1, false]],
      'must cancel WebTorrent\'s own whole-torrent low-priority selection by its exact (from, to, priority)'
    )
    streamer.stop()
  })

  // WebTorrent's default is rarest-first, which is right for archiving and
  // wrong for playback: it scatters pieces so the player has nothing
  // contiguous to read.
  test('the head of the file is marked critical so it arrives in order', async () => {
    const torrent = packTorrent([{ name: 'M.mkv', length: 90000, _startPiece: 0, _endPiece: 89 }])
    const streamer = new TorrentStreamer({ client: readyClient(torrent), prebufferBytes: 5000, prebufferTimeoutMs: 300 })
    await streamer.start({ magnet: 'magnet:?xt=urn:btih:A' })
    assert.deepStrictEqual(torrent.selectCalls, [[0, 89, 1]], 'the whole file is selected at high priority')
    assert.deepStrictEqual(torrent.criticalCalls, [[0, 4]], '5000 bytes / 1000 per piece = 5 head pieces')
    streamer.stop()
  })

  // Starting mpv at zero bytes is what made playback look like it was
  // "buffering slowly": mpv opened, found nothing, and stalled on its own.
  test('ready is withheld until the head buffer is filled', async () => {
    let havePieces = 0
    const torrent = packTorrent(
      [{ name: 'M.mkv', length: 90000, _startPiece: 0, _endPiece: 89 }],
      { have: i => i < havePieces }
    )
    const streamer = new TorrentStreamer({ client: readyClient(torrent), prebufferBytes: 5000, prebufferTimeoutMs: 300 })
    let ready = false
    streamer.on('ready', () => { ready = true })
    const started = streamer.start({ magnet: 'magnet:?xt=urn:btih:A' })
    await new Promise(r => setTimeout(r, 50))
    assert.strictEqual(ready, false, 'must not start playing on an empty buffer')
    havePieces = 5
    await started
    assert.strictEqual(ready, true)
    streamer.stop()
  })

  test('prebuffer progress is reported so the wait is visible', async () => {
    let havePieces = 0
    const torrent = packTorrent(
      [{ name: 'M.mkv', length: 90000, _startPiece: 0, _endPiece: 89 }],
      { have: i => i < havePieces }
    )
    const streamer = new TorrentStreamer({ client: readyClient(torrent), prebufferBytes: 5000, prebufferTimeoutMs: 300 })
    const seen = []
    streamer.on('progress', p => seen.push(p))
    const started = streamer.start({ magnet: 'magnet:?xt=urn:btih:A' })
    await new Promise(r => setTimeout(r, 500))
    havePieces = 5
    await started
    const pre = seen.filter(p => p.phase === 'prebuffer')
    assert.ok(pre.length > 0, 'the prebuffer phase must report progress')
    assert.strictEqual(pre[0].peers, 4)
    streamer.stop()
  })

  // Waiting out the full deadline for a measurement that can never arrive
  // would be a guaranteed stall.
  test('an unmeasurable torrent starts immediately instead of waiting', async () => {
    const torrent = packTorrent([{ name: 'M.mkv', length: 9000, _startPiece: 0, _endPiece: 8 }])
    torrent.bitfield = null
    const streamer = new TorrentStreamer({ client: readyClient(torrent), prebufferBytes: 5000, prebufferTimeoutMs: 400 })
    const t = Date.now()
    await streamer.start({ magnet: 'magnet:?xt=urn:btih:A' })
    assert.ok(Date.now() - t < 1000, 'must not block on an unmeasurable torrent')
    streamer.stop()
  })

  test('stop() during prebuffer does not leave the poll running', async () => {
    const torrent = packTorrent([{ name: 'M.mkv', length: 90000, _startPiece: 0, _endPiece: 89 }])
    const streamer = new TorrentStreamer({ client: readyClient(torrent), prebufferBytes: 50000, prebufferTimeoutMs: 300 })
    const started = streamer.start({ magnet: 'magnet:?xt=urn:btih:A' }).catch(e => e)
    await new Promise(r => setTimeout(r, 50))
    streamer.stop()
    const err = await started
    assert.strictEqual(err.code, 'STOPPED')
    assert.strictEqual(streamer._prebufferTimer, null)
  })
}

// ── Season packs ────────────────────────────────────────────────────────────
// Dubbed anime is released almost exclusively as season and batch packs rather
// than per-episode, so a pack is usually the only dub there is. Taking the
// largest file out of a twelve-episode pack hands back an arbitrary episode,
// which is why packs are worthless without this.
{
  const { pickVideoFile, matchesWantedEpisode, episodeNumberOf } = require('../torrent-stream')

  test('the requested episode is found inside a pack, not the largest file', () => {
    const pack = [
      { name: '[G] Show - S01E01.mkv', length: 1e9 },
      { name: '[G] Show - S01E09.mkv', length: 9e8 },
      { name: '[G] Show - S01E28.mkv', length: 3e9 },
      { name: 'readme.txt', length: 100 },
    ]
    assert.strictEqual(pickVideoFile(pack, { episode: 9 }), 1)
    assert.strictEqual(pickVideoFile(pack, { episode: 28 }), 2)
    // With no episode wanted — a film — the largest is still right.
    assert.strictEqual(pickVideoFile(pack), 2)
  })

  test('a season mismatch rules an episode out', () => {
    assert.strictEqual(matchesWantedEpisode('Show S02E09.mkv', { season: 1, episode: 9 }), false)
    assert.strictEqual(matchesWantedEpisode('Show S01E09.mkv', { season: 1, episode: 9 }), true)
    // With no season in the name the episode number alone decides.
    assert.strictEqual(matchesWantedEpisode('Show - 09.mkv', { season: 1, episode: 9 }), true)
  })

  test('an episode number is bounded, so 9 never matches 109 or a year', () => {
    assert.strictEqual(matchesWantedEpisode('Show - 109.mkv', { episode: 9 }), false)
    assert.strictEqual(matchesWantedEpisode('Show 2009 1080p.mkv', { episode: 9 }), false)
    assert.strictEqual(matchesWantedEpisode('Show - 09v2.mkv', { episode: 9 }), true)
  })

  test('several versions of the same episode resolve to the largest', () => {
    const pack = [
      { name: '[G] Show - 09 [480p].mkv', length: 3e8 },
      { name: '[G] Show - 09 [1080p].mkv', length: 2e9 },
    ]
    assert.strictEqual(pickVideoFile(pack, { episode: 9 }), 1)
  })

  test('an episode missing from the pack falls back rather than failing', () => {
    const pack = [{ name: '[G] Show - S01E01.mkv', length: 1e9 }]
    assert.strictEqual(pickVideoFile(pack, { episode: 99 }), 0)
  })

  test('episode numbers are read from either naming convention', () => {
    assert.strictEqual(episodeNumberOf('[G] Show - S01E09.mkv'), 9)
    assert.strictEqual(episodeNumberOf('[G] Show - 09 [1080p].mkv'), 9)
    assert.strictEqual(episodeNumberOf('[G] Show E28.mkv'), 28)
    // A four-digit number in a filename is a year far more often than an episode.
    assert.strictEqual(episodeNumberOf('Movie 2009 1080p.mkv'), null)
    assert.strictEqual(episodeNumberOf('readme.mkv'), null)
  })

  // Found live: a batch pack's ending-theme clip named "...[NCED1 Ver.2]..."
  // parsed as episode 2 — the "Ver.2" revision tag satisfied the bare digit
  // regex — and outranked the real episode 2 file in files()'s sort, so
  // prefetchFile() fetched the ending theme instead of the next episode.
  test('non-credit openings/endings and version tags are never read as an episode number', () => {
    assert.strictEqual(episodeNumberOf('[G] Show [NCED1 Ver.2][1080p].mkv'), null)
    assert.strictEqual(episodeNumberOf('[G] Show [NCOP][1080p].mkv'), null)
    assert.strictEqual(episodeNumberOf('[G] Show - 09 Ver.2 [1080p].mkv'), 9)
    assert.strictEqual(episodeNumberOf('[G] Show [OVA][1080p].mkv'), null)
    assert.strictEqual(matchesWantedEpisode('[G] Show [NCED1 Ver.2][1080p].mkv', { episode: 2 }), false)
  })

  test('the streamer is told which episode to look for', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'torrent-stream.js'), 'utf8')
    assert.match(src, /async start\(\{ magnet, fileIndex = 0, season = null, episode = null \} = \{\}\)/)
    // Captured before stop(), which clears it.
    assert.match(src, /const want = episode != null[\s\S]*?this\.stop\(\)[\s\S]*?this\._want = want/)
    assert.match(src, /pickVideoFile\(files, this\._want\)/)
  })
}


// ── Pack episode listing and switching ─────────────────────────────────────
// A season pack already holds every episode, so switching between them is a
// file change on a torrent that is already running — same peers, no new
// resolve, no wait. That is what makes a full episode strip worth showing.
{
  function packTorrentWithFiles(names) {
    const torrent = new EventEmitter()
    torrent.files = names.map(name => ({
      name, length: 1e9,
      select () { this.sel = true },
      deselect () { this.sel = false },
      createReadStream: () => new Readable(),
      _startPiece: 0, _endPiece: 9,
    }))
    torrent.pieceLength = 1000
    torrent.bitfield = null
    torrent.select = () => {}
    torrent.critical = () => {}
    torrent.createServer = () => http.createServer()
    torrent.destroy = (opts, cb) => { if (typeof opts === 'function') opts(); else if (cb) cb() }
    return torrent
  }

  test('the pack listing is ordered by episode, unnumbered files last', async () => {
    const torrent = packTorrentWithFiles([
      '[G] Show - 03.mkv', 'OP creditless.mkv', '[G] Show - 01.mkv',
    ])
    const streamer = new TorrentStreamer({ client: readyClient(torrent), prebufferBytes: 0 })
    await streamer.start({ magnet: 'magnet:?xt=urn:btih:A', episode: 1 })
    const files = streamer.files()
    assert.deepStrictEqual(files.map(f => f.episode), [1, 3, null])
    assert.strictEqual(files[0].current, true, 'the episode being played is marked')
    streamer.stop()
  })

  // A complete-series batch: three seasons in subfolders, each numbered from
  // 01 again, with an Extras folder of creditless openings. Flattened by name
  // the strip read "1 1 2 2…"; grouped by folder it reads as three seasons.
  test('a multi-season batch is grouped by folder, seasons in torrent order, extras dropped', async () => {
    const torrent = packTorrentWithFiles([
      'TR_-_01.mkv', 'TR_-_02.mkv', 'S2_-_01.mkv', 'S2_-_02.mkv', 'NCOP_.mkv', 'EXT_-_01.mkv',
    ])
    const paths = [
      'Tokyo Revengers/Tokyo Revengers/TR_-_01.mkv',
      'Tokyo Revengers/Tokyo Revengers/TR_-_02.mkv',
      'Tokyo Revengers/Tokyo Revengers Seiya Kessen-hen/S2_-_01.mkv',
      'Tokyo Revengers/Tokyo Revengers Seiya Kessen-hen/S2_-_02.mkv',
      'Tokyo Revengers/Tokyo Revengers Seiya Kessen-hen/Extras/NCOP_.mkv',
      'Tokyo Revengers/Tokyo Revengers Seiya Kessen-hen/Extras/EXT_-_01.mkv',
    ]
    torrent.files.forEach((f, i) => { f.path = paths[i] })
    const streamer = new TorrentStreamer({ client: readyClient(torrent), prebufferBytes: 0 })
    await streamer.start({ magnet: 'magnet:?xt=urn:btih:A', episode: 1 })
    const files = streamer.files()
    // Extras are gone entirely: the folder marker lives in the path, and the
    // creditless-opening clip is excluded by name even outside that folder.
    assert.deepStrictEqual(files.map(f => f.episode), [1, 2, 1, 2])
    assert.deepStrictEqual(files.map(f => f.group), [
      'Tokyo Revengers', 'Tokyo Revengers',
      'Tokyo Revengers Seiya Kessen-hen', 'Tokyo Revengers Seiya Kessen-hen',
    ])
    streamer.stop()
  })

  test('selecting another file returns a URL without restarting the torrent', async () => {
    const torrent = packTorrentWithFiles(['[G] Show - 01.mkv', '[G] Show - 02.mkv'])
    const streamer = new TorrentStreamer({ client: readyClient(torrent), prebufferBytes: 0 })
    await streamer.start({ magnet: 'magnet:?xt=urn:btih:A', episode: 1 })
    const url = streamer.selectFile(1)
    assert.match(url, /\/1\/.*Show.*02/)
    assert.strictEqual(torrent.files[1].sel, true, 'the new file is prioritised')
    assert.strictEqual(torrent.files[0].sel, false, 'the old one is dropped')
    assert.strictEqual(streamer.files().find(f => f.current).episode, 2)
    streamer.stop()
  })

  test('selecting a file that does not exist returns null', async () => {
    const torrent = packTorrentWithFiles(['a.mkv'])
    const streamer = new TorrentStreamer({ client: readyClient(torrent), prebufferBytes: 0 })
    await streamer.start({ magnet: 'magnet:?xt=urn:btih:A' })
    assert.strictEqual(streamer.selectFile(99), null)
    streamer.stop()
  })

  test('files() is empty before anything is streaming', () => {
    const streamer = new TorrentStreamer({ client: { add () {} } })
    assert.deepStrictEqual(streamer.files(), [])
  })

  // destroy() is asynchronous and on a pack can outlive the process; the
  // directory is removed directly as well so an immediate exit cannot leak it.
  test('the cache directory is removed without waiting on destroy', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'torrent-stream.js'), 'utf8')
    const stop = src.slice(src.indexOf('\n  stop() {'))
    assert.match(stop, /destroyStore: true/)
    // Once in the callback, once directly, once on a timer.
    assert.ok((stop.match(/removeDir\(storeDir\)/g) || []).length >= 3)
  })
}

// ── Stream cache lifetime ───────────────────────────────────────────────────
// Streamed video is watched once. Without an explicit path WebTorrent writes
// into its own default under the system temp directory and nothing removes it,
// so every film ever streamed accumulates — on this machine /tmp is a tmpfs,
// so that reached 19 GB of RAM and playback stopped working entirely for want
// of space. That is the bug these pin.
{
  const fsx = require('node:fs')
  const osx = require('node:os')
  const pathx = require('node:path')
  const { DEFAULT_STREAM_ROOT, streamRoot, setStreamRoot, purgeOrphanStreams, newStreamDir } =
    require('../torrent-stream')
  const STREAM_ROOT = streamRoot()

  test('each stream gets its own directory under one known root', () => {
    const a = newStreamDir()
    const b = newStreamDir()
    assert.notStrictEqual(a, b, 'two streams must not share a directory')
    assert.ok(a.startsWith(streamRoot()))
    assert.ok(DEFAULT_STREAM_ROOT.startsWith(osx.tmpdir()))
    // The owning pid is in the name so a sweep can tell live from orphaned.
    assert.match(pathx.basename(a), new RegExp('^s-' + process.pid + '-'))
  })

  // The temporary directory is a tmpfs here, so the default puts the cache in
  // RAM. Pointing it at a disk has to actually move it.
  test('the cache root can be moved to a disk', () => {
    const target = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'papa-root-'))
    try {
      assert.strictEqual(setStreamRoot(target), target)
      assert.ok(newStreamDir().startsWith(target))
    } finally {
      setStreamRoot('')
      fsx.rmSync(target, { recursive: true, force: true })
    }
    assert.strictEqual(streamRoot(), DEFAULT_STREAM_ROOT, 'clearing it restores the default')
  })

  // An unmounted drive leaves an empty mountpoint that looks like a perfectly
  // good directory until something writes to it. Falling back beats failing
  // playback outright.
  test('an unwritable location falls back instead of breaking playback', () => {
    // A directory path whose parent is a regular file: creating it fails
    // immediately with ENOTDIR, which is the fast, deterministic stand-in for
    // a drive that is not mounted.
    const file = pathx.join(osx.tmpdir(), 'papa-not-a-dir-' + process.pid)
    fsx.writeFileSync(file, 'x')
    try {
      assert.strictEqual(setStreamRoot(pathx.join(file, 'cache')), DEFAULT_STREAM_ROOT)
      assert.strictEqual(streamRoot(), DEFAULT_STREAM_ROOT)
    } finally {
      setStreamRoot('')
      fsx.rmSync(file, { force: true })
    }
  })

  // Moving the cache must not strand whatever the old location still holds —
  // here that would be gigabytes sitting in RAM that nothing comes back for.
  test('the sweep still cleans the old location after a move', () => {
    const target = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'papa-root-'))
    const strandedInOldRoot = pathx.join(DEFAULT_STREAM_ROOT, 's-999997-stranded')
    fsx.mkdirSync(strandedInOldRoot, { recursive: true })
    fsx.writeFileSync(pathx.join(strandedInOldRoot, 'old.bin'), Buffer.alloc(4096))
    try {
      setStreamRoot(target)
      purgeOrphanStreams()
      assert.strictEqual(fsx.existsSync(strandedInOldRoot), false,
        'the previous cache location must still be swept')
    } finally {
      setStreamRoot('')
      fsx.rmSync(target, { recursive: true, force: true })
      fsx.rmSync(strandedInOldRoot, { recursive: true, force: true })
    }
  })

  test('the torrent is added with an explicit path it owns', () => {
    const src = fsx.readFileSync(pathx.join(__dirname, '..', 'torrent-stream.js'), 'utf8')
    // The add options are now built into addOpts (so the curated tracker list can
    // be merged into the announce list) but must still carry the explicit path —
    // without a path WebTorrent picks its own directory and nothing cleans it.
    assert.match(src, /const addOpts = \{ path: this\._storeDir \}/,
      'the stream store path must still be set explicitly')
    assert.match(src, /this\.client\.add\(magnet, addOpts/,
      'the torrent is added with the owned-path options')
  })

  // destroyStore is the whole point: without it the pieces stay on disk after
  // the torrent object is gone.
  test('stopping destroys the store and removes the directory', () => {
    const src = fsx.readFileSync(pathx.join(__dirname, '..', 'torrent-stream.js'), 'utf8')
    const stop = src.slice(src.indexOf('\n  stop() {'))
    assert.match(stop, /destroyStore: true/)
    assert.match(stop, /removeDir\(storeDir\)/)
  })

  test('a sweep removes an orphan whose process is gone', () => {
    const dead = pathx.join(STREAM_ROOT, 's-999998-testorphan')
    fsx.mkdirSync(dead, { recursive: true })
    fsx.writeFileSync(pathx.join(dead, 'data.bin'), Buffer.alloc(2048))
    const out = purgeOrphanStreams()
    assert.ok(out.removed >= 1)
    assert.ok(out.bytes >= 2048, 'the reclaimed size is reported')
    assert.strictEqual(fsx.existsSync(dead), false)
  })

  // The hover-thumbnail cache the video engine drops beside a reused torrent is
  // named thumbs-<pid>-<ts>, which the s- sweep never matched — so it piled up
  // across crashes. It carries a pid too, so the same liveness check applies.
  test('a sweep removes an orphaned thumbnail cache whose process is gone', () => {
    const dead = pathx.join(STREAM_ROOT, 'thumbs-999996-' + Date.now())
    fsx.mkdirSync(dead, { recursive: true })
    fsx.writeFileSync(pathx.join(dead, 'frame-1.jpg'), Buffer.alloc(2048))
    const out = purgeOrphanStreams()
    assert.ok(out.removed >= 1)
    assert.strictEqual(fsx.existsSync(dead), false)
  })

  test('a sweep leaves a thumbnail cache owned by a live process alone', () => {
    const live = pathx.join(STREAM_ROOT, 'thumbs-' + process.pid + '-' + Date.now())
    fsx.mkdirSync(live, { recursive: true })
    try {
      purgeOrphanStreams({ keep: live })
      assert.strictEqual(fsx.existsSync(live), true)
    } finally {
      fsx.rmSync(live, { recursive: true, force: true })
    }
  })

  // A directory belonging to a running process is in use; removing it would
  // pull the file out from under a stream that is playing.
  test('a sweep leaves a directory owned by a live process alone', () => {
    const live = pathx.join(STREAM_ROOT, 's-' + process.pid + '-testlive')
    fsx.mkdirSync(live, { recursive: true })
    try {
      purgeOrphanStreams({ keep: live })
      assert.strictEqual(fsx.existsSync(live), true)
    } finally {
      fsx.rmSync(live, { recursive: true, force: true })
    }
  })

  test('a sweep with nothing to do is harmless', () => {
    const out = purgeOrphanStreams()
    assert.ok(typeof out.removed === 'number')
    assert.ok(typeof out.bytes === 'number')
  })

  // A crash or SIGKILL cannot run stop(), so the sweep is the only thing that
  // reclaims that space.
  test('the app sweeps orphaned caches at startup', () => {
    const main = fsx.readFileSync(pathx.join(__dirname, '..', 'main.js'), 'utf8')
    assert.match(main, /purgeOrphanStreams/)
    const at = main.indexOf('purgeOrphanStreams()')
    assert.ok(at > main.indexOf('app.whenReady'), 'the sweep runs on startup')
  })
}

const _fsx = require('node:fs')
const _pathx = require('node:path')
const { newStreamDir: _newStreamDir } = require('../torrent-stream')

  // The tests above read the source. This one actually runs stop() against a
  // real directory holding real bytes, because "the code says destroyStore" and
  // "the disk is empty afterwards" are different claims — and on this machine
  // the cache lives in RAM, so a leak costs memory, not just space.
  test('stopping really deletes the cache directory off disk', () => {
    const dir = _newStreamDir()
    _fsx.mkdirSync(dir, { recursive: true })
    _fsx.writeFileSync(_pathx.join(dir, 'episode.mkv'), Buffer.alloc(3 * 1024 * 1024))
    assert.strictEqual(_fsx.existsSync(dir), true, 'the fixture must exist first')

    const streamer = new TorrentStreamer({ client: { add() {} } })
    let destroyed = null
    streamer._storeDir = dir
    // A torrent this streamer created owns its store and may destroy it.
    streamer._ownsTorrent = true
    streamer._torrent = {
      removeListener() {},
      destroy(opts, cb) { destroyed = opts; if (cb) cb() },
    }
    streamer.stop()

    assert.deepStrictEqual(destroyed, { destroyStore: true }, 'the store must be destroyed too')
    assert.strictEqual(_fsx.existsSync(dir), false, 'the cache directory must be gone')
  })

  // Closing the player is the common case, but a torrent that never produced a
  // torrent object — a magnet that found no peers — still made a directory.
  test('stopping before a torrent exists still deletes the directory', () => {
    const dir = _newStreamDir()
    _fsx.mkdirSync(dir, { recursive: true })
    _fsx.writeFileSync(_pathx.join(dir, 'partial.bin'), Buffer.alloc(1024))
    const streamer = new TorrentStreamer({ client: { add() {} } })
    streamer._storeDir = dir
    streamer.stop()
    assert.strictEqual(_fsx.existsSync(dir), false)
  })

  // Every path that ends a video must go through stop(); a close that only hid
  // the window would leave the pack on disk for the rest of the session.
  test('every way of ending playback tears the streamer down', () => {
    const main = _fsx.readFileSync(_pathx.join(__dirname, '..', 'main.js'), 'utf8')
    const teardown = main.slice(main.indexOf('function _videoTeardown()'),
      main.indexOf('function _videoTeardown()') + 400)
    assert.match(teardown, /streamer\.stop\(\)/)
    // The stop verb (the player's stop button), quitting, and mpv dying.
    assert.match(main, /case 'stop':[\s\S]{0,200}_videoTeardown\(\)/)
    assert.match(main, /will-quit[\s\S]{0,400}_videoTeardown\(\)/)
    assert.match(main, /engineDown[\s\S]{0,300}streamer\.stop\(\)/)
  })

// ── Giving up ──────────────────────────────────────────────────────────────
// The deadline is for getting nowhere, not for taking a while. A fixed thirty
// seconds failed torrents that were working: measured here, one season pack was
// ready in 2.7s with the cache in memory and 13.3s with it on a mounted Windows
// drive, peers connected throughout in both.
function timeoutHarness ({ peers, downloaded = 0, timeoutMs = 20 }) {
  const streamer = new TorrentStreamer({ client: { add() {} }, timeoutMs })
  streamer._torrent = {
    numPeers: peers,
    downloaded,
    destroy(opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = null }
      this.destroyOpts = opts
      if (cb) cb()
    },
  }
  streamer._settled = false
  streamer._extensions = 0
  // The harness models a torrent this streamer created (it has its own store),
  // so the give-up path is entitled to destroy it and its data.
  streamer._ownsTorrent = true
  return streamer
}

test('a torrent with peers is given more time instead of being failed', () => {
  const s = timeoutHarness({ peers: 6 })
  let rejected = null
  s._onTimeout(e => { rejected = e })
  assert.strictEqual(rejected, null, 'peers are connected, so it must not give up')
  assert.strictEqual(s._extensions, 1)
  s.stop()
})

test('the extensions are bounded, so it cannot wait forever', () => {
  const s = timeoutHarness({ peers: 6 })
  let rejected = null
  for (let i = 0; i < 10; i++) s._onTimeout(e => { rejected = e })
  assert.ok(rejected, 'it must eventually give up')
  assert.strictEqual(rejected.code, 'SLOW_START')
  s.stop()
})

// Reporting "no seeders" for a torrent with peers is what made a release with
// 433 reported seeders read as having none.
test('peers found but no start is reported as slow, not as no seeders', () => {
  const s = timeoutHarness({ peers: 12 })
  let rejected = null
  for (let i = 0; i < 10; i++) s._onTimeout(e => { rejected = e })
  assert.strictEqual(rejected.code, 'SLOW_START')
  assert.match(rejected.message, /Found 12 peers/)
  s.stop()
})

test('finding nobody at all is still reported as no seeders', () => {
  const s = timeoutHarness({ peers: 0 })
  let rejected = null
  s._onTimeout(e => { rejected = e })
  assert.ok(rejected, 'with no peers there is nothing to wait for')
  assert.strictEqual(rejected.code, 'NO_SEEDERS')
  assert.match(rejected.message, /Nobody is sharing this/)
  s.stop()
})

// Giving up used to destroy the torrent without destroyStore and never remove
// the stream directory — the exact cache leak the per-stream directory exists
// to prevent, reopened on the failure path. Every dead magnet left its
// half-fetched pieces behind for the rest of the session.
test('giving up cleans the cache exactly like stop() does', () => {
  const dir = _newStreamDir()
  _fsx.mkdirSync(dir, { recursive: true })
  _fsx.writeFileSync(_pathx.join(dir, 'partial.bin'), Buffer.alloc(2048))
  const s = timeoutHarness({ peers: 0 })
  s._storeDir = dir
  let rejected = null
  const torrent = s._torrent
  s._onTimeout(e => { rejected = e })
  assert.strictEqual(rejected.code, 'NO_SEEDERS')
  assert.deepStrictEqual(torrent.destroyOpts, { destroyStore: true },
    'the store must be destroyed, not just the torrent object')
  assert.strictEqual(_fsx.existsSync(dir), false, 'the cache directory must be gone')
  assert.strictEqual(s._storeDir, null)
  s.stop()
})

// Bytes arriving is progress even before a peer count settles.
test('bytes arriving also earn more time', () => {
  const s = timeoutHarness({ peers: 0, downloaded: 4096 })
  let rejected = null
  s._onTimeout(e => { rejected = e })
  assert.strictEqual(rejected, null)
  s.stop()
})

// ── Seeking ─────────────────────────────────────────────────────────────────
// The head is prioritised once when a stream starts and never again, so a jump
// to the middle was served at ordinary priority behind bytes nobody was going
// to watch. This tells the swarm where the viewer actually went.
function seekHarness (opts = {}) {
  const calls = { select: [], critical: [] }
  const streamer = new TorrentStreamer({ client: { add() {} } })
  streamer._torrent = {
    pieceLength: opts.pieceLength || 1024 * 1024,
    select: (a, b, p) => calls.select.push([a, b, p]),
    critical: (a, b) => calls.critical.push([a, b]),
  }
  streamer._file = {
    length: opts.length || 1024 * 1024 * 1000,   // 1000 pieces
    _startPiece: opts.startPiece != null ? opts.startPiece : 0,
    _endPiece: opts.endPiece != null ? opts.endPiece : 999,
  }
  return { streamer, calls }
}

test('a jump asks the swarm for the place jumped to', () => {
  const { streamer, calls } = seekHarness()
  assert.strictEqual(streamer.seekToFraction(0.5), true)
  // Halfway through a thousand-piece file.
  assert.deepStrictEqual(calls.select[0], [500, 999, 1], 'everything from here on is what will be watched')
  assert.strictEqual(calls.critical[0][0], 500, 'and the first of it is needed now')
  assert.ok(calls.critical[0][1] > 500, 'a window, not a single piece')
})

// A file that does not begin at piece zero — the normal case inside a season
// pack — must not be prioritised as though it did.
test('the offset is measured from the file, not the torrent', () => {
  const { streamer, calls } = seekHarness({ startPiece: 4000, endPiece: 4999 })
  streamer.seekToFraction(0.25)
  assert.deepStrictEqual(calls.select[0], [4250, 4999, 1])
})

test('the urgent window never runs past the end of the file', () => {
  const { streamer, calls } = seekHarness()
  streamer.seekToFraction(1)
  assert.ok(calls.critical[0][1] <= 999, 'asked for piece ' + calls.critical[0][1] + ' of 999')
})

test('a fraction outside the film is clamped rather than refused', () => {
  const { streamer, calls } = seekHarness()
  streamer.seekToFraction(-5)
  streamer.seekToFraction(50)
  assert.strictEqual(calls.select[0][0], 0)
  assert.strictEqual(calls.select[1][0], 999)
})

test('nonsense is refused rather than turned into piece zero', () => {
  const { streamer, calls } = seekHarness()
  assert.strictEqual(streamer.seekToFraction(NaN), false)
  assert.strictEqual(streamer.seekToFraction(undefined), false)
  assert.strictEqual(calls.select.length, 0, 'Number(undefined) is NaN, but Number(null) is 0')
})

// Prioritisation is an optimisation. A torrent that cannot do it must give a
// slower seek, never a broken one.
test('a client without prioritisation still seeks', () => {
  const streamer = new TorrentStreamer({ client: { add() {} } })
  streamer._torrent = { pieceLength: 1024 }
  streamer._file = { length: 4096, _startPiece: 0, _endPiece: 3 }
  assert.doesNotThrow(() => streamer.seekToFraction(0.5))
})

test('no stream at all is not an error', () => {
  const streamer = new TorrentStreamer({ client: { add() {} } })
  assert.strictEqual(streamer.seekToFraction(0.5), false)
})

// ── Prefetching the next episode ────────────────────────────────────────────
// A season pack already holds every episode and the swarm is already connected,
// so the next episode's opening can arrive quietly while the current one plays.
// Without it, pressing Next drops the viewer onto an empty file and a spinner
// on a torrent that had the bytes available the whole time.

function packTorrent() {
  const calls = { select: [], critical: [] }
  const mk = (start, end, len) => ({
    _startPiece: start, _endPiece: end, length: len, name: 'ep.mkv',
    select () {}, deselect () {},
  })
  const torrent = {
    pieceLength: 1 << 20,                       // 1 MiB pieces
    files: [mk(0, 999, 1e9), mk(1000, 1999, 1e9), mk(2000, 2999, 1e9)],
    select: (a, b, p) => calls.select.push([a, b, p]),
    critical: (a, b) => calls.critical.push([a, b]),
  }
  const s = new TorrentStreamer({ client: { add () {} } })
  s._torrent = torrent
  s._file = torrent.files[0]
  s._fileIndex = 0
  return { s, calls, torrent }
}

test('the next episode’s opening is requested, and only its opening', () => {
  const { s, calls } = packTorrent()
  assert.strictEqual(s.prefetchFile(1), true)
  assert.strictEqual(calls.select.length, 1)
  const [from, to] = calls.select[0]
  assert.strictEqual(from, 1000, 'from the start of that file')
  const { PREFETCH_BYTES } = require('../torrent-stream')
  assert.strictEqual(to, 1000 + Math.ceil(PREFETCH_BYTES / (1 << 20)) - 1,
    'a window, not the whole episode')
})

// The episode being watched right now must not lose a single piece to this.
test('a prefetch never outranks the episode playing', () => {
  const { s, calls } = packTorrent()
  s.prefetchFile(1)
  assert.strictEqual(calls.select[0][2], 0, 'lowest priority')
  assert.strictEqual(calls.critical.length, 0, 'and never marked critical')
})

test('asking twice does not ask the swarm twice', () => {
  const { s, calls } = packTorrent()
  s.prefetchFile(1)
  s.prefetchFile(1)
  s.prefetchFile(1)
  assert.strictEqual(calls.select.length, 1)
})

test('the file being watched is never prefetched over itself', () => {
  const { s, calls } = packTorrent()
  assert.strictEqual(s.prefetchFile(0), false)
  assert.strictEqual(calls.select.length, 0)
})

// Switching episodes makes the old bookkeeping wrong: what was "next" either is
// now playing, or is no longer next.
test('switching episode clears the prefetch marker', () => {
  const { s, calls } = packTorrent()
  s.prefetchFile(1)
  s._fileIndex = 2
  s._prefetched = null                       // what selectFile does
  s.prefetchFile(1)
  assert.strictEqual(calls.select.length, 2, 'it can be asked for again')
})

test('a torrent that cannot answer costs a wait, not playback', () => {
  const s = new TorrentStreamer({ client: { add () {} } })
  assert.strictEqual(s.prefetchFile(1), false, 'nothing playing')
  s._torrent = { pieceLength: 0, files: [{}, {}] }
  s._fileIndex = 0
  assert.strictEqual(s.prefetchFile(1), false, 'no piece length')
  s._torrent = { pieceLength: 1 << 20, files: [{}, { _startPiece: null }] }
  assert.strictEqual(s.prefetchFile(1), false, 'no piece bounds')
})

// ── Live stream stats ───────────────────────────────────────────────────────
// The 'progress' events push; stats() is the pull side, read fresh from the
// torrent for anything that asks on its own schedule.
test('stats() reads the swarm live', async () => {
  const torrent = fakeTorrent()
  torrent.downloaded = 250
  torrent.length = 1000
  torrent.downloadSpeed = 512
  torrent.numPeers = 7
  torrent.uploaded = 125
  torrent.uploadSpeed = 64
  torrent.ratio = 0.5
  const streamer = new TorrentStreamer({ client: readyClient(torrent) })
  await streamer.start({ magnet: 'magnet:?xt=urn:btih:AAA' })
  assert.deepStrictEqual(streamer.stats(), {
    speedBps: 512, peers: 7, downloadedBytes: 250, totalBytes: 1000, progress: 0.25,
    uploadedBytes: 125, uploadSpeedBps: 64, ratio: 0.5,
  })
  // Live means live: the next read reflects the swarm now, not at start.
  torrent.downloaded = 900
  torrent.downloadSpeed = 0
  assert.strictEqual(streamer.stats().downloadedBytes, 900)
  assert.strictEqual(streamer.stats().speedBps, 0)
  streamer.stop()
})

test('stats() is null before a stream and after stop()', async () => {
  const idle = new TorrentStreamer({ client: { add() {} } })
  assert.strictEqual(idle.stats(), null)
  const torrent = fakeTorrent()
  const streamer = new TorrentStreamer({ client: readyClient(torrent) })
  await streamer.start({ magnet: 'magnet:?xt=urn:btih:AAA' })
  streamer.stop()
  assert.strictEqual(streamer.stats(), null)
})

test('stats() survives a torrent with missing counters', () => {
  const streamer = new TorrentStreamer({ client: { add() {} } })
  streamer._torrent = {}
  assert.deepStrictEqual(streamer.stats(), {
    speedBps: 0, peers: 0, downloadedBytes: 0, totalBytes: 0, progress: 0,
    uploadedBytes: 0, uploadSpeedBps: 0, ratio: 0,
  })
})

// ── Bandwidth cap (App #41) ─────────────────────────────────────────────────
// WebTorrent 1.9.7 throttles the CLIENT, not a torrent, via
// client.throttleDownload(bps) — a real token-bucket limiter on every peer
// connection (webtorrent/index.js). This class holds the intent and drives that
// method; the cap is client-wide, which is the honest caveat, but the mechanism
// is real, not piece-selection pacing.
{
  function throttleClient() {
    const calls = { down: [], up: [] }
    return {
      calls,
      add() {},
      throttleDownload(rate) { calls.down.push(rate) },
      throttleUpload(rate) { calls.up.push(rate) },
    }
  }

  test('a constructor bandwidth cap is applied to the client immediately', () => {
    const client = throttleClient()
    const streamer = new TorrentStreamer({ client, downloadLimitBps: 500000 })
    assert.deepStrictEqual(client.calls.down, [500000])
    assert.strictEqual(streamer.downloadLimit(), 500000)
  })

  test('setDownloadLimit changes the cap live and reports it', () => {
    const client = throttleClient()
    const streamer = new TorrentStreamer({ client })
    assert.strictEqual(streamer.downloadLimit(), null, 'uncapped by default')
    assert.strictEqual(streamer.setDownloadLimit(250000), 250000)
    assert.strictEqual(streamer.downloadLimit(), 250000)
    assert.deepStrictEqual(client.calls.down, [250000])
  })

  test('lifting the cap passes WebTorrent’s -1 disable sentinel', () => {
    const client = throttleClient()
    const streamer = new TorrentStreamer({ client, downloadLimitBps: 100000 })
    assert.strictEqual(streamer.setDownloadLimit(null), null)
    assert.strictEqual(streamer.setDownloadLimit(-1), null, 'a negative rate is also "off"')
    assert.deepStrictEqual(client.calls.down, [100000, -1, -1])
  })

  test('a nonsense limit is treated as uncapped, never NaN through to the client', () => {
    const client = throttleClient()
    const streamer = new TorrentStreamer({ client })
    assert.strictEqual(streamer.setDownloadLimit(NaN), null)
    assert.strictEqual(streamer.setDownloadLimit(Infinity), null)
    assert.deepStrictEqual(client.calls.down, [-1, -1])
  })

  test('a client with no throttle support does not throw', () => {
    const streamer = new TorrentStreamer({ client: { add() {} } })
    assert.doesNotThrow(() => streamer.setDownloadLimit(500000))
    assert.strictEqual(streamer.downloadLimit(), 500000, 'the intent is still recorded')
  })

  // A cap set before anything is streaming must survive to the torrent that
  // eventually starts — the client that carries the throttle may be fresh then.
  test('a cap set before start is re-asserted when a torrent goes live', async () => {
    const torrent = fakeTorrent()
    const client = readyClient(torrent)
    client.throttleDownload = rate => (client._rate = rate)
    const streamer = new TorrentStreamer({ client, downloadLimitBps: 300000 })
    await streamer.start({ magnet: 'magnet:?xt=urn:btih:A' })
    assert.strictEqual(client._rate, 300000, 'the live torrent’s client carries the cap')
    streamer.stop()
  })
}

// ── Seed-back toggle (App #42) ──────────────────────────────────────────────
// WebTorrent uploads while it downloads. Turning seeding off suppresses it with
// client.throttleUpload(0) — connections stay open (we still download from
// them), but nothing goes out. Same client-wide caveat as the download cap.
{
  test('seedWhileWatching is on by default and does not choke uploads', () => {
    const client = { add() {}, throttleUpload(r) { this._up = r } }
    const streamer = new TorrentStreamer({ client })
    assert.strictEqual(streamer.seedWhileWatching(), true)
    // No suppression call on construction — the default is simply to seed.
    assert.strictEqual(client._up, undefined)
  })

  test('setSeedWhileWatching(false) chokes uploads to zero', () => {
    const client = { add() {}, throttleUpload(r) { this._up = r } }
    const streamer = new TorrentStreamer({ client })
    assert.strictEqual(streamer.setSeedWhileWatching(false), false)
    assert.strictEqual(client._up, 0, 'uploads throttled to nothing')
    assert.strictEqual(streamer.setSeedWhileWatching(true), true)
    assert.strictEqual(client._up, -1, 'and lifted again with the disable sentinel')
  })

  test('seedWhileWatching:false in the constructor suppresses uploads on start', async () => {
    const torrent = fakeTorrent()
    const client = readyClient(torrent)
    client.throttleUpload = r => (client._up = r)
    const streamer = new TorrentStreamer({ client, seedWhileWatching: false })
    await streamer.start({ magnet: 'magnet:?xt=urn:btih:A' })
    assert.strictEqual(client._up, 0, 'the live stream is not seeding back')
    streamer.stop()
  })

  test('a client without throttleUpload does not throw', () => {
    const streamer = new TorrentStreamer({ client: { add() {} } })
    assert.doesNotThrow(() => streamer.setSeedWhileWatching(false))
    assert.strictEqual(streamer.seedWhileWatching(), false)
  })

  // stats() carries the seed-back numbers the toggle exists to make sense of.
  test('stats() reports uploaded bytes, upload speed and ratio', () => {
    const streamer = new TorrentStreamer({ client: { add() {} } })
    streamer._torrent = {
      downloaded: 1000, length: 4000, uploaded: 500, uploadSpeed: 128, ratio: 0.5,
    }
    const s = streamer.stats()
    assert.strictEqual(s.uploadedBytes, 500)
    assert.strictEqual(s.uploadSpeedBps, 128)
    assert.strictEqual(s.ratio, 0.5)
  })

  // WebTorrent's ratio is uploaded/(received||length); a torrent with nothing
  // downloaded yet would make that Infinity or NaN. The panel must never see it.
  test('stats() never lets a NaN or Infinity ratio reach the UI', () => {
    const streamer = new TorrentStreamer({ client: { add() {} } })
    streamer._torrent = { downloaded: 0, length: 0, uploaded: 100, ratio: Infinity }
    assert.strictEqual(streamer.stats().ratio, 0, 'undefined ratio reads as 0, not ∞')
    streamer._torrent = { downloaded: 200, uploaded: 100 }   // no ratio field at all
    assert.strictEqual(streamer.stats().ratio, 0.5, 'recomputed from what is present')
  })
}

// ── Full predownload (App #40) ──────────────────────────────────────────────
// prefetchFile() grabs an opening; predownloadFile() grabs the WHOLE file, both
// at the lowest priority so the episode playing keeps every peer it wants.
{
  function predlPack() {
    const calls = { select: [], deselect: [] }
    const mk = (start, end, len) => ({
      _startPiece: start, _endPiece: end, length: len, name: 'ep.mkv',
      select() {}, deselect() {},
    })
    const torrent = {
      pieceLength: 1 << 20,
      files: [mk(0, 999, 1e9), mk(1000, 1999, 1e9), mk(2000, 2999, 1e9)],
      select: (a, b, p) => calls.select.push([a, b, p]),
      deselect: (a, b, p) => calls.deselect.push([a, b, p]),
      bitfield: { get: () => false },
    }
    const s = new TorrentStreamer({ client: { add() {} } })
    s._torrent = torrent
    s._file = torrent.files[0]
    s._fileIndex = 0
    return { s, calls, torrent }
  }

  test('predownloadFile selects the ENTIRE file, at the lowest priority', () => {
    const { s, calls } = predlPack()
    assert.strictEqual(s.predownloadFile(1), true)
    assert.deepStrictEqual(calls.select, [[1000, 1999, 0]],
      'the whole file 1000..1999, priority 0 — distinct from the opening-only prefetch')
  })

  test('predownloadFile is distinct from prefetchFile’s opening window', () => {
    const { s } = predlPack()
    // A 1e9-byte file spans 1000 pieces; the opening prefetch is only ~24 pieces.
    s.predownloadFile(1)
    const pd = s.predownloadProgress()
    assert.strictEqual(pd.index, 1)
    assert.strictEqual(pd.total, 1e9, 'the whole file is the target, not a window')
  })

  test('asking to predownload the same file twice does not re-select', () => {
    const { s, calls } = predlPack()
    s.predownloadFile(1)
    s.predownloadFile(1)
    assert.strictEqual(calls.select.length, 1)
  })

  test('predownloading a different file cancels the first', () => {
    const { s, calls } = predlPack()
    s.predownloadFile(1)
    s.predownloadFile(2)
    assert.deepStrictEqual(calls.deselect, [[1000, 1999, 0]],
      'the first whole-file selection is withdrawn before the second is placed')
    assert.deepStrictEqual(calls.select, [[1000, 1999, 0], [2000, 2999, 0]])
    assert.strictEqual(s.predownloadProgress().index, 2)
  })

  test('cancelPredownload withdraws the standing selection by its exact triple', () => {
    const { s, calls } = predlPack()
    s.predownloadFile(1)
    assert.strictEqual(s.cancelPredownload(), true)
    assert.deepStrictEqual(calls.deselect, [[1000, 1999, 0]])
    assert.strictEqual(s.predownloadProgress(), null, 'nothing predownloading after a cancel')
    assert.strictEqual(s.cancelPredownload(), false, 'and nothing left to cancel')
  })

  test('predownloadProgress counts bytes present across the whole file', () => {
    const { s, torrent } = predlPack()
    // Pieces 1000..1004 present — 5 pieces of 1 MiB — anywhere in the file.
    torrent.bitfield = { get: i => i >= 1000 && i <= 1004 }
    s.predownloadFile(1)
    const pd = s.predownloadProgress()
    assert.strictEqual(pd.bytes, 5 * (1 << 20))
    assert.strictEqual(pd.total, 1e9)
  })

  test('predownloadProgress never reports more bytes than the file holds', () => {
    const { s, torrent } = predlPack()
    torrent.bitfield = { get: () => true }   // every piece "present"
    s.predownloadFile(1)
    const pd = s.predownloadProgress()
    assert.ok(pd.bytes <= pd.total, 'a whole-piece count is clamped to the file length')
    assert.strictEqual(pd.bytes, 1e9)
  })

  test('predownloadFile on a missing file or with no stream is a clean false', () => {
    const idle = new TorrentStreamer({ client: { add() {} } })
    assert.strictEqual(idle.predownloadFile(0), false, 'nothing streaming')
    assert.strictEqual(idle.predownloadProgress(), null)
    const { s } = predlPack()
    assert.strictEqual(s.predownloadFile(99), false, 'no such file')
  })

  test('predownloadFile on a file with no piece bounds is refused', () => {
    const s = new TorrentStreamer({ client: { add() {} } })
    s._torrent = { pieceLength: 1 << 20, files: [{}, { _startPiece: null }], select() {} }
    s._fileIndex = 0
    assert.strictEqual(s.predownloadFile(1), false)
  })

  // stop() tears the torrent down; the standing selection goes with it, and the
  // bookkeeping must not survive to point at a torrent that no longer exists.
  test('stop() clears the predownload bookkeeping', () => {
    const { s } = predlPack()
    s._server = null
    s.predownloadFile(1)
    assert.ok(s.predownloadProgress())
    s.stop()
    assert.strictEqual(s._predownload, null)
    assert.strictEqual(s.predownloadProgress(), null)
  })
}

// ── Subtitles inside the pack ───────────────────────────────────────────────
// The file list filters to video on purpose, which made a pack's
// .srt/.ass/.vtt unreachable: the one subtitle that matches the release
// exactly was sitting in the torrent and could never be handed to mpv.
{
  function subsPack() {
    const torrent = new EventEmitter()
    const mk = (name, length, body) => ({
      name, length,
      _startPiece: 0, _endPiece: 0,
      select () { this.sel = true },
      deselect () {},
      createReadStream: () => Readable.from([Buffer.from(body || '')]),
      getBuffer (cb) { queueMicrotask(() => cb(null, Buffer.from(body || ''))) },
    })
    torrent.files = [
      mk('Show.S01E01.1080p.mkv', 9e8, ''),
      mk('Subs/Show.S01E01.en.srt', 4096, '1\n00:00:01,000 --> 00:00:02,000\nhello\n'),
      mk('readme.txt', 100, 'x'),
      mk('Show.S01E01.signs.ass', 2048, '[Script Info]'),
    ]
    torrent.length = torrent.files.reduce((n, f) => n + f.length, 0)
    torrent.pieceLength = 1000
    torrent.bitfield = null
    torrent.select = () => {}
    torrent.criticalCalls = []
    torrent.critical = (a, b) => torrent.criticalCalls.push([a, b])
    torrent.createServer = () => require('node:http').createServer()
    torrent.destroy = (opts, cb) => { if (typeof opts === 'function') opts(); else if (cb) cb() }
    return torrent
  }

  test('subtitleFiles lists the pack subtitles by their full-list index', async () => {
    const torrent = subsPack()
    const streamer = new TorrentStreamer({ client: readyClient(torrent), prebufferBytes: 0 })
    await streamer.start({ magnet: 'magnet:?xt=urn:btih:A' })
    assert.deepStrictEqual(streamer.subtitleFiles(), [
      { index: 1, name: 'Subs/Show.S01E01.en.srt', size: 4096 },
      { index: 3, name: 'Show.S01E01.signs.ass', size: 2048 },
    ])
    // And the video list stays video-only, exactly as before.
    assert.ok(streamer.files().every(f => !/\.(srt|ass|ssa|vtt)$/i.test(f.name)))
    streamer.stop()
  })

  test('subtitleFiles is empty before anything is streaming', () => {
    const streamer = new TorrentStreamer({ client: { add() {} } })
    assert.deepStrictEqual(streamer.subtitleFiles(), [])
  })

  test('serveSubtitle writes the bytes under the stream cache and resolves the path', async () => {
    const torrent = subsPack()
    const streamer = new TorrentStreamer({ client: readyClient(torrent), prebufferBytes: 0 })
    await streamer.start({ magnet: 'magnet:?xt=urn:btih:A' })
    const served = await streamer.serveSubtitle(1)
    assert.ok(_pathx.isAbsolute(served))
    assert.ok(served.startsWith(streamer._storeDir), 'must live under the stream cache dir')
    assert.match(_fsx.readFileSync(served, 'utf8'), /hello/)
    // The subtitle file's own pieces were asked for; the video was untouched.
    assert.strictEqual(torrent.files[1].sel, true)
    // And it goes away with the rest of the cache.
    streamer.stop()
    assert.strictEqual(_fsx.existsSync(served), false)
  })

  test('serveSubtitle refuses an index that is not a subtitle', async () => {
    const torrent = subsPack()
    const streamer = new TorrentStreamer({ client: readyClient(torrent), prebufferBytes: 0 })
    await streamer.start({ magnet: 'magnet:?xt=urn:btih:A' })
    await assert.rejects(() => streamer.serveSubtitle(0), { code: 'NO_SUBTITLE' })
    await assert.rejects(() => streamer.serveSubtitle(2), { code: 'NO_SUBTITLE' })
    await assert.rejects(() => streamer.serveSubtitle(99), { code: 'NO_SUBTITLE' })
    streamer.stop()
  })

  test('serveSubtitle with no stream is a clean refusal', async () => {
    const streamer = new TorrentStreamer({ client: { add() {} } })
    await assert.rejects(() => streamer.serveSubtitle(0), { code: 'NO_SUBTITLE' })
  })

  // A torrent reused from elsewhere in the app has no cache directory of this
  // stream's own; the subtitle still needs somewhere to land, and stop() must
  // still take it away.
  test('a reused torrent still gets its subtitle served and cleaned up', async () => {
    const torrent = subsPack()
    torrent.ready = true
    const client = { get: () => torrent, add() { throw new Error('must reuse, never re-add') } }
    const streamer = new TorrentStreamer({ client, prebufferBytes: 0 })
    await streamer.start({ magnet: 'magnet:?xt=urn:btih:A' })
    assert.strictEqual(streamer._storeDir, null, 'a reused torrent owns its own directory')
    const served = await streamer.serveSubtitle(3)
    assert.ok(_fsx.existsSync(served))
    streamer.stop()
    assert.strictEqual(_fsx.existsSync(served), false)
  })

  // Two subtitles named the same thing in different folders of the pack must
  // not overwrite each other on disk.
  test('served subtitle paths are unique per index', async () => {
    const torrent = subsPack()
    torrent.files.push({
      name: 'Signs/Show.S01E01.en.srt', length: 512,
      _startPiece: 0, _endPiece: 0,
      select () {}, deselect () {},
      createReadStream: () => Readable.from([Buffer.from('signs')]),
      getBuffer (cb) { queueMicrotask(() => cb(null, Buffer.from('signs'))) },
    })
    const streamer = new TorrentStreamer({ client: readyClient(torrent), prebufferBytes: 0 })
    await streamer.start({ magnet: 'magnet:?xt=urn:btih:A' })
    const a = await streamer.serveSubtitle(1)
    const b = await streamer.serveSubtitle(4)
    assert.notStrictEqual(a, b)
    assert.match(_fsx.readFileSync(a, 'utf8'), /hello/)
    assert.match(_fsx.readFileSync(b, 'utf8'), /signs/)
    streamer.stop()
  })
}
