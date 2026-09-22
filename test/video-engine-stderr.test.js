'use strict'
// mpv only ever explains a refusal on stderr. This engine used to drain that
// pipe into nothing — necessary (a full pipe buffer blocks the process) but it
// threw away the only account of the failure that exists, so "Playback stopped
// unexpectedly (mpv exited)" was the whole of what anyone could know.
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('events')
const { VideoEngine, redactStderr, STDERR_KEEP_LINES } = require('../video-engine')

function fakeProc() {
  const proc = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = () => {}
  return proc
}

// Drive start() far enough to attach the stderr handler without needing a real
// mpv or a real socket. The start is NOT awaited: its connect to a socket that
// will never exist eventually fails and tears the process reference down, which
// is correct — but every line mpv writes arrives long before that, in the window
// this opens.
async function engineWithProc() {
  const proc = fakeProc()
  const engine = new VideoEngine({
    binary: '/nonexistent/mpv',
    spawnFn: () => proc,
    socketPath: '/nonexistent/papa-test.sock',
  })
  const pending = engine.start('/tmp/nothing.mkv')
  pending.catch(() => {})
  await new Promise(r => setImmediate(r))
  return { engine, proc }
}

test('mpv stderr is kept, not discarded', async () => {
  const { engine, proc } = await engineWithProc()
  proc.stderr.emit('data', 'Failed to recognize file format.\n')
  assert.deepEqual(engine.stderrTail(), ['Failed to recognize file format.'])
})

test('a partial line is held until its newline arrives', async () => {
  const { engine, proc } = await engineWithProc()
  proc.stderr.emit('data', 'Cannot open ')
  assert.deepEqual(engine.stderrTail(), [], 'half a line is not a line yet')
  proc.stderr.emit('data', 'file\nnext line\n')
  assert.deepEqual(engine.stderrTail(), ['Cannot open file', 'next line'])
})

test('the ring is bounded, keeping the most recent lines', async () => {
  const { engine, proc } = await engineWithProc()
  for (let i = 0; i < STDERR_KEEP_LINES + 50; i++) proc.stderr.emit('data', 'line ' + i + '\n')
  const tail = engine.stderrTail()
  assert.equal(tail.length, STDERR_KEEP_LINES)
  assert.equal(tail[tail.length - 1], 'line ' + (STDERR_KEEP_LINES + 49))
})

test('a replaced process cannot write into the live engine log', async () => {
  const { engine, proc } = await engineWithProc()
  const stale = proc
  engine.proc = fakeProc()               // as a newer start() would leave it
  stale.stderr.emit('data', 'dying words of the old mpv\n')
  assert.deepEqual(engine.stderrTail(), [], 'the old process no longer speaks for this engine')
})

// The reason redaction is not optional: mpv prints the URL it opens, and a
// RealDebrid link carries the account token in its path. A diagnostic log that
// leaks the token is worse than no log.
test('a debrid URL is reduced to its host', () => {
  const line = '[ffmpeg/demuxer] Opening https://45.download.real-debrid.com/d/SECRETTOKEN99/Show.S01E02.mkv'
  const out = redactStderr(line)
  assert.ok(!out.includes('SECRETTOKEN99'), 'the token must not survive: ' + out)
  assert.ok(!out.includes('Show.S01E02.mkv'), 'nor the path')
  assert.ok(out.includes('45.download.real-debrid.com'), 'which server refused is not a secret')
})

test('redaction leaves ordinary lines alone', () => {
  assert.equal(redactStderr('Failed to open file'), 'Failed to open file')
  assert.equal(redactStderr(''), '')
})

test('stderrTail redacts what it returns', async () => {
  const { engine, proc } = await engineWithProc()
  proc.stderr.emit('data', 'Opening https://host.example/d/TOKEN/f.mkv\n')
  const tail = engine.stderrTail()
  assert.ok(!tail[0].includes('TOKEN'), tail[0])
})
