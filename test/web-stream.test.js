'use strict'
// V1: the smooth player's feed — sessions, the per-request ffmpeg, seeking by
// restart, subtitle sidecars — with spawn and probe injected.
const test = require('node:test')
const assert = require('node:assert')
const http = require('http')
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createWebStreamServer } = require('../web-stream')
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'papa-ws-')) }

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
  const srv = createWebStreamServer({ spawnFn: makeSpawn(spawned), execFileFn: fakeExecFile, cacheDir: tmpDir() })
  const s = await srv.open('/x/film.mkv')
  assert.ok(s.id && /^http:\/\/127\.0\.0\.1:\d+\/s\/[a-f0-9]+\.mp4$/.test(s.streamUrl))
  assert.equal(s.duration, 123.4)
  assert.equal(s.plan.mode, 'remux')
  assert.equal(s.subtitles.length, 1)
  assert.match(s.subtitles[0].url, /\/sub\/3\.vtt$/)
  // A burned subtitle's run re-encodes the picture to H.264 whatever the
  // source codec; the page types its SourceBuffer with this for that run.
  assert.match(s.burnMime, /^video\/mp4; codecs="avc1\.[0-9a-f]{6},/)
  srv.shutdown()
})

test('a stream request spawns ffmpeg at the requested second; a second request kills the first', async () => {
  const spawned = []
  const srv = createWebStreamServer({ spawnFn: makeSpawn(spawned), execFileFn: fakeExecFile, cacheDir: tmpDir() })
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
  const srv = createWebStreamServer({ spawnFn: makeSpawn(spawned), execFileFn: fakeExecFile, cacheDir: tmpDir() })
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
  const srv = createWebStreamServer({ spawnFn: makeSpawn(spawned), execFileFn: fakeExecFile, cacheDir: tmpDir() })
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
  const srv = createWebStreamServer({ spawnFn: makeSpawn(spawned), execFileFn: (_b, _a, _o, cb) => cb(null, JSON.stringify({ streams: [{ index: 0, codec_type: 'audio', codec_name: 'aac' }], format: {} })), cacheDir: tmpDir() })
  const r = await srv.open('/x/audio-only.mkv')
  assert.equal(r.refused, true)
  const srv2 = createWebStreamServer({ spawnFn: makeSpawn(spawned), execFileFn: fakeExecFile, cacheDir: tmpDir() })
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
  const srv = createWebStreamServer({ spawnFn: makeSpawn(spawned), execFileFn: fakeExecFile, cacheDir: tmpDir() })
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

test('parallel requests for one subtitle track share a single extraction; close kills a running one', async () => {
  const spawned = []
  // A slow extractor: does not finish until told.
  const spawnSlow = function (bin, args) {
    const p = new EventEmitter(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.killed = false
    p.kill = () => { p.killed = true; setImmediate(() => { p.stdout.end(); p.emit('close', 255) }) }
    spawned.push({ bin, args, proc: p }); return p
  }
  const srv = createWebStreamServer({ spawnFn: spawnSlow, execFileFn: fakeExecFile, cacheDir: tmpDir() })
  const s = await srv.open('/x/film.mkv')
  const a = get(s.subtitles[0].url); const b = get(s.subtitles[0].url); const c = get(s.subtitles[0].url)
  await new Promise(r => setTimeout(r, 40))
  assert.equal(spawned.filter(x => x.args.includes('webvtt')).length, 1, 'three requests, one ffmpeg')
  spawned[0].proc.stdout.write('WEBVTT\n\n00:00.000 --> 00:01.000\nhi\n'); spawned[0].proc.stdout.end(); spawned[0].proc.emit('close', 0)
  const [ra, rb, rc] = await Promise.all([a, b, c])
  assert.ok(ra.body === rb.body && rb.body === rc.body && /hi/.test(ra.body))
  const s2 = await srv.open('/x/film2.mkv')
  const p2 = get(s2.subtitles[0].url)
  await new Promise(r => setTimeout(r, 30))
  const running = spawned[spawned.length - 1].proc
  srv.close(s2.id)
  assert.ok(running.killed, 'closing the session stops the extraction')
  await p2.catch(() => {})
  srv.shutdown()
})

// ── the disk cache ──────────────────────────────────────────────────────────
function box(type, payload) { const b = Buffer.alloc(8 + payload.length); b.writeUInt32BE(8 + payload.length, 0); b.write(type, 4, 'latin1'); payload.copy(b, 8); return b }
function full(type, version, payload) { const h = Buffer.alloc(4); h[0] = version; return box(type, Buffer.concat([h, payload])) }
function mdhd(ts) { const p = Buffer.alloc(20); p.writeUInt32BE(ts, 8); return full('mdhd', 0, p) }
function moovBox(ts) { return box('moov', Buffer.concat([box('mvhd', Buffer.alloc(100)), box('trak', box('mdia', mdhd(ts)))])) }
function moofBox(tfdt) { const p = Buffer.alloc(4); p.writeUInt32BE(tfdt, 0); return box('moof', Buffer.concat([box('mfhd', Buffer.alloc(8)), box('traf', Buffer.concat([box('tfhd', Buffer.alloc(8)), full('tfdt', 0, p)]))])) }
function mdatBox(n, fill) { return box('mdat', Buffer.alloc(n, fill)) }
// A converter that emits a real fragmented MP4: init, then one fragment per
// second for `secs` seconds, then exits.
function makeFmp4Spawn(record, secs) {
  return function (bin, args) {
    const p = new EventEmitter(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.killed = false
    p.kill = () => { p.killed = true; setImmediate(() => { p.stdout.end(); p.emit('close', 255) }) }
    record.push({ bin, args, proc: p })
    if (args.includes('webvtt')) { setImmediate(() => { p.stdout.end(); p.emit('close', 0) }); return p }
    setImmediate(() => {
      p.stdout.write(Buffer.concat([box('ftyp', Buffer.alloc(16)), moovBox(1000)]))
      for (let i = 0; i < secs; i++) p.stdout.write(Buffer.concat([moofBox(i * 1000), mdatBox(100, i)]))
      p.stdout.end(); p.emit('close', 0)
    })
    return p
  }
}
function getBuf(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })); res.on('error', reject) }).on('error', reject)
  })
}

test('a second inside a converted span is served from the run file: no new ffmpeg, the init segment then the fragment', async () => {
  const spawned = []
  const dir = tmpDir()
  const srv = createWebStreamServer({ spawnFn: makeFmp4Spawn(spawned, 10), execFileFn: fakeExecFile, cacheDir: dir })
  const s = await srv.open('/x/film.mkv')
  const first = await getBuf(s.streamUrl + '?t=0')
  assert.equal(first.headers['x-papa-cached'], '0')
  assert.equal(spawned.length, 1)
  const initLen = 24 + moovBox(1000).length
  assert.equal(first.body.length, initLen + 10 * (moofBox(0).length + 108))
  // Seek back to 4 s: a file read.
  const back = await getBuf(s.streamUrl + '?t=4.3')
  assert.equal(spawned.length, 1, 'no second converter')
  assert.equal(back.headers['x-papa-cached'], '1')
  assert.equal(back.headers['x-papa-start'], '0', 'the run starts at 0; timestamps inside are on that clock')
  assert.ok(back.body.subarray(0, initLen).equals(first.body.subarray(0, initLen)), 'init segment first')
  const fragLen = moofBox(0).length + 108
  assert.equal(back.body.length, initLen + 6 * fragLen, 'fragments 4..9')
  assert.equal(back.body[initLen + moofBox(0).length + 8], 4, 'the first served fragment is the one for 4 s')
  // Beyond the span: a new run at 50 s, the old file kept.
  const far = await getBuf(s.streamUrl + '?t=50')
  assert.equal(spawned.length, 2)
  assert.equal(spawned[1].args[spawned[1].args.indexOf('-ss') + 1], '50')
  assert.equal(far.headers['x-papa-start'], '50')
  assert.equal(fs.readdirSync(path.join(dir, s.id)).length, 2, 'both run files on disk')
  // Back into the first span again: still no converter.
  await getBuf(s.streamUrl + '?t=2')
  assert.equal(spawned.length, 2)
  assert.equal(srv.close(s.id), true)
  assert.ok(!fs.existsSync(path.join(dir, s.id)), 'close removes the title\'s cache')
  srv.shutdown()
})

test('a live run stops when a request lands outside its span, and its file stays for later seeks', async () => {
  const spawned = []
  const srv = createWebStreamServer({ spawnFn: makeSpawn(spawned), execFileFn: fakeExecFile, cacheDir: tmpDir() })
  const s = await srv.open('/x/film.mkv')
  const a = get(s.streamUrl + '?t=0')
  await new Promise(r => setTimeout(r, 30))
  const b = get(s.streamUrl + '?t=600')
  await new Promise(r => setTimeout(r, 30))
  assert.equal(spawned.length, 2)
  assert.ok(spawned[0].proc.killed, 'only one converter is live per title')
  spawned[1].proc.stdout.end(); spawned[1].proc.emit('close', 0)
  await a; await b
  assert.equal(srv._sessions.get(s.id).runs.length, 2, 'the stopped run keeps its file')
  srv.shutdown()
})

test('the cache directory is wiped of leftovers on start and a session cap drops the oldest finished run', async () => {
  const dir = tmpDir()
  fs.mkdirSync(path.join(dir, 'stale')); fs.writeFileSync(path.join(dir, 'stale', 'run-0.mp4'), 'x')
  const spawned = []
  const srv = createWebStreamServer({ spawnFn: makeFmp4Spawn(spawned, 3), execFileFn: fakeExecFile, cacheDir: dir, maxSessionBytes: 1000 })
  assert.ok(!fs.existsSync(path.join(dir, 'stale')))
  const s = await srv.open('/x/film.mkv')
  await getBuf(s.streamUrl + '?t=0')
  await getBuf(s.streamUrl + '?t=100')
  await new Promise(r => setTimeout(r, 30))
  const runs = srv._sessions.get(s.id).runs
  assert.equal(runs.length, 1, 'the older finished run was dropped to stay under the cap')
  assert.equal(runs[0].start, 100)
  srv.shutdown()
})

test('a streamed input gets its subtitles from the run itself: no separate whole-file extractor, and the sidecar is the merge of what runs have written', async () => {
  const spawned = []
  const dir = tmpDir()
  const spawnWithSubs = function (bin, args) {
    const p = makeFmp4Spawn(spawned, 2)(bin, args)
    const at = args.indexOf('-f', args.indexOf('pipe:1'))
    // Write the VTT file the run was asked for, as ffmpeg would.
    const file = args[args.length - 1]
    if (/\.vtt$/.test(file)) {
      const ss = args.indexOf('-ss') !== -1 ? Number(args[args.indexOf('-ss') + 1]) : 0
      fs.writeFileSync(file, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\ncue from run at ' + ss + '\n')
    }
    void at
    return p
  }
  const srv = createWebStreamServer({ spawnFn: spawnWithSubs, execFileFn: fakeExecFile, cacheDir: dir })
  const s = await srv.open('http://127.0.0.1:1/film.mkv')
  await getBuf(s.streamUrl + '?t=0')
  const runArgs = spawned[0].args
  assert.ok(runArgs.includes('webvtt') && /run-0-sub-3\.vtt$/.test(runArgs[runArgs.length - 1]), 'the run carries the subtitle output')
  const r1 = await get(s.subtitles[0].url)
  assert.equal(spawned.filter(x => x.args[0] === '-hide_banner' && x.args.includes('webvtt') && !x.args.includes('pipe:1')).length, 0, 'no standalone extractor for a streamed input')
  assert.match(r1.body, /00:00:01\.000 --> 00:00:02\.000\ncue from run at 0/)
  await getBuf(s.streamUrl + '?t=600')
  const r2 = await get(s.subtitles[0].url)
  assert.match(r2.body, /00:00:01\.000 --> 00:00:02\.000\ncue from run at 0/)
  assert.match(r2.body, /00:10:01\.000 --> 00:10:02\.000\ncue from run at 600/, 'the later run\'s cues are shifted by its start')
  srv.shutdown()
})

test('open reports chapters and a coverage URL; coverage lists the converted spans, merged', async () => {
  const spawned = []
  const probe = (_b, _a, _o, cb) => cb(null, JSON.stringify({ streams: STREAMS, format: { duration: '123.4' }, chapters: [{ start_time: '0.000', tags: { title: 'Opening' } }, { start_time: '60.5', tags: { TITLE: 'Act 2' } }] }))
  const srv = createWebStreamServer({ spawnFn: makeFmp4Spawn(spawned, 5), execFileFn: probe, cacheDir: tmpDir() })
  const s = await srv.open('/x/film.mkv')
  assert.deepEqual(s.chapters, [{ index: 0, title: 'Opening', start: 0 }, { index: 1, title: 'Act 2', start: 60.5 }])
  assert.match(s.coverageUrl, /\/coverage$/)
  await getBuf(s.streamUrl + '?t=0')
  await getBuf(s.streamUrl + '?t=100')
  await new Promise(r => setTimeout(r, 30))
  const cov = JSON.parse((await get(s.coverageUrl)).body)
  assert.deepEqual(cov.ranges, [[0, 4], [100, 104]], 'each run covers up to the start of its last fragment')
  srv.shutdown()
})

test('a streamed source is probed up to three times before the smooth player gives up on it, with the probe\'s own error in the reason', async () => {
  let calls = 0
  const flaky = (_b, args, _o, cb) => { calls++; if (calls < 3) return cb(new Error('boom'), '', 'Server returned 404 Not Found'); cb(null, JSON.stringify({ streams: STREAMS, format: { duration: '10' } })) }
  const srv = createWebStreamServer({ spawnFn: makeSpawn([]), execFileFn: flaky, cacheDir: tmpDir() })
  const s = await srv.open('http://127.0.0.1:1/film.mkv')
  assert.equal(calls, 3); assert.ok(s.id)
  let local = 0
  const failing = (_b, args, _o, cb) => { local++; assert.ok(!args.includes('-rw_timeout'), 'no network timeout for a file'); cb(new Error('x'), '', 'Invalid data found when processing input') }
  const srv2 = createWebStreamServer({ spawnFn: makeSpawn([]), execFileFn: failing, cacheDir: tmpDir() })
  await assert.rejects(() => srv2.open('/x/film.mkv'), /ffprobe could not read the source: Invalid data/)
  assert.equal(local, 1, 'a local file is probed once')
  srv.shutdown(); srv2.shutdown()
})

test('a copied-picture run starts on the keyframe at or before the asked second and says so', async () => {
  const spawned = []
  const probes = []
  const exec = (_b, args, _o, cb) => {
    if (args.includes('-skip_frame')) { probes.push(args); return cb(null, '16.000000\n18.000000\n20.000000\n') }
    cb(null, JSON.stringify({ streams: STREAMS, format: { duration: '123.4' } }))
  }
  const srv = createWebStreamServer({ spawnFn: makeSpawn(spawned), execFileFn: exec, cacheDir: tmpDir() })
  const s = await srv.open('/x/film.mkv')   // AV1 + Opus: a remux, picture copied
  const p = get(s.streamUrl + '?t=21')
  await new Promise(r => setTimeout(r, 40))
  assert.equal(probes.length, 1); assert.ok(probes[0].includes('1%21'))
  assert.equal(spawned[0].args[spawned[0].args.indexOf('-ss') + 1], '20', 'the run starts on the keyframe')
  spawned[0].proc.stdout.end(); spawned[0].proc.emit('close', 0)
  const r = await p
  assert.equal(r.headers['x-papa-start'], '20')
  srv.shutdown()
})
