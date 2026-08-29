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
  torrent.destroy = (cb) => {
    torrent.destroyed = true
    torrent.destroyCalls = (torrent.destroyCalls || 0) + 1
    torrent.emit('close')
    if (cb) cb()
  }
  return torrent
}

function readyClient(torrent) {
  return {
    add(magnet, cb) {
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
    add(magnet, cb) {
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

  // WebTorrent's default is rarest-first, which is right for archiving and
  // wrong for playback: it scatters pieces so the player has nothing
  // contiguous to read.
  test('the head of the file is marked critical so it arrives in order', async () => {
    const torrent = packTorrent([{ name: 'M.mkv', length: 90000, _startPiece: 0, _endPiece: 89 }])
    const streamer = new TorrentStreamer({ client: readyClient(torrent), prebufferBytes: 5000 })
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
    const streamer = new TorrentStreamer({ client: readyClient(torrent), prebufferBytes: 5000 })
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
    const streamer = new TorrentStreamer({ client: readyClient(torrent), prebufferBytes: 5000 })
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
    const streamer = new TorrentStreamer({ client: readyClient(torrent), prebufferBytes: 5000, prebufferTimeoutMs: 60000 })
    const t = Date.now()
    await streamer.start({ magnet: 'magnet:?xt=urn:btih:A' })
    assert.ok(Date.now() - t < 1000, 'must not block on an unmeasurable torrent')
    streamer.stop()
  })

  test('stop() during prebuffer does not leave the poll running', async () => {
    const torrent = packTorrent([{ name: 'M.mkv', length: 90000, _startPiece: 0, _endPiece: 89 }])
    const streamer = new TorrentStreamer({ client: readyClient(torrent), prebufferBytes: 50000 })
    const started = streamer.start({ magnet: 'magnet:?xt=urn:btih:A' }).catch(e => e)
    await new Promise(r => setTimeout(r, 50))
    streamer.stop()
    const err = await started
    assert.strictEqual(err.code, 'STOPPED')
    assert.strictEqual(streamer._prebufferTimer, null)
  })
}
