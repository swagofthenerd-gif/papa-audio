'use strict'
// Runs ffmpeg over the library to produce feature vectors.
//
// spawnFn is injectable so the whole path is testable without ffmpeg and
// without touching the disk.

const { spawn } = require('child_process')
const { parseAnalysis, rawToVector, FEATURE_VERSION } = require('./src/audio-features')

const DEFAULT_TIMEOUT_MS = 120000

function buildFfmpegArgs(filePath) {
  return [
    '-hide_banner', '-nostats', '-nostdin',
    '-i', filePath,
    '-map', '0:a:0',
    '-af', 'aresample=22050,aformat=channel_layouts=mono,ebur128=peak=true,astats=reset=0,aspectralstats=win_size=8192:overlap=0,ametadata=mode=print',
    '-f', 'null', '-',
  ]
}

function analyseOne(filePath, { spawnFn = spawn, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let done = false
    const finish = r => { if (!done) { done = true; clearTimeout(timer); resolve(r) } }

    let proc
    try {
      proc = spawnFn('ffmpeg', buildFfmpegArgs(filePath), { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (e) {
      return finish({ ok: false, error: String(e && e.message || e) })
    }

    // ffmpeg writes its measurements to stderr, so the buffer is the result,
    // not a diagnostic. A file with no timeout can wedge the whole pool.
    // finish() first, then kill. finish() latches on `done`, so whenever the
    // kill's 'close' arrives -- synchronously or later -- it is already a no-op
    // and cannot overwrite the timeout as the reported outcome. Killing is
    // cleanup here; the timeout is the result.
    const timer = setTimeout(() => {
      finish({ ok: false, error: `timed out after ${timeoutMs}ms` })
      try { proc.kill('SIGKILL') } catch { /* already gone */ }
    }, timeoutMs)

    let buf = ''
    proc.stderr.on('data', d => { buf += d.toString() })
    proc.on('error', e => finish({ ok: false, error: String(e && e.message || e) }))
    proc.on('close', code => {
      if (code !== 0) return finish({ ok: false, error: `ffmpeg exit ${code}` })
      const vector = rawToVector(parseAnalysis(buf))
      if (!vector) return finish({ ok: false, error: 'analysis produced no usable measurements' })
      finish({ ok: true, vector, featureVersion: FEATURE_VERSION })
    })
  })
}

const os = require('os')

function defaultConcurrency() {
  return Math.max(1, (os.cpus() || []).length - 1)
}

function needsAnalysis(track, entry) {
  if (!entry || !entry.vector) return true
  if (entry.featureVersion !== FEATURE_VERSION) return true
  if (Number(entry.mtimeMs) !== Number(track.mtimeMs)) return true
  if (Number(entry.size) !== Number(track.size)) return true
  return false
}

async function runAnalysis({
  tracks = [], existing = new Map(), concurrency = defaultConcurrency(),
  isPlaying = () => false, analyseFn = analyseOne,
  onProgress = () => {}, shouldStop = () => false,
} = {}) {
  const todo = []
  let skipped = 0
  for (const t of tracks) {
    if (needsAnalysis(t, existing.get(t.filePath))) todo.push(t)
    else skipped++
  }

  const results = new Map()
  let analysed = 0, failed = 0, cursor = 0, halted = false

  async function worker() {
    while (!halted) {
      // Playback owns the machine. The stability round established that heavy
      // background work on this path is what breaks audio; this yields to it
      // rather than competing.
      if (isPlaying() || shouldStop()) { halted = true; return }
      const i = cursor++
      if (i >= todo.length) return
      const t = todo[i]
      // analyseFn is injectable, so it can reject as well as resolve {ok:false}.
      // A rejection here would take down Promise.all and discard every vector
      // already collected -- one bad file costing the whole run. Both shapes of
      // failure are the same thing to this loop: count it and carry on.
      let r
      try {
        r = await analyseFn(t.filePath)
      } catch (e) {
        r = { ok: false, error: String((e && e.message) || e) }
      }
      if (r && r.ok) {
        results.set(t.filePath, {
          vector: r.vector, featureVersion: FEATURE_VERSION,
          mtimeMs: t.mtimeMs, size: t.size,
        })
        analysed++
      } else {
        failed++
      }
      onProgress({ done: analysed + failed, total: todo.length, filePath: t.filePath })
    }
  }

  const n = Math.max(1, Math.min(concurrency, todo.length || 1))
  await Promise.all(Array.from({ length: n }, worker))
  return { analysed, skipped, failed, results }
}

module.exports = { buildFfmpegArgs, analyseOne, DEFAULT_TIMEOUT_MS, needsAnalysis, runAnalysis }
