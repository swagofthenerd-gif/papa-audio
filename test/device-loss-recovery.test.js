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
    // The engine closes its socket while it respawns, and the playback-restart
    // pump keeps firing across that moment. Writing to the closed end throws
    // EPIPE out of the interval and failed the test roughly two runs in five —
    // a flaky test is worse than no test, and this one was flaky because of the
    // harness, not the thing under test.
    push: msg => conns.forEach(c => {
      try { if (c.writable && !c.destroyed) c.write(JSON.stringify(msg) + '\n') } catch (_) {}
    }),
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
// Exercised by calling _onExit directly rather than by killing the process and
// waiting for a respawn to announce itself. The bug was a synchronous TypeError
// thrown INSIDE _onExit, before start() was ever reached, so "does this path
// complete and reach the respawn" is the exact question — and asking it directly
// removes the socket handshake, the playback-restart pump and the machine's
// load from the answer. Two earlier versions of this test raced that handshake
// and failed 2-3 runs in 20 even at four times the headroom; a flaky test is
// worse than no test.
async function deviceFaultExit(eng, f, { playing }) {
  await eng.load('/music/a.flac', { play: playing })
  eng.state.paused = !playing
  f.push({ event: 'log-message', level: 'error', prefix: 'ao/alsa', text: 'Audio device lost, trying to reopen' })
  await settle()
  const calls = []
  eng.start = async function () { calls.push(Date.now()); eng.alive = true; return true }
  await eng._onExit()
  // The flight recorder is the deterministic witness: _rec('device-loss-pause')
  // is written by the policy itself, on the line immediately after the
  // assignment that used to throw. The engineRecovered payload would need the
  // real resume sequence, which a stubbed start() deliberately skips.
  const rec = eng.getFlightRecorder()
  return {
    restarts: calls.length,
    pausedForSafety: rec.some(r => r.ev === 'device-loss-pause'),
  }
}

test('pulling the audio device mid-track still brings the engine back', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock, ...FAST })
  await eng.start()
  try {
    const r = await deviceFaultExit(eng, f, { playing: true })
    assert.strictEqual(r.restarts, 1,
      'the engine must actually try to come back — the policy used to throw before it could')
    assert.strictEqual(r.pausedForSafety, true,
      'and record that it came back paused on purpose, so the renderer can offer "keep playing"')
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
    const r = await deviceFaultExit(eng, f, { playing: true })
    assert.strictEqual(r.restarts, 1, 'it recovered')
    assert.strictEqual(r.pausedForSafety, false, 'continue means keep playing')
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
    const r = await deviceFaultExit(eng, f, { playing: false })
    assert.strictEqual(r.restarts, 1, 'it recovered')
    assert.strictEqual(r.pausedForSafety, false,
      'it was already paused; there is nothing to pause for safety')
  } finally {
    try { eng.stop() } catch (_) {}
    f.close()
  }
})
