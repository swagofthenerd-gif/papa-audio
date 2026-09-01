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
    assert.match(src, /this\.client\.add\(magnet, \{ path: this\._storeDir \}/,
      'without a path WebTorrent picks its own directory and nothing cleans it')
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
  streamer._torrent = { numPeers: peers, downloaded, destroy(cb) { if (cb) cb() } }
  streamer._settled = false
  streamer._extensions = 0
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
