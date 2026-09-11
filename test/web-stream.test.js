'use strict'
// V1: the smooth player's feed — sessions, the per-request ffmpeg, seeking by
// restart, subtitle sidecars — with spawn and probe injected.
const test = require('node:test')
const assert = require('node:assert')
const http = require('http')
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')
const { createWebStreamServer } = require('../web-stream')

const STREAMS = [
  { index: 0, codec_type: 'video', codec_name: 'av1', pix_fmt: 'yuv420p10le', width: 1788, height: 1080 },
  { index: 1, codec_type: 'audio', codec_name: 'opus', channels: 6 },
  { index: 3, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } },
]
function fakeExecFile(_bin, _args, _o, cb) { cb(null, JSON.stringify({ streams: STREAMS, format: { duration: '123.4' } })) }
function makeSpawn(record) {
  return function (bin, args) {
    const p = new EventEmitter()
    p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.killed = false
    p.kill = () => { p.killed = true; setImmediate(() => { p.stdout.end(); p.emit('close', 255) }) }
    record.push({ bin, args, proc: p })
    setImmediate(() => { p.stdout.write(args.includes('webvtt') ? 'WEBVTT\n\n00:00.000 --> 00:01.000\nhi\n' : 'ftyp'); if (args.includes('webvtt')) { p.stdout.end(); p.emit('close', 0) } })
    return p
  }
}
function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); res.on('error', reject) }).on('error', reject)
  })
}

test('open probes, plans, and returns a session with a stream URL and subtitle sidecars', async () => {
  const spawned = []
  const srv = createWebStreamServer({ spawnFn: makeSpawn(spawned), execFileFn: fakeExecFile })
  const s = await srv.open('/x/film.mkv')
  assert.ok(s.id && /^http:\/\/127\.0\.0\.1:\d+\/s\/[a-f0-9]+\.mp4$/.test(s.streamUrl))
  assert.equal(s.duration, 123.4)
  assert.equal(s.plan.mode, 'remux')
  assert.equal(s.subtitles.length, 1)
  assert.match(s.subtitles[0].url, /\/sub\/3\.vtt$/)
  srv.shutdown()
})

test('a stream request spawns ffmpeg at the requested second; a second request kills the first', async () => {
  const spawned = []
  const srv = createWebStreamServer({ spawnFn: makeSpawn(spawned), execFileFn: fakeExecFile })
  const s = await srv.open('/x/film.mkv')
  const a = get(s.streamUrl + '?t=0')
  await new Promise(r => setTimeout(r, 30))
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].bin, 'ffmpeg')
  assert.ok(!spawned[0].args.includes('-ss'))
  const b = get(s.streamUrl + '?t=600')
  await new Promise(r => setTimeout(r, 30))
  assert.equal(spawned.length, 2)
  assert.ok(spawned[0].proc.killed, 'the earlier converter is gone')
  assert.equal(spawned[1].args[spawned[1].args.indexOf('-ss') + 1], '600')
  spawned[1].proc.stdout.end(); spawned[1].proc.emit('close', 0)
  const r1 = await a; const r2 = await b
  assert.equal(r1.status, 200); assert.equal(r2.headers['content-type'], 'video/mp4'); assert.equal(r2.headers['x-papa-start'], '600')
  srv.shutdown()
})

test('an audio-track switch re-plans the session; a burn-in request adds the subtitle filter', async () => {
  const spawned = []
  const srv = createWebStreamServer({ spawnFn: makeSpawn(spawned), execFileFn: fakeExecFile })
  const s = await srv.open('/x/film.mkv')
  const p = get(s.streamUrl + '?t=0&a=1&burn=3')
  await new Promise(r => setTimeout(r, 30))
  const args = spawned[0].args
  assert.ok(args.join(' ').includes("subtitles='/x/film.mkv':si=0"))
  spawned[0].proc.stdout.end(); spawned[0].proc.emit('close', 0)
  await p
  srv.shutdown()
})

test('subtitle sidecars are extracted once and cached; unknown sessions are 404', async () => {
  const spawned = []
  const srv = createWebStreamServer({ spawnFn: makeSpawn(spawned), execFileFn: fakeExecFile })
  const s = await srv.open('/x/film.mkv')
  const r1 = await get(s.subtitles[0].url)
  assert.equal(r1.status, 200); assert.match(r1.body, /^WEBVTT/)
  const r2 = await get(s.subtitles[0].url)
  assert.equal(r2.body, r1.body)
  assert.equal(spawned.filter(x => x.args.includes('webvtt')).length, 1, 'cached after the first extraction')
  const r3 = await get(s.streamUrl.replace(/\/s\/[a-f0-9]+/, '/s/deadbeef'))
  assert.equal(r3.status, 404)
  srv.shutdown()
})

test('a source with no video is refused so the caller can fall back to mpv; close kills the converter', async () => {
  const spawned = []
  const srv = createWebStreamServer({ spawnFn: makeSpawn(spawned), execFileFn: (_b, _a, _o, cb) => cb(null, JSON.stringify({ streams: [{ index: 0, codec_type: 'audio', codec_name: 'aac' }], format: {} })) })
  const r = await srv.open('/x/audio-only.mkv')
  assert.equal(r.refused, true)
  const srv2 = createWebStreamServer({ spawnFn: makeSpawn(spawned), execFileFn: fakeExecFile })
  const s = await srv2.open('/x/film.mkv')
  const p = get(s.streamUrl)
  await new Promise(r => setTimeout(r, 30))
  assert.equal(srv2.close(s.id), true)
  assert.ok(spawned[0].proc.killed)
  await p.catch(() => {})
  assert.equal(srv2.close(s.id), false)
  srv2.shutdown()
})

test('a paired session copies a remote video URL and a remote audio URL into one stream; seeks restart both', async () => {
  const spawned = []
  const srv = createWebStreamServer({ spawnFn: makeSpawn(spawned), execFileFn: fakeExecFile })
  const s = await srv.openPair('https://v.example/video', 'https://a.example/audio')
  assert.ok(s.paired && /\/s\/[a-f0-9]+\.mp4$/.test(s.streamUrl))
  assert.deepEqual(s.subtitles, [])
  const p = get(s.streamUrl + '?t=12')
  await new Promise(r => setTimeout(r, 30))
  const a = spawned[0].args
  assert.deepEqual(a.filter((x, i) => a[i - 1] === '-i'), ['https://v.example/video', 'https://a.example/audio'])
  assert.equal(a.filter(x => x === '-ss').length, 2, 'both inputs seek')
  assert.deepEqual(a.slice(a.indexOf('-map'), a.indexOf('-map') + 6), ['-map', '0:v:0', '-map', '1:a:0', '-c', 'copy'])
  assert.ok(a.includes('-reconnect'))
  spawned[0].proc.stdout.end(); spawned[0].proc.emit('close', 0)
  await p
  await assert.rejects(() => srv.openPair('https://v.example/video', null))
  srv.shutdown()
})
