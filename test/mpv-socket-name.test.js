'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const net = require('net')
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')
const { MpvEngine } = require('../mpv-engine')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

// mpv-engine.js generates the socket name; main.js's orphan reaper parses it to
// find the owning pid. Nothing links the two but this test — and when the name
// changed from pid-then-counter to pid-then-random-hex, a reaper matching only
// digits would have silently stopped reaping anything, forever, with the only
// symptom being an mpv that keeps playing after the window is gone.
test('the reaper pattern matches the names the engine actually generates', async () => {
  const m = MAIN.match(/const MPV_SOCK_RE = (\/[^\n]*\/)\n/)
  assert.ok(m, 'main.js must declare MPV_SOCK_RE so this test can check it')
  // eslint-disable-next-line no-eval
  const re = eval(m[1])

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-sock-'))
  const prev = process.env.XDG_RUNTIME_DIR
  process.env.XDG_RUNTIME_DIR = dir
  try {
    // Let the engine name a socket for real, twice, and check both.
    for (let i = 0; i < 2; i++) {
      const proc = new EventEmitter()
      proc.stderr = new PassThrough()
      proc.kill = () => {}
      const eng = new MpvEngine({ spawnFn: () => proc })
      // start() will fail to connect (nothing is listening); the name is chosen
      // before that, which is all this test needs.
      await eng.start().catch(() => {})
      const rec = eng.getFlightRecorder().find(r => r.ev === 'spawn')
      assert.ok(rec, 'the spawn record carries the socket path')
      const base = path.basename(rec.socketPath)
      assert.match(base, re, `the reaper would never match ${base}`)
      assert.strictEqual(Number(base.match(re)[1]), process.pid,
        'the reaper reads the owning pid out of the name')
    }
  } finally {
    if (prev === undefined) delete process.env.XDG_RUNTIME_DIR
    else process.env.XDG_RUNTIME_DIR = prev
  }
})

test('the reaper pattern still matches the old pid-and-counter names', () => {
  const re = eval(MAIN.match(/const MPV_SOCK_RE = (\/[^\n]*\/)\n/)[1])
  // A socket left behind by a build from before the rename still has to be
  // recognised, or upgrading strands an orphan permanently.
  assert.match('papa-mpv-12345-0.sock', re)
  assert.match('papa-mpv-12345-7.sock', re)
})

test('the reaper pattern does not match somebody else', () => {
  const re = eval(MAIN.match(/const MPV_SOCK_RE = (\/[^\n]*\/)\n/)[1])
  for (const name of ['mpv.sock', 'papa-mpv.sock', 'papa-mpv-abc-0.sock', 'papa-mpv-1-.sock',
                      'papa-mpv-1-0.sock.bak', 'other-papa-mpv-1-0.sock']) {
    assert.doesNotMatch(name, re, `${name} is not ours to kill`)
  }
})

test('the engine unlinks its own socket on stop', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-sock2-'))
  const prev = process.env.XDG_RUNTIME_DIR
  process.env.XDG_RUNTIME_DIR = dir
  try {
    // A real listening socket so start() gets far enough to matter.
    const proc = new EventEmitter()
    proc.stderr = new PassThrough()
    proc.kill = () => {}
    let srv = null
    const eng = new MpvEngine({ spawnFn: (bin, args) => {
      // Stand in for mpv: create the socket it was told to create, and answer,
      // or start() never gets past observing properties.
      const sockArg = args.find(a => a.startsWith('--input-ipc-server='))
      srv = net.createServer(c => {
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
      srv.listen(sockArg.split('=')[1])
      return proc
    } })
    await eng.start()
    const created = eng._socketPath
    assert.strictEqual(fs.existsSync(created), true)
    eng.stop()
    assert.strictEqual(fs.existsSync(created), false,
      'a socket left on disk is what made the reaper ambiguous in the first place')
    srv?.close()
  } finally {
    if (prev === undefined) delete process.env.XDG_RUNTIME_DIR
    else process.env.XDG_RUNTIME_DIR = prev
  }
})
