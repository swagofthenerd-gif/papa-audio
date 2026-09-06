'use strict'
// The seek-bar hover thumbnailer (Player #5). Most of these drive it with a fake
// exec so the bucket maths, the cache, the negative cache and the in-flight
// dedupe are exercised without a video file or ffmpeg; the last one runs real
// ffmpeg against a tiny generated clip to prove a frame actually comes out.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { createThumbnailer, bucketOf } = require('../src/thumbnailer')

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// A fake execFile: records every spawn, and completes it only when the test
// says so, so in-flight state can be observed before the callback fires. Each
// call gets a `finish(err)` pushed onto `calls`. By default it writes a
// non-empty file (a "successful" frame) unless told to fail.
function fakeExec() {
  const calls = []
  const exec = (cmd, args, optsOrCb, cb) => {
    const done = typeof optsOrCb === 'function' ? optsOrCb : cb
    // The destination is the last positional arg (ffmpeg output path).
    const dest = args[args.length - 1]
    calls.push({
      cmd, args, dest,
      finish (err, { write = true } = {}) {
        if (write && !err) {
          try { fs.writeFileSync(dest, 'JPEGBYTES') } catch (_) {}
        }
        done(err || null)
      },
      finishEmpty () {
        // execFile reports success but the file is zero bytes — the "seek past
        // the end" case the thumbnailer must treat as a failure.
        try { fs.writeFileSync(dest, '') } catch (_) {}
        done(null)
      },
    })
  }
  return { exec, calls }
}

test('bucketOf floors a position to its interval', () => {
  assert.strictEqual(bucketOf(0, 30), 0)
  assert.strictEqual(bucketOf(29, 30), 0)
  assert.strictEqual(bucketOf(30, 30), 30)
  assert.strictEqual(bucketOf(31, 30), 30)
  assert.strictEqual(bucketOf(125, 30), 120)
  assert.strictEqual(bucketOf(-5, 30), 0)
  assert.strictEqual(bucketOf(NaN, 30), 0)
})

test('at() rounds to the bucket and spawns exactly one ffmpeg for it', () => {
  const dir = tmp('papa-thumb-')
  const { exec, calls } = fakeExec()
  const t = createThumbnailer({ dir, exec, intervalSec: 30, source: 'http://x/v' })
  try {
    assert.strictEqual(t.at(0), null)          // generating
    assert.strictEqual(t.at(14), null)         // same bucket, already in flight
    assert.strictEqual(t.at(29), null)         // still bucket 0
    assert.strictEqual(calls.length, 1, 'one ffmpeg for bucket 0 despite three hovers')
    assert.strictEqual(calls[0].args.includes('-ss'), true)
    // -ss carries the bucket, not the raw hover position.
    const ssIdx = calls[0].args.indexOf('-ss')
    assert.strictEqual(calls[0].args[ssIdx + 1], '0')
  } finally {
    t.cleanup()
  }
})

test('a finished frame is cached and returned without a second ffmpeg', () => {
  const dir = tmp('papa-thumb-')
  const { exec, calls } = fakeExec()
  const t = createThumbnailer({ dir, exec, intervalSec: 30, source: 'http://x/v' })
  try {
    assert.strictEqual(t.at(45), null)         // bucket 30, spawns
    assert.strictEqual(calls.length, 1)
    calls[0].finish(null)                       // ffmpeg wrote the frame
    const p = t.at(50)                          // same bucket 30
    assert.ok(p && p.endsWith('thumb-30.jpg'), 'cached path returned')
    assert.strictEqual(calls.length, 1, 'no new ffmpeg for a cached bucket')
  } finally {
    t.cleanup()
  }
})

test('in-flight dedupe: concurrent hovers over one bucket spawn one ffmpeg', () => {
  const dir = tmp('papa-thumb-')
  const { exec, calls } = fakeExec()
  const t = createThumbnailer({ dir, exec, intervalSec: 30, source: 'http://x/v' })
  try {
    for (let i = 0; i < 10; i++) t.at(30 + i)   // all bucket 30
    assert.strictEqual(calls.length, 1)
    calls[0].finish(null)
    // Now cached; hovering again returns it, still one ffmpeg total.
    assert.ok(t.at(35))
    assert.strictEqual(calls.length, 1)
  } finally {
    t.cleanup()
  }
})

test('a failed bucket is negative-cached and not retried until the TTL elapses', () => {
  const dir = tmp('papa-thumb-')
  const { exec, calls } = fakeExec()
  let clock = 1000
  const t = createThumbnailer({
    dir, exec, intervalSec: 30, source: 'http://x/v',
    negativeTtlMs: 60000, now: () => clock,
  })
  try {
    t.at(0)
    calls[0].finish({ code: 1 }, { write: false })   // ffmpeg failed
    // Within the cooldown: no new ffmpeg, still null.
    clock += 30000
    assert.strictEqual(t.at(5), null)
    assert.strictEqual(calls.length, 1, 'no retry inside the negative-cache window')
    // After the cooldown: one retry is allowed.
    clock += 40000                                     // 70s > 60s TTL
    assert.strictEqual(t.at(10), null)
    assert.strictEqual(calls.length, 2, 'a retry after the TTL')
  } finally {
    t.cleanup()
  }
})

test('a zero-byte output is treated as a failure, not a cached frame', () => {
  const dir = tmp('papa-thumb-')
  const { exec, calls } = fakeExec()
  const t = createThumbnailer({ dir, exec, intervalSec: 30, source: 'http://x/v' })
  try {
    t.at(0)
    calls[0].finishEmpty()                       // success exit, empty file
    // Not cached: a re-hover after the negative window would spawn again, and
    // right now it returns null rather than a path to an empty file.
    assert.strictEqual(t.at(0), null)
    assert.strictEqual(t._state().ready, 0)
    assert.strictEqual(t._state().failed, 1)
  } finally {
    t.cleanup()
  }
})

test('the max-thumbs ceiling bounds the cache', () => {
  const dir = tmp('papa-thumb-')
  const { exec, calls } = fakeExec()
  const t = createThumbnailer({ dir, exec, intervalSec: 10, source: 'http://x/v', maxThumbs: 2 })
  try {
    t.at(0);  calls[0].finish(null)
    t.at(10); calls[1].finish(null)
    // Two frames cached; a third distinct bucket is refused.
    assert.strictEqual(t._state().ready, 2)
    assert.strictEqual(t.at(20), null)
    assert.strictEqual(calls.length, 2, 'no ffmpeg past the ceiling')
    // A hover back onto an already-cached bucket still works.
    assert.ok(t.at(5))
  } finally {
    t.cleanup()
  }
})

test('cleanup removes the directory and stops honouring calls', () => {
  const dir = tmp('papa-thumb-')
  const { exec } = fakeExec()
  const t = createThumbnailer({ dir, exec, source: 'http://x/v' })
  assert.ok(fs.existsSync(dir))
  t.cleanup()
  assert.strictEqual(fs.existsSync(dir), false, 'directory swept')
  assert.strictEqual(t.at(0), null, 'disposed thumbnailer generates nothing')
})

test('a late ffmpeg callback after cleanup does not repopulate the cache', () => {
  const dir = tmp('papa-thumb-')
  const { exec, calls } = fakeExec()
  const t = createThumbnailer({ dir, exec, source: 'http://x/v' })
  t.at(0)
  t.cleanup()
  // ffmpeg finishes after teardown; the frame it wrote is about to be swept.
  calls[0].finish(null)
  assert.strictEqual(t._state().ready, 0)
})

test('no source means no thumbnails at all', () => {
  const dir = tmp('papa-thumb-')
  const { exec, calls } = fakeExec()
  const t = createThumbnailer({ dir, exec })     // no source
  try {
    assert.strictEqual(t.at(0), null)
    assert.strictEqual(calls.length, 0)
  } finally {
    t.cleanup()
  }
})

// ── Real ffmpeg, against a generated clip ─────────────────────────────────────
// Proves the actual command line produces a frame. Skipped automatically if
// ffmpeg is not on PATH so the suite still runs on a machine without it.
function hasFfmpeg() {
  try {
    require('node:child_process').execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch (_) { return false }
}

test('real ffmpeg extracts a JPEG frame from a generated clip', { skip: !hasFfmpeg() }, async () => {
  const work = tmp('papa-thumb-real-')
  const clip = path.join(work, 'clip.mp4')
  const thumbDir = path.join(work, 'thumbs')
  // A 4-second solid-colour clip at 5fps; enough to seek to a bucket at 2s.
  await new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=5:d=4',
      '-pix_fmt', 'yuv420p', clip,
    ], { timeout: 30000 }, err => err ? reject(err) : resolve())
  })
  const t = createThumbnailer({ dir: thumbDir, source: clip, intervalSec: 2, width: 160 })
  try {
    // First call spawns; poll until the frame lands (real ffmpeg is async).
    assert.strictEqual(t.at(2), null)
    const deadline = Date.now() + 15000
    let p = null
    while (Date.now() < deadline) {
      p = t.at(2)
      if (p) break
      await new Promise(r => setTimeout(r, 100))
    }
    assert.ok(p, 'a frame path eventually returned')
    const size = fs.statSync(p).size
    assert.ok(size > 0, 'the frame file is non-empty')
    // JPEG magic bytes.
    const head = fs.readFileSync(p).subarray(0, 2)
    assert.strictEqual(head[0], 0xff)
    assert.strictEqual(head[1], 0xd8)
  } finally {
    t.cleanup()
    fs.rmSync(work, { recursive: true, force: true })
  }
})
