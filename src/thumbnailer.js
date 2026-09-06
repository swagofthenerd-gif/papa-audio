'use strict'
// Seek-bar hover thumbnails (Player #5).
//
// One ffmpeg per requested timestamp, spawned lazily: `at(positionSec)` rounds
// the position to a fixed interval bucket and hands back the cached jpg for that
// bucket, or spawns ffmpeg to make it and returns null until the file is on
// disk. A full pre-pass over a two-hour film would spawn hundreds of ffmpegs the
// moment playback started, most for buckets the viewer never hovers; this pays
// only for the buckets actually asked for, and only once each.
//
// The source is the streamer's own local HTTP URL — the same one mpv is
// playing. ffmpeg seeks it with `-ss <t>` before `-i`, which is an input seek:
// it jumps straight to the nearest keyframe without decoding from zero, so a
// single frame near the two-hour mark costs a keyframe fetch, not a two-hour
// decode. Reading the served URL rather than the half-written file on disk is
// deliberate: WebTorrent pre-allocates every file sparse, so a raw `-ss` into a
// region not yet downloaded reads zeros and ffmpeg either errors or produces a
// grey frame. The server, by contrast, answers a byte-range request by
// prioritising exactly those pieces — the same mechanism a seek in the player
// uses — so the frame that comes back is the real one, fetched on demand.
//
// Three guards keep a hover storm, or a broken source, from turning into an
// ffmpeg storm:
//   • in-flight: a bucket already being generated is not spawned a second time;
//     concurrent hovers over the same spot collapse to one ffmpeg.
//   • negative cache: a bucket whose ffmpeg failed is remembered as failed for a
//     cooldown, so a source that cannot be thumbnailed at all (no video stream,
//     a dead URL) is tried once per bucket per minute, not on every hover.
//   • timeout: an ffmpeg that hangs (a stalled range that never arrives) is
//     killed, and the bucket is marked failed like any other failure.
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// Every generated frame is scaled to this width; height follows the aspect
// ratio (-1). 240px is wide enough to make a scene recognisable in the bubble
// and small enough that the jpg is a few KB and ffmpeg's scale is cheap.
const DEFAULT_WIDTH = 240
// One frame every this many seconds. A hover lands on the nearest bucket, so a
// smaller interval is a finer preview at the cost of more distinct ffmpegs; 30s
// keeps a two-hour film under ~240 possible frames.
const DEFAULT_INTERVAL_SEC = 30
// A ceiling on distinct buckets, so a pathological duration (or a source that
// reports a nonsense length) cannot let the cache grow without bound.
const DEFAULT_MAX_THUMBS = 200
// How long a single ffmpeg may run before it is killed. A frame near a
// downloaded keyframe returns in well under a second; this covers a range that
// has to be fetched from the swarm first, without letting a stalled fetch hang
// a generate slot forever.
const DEFAULT_TIMEOUT_MS = 10000
// How long a failed bucket stays failed before ffmpeg is allowed to try it
// again. Long enough that a broken source is not hammered; short enough that a
// bucket that failed only because its bytes had not arrived yet becomes
// available again once they have.
const DEFAULT_NEGATIVE_TTL_MS = 60000

// Round a position down to its interval bucket. Bucket N covers [N, N+interval).
function bucketOf(positionSec, intervalSec) {
  const p = Number(positionSec)
  const i = Number(intervalSec) || DEFAULT_INTERVAL_SEC
  if (!isFinite(p) || p < 0) return 0
  return Math.floor(p / i) * i
}

// The thumbnailer owns exactly one directory. In production it lives inside the
// stream's own cache directory, so the streamer's existing teardown sweep
// removes it along with the video pieces; cleanup() is the explicit path for a
// caller that owns the lifetime directly.
function createThumbnailer(opts) {
  opts = opts || {}
  const dir = opts.dir
  if (!dir) throw new TypeError('createThumbnailer requires a { dir }')
  // The source is fixed for the life of a thumbnailer: one video, one URL. A new
  // episode gets a new thumbnailer (and a new directory), because its frames and
  // its buckets are its own.
  const source = opts.source || null
  const intervalSec = Number(opts.intervalSec) > 0 ? Number(opts.intervalSec) : DEFAULT_INTERVAL_SEC
  const width = Number(opts.width) > 0 ? Math.floor(Number(opts.width)) : DEFAULT_WIDTH
  const maxThumbs = Number(opts.maxThumbs) > 0 ? Math.floor(Number(opts.maxThumbs)) : DEFAULT_MAX_THUMBS
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS
  const negativeTtlMs = Number(opts.negativeTtlMs) >= 0 ? Number(opts.negativeTtlMs) : DEFAULT_NEGATIVE_TTL_MS
  // A seam for tests: the default spawns real ffmpeg via execFile, but a test
  // hands a fake so the bucket maths, caching and dedupe can be exercised
  // without a video file or the binary. The contract is execFile's:
  // (cmd, args, options, callback) and callback(err).
  const exec = typeof opts.exec === 'function' ? opts.exec : execFile
  // A seam for tests and for a caller that already knows the clock; production
  // reads Date.now.
  const now = typeof opts.now === 'function' ? opts.now : Date.now

  // bucket -> absolute jpg path, for buckets whose file is on disk.
  const ready = new Map()
  // bucket -> true, for buckets whose ffmpeg is running right now.
  const inflight = new Set()
  // bucket -> timestamp the failure expires at.
  const failed = new Map()

  let disposed = false

  // ffmpeg writes the frame but will not create the directory it goes in, so it
  // is made once, up front. A directory that cannot be created leaves every
  // generate failing and the bubble time-only — never a thrown error into the
  // caller.
  let dirReady = false
  try { fs.mkdirSync(dir, { recursive: true }); dirReady = true } catch (_) { dirReady = false }

  function pathFor(bucket) {
    return path.join(dir, `thumb-${bucket}.jpg`)
  }

  // The one place ffmpeg is spawned. Guarded by the caller (at) so it only ever
  // runs for a bucket that is not ready, not in flight and not negative-cached.
  function spawnFor(bucket) {
    inflight.add(bucket)
    const dest = pathFor(bucket)
    // -ss BEFORE -i is an input seek (fast, keyframe-accurate-enough for a
    // preview); -frames:v 1 takes a single frame; -y overwrites a stale partial
    // from a killed run; -an drops audio the frame does not need.
    const args = [
      '-y',
      '-ss', String(bucket),
      '-i', source,
      '-frames:v', '1',
      '-an',
      '-vf', `scale=${width}:-1`,
      dest,
    ]
    try {
      exec('ffmpeg', args, { timeout: timeoutMs }, (err) => {
        inflight.delete(bucket)
        if (disposed) {
          // The stream ended while ffmpeg ran; whatever it wrote is about to be
          // swept with the directory. Record nothing.
          return
        }
        if (err) {
          failed.set(bucket, now() + negativeTtlMs)
          return
        }
        // execFile reports the frame written, but a zero-byte file is a failure
        // dressed as success (it happens when the seek lands past the end of
        // what exists). Treat an empty or missing file as a failure so the
        // bubble never points <img> at nothing.
        let ok = false
        try { ok = fs.statSync(dest).size > 0 } catch (_) { ok = false }
        if (ok) {
          ready.set(bucket, dest)
          failed.delete(bucket)
        } else {
          failed.set(bucket, now() + negativeTtlMs)
        }
      })
    } catch (_) {
      // A synchronous throw from exec (a bad spawn) is a failure like any other.
      inflight.delete(bucket)
      failed.set(bucket, now() + negativeTtlMs)
    }
  }

  return {
    // Round to a bucket; hand back the ready jpg, or null while (or if) it is
    // being made. Never throws, never blocks: the UI treats null as "no preview
    // yet" and shows the time alone.
    at(positionSec) {
      if (disposed || !source || !dirReady) return null
      const bucket = bucketOf(positionSec, intervalSec)
      const cached = ready.get(bucket)
      if (cached) return cached
      // A bucket beyond the ceiling is not generated at all — the cache stays
      // bounded even for a source claiming an absurd duration.
      if (ready.size >= maxThumbs && !ready.has(bucket)) return null
      if (inflight.has(bucket)) return null
      const failUntil = failed.get(bucket)
      if (failUntil != null) {
        if (now() < failUntil) return null
        // Cooldown elapsed: forget the failure and let this call spawn a retry.
        failed.delete(bucket)
      }
      spawnFor(bucket)
      return null
    },

    // Test/inspection surface. Not part of the UI contract.
    _bucketOf(p) { return bucketOf(p, intervalSec) },
    _state() {
      return {
        ready: ready.size,
        inflight: inflight.size,
        failed: failed.size,
        dir,
        source,
      }
    },

    // Remove the directory and stop honouring further calls. In production the
    // streamer's own sweep usually gets here first; this makes the thumbnailer
    // safe to tear down on its own too, and stops a late ffmpeg callback from
    // repopulating a cache whose files are gone.
    cleanup() {
      disposed = true
      ready.clear()
      inflight.clear()
      failed.clear()
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) {}
    },
  }
}

module.exports = {
  createThumbnailer,
  bucketOf,
  DEFAULT_WIDTH,
  DEFAULT_INTERVAL_SEC,
  DEFAULT_MAX_THUMBS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_NEGATIVE_TTL_MS,
}
