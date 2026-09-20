'use strict'
// "when i select instant source, it doesnt play and sits there waiting"
// (2026-09-20).
//
// The source list marks a row INSTANT because RealDebrid is holding it. This
// handler went straight to _startTorrentStream and never asked RealDebrid at
// all — so the one source advertised as instant started a cold peer download,
// and behind a download cap it never arrived. A badge the app then ignores is
// worse than no badge: it aims people at the slowest path on purpose.
//
// These run the real handler out of main.js (test/helpers/lift-ipc.js) rather
// than reading its source, so an assertion here is about behaviour.
const test = require('node:test')
const assert = require('node:assert')
const { runHandler } = require('./helpers/lift-ipc')

const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'

// One harness: records what the handler reached for, and lets each test decide
// what RealDebrid says.
function rig(over = {}) {
  const seen = { loaded: [], osd: [], torrents: [], sent: [], misses: [], seeks: [] }
  const globals = Object.assign({
    DEBRID_BUDGET_MS: 200,
    _videoSession: { token: 0, streamer: null, switching: false, debrid: null },
    videoEngine: () => ({
      state: { position: 120 },
      load: async url => { seen.loaded.push(url) },
      seek: async (pos, mode) => { seen.seeks.push([pos, mode]) },
      osdMessage: (text) => { seen.osd.push(String(text)) },
    }),
    _startTorrentStream: (result, opts) => { seen.torrents.push({ result, opts }) },
    safeSend: (_ch, payload) => { seen.sent.push(payload) },
    _sendDebridMiss: (_cur, err) => { seen.misses.push(String(err && err.message || err)) },
    _sendDebridPack: () => {},
    _startPackChainTick: () => {},
    _prioritiseStreamAtPlayhead: () => {},
    _debridConfigured: () => true,
    _debridRateLimited: () => false,
    _debridAnyWorthTrying: () => true,
    _debridPlayableAny: async () => 'https://rd.example/stream.mkv',
  }, over)
  return { seen, globals }
}

async function run(globals, result) {
  const out = await runHandler('video-switch-stream', {
    args: { result: Object.assign({ kind: 'torrent', magnet: MAGNET }, result || {}) },
    globals,
    timeoutMs: 400,
  })
  // The handler returns as soon as the switch is under way; the resolution it
  // started settles on later ticks.
  await new Promise(r => setTimeout(r, 60))
  return out
}

test('a source RealDebrid is holding is played FROM RealDebrid, not from the swarm', async () => {
  const { seen, globals } = rig()
  const out = await run(globals)
  assert.deepEqual(out.result, { ok: true })
  assert.deepEqual(seen.loaded, ['https://rd.example/stream.mkv'],
    'mpv must be pointed at the debrid link')
  assert.equal(seen.torrents.length, 0,
    'the whole bug: an INSTANT source must not start a cold peer download')
  assert.ok(seen.sent.some(p => p && p.kind === 'debrid' && p.ok === true),
    'and the page is told debrid served it')
})

test('the viewer is put back where they were, not at the start', async () => {
  const { seen, globals } = rig()
  await run(globals)
  assert.deepEqual(seen.seeks, [[120, 'absolute']])
})

test('when RealDebrid cannot serve it, the swarm still takes over', async () => {
  const { seen, globals } = rig({ _debridPlayableAny: async () => { throw new Error('not held') } })
  await run(globals)
  assert.equal(seen.torrents.length, 1, 'the fallback must still happen')
  assert.equal(seen.loaded.length, 0, 'nothing was loaded from debrid')
  assert.ok(seen.misses.includes('not held'), 'and the miss is reported, not swallowed')
})

test('a debrid link that will not load falls back rather than leaving a dead switch', async () => {
  const { seen, globals } = rig({
    videoEngine: () => ({
      state: { position: 0 },
      load: async () => { throw new Error('mpv refused the link') },
      seek: async () => {},
      osdMessage: () => {},
    }),
  })
  await run(globals)
  assert.equal(seen.torrents.length, 1, 'a switch must never end with nothing running')
})

test('nothing worth asking about goes to peers and SAYS so', async () => {
  const { seen, globals } = rig({ _debridAnyWorthTrying: () => false })
  await run(globals)
  assert.equal(seen.torrents.length, 1)
  assert.equal(seen.misses.length, 1,
    'falling back in silence is what made a paid account look ignored')
})

test('the switch narrates over the picture, where the viewer is actually looking', async () => {
  // The HTML stage renders UNDER mpv's surface: during a switch the only thing
  // on screen is the old frozen frame. Silence there is most of what "it just
  // sits there" was.
  const { seen, globals } = rig()
  await run(globals)
  assert.ok(seen.osd.some(t => /RealDebrid/i.test(t)), 'got: ' + JSON.stringify(seen.osd))

  const peers = rig({ _debridAnyWorthTrying: () => false })
  await run(peers.globals)
  assert.ok(peers.seen.osd.some(t => /peers/i.test(t)), 'got: ' + JSON.stringify(peers.seen.osd))
})

test('the old streamer is stopped before a new source is resolved', async () => {
  let stopped = 0
  const { seen, globals } = rig()
  globals._videoSession = { token: 0, switching: false, streamer: { stop() { stopped++ } } }
  await run(globals)
  assert.equal(stopped, 1, 'two streamers fighting over one player is the other way this hangs')
  assert.equal(globals._videoSession.streamer, null)
})

test('a non-torrent or magnet-less source is refused plainly, not started', async () => {
  const { seen, globals } = rig()
  const a = await runHandler('video-switch-stream', {
    args: { result: { kind: 'direct', url: 'https://x/y.mp4' } }, globals, timeoutMs: 200,
  })
  assert.equal(a.result.ok, false)
  const b = await runHandler('video-switch-stream', {
    args: { result: { kind: 'torrent' } }, globals, timeoutMs: 200,
  })
  assert.equal(b.result.ok, false)
  assert.equal(seen.torrents.length, 0)
})
