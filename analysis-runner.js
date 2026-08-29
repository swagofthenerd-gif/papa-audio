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

module.exports = { buildFfmpegArgs, analyseOne, DEFAULT_TIMEOUT_MS }
