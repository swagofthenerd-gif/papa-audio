'use strict'
const test = require('node:test')
const assert = require('node:assert')
const net = require('net')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { EventEmitter } = require('events')
const { MpvEngine } = require('../mpv-engine')

function fakeMpv() {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'papa-conf-')), 'mpv.sock')
  const conns = []
  const commands = []
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
        c.write(JSON.stringify({ error: 'success', data: null, request_id: msg.request_id }) + '\n')
      }
    })
  })
  const proc = new EventEmitter()
  proc.kill = () => proc.emit('exit', 0)
  return new Promise(res => server.listen(sock, () => res({
    sock, proc, commands,
    spawnFn: () => proc,
    push: msg => conns.forEach(c => c.write(JSON.stringify(msg) + '\n')),
    close: () => { conns.forEach(c => c.destroy()); server.close() },
  })))
}

const settle = () => new Promise(r => setTimeout(r, 40))

// The fake mpv is torn down in a finally. An assertion that throws before
// stop()/close() leaves a listening socket behind and node --test then waits on
// the open handle instead of reporting the failure — a mutation check that
// hangs rather than going red is one you cannot read.
async function withEngine(fn) {
  const f = await fakeMpv()
  const eng = new MpvEngine({ spawnFn: f.spawnFn, socketPath: f.sock })
  await eng.start()
  try { await fn(eng, f) } finally { try { eng.stop() } catch (_) {} f.close() }
}

// trackChanged exists to tell the renderer what mpv ACTUALLY has open, as
// opposed to what the app asked for. load() sets state.path the moment loadfile
// is issued, so comparing mpv's confirmation against state.path made every
// confirmation look like old news: the event was never emitted for an ordinary
// track change, and the renderer's copy of mpv's path sat at null — or, once
// set by a rarer path, stayed stale for the rest of the session.
test('mpv confirming an explicitly loaded file still emits trackChanged', () => withEngine(async (eng, f) => {
  const seen = []
  eng.on('trackChanged', p => seen.push(p))
  await eng.load('/music/a.flac')
  f.push({ event: 'property-change', name: 'path', data: '/music/a.flac' })
  await settle()
  assert.deepStrictEqual(seen, ['/music/a.flac'],
    'the confirmation for an explicit load must reach the renderer')
}))

test('every manual track change is confirmed, not just the first', () => withEngine(async (eng, f) => {
  const seen = []
  eng.on('trackChanged', p => seen.push(p))
  for (const file of ['/music/a.flac', '/music/b.flac', '/music/c.flac']) {
    await eng.load(file)
    f.push({ event: 'property-change', name: 'path', data: file })
    await settle()
  }
  assert.deepStrictEqual(seen, ['/music/a.flac', '/music/b.flac', '/music/c.flac'])
}))

test('a repeated report of the same file is not re-announced', () => withEngine(async (eng, f) => {
  const seen = []
  eng.on('trackChanged', p => seen.push(p))
  await eng.load('/music/a.flac')
  f.push({ event: 'property-change', name: 'path', data: '/music/a.flac' })
  await settle()
  f.push({ event: 'property-change', name: 'path', data: '/music/a.flac' })
  await settle()
  assert.deepStrictEqual(seen, ['/music/a.flac'], 'exactly once for one file')
}))

// The prefetched next must still be told apart from a manual jump, or a gapless
// advance would be reported as though the listener had picked the track.
test('the prefetched next is still announced as autoAdvanced, not trackChanged', () => withEngine(async (eng, f) => {
  const changed = [], advanced = []
  eng.on('trackChanged', p => changed.push(p))
  eng.on('autoAdvanced', p => advanced.push(p))
  await eng.load('/music/a.flac')
  f.push({ event: 'property-change', name: 'path', data: '/music/a.flac' })
  await settle()
  await eng.setNext('/music/b.flac')
  f.push({ event: 'property-change', name: 'path', data: '/music/b.flac' })
  await settle()
  assert.deepStrictEqual(advanced, ['/music/b.flac'])
  assert.deepStrictEqual(changed, ['/music/a.flac'], 'the gapless advance is not a manual change')
}))

// Re-announcing the ADVANCE would double-scrobble; saying nothing at all left
// the renderer's copy of mpv's file pinned to the track that just finished,
// which is exactly what the desync reconciler then acted on.
test('a suppressed late advance still reports which file mpv now has open', () => withEngine(async (eng, f) => {
  await eng.load('/music/a.flac')
  f.push({ event: 'property-change', name: 'path', data: '/music/a.flac' })
  await settle()
  await eng.setNext('/music/b.flac')
  const changed = [], advanced = []
  eng.on('trackChanged', p => changed.push(p))
  eng.on('autoAdvanced', p => advanced.push(p))
  const ended = new Promise(r => eng.once('ended', r))
  f.push({ event: 'end-file', reason: 'eof' })
  await ended
  f.push({ event: 'property-change', name: 'path', data: '/music/b.flac' })
  await settle()
  assert.deepStrictEqual(advanced, [], 'the advance itself stays suppressed')
  assert.deepStrictEqual(changed, ['/music/b.flac'], 'but which file is open is still reported')
  assert.ok(eng.getFlightRecorder().some(r => r.ev === 'late-advance-suppressed'),
    'and it is still recorded as a suppressed late advance')
}))
