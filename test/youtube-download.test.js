'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { parseProgress, sanitizeFilename, buildArgs, downloadAudio } = require('../youtube-download')

test('parseProgress reads yt-dlp percent lines', () => {
  assert.strictEqual(parseProgress('[download]  42.3% of 3.52MiB at 1.2MiB/s ETA 00:02'), 42.3)
  assert.strictEqual(parseProgress('[download] 100% of 3.52MiB in 00:03'), 100)
  assert.strictEqual(parseProgress('[ExtractAudio] Destination: /x/y.opus'), null)
  assert.strictEqual(parseProgress(''), null)
})

test('sanitizeFilename strips path separators and control chars', () => {
  assert.strictEqual(sanitizeFilename('AC/DC: Back in Black'), 'AC_DC_ Back in Black')
  assert.strictEqual(sanitizeFilename('a b\nc'), 'a bc')
  assert.strictEqual(sanitizeFilename('  spaced  '), 'spaced')
  assert.strictEqual(sanitizeFilename('CON? <title>"song" *feat|ft*>'), 'CON_ _title__song_ _feat_ft__')
  assert.strictEqual(sanitizeFilename('song...  '), 'song')
})

test('buildArgs keeps native codec (no --audio-format) and guards dash ids', () => {
  const args = buildArgs({ videoId: '-abc123', base: 'Artist - Title', outDir: '/dl' })
  assert.ok(args.includes('-x'))
  assert.ok(args.includes('bestaudio'))
  assert.ok(!args.includes('--audio-format'))
  assert.ok(args.includes('--embed-metadata'))
  assert.ok(args.includes('--embed-thumbnail'))
  assert.ok(args.includes('/dl/Artist - Title.%(ext)s'))
  // '--' must come right before the video id so a leading dash isn't a flag
  assert.strictEqual(args[args.length - 2], '--')
  assert.strictEqual(args[args.length - 1], '-abc123')
})

function fakeSpawn(exitCode, stdoutLines, stderrText) {
  return () => {
    const proc = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    setImmediate(() => {
      for (const l of stdoutLines) proc.stdout.emit('data', Buffer.from(l + '\n'))
      if (stderrText) proc.stderr.emit('data', Buffer.from(stderrText))
      proc.emit('close', exitCode)
    })
    return proc
  }
}

test('downloadAudio resolves ok and reports progress', async () => {
  const seen = []
  const r = await downloadAudio({
    videoId: 'x', title: 'T', artist: 'A', outDir: '/tmp',
    onProgress: p => seen.push(p),
    spawnFn: fakeSpawn(0, ['[download]  50.0% of 1MiB', '[download] 100% of 1MiB']),
  })
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(seen, [50, 100])
})

test('downloadAudio reports failure with stderr tail', async () => {
  const r = await downloadAudio({
    videoId: 'x', title: 'T', artist: 'A', outDir: '/tmp',
    onProgress: () => {},
    spawnFn: fakeSpawn(1, [], 'ERROR: Video unavailable'),
  })
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /Video unavailable/)
})
