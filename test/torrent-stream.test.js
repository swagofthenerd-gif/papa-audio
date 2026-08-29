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
  assert.deepStrictEqual(progress[0], { downloaded: 500, total: 1000, speed: 100, percent: 0.5 })
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
