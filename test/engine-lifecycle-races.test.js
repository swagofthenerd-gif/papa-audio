'use strict'
// Three ways the mpv lifecycle misbehaved around a crash or a stop.
//
// 1. A crash-respawn never unlinked the dead socket. stop() removes it; a crash
//    never reaches stop(), and the respawn mints a NEW random name — so every
//    crash left one more stale socket for the orphan reaper to puzzle over.
// 2. stop() landing inside start()'s connect threw a bare TypeError (reading
//    .on off a nulled client) where every call site expects EngineGone.
// 3. The stall probe is five awaited round trips. stop() could land in the
//    middle, and it still emitted 'stalled' — a stall warning for a track
//    nobody was playing any more.
const test = require('node:test')
const assert = require('node:assert')
const net = require('net')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { PassThrough } = require('stream')
const { EventEmitter } = require('events')
const { MpvEngine, EngineGone } = require('../mpv-engine')

function fakeMpv({ mute = false, onConnect = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-races-'))
  const sock = path.join(dir, 'mpv.sock')
  const conns = []
  const state = { mute }
  const server = net.createServer(c => {
    conns.push(c)
    c.on('error', () => {})
    if (onConnect) onConnect()
    let buf = ''
    c.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line)
        if (state.mute) continue
        try { c.write(JSON.stringify({ error: 'success', data: null, request_id: msg.request_id }) + '\n') } catch (_) {}
      }
    })
  })
  const proc = new EventEmitter()
  proc.stderr = new PassThrough()
  proc.kill = () => proc.emit('exit', 0)
  return new Promise(res => server.listen(sock, () => res({
    sock, proc, dir, state,
    spawnFn: () => proc,
    push: msg => conns.forEach(c => { try { if (c.writable && !c.destroyed) c.write(JSON.stringify(msg) + '\n') } catch (_) {} }),
    close: () => { conns.forEach(c => c.destroy()); server.close(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) {} },
  })))
}

const FAST = { tickMs: 20, heartbeatTicks: 3, stallMs: 60 }

// ── 1. the stale socket ─────────────────────────────────────────────────────

test('a crash removes the dead socket before the respawn makes a new one', async () => {
  const f = await fakeMpv()
  // A socket path the engine owns (not the fixed test path), standing in for
  // the file mpv left behind when it died.
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock, ...FAST })
  await eng.start()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-deadsock-'))
  const dead = path.join(dir, 'papa-mpv-dead.sock')
  fs.writeFileSync(dead, '')
  eng._socketPath = dead
  eng._fixedSocketPath = null
  try {
    eng._unlinkSocket()
    assert.strictEqual(fs.existsSync(dead), false,
      "the dead mpv's socket must go, or the orphan reaper cannot tell live from dead")
    const src = fs.readFileSync(path.join(__dirname, '..', 'mpv-engine.js'), 'utf8')
    const onExit = src.slice(src.indexOf('  async _onExit() {'), src.indexOf('let resume = {'))
    assert.match(onExit, /this\._unlinkSocket\(\)/,
      'the crash path itself must do it — the respawn mints a new name')
  } finally {
    eng._socketPath = f.sock
    eng._fixedSocketPath = f.sock
    eng.stop()
    f.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the video engine removes its dead socket on a crash too', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'video-engine.js'), 'utf8')
  const onExit = src.slice(src.indexOf('  _onExit() {'), src.indexOf("this.emit('engineDown', {})"))
  assert.match(onExit, /unlinkSync\(this\._socketPath\)/)
  assert.match(onExit, /!this\._fixedSocketPath/, 'a fixed test socket is not ours to remove')
})

// ── 2. stop() during connect ────────────────────────────────────────────────

test('stop() during connect fails start() with EngineGone, not a TypeError', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock, ...FAST })
  // Stop the engine the moment the socket is accepted — the exact window in
  // which this.client used to be nulled out from under start().
  const realConnect = eng.start
  const p = (async () => {
    const started = realConnect.call(eng)
    await new Promise(r => setImmediate(r))
    eng.stop()
    return started
  })()
  try {
    await assert.rejects(() => p, e => {
      assert.ok(e instanceof EngineGone,
        'expected the engine\'s own "it is gone", got ' + e.name + ': ' + e.message)
      assert.strictEqual(e.code, 'ENGINE_GONE')
      return true
    })
  } finally {
    f.close()
  }
})

// ── 3. the stall probe after stop() ─────────────────────────────────────────

test('a stall probe in flight when stop() lands says nothing', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock, ...FAST })
  const stalls = []
  eng.on('stalled', s => stalls.push(s))
  eng.on('stopped', s => stalls.push(s))
  await eng.start()
  try {
    // Look like a track that is playing and whose position has frozen.
    eng.state.path = '/music/a.flac'
    eng.state.paused = false
    eng.state.duration = 200
    eng._lastPosChangeAt = Date.now() - 100000
    // The probe's round trips never answer while muted, so it is guaranteed to
    // still be in flight when stop() lands.
    f.state.mute = true
    eng._onTick()
    await new Promise(r => setTimeout(r, 20))
    eng.stop()
    f.state.mute = false
    await new Promise(r => setTimeout(r, 300))
    assert.deepStrictEqual(stalls, [],
      'a stall warning for a track nobody is playing any more: ' + JSON.stringify(stalls))
  } finally {
    f.close()
  }
})

test('a stall on a live engine is still reported', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock, ...FAST })
  const stalls = []
  eng.on('stalled', s => stalls.push(s))
  await eng.start()
  try {
    eng.state.path = '/music/a.flac'
    eng.state.paused = false
    eng.state.duration = 200
    eng._lastPosChangeAt = Date.now() - 100000
    eng._onTick()
    await new Promise(r => setTimeout(r, 200))
    assert.strictEqual(stalls.length, 1, 'the watchdog must still do its job')
    assert.strictEqual(stalls[0].path, '/music/a.flac')
  } finally {
    eng.stop()
    f.close()
  }
})
