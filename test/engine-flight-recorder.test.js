'use strict'
const test = require('node:test')
const assert = require('node:assert')
const net = require('net')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { PassThrough } = require('stream')
const { EventEmitter } = require('events')
const { MpvEngine, FLIGHT_ENTRIES } = require('../mpv-engine')

// Same fake mpv as mpv-engine.test.js, plus the two things the flight recorder
// needs: a real stderr stream on the child, and the spawn options as passed.
function fakeMpv() {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'papa-fr-')), 'mpv.sock')
  const conns = []
  const commands = []
  const spawns = []
  const server = net.createServer(c => {
    conns.push(c)
    c.on('error', () => {})   // a dead peer is not a test failure
    c.on('close', () => { const i = conns.indexOf(c); if (i >= 0) conns.splice(i, 1) })
    let buf = ''
    c.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line)
        commands.push(msg.command)
        c.write(JSON.stringify({ error: 'success', data: null, request_id: msg.request_id }) + '\n')
      }
    })
  })
  const proc = new EventEmitter()
  proc.stderr = new PassThrough()
  proc.kill = () => proc.emit('exit', 0)
  return new Promise(res => server.listen(sock, () => res({
    sock, proc, commands, spawns,
    spawnFn: (bin, args, opts) => { spawns.push({ bin, args, opts }); return proc },
    push: msg => conns.forEach(c => {
      // The engine destroy()s its socket on respawn/stop; writing to that corpse is
      // EPIPE, async, and with no error listener it was an uncaught exception that
      // failed whichever test was running — only under load, so it read as flaky.
      try { if (c.writable && !c.destroyed) c.write(JSON.stringify(msg) + '\n') } catch (_) {}
    }),
    close: () => { conns.forEach(c => c.destroy()); server.close() },
  })))
}

const settle = (ms = 60) => new Promise(r => setTimeout(r, ms))

// The respawn path awaits seek(), and seek() only resolves once mpv reports
// playback-restart. Real mpv gets there on its own; the fake has to be told to.
// (Worth knowing: if mpv never reaches playback-restart after a respawn, that
// await in _onExit never settles and no engineRecovered or engineFailed is ever
// emitted. Pre-existing, and out of Tier 1 scope — see the handoff notes.)
function pumpPlaybackRestart(f) {
  const t = setInterval(() => f.push({ event: 'playback-restart' }), 20)
  t.unref?.()
  return () => clearInterval(t)
}

async function startedEngine(f, opts = {}) {
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock, ...opts })
  await eng.start()
  return eng
}

// ── Capturing mpv's own diagnosis ────────────────────────────────────────────

test('mpv is spawned with stderr piped, not ignored', async () => {
  const f = await fakeMpv()
  const eng = await startedEngine(f)
  assert.deepStrictEqual(f.spawns[0].opts.stdio, ['ignore', 'ignore', 'pipe'],
    "stdio:'ignore' is what threw away mpv's diagnosis in the first place")
  eng.stop(); f.close()
})

test('mpv log messages are requested over IPC, because --no-terminal silences stderr', async () => {
  const f = await fakeMpv()
  const eng = await startedEngine(f)
  assert.ok(f.commands.some(c => c[0] === 'request_log_messages' && c[1] === 'warn'),
    'without this, mpv writes its warnings nowhere we can read')
  eng.stop(); f.close()
})

test('an mpv that does not know request_log_messages still starts', async () => {
  // Old mpv answers with an error rather than success; that must not be fatal.
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'papa-fr-old-')), 'mpv.sock')
  const server = net.createServer(c => {
    let buf = ''
    c.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line)
        const bad = msg.command[0] === 'request_log_messages'
        c.write(JSON.stringify({
          error: bad ? 'invalid parameter' : 'success', data: null, request_id: msg.request_id,
        }) + '\n')
      }
    })
  })
  await new Promise(r => server.listen(sock, r))
  const proc = new EventEmitter()
  proc.stderr = new PassThrough()
  proc.kill = () => {}
  const eng = new MpvEngine({ spawnFn: () => proc, socketPath: sock })
  await eng.start()
  assert.strictEqual(eng.alive, true)
  assert.ok(eng.getFlightRecorder().some(r => r.ev === 'log-request-failed'),
    'the refusal should be recorded, not swallowed')
  eng.stop(); server.close()
})

test('mpv log-message events reach the log tail and errors reach the timeline', async () => {
  const f = await fakeMpv()
  const eng = await startedEngine(f)
  f.push({ event: 'log-message', level: 'error', prefix: 'ao/alsa', text: 'Audio device lost, trying to reopen\n' })
  f.push({ event: 'log-message', level: 'warn', prefix: 'ffmpeg', text: 'nothing interesting here' })
  await settle()
  const tail = eng.getLogTail()
  assert.ok(tail.some(l => /Audio device lost/.test(l.text)), 'mpv said it and we must have it')
  assert.ok(tail.some(l => l.source === 'mpv/ao/alsa'), 'the subsystem prefix identifies the fault')
  const flight = eng.getFlightRecorder()
  assert.ok(flight.some(r => r.ev === 'mpv-log' && /Audio device lost/.test(r.text)),
    'a fault line belongs inline in the timeline, not only in the tail')
  assert.ok(!flight.some(r => r.ev === 'mpv-log' && /nothing interesting/.test(r.text)),
    'ordinary warnings must not flood the timeline')
  eng.stop(); f.close()
})

test('stderr lines are captured line by line', async () => {
  const f = await fakeMpv()
  const eng = await startedEngine(f)
  f.proc.stderr.write('Assertion failed in ao_alsa\nsecond line\n')
  await settle()
  const texts = eng.getLogTail().filter(l => l.source === 'stderr').map(l => l.text)
  assert.deepStrictEqual(texts, ['Assertion failed in ao_alsa', 'second line'])
  eng.stop(); f.close()
})

test('a child with no stderr does not break start', async () => {
  const f = await fakeMpv()
  delete f.proc.stderr
  const eng = await startedEngine(f)
  assert.strictEqual(eng.alive, true)
  eng.stop(); f.close()
})

// ── The flight recorder ──────────────────────────────────────────────────────

test('the timeline records the sequence a stop has to be explained against', async () => {
  const f = await fakeMpv()
  const eng = await startedEngine(f)
  await eng.load('/music/a.flac')
  await eng.setNext('/music/b.flac')
  f.push({ event: 'start-file' })
  f.push({ event: 'playback-restart' })
  f.push({ event: 'property-change', name: 'pause', data: false })
  await settle()
  const evs = eng.getFlightRecorder().map(r => r.ev)
  for (const want of ['spawn', 'ready', 'load', 'set-next', 'start-file', 'playback-restart', 'pause']) {
    assert.ok(evs.includes(want), `timeline is missing ${want}`)
  }
  const load = eng.getFlightRecorder().find(r => r.ev === 'load')
  assert.strictEqual(load.path, '/music/a.flac')
  assert.ok(eng.getFlightRecorder().every(r => typeof r.at === 'number'), 'every entry needs a time')
  eng.stop(); f.close()
})

test('the timeline is bounded, so it cannot grow without limit', async () => {
  const f = await fakeMpv()
  const eng = await startedEngine(f)
  for (let i = 0; i < FLIGHT_ENTRIES + 250; i++) eng._rec('filler', { i })
  const flight = eng.getFlightRecorder()
  assert.strictEqual(flight.length, FLIGHT_ENTRIES)
  // The newest entries are the ones that survive; the oldest are dropped.
  assert.strictEqual(flight[flight.length - 1].i, FLIGHT_ENTRIES + 249)
  eng.stop(); f.close()
})

test('the recorder returns a copy, so a reader cannot corrupt it', async () => {
  const f = await fakeMpv()
  const eng = await startedEngine(f)
  eng.getFlightRecorder().length = 0
  eng.getLogTail().length = 0
  assert.ok(eng.getFlightRecorder().length > 0)
  eng.stop(); f.close()
})

// ── Every end-file reason ────────────────────────────────────────────────────

test('an unexplained end-file stop emits stopped with the reason and the position', async () => {
  const f = await fakeMpv()
  const eng = await startedEngine(f)
  eng.state.path = '/music/06 - The Snow Goose.flac'
  eng.state.position = 85.2
  eng.state.duration = 192
  const stopped = new Promise(r => eng.once('stopped', r))
  f.push({ event: 'end-file', reason: 'stop' })
  const d = await stopped
  assert.strictEqual(d.reason, 'stop')
  assert.strictEqual(d.position, 85.2)
  assert.strictEqual(d.path, '/music/06 - The Snow Goose.flac')
  eng.stop(); f.close()
})

test('quit, unknown and a reason mpv has not invented yet all emit stopped', async () => {
  for (const reason of ['quit', 'unknown', 'something-new-in-mpv-1.0']) {
    const f = await fakeMpv()
    const eng = await startedEngine(f)
    const stopped = new Promise(r => eng.once('stopped', r))
    f.push({ event: 'end-file', reason })
    const d = await stopped
    assert.strictEqual(d.reason, reason)
    eng.stop(); f.close()
  }
})

test('an end-file with no reason at all is reported as unknown, not ignored', async () => {
  const f = await fakeMpv()
  const eng = await startedEngine(f)
  const stopped = new Promise(r => eng.once('stopped', r))
  f.push({ event: 'end-file' })
  assert.strictEqual((await stopped).reason, 'unknown')
  eng.stop(); f.close()
})

test('our own loadfile-replace does NOT look like an unexplained stop', async () => {
  const f = await fakeMpv()
  const eng = await startedEngine(f)
  let fired = null
  eng.on('stopped', d => { fired = d })
  await eng.load('/music/b.flac')
  f.push({ event: 'end-file', reason: 'stop' })
  await settle(120)
  assert.strictEqual(fired, null, 'switching tracks must not raise a fault')
  // It is still on the record, marked as ours.
  const ef = eng.getFlightRecorder().filter(r => r.ev === 'end-file').pop()
  assert.strictEqual(ef.reason, 'stop')
  assert.strictEqual(ef.expected, true)
  eng.stop(); f.close()
})

test('setNext playlist-clear does NOT look like an unexplained stop', async () => {
  const f = await fakeMpv()
  const eng = await startedEngine(f)
  let fired = null
  eng.on('stopped', d => { fired = d })
  await eng.setNext('/music/c.flac')
  f.push({ event: 'end-file', reason: 'stop' })
  await settle(120)
  assert.strictEqual(fired, null)
  eng.stop(); f.close()
})

test('a redirect is mpv resolving a playlist entry, not a fault', async () => {
  const f = await fakeMpv()
  const eng = await startedEngine(f)
  let fired = false
  eng.on('stopped', () => { fired = true })
  eng.on('loadError', () => { fired = true })
  f.push({ event: 'end-file', reason: 'redirect' })
  await settle(120)
  assert.strictEqual(fired, false)
  assert.ok(eng.getFlightRecorder().some(r => r.ev === 'end-file' && r.reason === 'redirect'),
    'still recorded, just not reported')
  eng.stop(); f.close()
})

test('eof still means ended, and error still means loadError', async () => {
  const f = await fakeMpv()
  const eng = await startedEngine(f)
  let stoppedFired = false
  eng.on('stopped', () => { stoppedFired = true })
  const ended = new Promise(r => eng.once('ended', r))
  f.push({ event: 'end-file', reason: 'eof' })
  await ended

  const f2 = await fakeMpv()
  const eng2 = await startedEngine(f2)
  eng2.state.path = '/music/gone.flac'
  const failed = new Promise(r => eng2.once('loadError', r))
  f2.push({ event: 'end-file', reason: 'error', file_error: 'loading failed' })
  assert.strictEqual(await failed, '/music/gone.flac')
  assert.strictEqual(stoppedFired, false)
  eng.stop(); eng2.stop(); f.close(); f2.close()
})

// ── Diagnostics ──────────────────────────────────────────────────────────────

test('an unexplained stop emits a diagnostic carrying mpv words and the timeline', async () => {
  const f = await fakeMpv()
  const eng = await startedEngine(f)
  eng.state.path = '/music/06 - The Snow Goose.flac'
  eng.state.position = 85.2
  f.push({ event: 'log-message', level: 'error', prefix: 'ao/pipewire', text: 'Audio device lost' })
  await settle()
  const diag = new Promise(r => eng.once('diagnostic', r))
  f.push({ event: 'end-file', reason: 'stop' })
  const d = await diag
  assert.strictEqual(d.kind, 'stopped')
  assert.strictEqual(d.detail.reason, 'stop')
  assert.strictEqual(d.state.path, '/music/06 - The Snow Goose.flac')
  assert.ok(d.log.some(l => /Audio device lost/.test(l.text)), 'the diagnosis must travel with the fault')
  assert.ok(d.flight.some(r => r.ev === 'end-file' && r.reason === 'stop'))
  eng.stop(); f.close()
})

test('a load error emits a diagnostic too', async () => {
  const f = await fakeMpv()
  const eng = await startedEngine(f)
  const diag = new Promise(r => eng.once('diagnostic', r))
  f.push({ event: 'end-file', reason: 'error', file_error: 'unrecognized file format' })
  const d = await diag
  assert.strictEqual(d.kind, 'load-error')
  assert.strictEqual(d.detail.fileError, 'unrecognized file format')
  eng.stop(); f.close()
})

// ── engineDown / engineRecovered / engineFailed ──────────────────────────────

test('engineDown says whether recovery is coming, and where playback was', async () => {
  const f = await fakeMpv()
  const eng = await startedEngine(f)
  eng.state.path = '/music/a.flac'
  eng.state.position = 85.2
  eng.state.paused = false
  const down = new Promise(r => eng.once('engineDown', r))
  f.proc.emit('exit', null, 'SIGKILL')
  const d = await down
  assert.strictEqual(d.willRecover, true)
  assert.strictEqual(d.position, 85.2)
  assert.strictEqual(d.path, '/music/a.flac')
  const rec = eng.getFlightRecorder().find(r => r.ev === 'proc-exit')
  assert.strictEqual(rec.signal, 'SIGKILL', 'how mpv died is the first question asked')
  eng.stop(); f.close()
})

test('a recovered engine reports where it resumed, so the UI can say so', async () => {
  const f = await fakeMpv()
  const eng = await startedEngine(f)
  eng.state.path = '/music/a.flac'
  eng.state.position = 85.2
  eng.state.paused = false
  const back = new Promise(r => eng.once('engineRecovered', r))
  const stopPump = pumpPlaybackRestart(f)
  f.proc.emit('exit', 1)
  const d = await back
  stopPump()
  assert.strictEqual(d.resumed, true)
  assert.strictEqual(d.position, 85.2)
  assert.strictEqual(d.wasPlaying, true)
  assert.ok(f.commands.some(c => c[0] === 'seek' && c[1] === 85.2),
    'resume means resume at the same position, not from the top')
  eng.stop(); f.close()
})

test('engineFailed carries the real reason instead of implying mpv is missing', async () => {
  const f = await fakeMpv()
  const eng = await startedEngine(f)
  f.push({ event: 'log-message', level: 'error', prefix: 'ao/alsa', text: 'Could not open ALSA device' })
  await settle()
  let failure = null
  eng.on('engineFailed', d => { failure = d })
  // Four deaths inside the window: three respawns are allowed, the fourth is not.
  const stopPump = pumpPlaybackRestart(f)
  for (let i = 0; i < 4; i++) {
    const settled = new Promise(r => {
      eng.once('engineRecovered', r)
      eng.once('engineFailed', r)
    })
    f.proc.emit('exit', 1)
    await settled
  }
  stopPump()
  assert.ok(failure, 'engineFailed should have fired on the fourth death')
  assert.strictEqual(failure.reason, 'respawn-limit')
  assert.match(failure.detail, /died \d+ times in 60s/)
  assert.ok(failure.log.some(l => /Could not open ALSA device/.test(l)),
    "the UI needs mpv's reason to write an honest message")
  eng.stop(); f.close()
})

test('an intentional stop still reports nothing', async () => {
  const f = await fakeMpv()
  const eng = await startedEngine(f)
  let noise = 0
  for (const ev of ['engineDown', 'engineFailed', 'stopped', 'diagnostic']) eng.on(ev, () => { noise++ })
  eng.stop()
  await settle(120)
  assert.strictEqual(noise, 0, 'quitting the app is not a fault')
  f.close()
})
