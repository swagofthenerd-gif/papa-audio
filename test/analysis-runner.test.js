'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { buildFfmpegArgs, analyseOne } = require('../analysis-runner')

const GOOD = `
    I:         -14.2 LUFS
    LRA:        11.4 LU
    Peak:        -0.3 dBFS
[astats] RMS level dB: -18.372
[astats] Crest factor: 6.221
[astats] Zero crossings rate: 0.041270
[astats] Flat factor: 0.000000
[Parsed_ametadata_5 @ 0x4] lavfi.aspectralstats.1.centroid=1800.00
[Parsed_ametadata_5 @ 0x4] lavfi.aspectralstats.1.flatness=0.128
[Parsed_ametadata_5 @ 0x4] lavfi.aspectralstats.1.rolloff=4820.50
[Parsed_ametadata_5 @ 0x4] lavfi.aspectralstats.1.entropy=0.712
[Parsed_ametadata_5 @ 0x4] lavfi.aspectralstats.2.centroid=1884.62
[Parsed_ametadata_5 @ 0x4] lavfi.aspectralstats.2.flatness=0.128
[Parsed_ametadata_5 @ 0x4] lavfi.aspectralstats.2.rolloff=4820.50
[Parsed_ametadata_5 @ 0x4] lavfi.aspectralstats.2.entropy=0.712
`

function fakeSpawn({ stderr = '', code = 0, delay = 0 }) {
  return () => {
    const proc = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = () => { proc.emit('close', null) }
    setTimeout(() => {
      if (stderr) proc.stderr.emit('data', Buffer.from(stderr))
      proc.emit('close', code)
    }, delay)
    return proc
  }
}

test('args downmix to mono 22050 and request all three filter sets', () => {
  const args = buildFfmpegArgs('/music/a.flac')
  const af = args[args.indexOf('-af') + 1]
  assert.ok(args.includes('/music/a.flac'))
  assert.ok(af.includes('aresample=22050'))
  assert.ok(af.includes('channel_layouts=mono'))
  assert.ok(af.includes('ebur128'))
  assert.ok(af.includes('astats'))
  assert.ok(af.includes('aspectralstats'))
  assert.ok(args.includes('-nostats'))
})

test('a clean run returns a vector', async () => {
  const r = await analyseOne('/a.flac', { spawnFn: fakeSpawn({ stderr: GOOD }) })
  assert.strictEqual(r.ok, true)
  assert.ok(Number.isFinite(r.vector.energy))
})

test('a non-zero exit is reported, not thrown', async () => {
  const r = await analyseOne('/a.flac', { spawnFn: fakeSpawn({ stderr: 'boom', code: 1 }) })
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /exit|1/)
})

test('output that parses to nothing usable is a failure, not a null vector', async () => {
  const r = await analyseOne('/a.flac', { spawnFn: fakeSpawn({ stderr: 'nothing here', code: 0 }) })
  assert.strictEqual(r.ok, false)
})

test('a hung ffmpeg is killed and reported rather than hanging forever', async () => {
  const r = await analyseOne('/a.flac', { spawnFn: fakeSpawn({ delay: 5000 }), timeoutMs: 30 })
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /timed out/i)
})

test('a spawn error is reported', async () => {
  const spawnFn = () => {
    const proc = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = () => {}
    setTimeout(() => proc.emit('error', new Error('ENOENT')), 0)
    return proc
  }
  const r = await analyseOne('/a.flac', { spawnFn })
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /ENOENT/)
})
