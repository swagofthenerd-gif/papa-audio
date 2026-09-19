'use strict'
// A start() that fails part-way used to throw and leave mpv running.
//
// The engine spawns mpv, connects, then observes its properties. Either of the
// last two failing threw straight out of start() without killing the process it
// had just spawned or removing the socket file — and since `alive` was never
// set, nothing would ever call stop() on it either. So a failed start left an
// idle mpv holding an audio device, and every retry left another.
// video-engine.js already tore down on exactly this path; this pins the same
// behaviour for the music engine.
const test = require('node:test')
const assert = require('node:assert')
const net = require('net')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { PassThrough } = require('stream')
const { EventEmitter } = require('events')
const { MpvEngine } = require('../mpv-engine')

// A fake mpv that answers the IPC handshake but refuses to observe anything —
// which is what a real mpv too old or too broken for a property looks like.
function fakeMpv({ refuseObserve = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-startleak-'))
  const sock = path.join(dir, 'mpv.sock')
  const conns = []
  const server = net.createServer(c => {
    conns.push(c)
    c.on('error', () => {})
    let buf = ''
    c.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line)
        const isObserve = msg.command && msg.command[0] === 'observe_property'
        const reply = (refuseObserve && isObserve)
          ? { error: 'property not found', request_id: msg.request_id }
          : { error: 'success', data: null, request_id: msg.request_id }
        try { c.write(JSON.stringify(reply) + '\n') } catch (_) {}
      }
    })
  })
  const proc = new EventEmitter()
  proc.stderr = new PassThrough()
  proc.killed = 0
  proc.kill = () => { proc.killed++; proc.emit('exit', 0) }
  return new Promise(res => server.listen(sock, () => res({
    sock, proc, dir,
    spawnFn: () => proc,
    close: () => { conns.forEach(c => c.destroy()); server.close(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) {} },
  })))
}

const FAST = { tickMs: 20, heartbeatTicks: 3, stallMs: 80 }

test('an observe failure kills the mpv it just spawned', async () => {
  const f = await fakeMpv({ refuseObserve: true })
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock, ...FAST })
  try {
    await assert.rejects(() => eng.start(), e => {
      assert.strictEqual(e.code, 'OBSERVE_FAILED', 'the real reason still reaches the caller')
      assert.ok(e.property, 'and names the property')
      return true
    })
    assert.strictEqual(f.proc.killed, 1, 'the mpv it spawned must be killed, not left running idle')
    assert.strictEqual(eng.proc, null, 'and the reference dropped')
    assert.strictEqual(eng.client, null, 'the IPC client goes with it')
    assert.strictEqual(eng.alive, false)
  } finally {
    f.close()
  }
})

test('a connect failure kills the mpv it just spawned and removes the socket', async () => {
  // No server listening: the socket path exists as a plain file, so connect()
  // fails the way it does when mpv spawned but never opened its socket.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-startleak-'))
  const sock = path.join(dir, 'never-listening.sock')
  fs.writeFileSync(sock, '')
  const proc = new EventEmitter()
  proc.stderr = new PassThrough()
  proc.killed = 0
  proc.kill = () => { proc.killed++; proc.emit('exit', 0) }
  const eng = new MpvEngine({ spawnFn: () => proc, ...FAST, ipcConnectTimeoutMs: 200 })
  // Not the fixed-socket path: the engine owns this name, so it must clean it.
  eng._fixedSocketPath = null
  const realStart = eng.start.bind(eng)
  eng.start = async () => { eng._fixedSocketPath = null; return realStart() }
  try {
    await assert.rejects(() => eng.start())
    assert.strictEqual(proc.killed, 1, 'the spawned mpv must not be left running')
    assert.strictEqual(eng.proc, null)
    assert.strictEqual(eng.client, null)
    assert.strictEqual(fs.existsSync(eng._socketPath), false,
      'the socket file it made must go too, or the orphan reaper cannot tell live from dead')
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) {}
  }
})

// The teardown must never reach past its own generation: a start() that lost a
// race has already been replaced, and this.proc now names the replacement's
// process.
test('a stale start does not tear down the engine that replaced it', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock, ...FAST })
  await eng.start()
  const live = eng.proc
  try {
    eng._abandonStart(eng._gen - 1)
    assert.strictEqual(eng.proc, live, 'the live process must survive a stale teardown')
    assert.strictEqual(f.proc.killed, 0, 'and must not be killed')
  } finally {
    eng.stop()
    f.close()
  }
})
