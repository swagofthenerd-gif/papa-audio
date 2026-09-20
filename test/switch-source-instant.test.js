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
const MAIN = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8')

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
    _debridRelayStandingFor: () => false,
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

// ── restoring the position (2026-09-20 audit) ──────────────────────────────
// mpv's loadfile is accepted long before the file is open — the engine emits
// 'fileLoaded' separately for the real thing. A seek issued the moment load()
// resolved landed in that gap and failed, and the catch threw the failure
// away, so a switch silently restarted the episode from zero.
test('the position is restored only once mpv has really opened the file', async () => {
  let openFile = null
  const opened = new Promise(r => { openFile = r })
  const { seen, globals } = rig({
    _awaitFileLoaded: () => opened,
    videoEngine: () => ({
      state: { position: 300, duration: 1400 },
      load: async url => { seen.loaded.push(url) },
      seek: async (pos, mode) => { seen.seeks.push([pos, mode]) },
      osdMessage: (t) => { seen.osd.push(String(t)) },
    }),
  })
  await run(globals)
  assert.deepEqual(seen.seeks, [], 'no seek may be issued while the file is still opening')
  openFile(true)
  await new Promise(r => setTimeout(r, 60))
  assert.deepEqual(seen.seeks, [[300, 'absolute']], 'and it happens once the file is open')
})

test('the seek is clamped inside a shorter cut, and says so', async () => {
  const { seen, globals } = rig({
    _awaitFileLoaded: async () => true,
    SWITCH_SEEK_TAIL_S: 5,
    videoEngine: () => ({
      // The new release is a different, shorter cut: 600 s against a 1200 s
      // playhead. Seeking there makes mpv report end-of-file, which the
      // renderer reads as a finished episode.
      state: { position: 1200, duration: 600 },
      load: async url => { seen.loaded.push(url) },
      seek: async (pos, mode) => { seen.seeks.push([pos, mode]) },
      osdMessage: (t) => { seen.osd.push(String(t)) },
    }),
  })
  await run(globals)
  assert.equal(seen.seeks.length, 1)
  assert.ok(seen.seeks[0][0] <= 595, 'must land inside the file; got ' + seen.seeks[0][0])
  assert.ok(seen.osd.some(t => /different cut/i.test(t)), 'and say why: ' + JSON.stringify(seen.osd))
})

test('a seek that fails is reported, not swallowed', async () => {
  const { seen, globals } = rig({
    _awaitFileLoaded: async () => true,
    videoEngine: () => ({
      state: { position: 300, duration: 1400 },
      load: async url => { seen.loaded.push(url) },
      seek: async () => { throw new Error('mpv refused the seek') },
      osdMessage: (t) => { seen.osd.push(String(t)) },
    }),
  })
  await run(globals)
  assert.ok(seen.osd.some(t => /could not restore your place/i.test(t)),
    'the empty catch is why a lost position was never diagnosable: ' + JSON.stringify(seen.osd))
})

test('a failed switch is announced where it can actually be seen', async () => {
  // The renderer paints switch errors on the HTML stage, which sits UNDER
  // mpv's window and is invisible in purist mode.
  const { seen, globals } = rig({
    _debridAnyWorthTrying: () => false,
    _startTorrentStream: (result, opts) => { opts.fail(new Error('Nobody is sharing this')) },
  })
  await run(globals)
  assert.ok(seen.osd.some(t => /could not switch source/i.test(t)),
    'got: ' + JSON.stringify(seen.osd))
  assert.ok(seen.sent.some(p => p && p.kind === 'error'), 'and the page is told too')
})

test('the old release stops downloading the moment the switch begins', async () => {
  // Its background next-episode pull kept eating the connection while the
  // viewer waited, and a stale magnet made later warms believe a debrid
  // stream was playing when it was not.
  const body = MAIN.slice(MAIN.indexOf("ipcMain.handle('video-switch-stream'"),
    MAIN.indexOf("ipcMain.handle('video-stop'"))
  assert.match(body, /_debridCacheAheadStop\(\)/)
  assert.match(body, /_videoSession\.debrid = null/)
})

test('the on-screen narration outlasts the wait it describes', async () => {
  const body = MAIN.slice(MAIN.indexOf("ipcMain.handle('video-switch-stream'"),
    MAIN.indexOf("ipcMain.handle('video-stop'"))
  assert.match(body, /say\('Checking RealDebrid…', DEBRID_BUDGET_MS\)/,
    'four seconds left ten seconds of silence inside a fourteen-second phase')
  assert.match(body, /say\('Connecting to peers…', 20000\)/)
})

// ── not re-asking a question already answered (2026-09-20 audit) ───────────
// Every switch spent up to DEBRID_BUDGET_MS on RealDebrid before a single peer
// was contacted — even for a row the page had already probed and been told
// RealDebrid does not hold. Fourteen seconds of frozen frame, to re-ask.
test('a source RealDebrid has already refused goes straight to peers', async () => {
  const { seen, globals } = rig()
  await run(globals, { debridKnownMiss: true })
  assert.equal(seen.torrents.length, 1, 'peers must start at once')
  assert.equal(seen.loaded.length, 0, 'and no debrid link is waited for')
  // The rig stubs the miss reporter, so check the message it is handed — the
  // real _debridReasonFrom maps /not holding any/ to the 'notHeld' reason the
  // renderer turns into words.
  assert.ok(seen.misses.some(m => /not holding any/.test(m)),
    'the viewer is told why, rather than it happening silently: ' + JSON.stringify(seen.misses))
})

test('a relay already standing beats the known miss, because it costs nothing', async () => {
  const { seen, globals } = rig({ _debridRelayStandingFor: () => true })
  await run(globals, { debridKnownMiss: true })
  assert.deepEqual(seen.loaded, ['https://rd.example/stream.mkv'])
  assert.equal(seen.torrents.length, 0)
})

test('a source nobody probed is UNKNOWN, not refused, and still gets the full attempt', async () => {
  // The page only probes the top few candidates; treating unprobed as refused
  // would quietly disable debrid for most of the list.
  const { seen, globals } = rig()
  await run(globals, { debridKnownMiss: false })
  assert.deepEqual(seen.loaded, ['https://rd.example/stream.mkv'])
  const absent = rig()
  await run(absent.globals)
  assert.deepEqual(absent.seen.loaded, ['https://rd.example/stream.mkv'],
    'and so is one with no flag at all')
})

test('the page tells "asked and refused" apart from "never asked"', () => {
  const R = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const at = R.indexOf('function _debridKnownMiss(s)')
  assert.ok(at > 0, 'the helper must exist')
  const body = R.slice(at, R.indexOf('\n}\n', at))
  assert.match(body, /_debridProbed\.indexOf\(s\.magnet\) !== -1/,
    'only a source that was actually asked about counts')
  assert.match(body, /if \(_isInstantSource\(s\)\) return false/)
  // And the probed list is recorded where the asking happens, and cleared with
  // the rest of the page's choices.
  assert.match(R, /_debridProbed = candidates\.slice\(\)/)
  const reset = R.slice(R.indexOf('function _resetDetailPageChoices()'), R.indexOf('function _resetDetailPageChoices()') + 700)
  assert.match(reset, /_debridProbed = \[\]/)
})
