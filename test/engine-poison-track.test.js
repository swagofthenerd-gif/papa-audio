'use strict'
// THE DSD CRASH (field report, 2026-09-11): "i cant play the song, the
// playback service is crashing".
//
// mpv took SIGSEGV roughly 1-3s after opening a DSD64 (.dsf) file — 17 times
// in a row, every one of them a .dsf, never a FLAC. Decoding the same file to
// a null output was fine, so the fault was in the output path, i.e. outside
// this app: an mpv/ALSA-level crash we cannot patch from here.
//
// What WAS ours: the respawn path resumed the very file that had just killed
// mpv, so one bad track burned the whole respawn budget and took the engine
// down with it — the player died instead of the track. These tests pin the
// quarantine: a file that kills the engine twice, early, is skipped and named,
// the engine stays alive, and a long-playing track is never blamed for an
// unrelated fault.
const test = require('node:test')
const assert = require('node:assert')
const net = require('net')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { PassThrough } = require('stream')
const { EventEmitter } = require('events')
const { MpvEngine } = require('../mpv-engine')

function fakeMpv() {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'papa-poison-')), 'mpv.sock')
  const conns = []
  const procs = []
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
        c.write(JSON.stringify({ error: 'success', data: null, request_id: msg.request_id }) + '\n')
      }
    })
  })
  return new Promise(res => server.listen(sock, () => res({
    sock, procs,
    spawnFn: () => {
      const p = new EventEmitter()
      p.stderr = new PassThrough()
      p.kill = () => {}
      procs.push(p)
      return p
    },
    // Kill the newest spawned mpv the way a segfault does.
    crash: () => procs[procs.length - 1].emit('exit', null, 'SIGSEGV'),
    close: () => { conns.forEach(c => c.destroy()); server.close() },
  })))
}

const FAST = { tickMs: 20, heartbeatTicks: 3, stallMs: 200, eofGraceMs: 20, eofAdvanceMs: 120, resumeTimeoutMs: 300 }
const settle = (ms = 120) => new Promise(r => setTimeout(r, ms))

test('a file that kills the engine twice is skipped, and the engine survives', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock, ...FAST })
  await eng.start()
  const skipped = []
  const failed = []
  eng.on('trackUnplayable', d => skipped.push(d))
  eng.on('engineFailed', d => failed.push(d))

  await eng.load('/music/Camel/01 Echoes.dsf')
  f.crash()
  await settle(200)   // first death: recovers and resumes, as before
  f.crash()
  await settle(300)   // second EARLY death on the same path: poison

  assert.equal(skipped.length, 1, 'the track is reported unplayable exactly once')
  assert.match(skipped[0].path, /01 Echoes\.dsf$/)
  assert.equal(failed.length, 0, 'the ENGINE must not be declared failed')
  assert.ok(eng.alive, 'the engine is alive and ready for the next track')
  eng.stop(); f.close()
})

test('the skip is recorded in the flight recorder with the file and the count', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock, ...FAST })
  await eng.start()
  eng.on('trackUnplayable', () => {})
  await eng.load('/music/bad.dsf')
  f.crash(); await settle(200)
  f.crash(); await settle(300)
  const rec = eng.getFlightRecorder()
  assert.ok(rec.some(r => r.ev === 'track-poisoned' && /bad\.dsf/.test(String(r.path))),
    'the quarantine is visible in the diagnostics bundle')
  eng.stop(); f.close()
})

test('one death still recovers normally — a track gets its second chance', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock, ...FAST })
  await eng.start()
  const skipped = []
  eng.on('trackUnplayable', d => skipped.push(d))
  await eng.load('/music/fine.flac')
  f.crash()
  await settle(250)
  assert.equal(skipped.length, 0, 'a single crash is not a verdict on the file')
  assert.ok(eng.alive)
  eng.stop(); f.close()
})

test('deaths on DIFFERENT files never accumulate into a false poisoning', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock, ...FAST })
  await eng.start()
  const skipped = []
  eng.on('trackUnplayable', d => skipped.push(d))
  await eng.load('/music/a.flac')
  f.crash(); await settle(200)
  await eng.load('/music/b.flac')
  f.crash(); await settle(250)
  assert.equal(skipped.length, 0, 'two different files, one death each — neither is poison')
  eng.stop(); f.close()
})

test('a track that had been playing a long time is not blamed for a late crash', async () => {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock, ...FAST })
  await eng.start()
  const skipped = []
  eng.on('trackUnplayable', d => skipped.push(d))
  await eng.load('/music/long-set.flac')
  // Pretend the file opened well outside the poison window.
  eng._pathOpenedAt = Date.now() - 10 * 60 * 1000
  f.crash(); await settle(200)
  eng._pathOpenedAt = Date.now() - 10 * 60 * 1000
  f.crash(); await settle(250)
  assert.equal(skipped.length, 0, 'late deaths are engine faults, not bad files')
  eng.stop(); f.close()
})
