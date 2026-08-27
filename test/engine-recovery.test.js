'use strict'
const test = require('node:test')
const assert = require('node:assert')
const net = require('net')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { PassThrough } = require('stream')
const { EventEmitter } = require('events')
const { MpvEngine, EngineGone } = require('../mpv-engine')

// A fake mpv that can be told to go quiet, so a wedged engine is testable.
function fakeMpv(opts = {}) {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'papa-rec-')), 'mpv.sock')
  const conns = []
  const commands = []
  const state = { mute: false, answers: opts.answers || {} }
  const server = net.createServer(c => {
    conns.push(c)
    let buf = ''
    c.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line)
        commands.push(msg.command)
        if (state.mute) continue
        const name = msg.command[0] === 'get_property' ? msg.command[1] : null
        const data = name && Object.prototype.hasOwnProperty.call(state.answers, name)
          ? state.answers[name] : null
        c.write(JSON.stringify({ error: 'success', data, request_id: msg.request_id }) + '\n')
      }
    })
  })
  const proc = new EventEmitter()
  proc.stderr = new PassThrough()
  proc.kill = () => proc.emit('exit', 0)
  return new Promise(res => server.listen(sock, () => res({
    sock, proc, commands, state,
    spawns: [],
    spawnFn: (bin, args, o) => { (res.spawns = res.spawns || []).push({ bin, args, o }); return proc },
    push: msg => conns.forEach(c => c.write(JSON.stringify(msg) + '\n')),
    mute: () => { state.mute = true },
    unmute: () => { state.mute = false },
    close: () => { conns.forEach(c => c.destroy()); server.close() },
  })))
}

const settle = (ms = 60) => new Promise(r => setTimeout(r, ms))

// Fast timings so a watchdog with an 8s threshold does not need an 8s test.
const FAST = { tickMs: 20, heartbeatTicks: 3, stallMs: 80, eofGraceMs: 20, eofAdvanceMs: 120, resumeTimeoutMs: 300 }

async function engine(f, extra = {}) {
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock, ...FAST, ...extra })
  await eng.start()
  return eng
}

function pumpPlaybackRestart(f) {
  const t = setInterval(() => f.push({ event: 'playback-restart' }), 15)
  t.unref?.()
  return () => clearInterval(t)
}

// ── Item 5: a vanished client is EngineGone, not a TypeError ─────────────────

test('a command issued after mpv died fails with EngineGone, not a TypeError', async () => {
  const f = await fakeMpv()
  const eng = await engine(f)
  eng.alive = false
  eng.client = null
  await assert.rejects(() => eng.setNext('/music/b.flac'), e => {
    assert.ok(e instanceof EngineGone, `expected EngineGone, got ${e.name}: ${e.message}`)
    assert.strictEqual(e.code, 'ENGINE_GONE')
    return true
  })
  eng.stop(); f.close()
})

test('mpv dying between two awaits of one sequence is EngineGone', async () => {
  const f = await fakeMpv()
  const eng = await engine(f)
  // setNext awaits playlist-clear, then loadfile. Kill the client in between.
  const realCommand = eng.client.command.bind(eng.client)
  eng.client.command = async (...args) => {
    const r = await realCommand(...args)
    if (args[0] === 'playlist-clear') { eng.alive = false; eng.client = null }
    return r
  }
  await assert.rejects(() => eng.setNext('/music/b.flac'), e => e.code === 'ENGINE_GONE')
  assert.ok(eng.getFlightRecorder().some(r => r.ev === 'set-next-failed' && r.code === 'ENGINE_GONE'))
  eng.stop(); f.close()
})

test('a command belonging to the previous mpv is refused after a respawn', async () => {
  const f = await fakeMpv()
  const eng = await engine(f)
  const cmd = eng._guard('stale')
  const genBefore = eng._gen
  const stopPump = pumpPlaybackRestart(f)
  const back = new Promise(r => eng.once('engineRecovered', r))
  f.proc.emit('exit', 1)
  await back
  stopPump()
  assert.notStrictEqual(eng._gen, genBefore, 'a respawn must bump the generation')
  await assert.rejects(() => cmd('set_property', 'pause', true), e => e.code === 'ENGINE_GONE')
  eng.stop(); f.close()
})

// ── Item 10: ended and autoAdvanced are mutually exclusive ───────────────────

test('eof with nothing queued means the queue ended', async () => {
  const f = await fakeMpv()
  const eng = await engine(f)
  const ended = new Promise(r => eng.once('ended', r))
  f.push({ event: 'end-file', reason: 'eof' })
  await ended
  const rec = eng.getFlightRecorder().find(r => r.ev === 'eof')
  assert.strictEqual(rec.expectingAdvance, false)
  eng.stop(); f.close()
})

test('eof with a queued next waits for the handoff instead of racing it', async () => {
  const f = await fakeMpv()
  const eng = await engine(f)
  await eng.load('/music/a.flac')
  await eng.setNext('/music/b.flac')
  let endedFired = 0
  eng.on('ended', () => { endedFired++ })
  const advanced = new Promise(r => eng.once('autoAdvanced', r))
  f.push({ event: 'end-file', reason: 'eof' })
  // The handoff lands later than the old 150 ms grace would have allowed.
  await settle(60)
  f.push({ event: 'start-file' })
  f.push({ event: 'property-change', name: 'path', data: '/music/b.flac' })
  assert.strictEqual(await advanced, '/music/b.flac')
  await settle(200)
  assert.strictEqual(endedFired, 0, 'ended and autoAdvanced must never both fire')
  eng.stop(); f.close()
})

test('a queued next that never opens is recorded, and the album still advances', async () => {
  const f = await fakeMpv()
  const eng = await engine(f)
  await eng.load('/music/a.flac')
  await eng.setNext('/music/b.flac')
  const ended = new Promise(r => eng.once('ended', r))
  const diag = new Promise(r => eng.once('diagnostic', d => { if (d.kind === 'advance-failed') r(d) }))
  f.push({ event: 'end-file', reason: 'eof' })
  await ended
  const d = await diag
  assert.strictEqual(d.detail.queued, '/music/b.flac')
  // ended still fires, so playback carries on — the failure is on the record
  // rather than being the reason the album stops one track early.
  assert.ok(eng.getFlightRecorder().some(r => r.ev === 'advance-failed'))
  eng.stop(); f.close()
})

test('a path change arriving after ended does not fire autoAdvanced as well', async () => {
  const f = await fakeMpv()
  const eng = await engine(f)
  await eng.load('/music/a.flac')
  await eng.setNext('/music/b.flac')
  const ended = new Promise(r => eng.once('ended', r))
  let advanced = 0
  eng.on('autoAdvanced', () => { advanced++ })
  f.push({ event: 'end-file', reason: 'eof' })
  await ended
  // mpv finally gets there, long after the renderer was told the track ended
  // and has already advanced. This is the double scrobble and the audible cut.
  f.push({ event: 'property-change', name: 'path', data: '/music/b.flac' })
  await settle(120)
  assert.strictEqual(advanced, 0)
  assert.ok(eng.getFlightRecorder().some(r => r.ev === 'late-advance-suppressed'))
  eng.stop(); f.close()
})

// ── Item 16: do not touch the playlist when nothing changed ──────────────────

test('setNext with the value it already has sends no command at all', async () => {
  const f = await fakeMpv()
  const eng = await engine(f)
  await eng.setNext('/music/b.flac')
  f.commands.length = 0
  await eng.setNext('/music/b.flac')
  await eng.setNext('/music/b.flac')
  assert.deepStrictEqual(f.commands, [],
    'playlist-clear on every prefetch update is what can end the current file')
  assert.strictEqual(eng.getFlightRecorder().filter(r => r.ev === 'set-next-unchanged').length, 2)
  eng.stop(); f.close()
})

// ── Item 18: a cancelled deferred seek is not a failure ─────────────────────

test('a deferred seek cancelled by a new load resolves instead of rejecting', async () => {
  const f = await fakeMpv()
  const eng = await engine(f)
  const seeking = eng.seek(42)          // deferred: not seekable yet
  await eng.load('/music/other.flac')   // cancels it
  const r = await seeking               // must not reject
  assert.deepStrictEqual(r, { cancelled: true, seconds: 42 })
  eng.stop(); f.close()
})

// ── Item 19: cosmetic commands never become playback failures ───────────────

test('a volume change against a dead engine is absorbed, not thrown', async () => {
  const f = await fakeMpv()
  const eng = await engine(f)
  eng.alive = false
  eng.client = null
  await assert.doesNotReject(() => eng.setVolume(80))
  await assert.doesNotReject(() => eng.setSpeed(1.5))
  assert.ok(eng.getFlightRecorder().some(r => r.ev === 'set-volume-skipped'))
  eng.stop(); f.close()
})

// ── Item 17: the stall watchdog ─────────────────────────────────────────────

test('a frozen position while unpaused is noticed and mpv is asked about it', async () => {
  const f = await fakeMpv({ answers: { 'idle-active': false, 'core-idle': true, 'eof-reached': false } })
  const eng = await engine(f)
  await eng.load('/music/a.flac')
  f.push({ event: 'property-change', name: 'pause', data: false })
  f.push({ event: 'property-change', name: 'time-pos', data: 12 })
  const stalled = new Promise(r => eng.once('stalled', r))
  const d = await stalled
  assert.ok(d.stalledForMs >= 80)
  assert.strictEqual(d.probe['core-idle'], true)
  assert.ok(eng.getFlightRecorder().some(r => r.ev === 'stall-probe'))
  eng.stop(); f.close()
})

test('a stall where mpv says it is idle is reported as a stop, because it is one', async () => {
  const f = await fakeMpv({ answers: { 'idle-active': true } })
  const eng = await engine(f)
  await eng.load('/music/a.flac')
  f.push({ event: 'property-change', name: 'pause', data: false })
  f.push({ event: 'property-change', name: 'time-pos', data: 85.2 })
  const stopped = new Promise(r => eng.once('stopped', r))
  const d = await stopped
  assert.strictEqual(d.reason, 'stalled-idle')
  assert.strictEqual(d.position, 85.2)
  eng.stop(); f.close()
})

test('a paused track is not a stall', async () => {
  const f = await fakeMpv()
  const eng = await engine(f)
  await eng.load('/music/a.flac', { play: false })
  f.push({ event: 'property-change', name: 'pause', data: true })
  let fired = false
  eng.on('stalled', () => { fired = true })
  eng.on('stopped', () => { fired = true })
  await settle(300)
  assert.strictEqual(fired, false)
  eng.stop(); f.close()
})

// ── Item 251: the resume sequence is bounded ─────────────────────────────────

test('a respawn whose resume never completes fails instead of hanging forever', async () => {
  const f = await fakeMpv()
  const eng = await engine(f)
  eng.state.path = '/music/a.flac'
  eng.state.position = 85.2
  eng.state.paused = false
  // No playback-restart is ever pushed, so the deferred seek never settles.
  const failed = new Promise(r => eng.once('engineFailed', r))
  f.proc.emit('exit', 1)
  const d = await failed
  assert.strictEqual(d.reason, 'resume-timeout')
  assert.match(d.detail, /did not complete within/)
  eng.stop(); f.close()
})

// ── Item 9 and device-loss detection ────────────────────────────────────────

test('an audio device fault is told apart from any other mpv complaint', async () => {
  const f = await fakeMpv()
  const eng = await engine(f)
  const lost = new Promise(r => eng.once('audioDeviceLost', r))
  f.push({ event: 'log-message', level: 'error', prefix: 'ao/alsa', text: 'Audio device lost, trying to reopen' })
  const d = await lost
  assert.match(d.text, /Audio device lost/)
  // An ordinary decoder complaint must not be mistaken for one.
  let again = false
  eng.on('audioDeviceLost', () => { again = true })
  f.push({ event: 'log-message', level: 'error', prefix: 'ffmpeg', text: 'error decoding frame' })
  await settle()
  assert.strictEqual(again, false)
  eng.stop(); f.close()
})

test('a device fault drops exclusive mode for the respawn rather than burning the budget', async () => {
  const f = await fakeMpv()
  const eng = await engine(f, { config: { outputMode: 'exclusive', alsaDevice: 'alsa/hw:1,0' } })
  assert.ok(eng._args('/tmp/x.sock').includes('--audio-exclusive=yes'))
  f.push({ event: 'log-message', level: 'error', prefix: 'ao/alsa', text: 'Could not open audio device' })
  await settle()
  const fellBack = new Promise(r => eng.once('audioDeviceFallback', r))
  const stopPump = pumpPlaybackRestart(f)
  f.proc.emit('exit', 1)
  const d = await fellBack
  stopPump()
  assert.strictEqual(d.from, 'alsa/hw:1,0')
  const args = eng._args('/tmp/x.sock')
  assert.ok(!args.some(a => a.startsWith('--audio-device=')), 'the vanished device must not be requested again')
  assert.ok(!args.includes('--audio-exclusive=yes'))
  eng.stop(); f.close()
})

test('engineFailed after a device fault names the device, not the respawn count', async () => {
  const f = await fakeMpv()
  const eng = await engine(f, { config: { outputMode: 'default' } })
  f.push({ event: 'log-message', level: 'error', prefix: 'ao/pipewire', text: 'Audio device lost' })
  await settle()
  let failure = null
  eng.on('engineFailed', d => { failure = d })
  const stopPump = pumpPlaybackRestart(f)
  for (let i = 0; i < 4; i++) {
    const done = new Promise(r => { eng.once('engineRecovered', r); eng.once('engineFailed', r) })
    f.proc.emit('exit', 1)
    await done
  }
  stopPump()
  assert.strictEqual(failure.reason, 'audio-device-lost')
  assert.match(failure.detail, /audio device kept failing/)
  eng.stop(); f.close()
})

// ── Item 21: a failed observer says which property ──────────────────────────

test('a failed observe_property names the property instead of failing blankly', async () => {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'papa-obs-')), 'mpv.sock')
  const server = net.createServer(c => {
    let buf = ''
    c.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line)
        const bad = msg.command[0] === 'observe_property' && msg.command[2] === 'audio-params'
        c.write(JSON.stringify({
          error: bad ? 'property not found' : 'success', data: null, request_id: msg.request_id,
        }) + '\n')
      }
    })
  })
  await new Promise(r => server.listen(sock, r))
  const proc = new EventEmitter()
  proc.stderr = new PassThrough()
  proc.kill = () => {}
  const eng = new MpvEngine({ spawnFn: () => proc, socketPath: sock, ...FAST })
  await assert.rejects(() => eng.start(), e => {
    assert.strictEqual(e.code, 'OBSERVE_FAILED')
    assert.strictEqual(e.property, 'audio-params')
    assert.match(e.message, /audio-params/)
    return true
  })
  assert.ok(eng.getFlightRecorder().some(r => r.ev === 'observe-failed' && r.property === 'audio-params'))
  eng.stop(); server.close()
})

// ── Item 20: restart reports a resume it could not finish ───────────────────

test('a restart that cannot finish its resume says so instead of going quiet', async () => {
  const f = await fakeMpv()
  const eng = await engine(f)
  eng.state.path = '/music/a.flac'
  eng.state.position = 40
  eng.state.paused = false
  const stopped = new Promise(r => eng.once('stopped', r))
  // No playback-restart, so the deferred seek in the resume never settles.
  await eng.restart({ replaygain: 'track' })
  const d = await stopped
  assert.strictEqual(d.reason, 'restart-incomplete')
  assert.strictEqual(d.path, '/music/a.flac')
  eng.stop(); f.close()
})
