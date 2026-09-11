'use strict'
// The smooth player's feed (video plan V1): ffmpeg turns a source into a
// browser-playable fragmented MP4 over a localhost HTTP server, per the
// decision table in src/stream-plan.js. One session per playing title; each
// GET /s/<id>.mp4?t=<sec> starts ffmpeg at that second (seeking outside the
// buffer is a fresh request — the Jellyfin model), and the previous ffmpeg
// for that session is killed so at most one converter runs per title.
// Text subtitles are served as WebVTT sidecars from the same source.
//
// Main-process module. Pure decisions live in src/stream-plan.js; this file
// owns processes and sockets and is exercised by test/web-stream.test.js
// through injectable spawn/probe functions.

const http = require('http')
const { spawn, execFile } = require('child_process')
const crypto = require('crypto')
const planner = require('./src/stream-plan')

function probeStreams(input, execFileFn, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFileFn('ffprobe', [
      '-v', 'error', '-show_streams', '-show_format', '-of', 'json', input,
    ], { encoding: 'utf8', timeout: timeoutMs || 25000, maxBuffer: 4 << 20 }, (err, out) => {
      if (err) return reject(err)
      try {
        const j = JSON.parse(out)
        resolve({ streams: j.streams || [], duration: Number(j.format && j.format.duration) || 0 })
      } catch (e) { reject(e) }
    })
  })
}

function createWebStreamServer(opts) {
  opts = opts || {}
  const spawnFn = opts.spawnFn || spawn
  const execFileFn = opts.execFileFn || execFile
  const log = opts.log || function () {}
  const ffmpegBin = opts.ffmpegBin || 'ffmpeg'
  const sessions = new Map() // id → { input, plan, duration, proc, subs: Map }
  let server = null
  let port = 0

  function _listen() {
    if (server) return Promise.resolve(port)
    return new Promise((resolve, reject) => {
      server = http.createServer(_handle)
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(port) })
    })
  }

  function _killProc(s) {
    if (s && s.proc) {
      try { s.proc.kill('SIGKILL') } catch (_) {}
      s.proc = null
    }
  }
  // Closing a session also stops any subtitle extraction still reading.
  function _killSubs(s) {
    if (s && s.subProcs) for (const p of Array.from(s.subProcs)) { try { p.kill('SIGKILL') } catch (_) {} }
  }

  function _handle(req, res) {
    const u = new URL(req.url, 'http://127.0.0.1')
    let m
    if ((m = /^\/s\/([a-f0-9]+)\.mp4$/.exec(u.pathname))) return _serveStream(sessions.get(m[1]), u, res)
    if ((m = /^\/s\/([a-f0-9]+)\/sub\/(\d+)\.vtt$/.exec(u.pathname))) return _serveSub(sessions.get(m[1]), Number(m[2]), res)
    res.writeHead(404); res.end()
  }

  // Two remote streams (YouTube's separate video and audio files) become one
  // fragmented MP4: copy both, no re-encode. Seeking restarts both inputs at t.
  function _pairArgs(s, t) {
    const seek = t > 0 ? ['-ss', String(t)] : []
    const net = ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '4']
    return ['-hide_banner', '-loglevel', 'error', '-nostdin']
      .concat(net, seek, ['-i', s.pair.video])
      .concat(net, seek, ['-i', s.pair.audio])
      .concat(['-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-sn',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '1000000', '-f', 'mp4', 'pipe:1'])
  }

  function _serveStream(s, u, res) {
    if (!s) { res.writeHead(404); res.end(); return }
    const t = Math.max(0, Number(u.searchParams.get('t')) || 0)
    const burn = u.searchParams.has('burn') ? Number(u.searchParams.get('burn')) : null
    const audioIndex = u.searchParams.has('a') ? Number(u.searchParams.get('a')) : null
    let plan = s.plan
    if (audioIndex != null && audioIndex !== (plan.audio && plan.audio.index)) {
      plan = planner.plan(s.streams, { prefs: { audioIndex } })
      s.plan = plan
    }
    let extra = {}
    if (burn != null) {
      const ordinal = s.streams.filter(x => x.codec_type === 'subtitle').findIndex(x => x.index === burn)
      if (ordinal >= 0) extra = { burnIndex: burn, burnSubOrdinal: ordinal }
    }
    _killProc(s)
    const args = s.pair ? _pairArgs(s, t) : planner.ffmpegArgs(plan, s.input, t, extra)
    log('[web-stream] ffmpeg', args.join(' '))
    const proc = spawnFn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    s.proc = proc
    s.startedAt = t
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'X-Papa-Start': String(t),
    })
    proc.stdout.pipe(res)
    let err = ''
    if (proc.stderr) proc.stderr.on('data', d => { err += String(d); if (err.length > 4000) err = err.slice(-4000) })
    proc.on('close', code => {
      if (s.proc === proc) s.proc = null
      if (code && code !== 0 && code !== 255) log('[web-stream] ffmpeg exited ' + code + ': ' + err.trim().split('\n').slice(-2).join(' | '))
      try { res.end() } catch (_) {}
    })
    res.on('close', () => { if (s.proc === proc) _killProc(s) })
  }

  // One extraction per subtitle track per session, however many requests
  // arrive while it runs: a 4K torrent-backed film showed three ffmpegs
  // reading the same 20 GB file seconds apart. Requests that land mid-flight
  // wait on the same promise. (An extraction still reads the whole input —
  // subtitles are interleaved through it — which on a torrent stream means
  // the whole file; a progressive extractor is a planned follow-up.)
  function _extractSub(s, index) {
    const cached = s.subs.get(index)
    if (cached) return Promise.resolve(cached)
    if (!s.subJobs) s.subJobs = new Map()
    if (s.subJobs.has(index)) return s.subJobs.get(index)
    const job = new Promise(resolve => {
      const proc = spawnFn(ffmpegBin, planner.subtitleArgs(s.input, index), { stdio: ['ignore', 'pipe', 'ignore'] })
      s.subProcs = s.subProcs || new Set()
      s.subProcs.add(proc)
      const chunks = []
      proc.stdout.on('data', d => chunks.push(d))
      proc.on('close', () => {
        s.subProcs.delete(proc)
        s.subJobs.delete(index)
        const text = Buffer.concat(chunks).toString('utf8')
        if (text.length > 10) s.subs.set(index, text)
        resolve(text || 'WEBVTT\n\n')
      })
    })
    s.subJobs.set(index, job)
    return job
  }
  function _serveSub(s, index, res) {
    if (!s) { res.writeHead(404); res.end(); return }
    _extractSub(s, index).then(text => {
      res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
      res.end(text)
    })
  }

  // Probe, plan, register. Resolves the session the renderer needs, or
  // { refused, reason } when the planner cannot serve this source.
  async function open(input, prefs) {
    const { streams, duration } = await probeStreams(input, execFileFn, opts.probeTimeoutMs)
    const plan = planner.plan(streams, { prefs: prefs || {}, caps: opts.caps })
    if (plan.mode === 'refuse') return { refused: true, reason: plan.reason }
    await _listen()
    const id = crypto.randomBytes(8).toString('hex')
    sessions.set(id, { id, input, streams, plan, duration, proc: null, subs: new Map(), startedAt: 0 })
    return {
      id,
      duration,
      streamUrl: `http://127.0.0.1:${port}/s/${id}.mp4`,
      subtitles: plan.subtitles.sidecars.map(sub => ({ index: sub.index, lang: sub.lang, title: sub.title, url: `http://127.0.0.1:${port}/s/${id}/sub/${sub.index}.vtt` })),
      burnable: plan.subtitles.burnable,
      audios: plan.audios,
      plan: { mode: plan.mode, reason: plan.reason, badges: plan.badges, prerollSec: plan.prerollSec, video: plan.video, audio: plan.audio },
    }
  }

  // A session for a video URL plus an audio URL (a YouTube trailer, now that
  // YouTube serves no single file with both). Nothing to probe: the caller
  // asked yt-dlp for H.264 + AAC, which the browser plays as-is.
  async function openPair(videoUrl, audioUrl, opts) {
    if (!videoUrl || !audioUrl) throw new Error('a paired session needs both a video and an audio URL')
    await _listen()
    const id = crypto.randomBytes(8).toString('hex')
    const plan = { mode: 'remux', reason: 'paired streams copied', badges: [], prerollSec: 0, video: { copy: true }, audio: { copy: true } }
    sessions.set(id, { id, input: videoUrl, pair: { video: videoUrl, audio: audioUrl }, streams: [], plan, duration: Number(opts && opts.duration) || 0, proc: null, subs: new Map(), startedAt: 0 })
    return {
      id, duration: Number(opts && opts.duration) || 0,
      streamUrl: `http://127.0.0.1:${port}/s/${id}.mp4`,
      subtitles: [], burnable: [], audios: [], plan, paired: true,
    }
  }

  function close(id) {
    const s = sessions.get(id)
    if (!s) return false
    _killProc(s)
    _killSubs(s)
    sessions.delete(id)
    return true
  }

  function closeAll() { for (const id of Array.from(sessions.keys())) close(id) }

  function shutdown() {
    closeAll()
    if (server) { try { server.close() } catch (_) {} server = null; port = 0 }
  }

  return { open, openPair, close, closeAll, shutdown, _sessions: sessions, _port: () => port, _handle }
}

module.exports = { createWebStreamServer, probeStreams }
