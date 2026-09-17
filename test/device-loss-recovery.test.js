'use strict'
const test = require('node:test')
const assert = require('node:assert')
const net = require('net')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { EventEmitter, PassThrough } = require('stream').PassThrough ? require('events') : require('events')
const { PassThrough: PT } = require('stream')
const { MpvEngine } = require('../mpv-engine')

const FAST = { tickMs: 20, heartbeatTicks: 3, stallMs: 80, eofGraceMs: 20, eofAdvanceMs: 120, resumeTimeoutMs: 300 }
const settle = (ms = 80) => new Promise(r => setTimeout(r, ms))

function fakeMpv() {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'papa-dev-')), 'mpv.sock')
  const conns = []
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
        c.write(JSON.stringify({ error: 'success', data: null, request_id: msg.request_id }) + '\n')
      }
    })
  })
  const { EventEmitter: EE } = require('events')
  const proc = new EE()
  proc.stderr = new PT()
  proc.kill = () => proc.emit('exit', 0)
  return new Promise(res => server.listen(sock, () => res({
    sock, proc,
    spawnFn: () => proc,
    push: msg => conns.forEach(c => c.write(JSON.stringify(msg) + '\n')),
    close: () => { conns.forEach(c => c.destroy()); server.close() },
  })))
}

function pumpPlaybackRestart(f) {
  const t = setInterval(() => f.push({ event: 'playback-restart' }), 15)
  t.unref?.()
  return () => clearInterval(t)
}

// Roadmap 038's default policy is to come back PAUSED after the audio device
// vanishes, rather than blast the next device at full volume. Reaching that
// policy used to throw: `resume` was a const and the policy reassigned it, so a
// TypeError escaped _onExit before start() was ever called. Nothing respawned,
// nothing was emitted, and the only cure was restarting the app.
//
// This is the scenario, not a source-text match: playing, headphones pulled,
// mpv dies. The engine must come back.
test('pulling the audio device mid-track still brings the engine back', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock, ...FAST })
  await eng.start()
  try {
    await eng.load('/music/a.flac', { play: true })
    // Playing, not paused — this is what makes the pause-for-safety policy fire.
    eng.state.paused = false
    f.push({ event: 'log-message', level: 'error', prefix: 'ao/alsa', text: 'Audio device lost, trying to reopen' })
    await settle()

    const recovered = new Promise(r => eng.once('engineRecovered', r))
    const failed = new Promise(r => eng.once('engineFailed', r))
    const stopPump = pumpPlaybackRestart(f)
    f.proc.emit('exit', 1)

    const outcome = await Promise.race([
      recovered.then(d => ({ kind: 'recovered', d })),
      failed.then(d => ({ kind: 'failed', d })),
      settle(2500).then(() => ({ kind: 'nothing at all' })),
    ])
    stopPump()
    assert.notStrictEqual(outcome.kind, 'nothing at all',
      'the engine must say something — silence here is the app dying with no way back')
    assert.strictEqual(outcome.kind, 'recovered', 'and it must actually respawn')
    assert.strictEqual(outcome.d.pausedForSafety, true,
      'and say it came back paused on purpose, so the renderer can offer "keep playing"')
  } finally {
    try { eng.stop() } catch (_) {}
    f.close()
  }
})

// The same path with the continue policy must not pause — that policy exists
// for speakers that are not going anywhere.
test('the continue policy comes back playing instead of paused', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock, ...FAST, config: { onDeviceLoss: 'continue' } })
  await eng.start()
  try {
    await eng.load('/music/a.flac', { play: true })
    eng.state.paused = false
    f.push({ event: 'log-message', level: 'error', prefix: 'ao/alsa', text: 'Could not open audio device' })
    await settle()
    const recovered = new Promise(r => eng.once('engineRecovered', r))
    const stopPump = pumpPlaybackRestart(f)
    f.proc.emit('exit', 1)
    const d = await Promise.race([recovered, settle(2500).then(() => null)])
    stopPump()
    assert.ok(d, 'the engine recovered')
    assert.notStrictEqual(d.pausedForSafety, true, 'continue means keep playing')
  } finally {
    try { eng.stop() } catch (_) {}
    f.close()
  }
})

// A device fault while already paused must not trip the policy either.
test('a device fault while paused recovers without claiming it paused for safety', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock, ...FAST })
  await eng.start()
  try {
    await eng.load('/music/a.flac', { play: false })
    eng.state.paused = true
    f.push({ event: 'log-message', level: 'error', prefix: 'ao/alsa', text: 'Audio device lost, trying to reopen' })
    await settle()
    const recovered = new Promise(r => eng.once('engineRecovered', r))
    const stopPump = pumpPlaybackRestart(f)
    f.proc.emit('exit', 1)
    const d = await Promise.race([recovered, settle(2500).then(() => null)])
    stopPump()
    assert.ok(d, 'the engine recovered')
    assert.notStrictEqual(d.pausedForSafety, true)
  } finally {
    try { eng.stop() } catch (_) {}
    f.close()
  }
})
