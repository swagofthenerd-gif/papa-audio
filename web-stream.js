'use strict'
// The smooth player's feed (video plan V1, reworked): ffmpeg turns a source
// into a browser-playable fragmented MP4, served over a localhost HTTP server
// per the decision table in src/stream-plan.js.
//
// Every converter RUN writes to a file in the cache directory while a
// fragment index (src/fmp4-index.js) notes where each second starts. A
// request for a second that a run has already converted is served from that
// file — a seek back into what has played is a file read and starts at
// once; it never runs ffmpeg again. Only one ffmpeg is live per session:
// a request outside every converted span starts a new run at that second
// and stops the previous one (its file stays). Runs are capped in size and
// the oldest finished ones are dropped when a session's cache grows too big.
//
// Text subtitles are served as WebVTT sidecars from the same source, one
// extraction per track. Main-process module; exercised by
// test/web-stream.test.js through injectable spawn/probe functions and a
// temporary cache directory.

const http = require('http')
const { spawn, execFile } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { EventEmitter } = require('events')
const planner = require('./src/stream-plan')
const fmp4 = require('./src/fmp4-index')

const READ_CHUNK = 1 << 20          // 1 MiB per read when following a file
const NEAR_LIVE_SEC = 3             // a run this close behind the target is worth waiting for

// A torrent-backed source may not have its head yet when playback begins:
// the probe is tried a few times before the smooth player gives up on it.
const PROBE_ATTEMPTS = 3
const PROBE_RETRY_MS = 1500
function probeStreams(input, execFileFn, timeoutMs, attempt) {
  const isRemote = /^https?:\/\//i.test(String(input || ''))
  return new Promise((resolve, reject) => {
    execFileFn('ffprobe', [
      '-v', 'error',
    ].concat(isRemote ? ['-rw_timeout', '15000000'] : []).concat([
      '-show_streams', '-show_format', '-show_chapters', '-of', 'json', input,
    ]), { encoding: 'utf8', timeout: timeoutMs || 25000, maxBuffer: 4 << 20 }, (err, out, stderr) => {
      if (err) {
        const n = (attempt || 1)
        if (isRemote && n < PROBE_ATTEMPTS) return setTimeout(() => probeStreams(input, execFileFn, timeoutMs, n + 1).then(resolve, reject), PROBE_RETRY_MS)
        const detail = String(stderr || '').trim().split('\n').slice(-2).join(' | ')
        return reject(new Error('ffprobe could not read the source' + (detail ? ': ' + detail : '') + (isRemote ? ' (after ' + n + ' attempts)' : '')))
      }
      try {
        const j = JSON.parse(out)
        // Chapters in the shape the theatre already reads from mpv.
        const chapters = (Array.isArray(j.chapters) ? j.chapters : []).map((c, i) => ({
          index: i, title: (c.tags && (c.tags.title || c.tags.TITLE)) || null, start: Number(c.start_time) || 0,
        })).filter(c => Number.isFinite(c.start))
        resolve({ streams: j.streams || [], duration: Number(j.format && j.format.duration) || 0, chapters })
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
  const cacheDir = opts.cacheDir || path.join(os.homedir(), '.cache', 'papa-audio', 'web-stream')
  const maxRunBytes = opts.maxRunBytes || 4 * 1024 * 1024 * 1024        // 4 GiB per run
  const maxSessionBytes = opts.maxSessionBytes || 10 * 1024 * 1024 * 1024 // 10 GiB per title
  const sessions = new Map() // id → session
  let server = null
  let port = 0

  try { fs.mkdirSync(cacheDir, { recursive: true }) } catch (_) {}
  // Leftovers from a crash are worthless: no session remembers them.
  try { for (const d of fs.readdirSync(cacheDir)) fs.rmSync(path.join(cacheDir, d), { recursive: true, force: true }) } catch (_) {}

  function _listen() {
    if (server) return Promise.resolve(port)
    return new Promise((resolve, reject) => {
      server = http.createServer(_handle)
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(port) })
    })
  }

  function _handle(req, res) {
    const u = new URL(req.url, 'http://127.0.0.1')
    let m
    if ((m = /^\/s\/([a-f0-9]+)\.mp4$/.exec(u.pathname))) return _serveStream(sessions.get(m[1]), u, res)
    if ((m = /^\/s\/([a-f0-9]+)\/sub\/(\d+)\.vtt$/.exec(u.pathname))) return _serveSub(sessions.get(m[1]), Number(m[2]), res)
    if ((m = /^\/s\/([a-f0-9]+)\/coverage$/.exec(u.pathname))) return _serveCoverage(sessions.get(m[1]), res)
    res.writeHead(404); res.end()
  }

  // ── runs ──────────────────────────────────────────────────────────────────
  function _variantOf(s, u) {
    const burn = u.searchParams.has('burn') ? Number(u.searchParams.get('burn')) : null
    const audioIndex = u.searchParams.has('a') ? Number(u.searchParams.get('a')) : null
    let plan = s.plan
    if (audioIndex != null && !s.pair && audioIndex !== (plan.audio && plan.audio.index)) {
      plan = planner.plan(s.streams, { prefs: { audioIndex } })
      s.plan = plan
    }
    let extra = {}
    if (burn != null && !s.pair) {
      const subs = s.streams.filter(x => x.codec_type === 'subtitle')
      const ordinal = subs.findIndex(x => x.index === burn)
      if (ordinal >= 0) {
        const codec = String(subs[ordinal].codec_name || '').toLowerCase()
        extra = { burnIndex: burn, burnSubOrdinal: ordinal, burnImage: /pgs|dvd_subtitle|dvb/.test(codec) }
      }
    }
    return { key: 'a:' + (plan.audio ? plan.audio.index : '-') + '|b:' + (extra.burnIndex != null ? extra.burnIndex : '-'), plan, extra }
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

  function _liveRun(s) { return s.runs.find(r => !r.done) || null }

  function _stopRun(run, why) {
    if (!run || run.done) return
    run.done = true
    run.truncated = why !== 'finished'
    if (run.proc) { try { run.proc.kill('SIGKILL') } catch (_) {} run.proc = null }
    run.emit('grow')
  }

  // The run (and fragment) that already holds second `t` of this variant.
  function _runCovering(s, variant, t) {
    for (let i = s.runs.length - 1; i >= 0; i--) {
      const r = s.runs[i]
      if (r.variant !== variant || t < r.start || !r.index.state.ready) continue
      const local = t - r.start
      const frag = r.index.fragmentAt(local)
      if (!frag) continue
      const covered = r.index.coveredSec()
      if (local <= covered) return { run: r, frag }
      if (!r.done && local - covered <= NEAR_LIVE_SEC) return { run: r, frag }
    }
    return null
  }

  // A copied picture can only start on a keyframe. Asked for t, the run
  // starts on the keyframe at or before it, and says so (X-Papa-Start), so
  // the page's timeline stays exact and both tracks share one origin.
  function _alignedStart(s, plan, t) {
    if (t <= 0 || s.pair || !(plan.video && plan.video.copy)) return Promise.resolve(t)
    return new Promise(resolve => {
      execFileFn('ffprobe', planner.keyframeProbeArgs(s.input, t, 20), { encoding: 'utf8', timeout: 15000, maxBuffer: 1 << 20 }, (err, out) => {
        if (err) return resolve(t)
        const k = planner.keyframeAtOrBefore(out, t)
        resolve(k == null ? t : k)
      })
    })
  }

  function _startRun(s, variant, plan, extra, t) {
    const live = _liveRun(s)
    if (live) _stopRun(live, 'superseded')
    const run = new EventEmitter()
    Object.assign(run, {
      id: s.nextRun++, variant, start: t, done: false, truncated: false, proc: null,
      file: path.join(s.dir, 'run-' + s.nextRun + '.mp4'), fd: null, bytes: 0, index: fmp4.create(), readers: 0,
    })
    run.setMaxListeners(0)
    try { fs.mkdirSync(s.dir, { recursive: true }) } catch (_) {}
    run.fd = fs.openSync(run.file, 'w')
    // A streamed (http/torrent) input is read once: its text subtitles come
    // out of this same run as WebVTT files. A local file keeps the direct
    // extractor, which is complete in seconds.
    if (_isRemote(s.input) && !s.pair) {
      run.subFiles = (plan.subtitles && plan.subtitles.sidecars || []).map(sub => ({ index: sub.index, file: path.join(s.dir, 'run-' + run.id + '-sub-' + sub.index + '.vtt') }))
      extra = Object.assign({}, extra, { subOutputs: run.subFiles })
    }
    const args = s.pair ? _pairArgs(s, t) : planner.ffmpegArgs(plan, s.input, t, extra)
    log('[web-stream] ffmpeg run ' + run.id + ' @' + t + 's: ' + args.join(' ').slice(0, 200))
    const proc = spawnFn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    run.proc = proc
    s.runs.push(run)
    let err = ''
    let writing = Promise.resolve()
    proc.stdout.on('data', chunk => {
      writing = writing.then(() => new Promise(resolve => {
        fs.write(run.fd, chunk, 0, chunk.length, run.bytes, e => {
          if (!e) { run.bytes += chunk.length; run.index.push(chunk); run.emit('grow') }
          if (run.bytes >= maxRunBytes && !run.done) { log('[web-stream] run ' + run.id + ' reached its size cap'); _stopRun(run, 'capped') }
          resolve()
        })
      }))
    })
    if (proc.stderr) proc.stderr.on('data', d => { err += String(d); if (err.length > 4000) err = err.slice(-4000) })
    proc.on('close', code => {
      writing.then(() => {
        if (run.proc === proc) run.proc = null
        if (code && code !== 0 && code !== 255 && !run.done) log('[web-stream] ffmpeg exited ' + code + ': ' + err.trim().split('\n').slice(-2).join(' | '))
        if (!run.done) { run.done = true; run.truncated = false; run.emit('grow') }
        _trimSession(s)
      })
    })
    return run
  }

  // Keep a title's cache under its cap: drop the oldest finished runs nobody
  // is reading. The live run and any run being read stay.
  function _trimSession(s) {
    let total = s.runs.reduce((n, r) => n + r.bytes, 0)
    for (const r of s.runs.slice()) {
      if (total <= maxSessionBytes) break
      if (!r.done || r.readers > 0) continue
      total -= r.bytes
      _dropRun(s, r)
    }
  }
  function _dropRun(s, r) {
    s.runs = s.runs.filter(x => x !== r)
    try { fs.closeSync(r.fd) } catch (_) {}
    try { fs.unlinkSync(r.file) } catch (_) {}
  }

  // Stream a run's file to a response: the init segment, then from `offset`
  // to the end, following the file while the run is live.
  function _followRun(run, offset, res, durationSec) {
    run.readers++
    let closed = false
    res.on('close', () => { closed = true; run.emit('grow') })
    const fd = fs.openSync(run.file, 'r')
    let pos = 0
    let phase = 'init'   // init bytes [0, initLength), then body from offset
    const readAt = (at, len) => new Promise(resolve => {
      const buf = Buffer.allocUnsafe(len)
      fs.read(fd, buf, 0, len, at, (e, n) => resolve(e || n <= 0 ? null : buf.subarray(0, n)))
    })
    const write = chunk => new Promise(resolve => { if (!res.write(chunk)) res.once('drain', resolve); else resolve() })
    ;(async () => {
      try {
        while (!closed) {
          const initLen = run.index.state.initLength
          if (phase === 'init') {
            if (!run.index.state.ready) { if (run.done) break; await _wait(run); continue }
            if (pos < initLen) {
              let c = await readAt(pos, Math.min(READ_CHUNK, initLen - pos)); if (!c) { await _wait(run); continue }
              // The init segment carries the title's duration (see
              // fmp4.stampDuration): the browser must not take a
              // streamed conversion for a live broadcast.
              if (pos === 0 && c.length === initLen && durationSec > 0) c = Buffer.from(fmp4.stampDuration(c, durationSec))
              pos += c.length; await write(c); continue
            }
            phase = 'body'; pos = Math.max(offset, initLen)
          }
          if (pos < run.bytes) { const c = await readAt(pos, Math.min(READ_CHUNK, run.bytes - pos)); if (!c) { await _wait(run); continue } pos += c.length; await write(c); continue }
          if (run.done) break
          await _wait(run)
        }
      } catch (_) { /* a reader error ends the response below */ }
      run.readers--
      try { fs.closeSync(fd) } catch (_) {}
      try { res.end() } catch (_) {}
    })()
  }
  function _wait(run) { return new Promise(resolve => { const t = setTimeout(done, 250); function done() { clearTimeout(t); run.removeListener('grow', done); resolve() } run.once('grow', done) }) }

  // The seconds already converted to disk, as ranges — what the seek bar
  // shows as buffered beyond the browser's own buffer, and where a seek is
  // a file read.
  function coverage(s) {
    const out = []
    for (const r of s.runs) {
      if (!r.index.state.ready) continue
      const end = r.start + r.index.coveredSec()
      if (end > r.start) out.push([r.start, end])
    }
    out.sort((a, b) => a[0] - b[0])
    const merged = []
    for (const r of out) {
      const last = merged[merged.length - 1]
      if (last && r[0] <= last[1] + 0.5) last[1] = Math.max(last[1], r[1]); else merged.push([r[0], r[1]])
    }
    return merged
  }
  function _serveCoverage(s, res) {
    if (!s) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ ranges: coverage(s) }))
  }

  async function _serveStream(s, u, res) {
    if (!s) { res.writeHead(404); res.end(); return }
    const t = Math.max(0, Number(u.searchParams.get('t')) || 0)
    const variant = _variantOf(s, u)
    // `fresh=1`: the caller cannot handle a stream whose clock starts later
    // than 0 (a plain <video src>), so it gets a run of its own at t.
    let hit = u.searchParams.get('fresh') === '1' ? null : _runCovering(s, variant.key, t)
    let run, offset
    if (hit) {
      run = hit.run; offset = hit.frag.offset
      log('[web-stream] cache hit run ' + run.id + ' for ' + t + 's (fragment at ' + (run.start + hit.frag.time).toFixed(1) + 's)')
    } else {
      const start = await _alignedStart(s, variant.plan, t)
      if (!sessions.has(s.id)) { res.writeHead(410); res.end(); return }
      run = _startRun(s, variant.key, variant.plan, variant.extra, start)
      offset = 0
    }
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'X-Papa-Start, X-Papa-Cached',
      'X-Papa-Start': String(run.start),
      'X-Papa-Cached': hit ? '1' : '0',
    })
    _followRun(run, offset, res, s.duration)
  }

  // ── subtitles ─────────────────────────────────────────────────────────────
  // One extraction per subtitle track per session, however many requests
  // arrive while it runs. (An extraction reads the whole input — subtitles
  // are interleaved through it — which on a torrent stream means the whole
  // file; a progressive extractor is a planned follow-up.)
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
  function _isRemote(input) { return /^https?:\/\//i.test(String(input || '')) }
  // For a streamed input: every run's WebVTT for this track, cues shifted by
  // the run's start, merged. What has been converted so far, nothing more.
  function _mergedRunSubs(s, index) {
    const lists = []
    for (const r of s.runs) {
      const f = (r.subFiles || []).find(x => x.index === index)
      if (!f) continue
      let text = ''
      try { text = fs.readFileSync(f.file, 'utf8') } catch (_) { continue }
      lists.push(planner.parseVtt(text, r.start))
    }
    return planner.mergeVtt(lists)
  }
  function _serveSub(s, index, res) {
    if (!s) { res.writeHead(404); res.end(); return }
    if (_isRemote(s.input)) {
      res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' })
      res.end(_mergedRunSubs(s, index))
      return
    }
    _extractSub(s, index).then(text => {
      res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
      res.end(text)
    })
  }
  function _killSubs(s) {
    if (s && s.subProcs) for (const p of Array.from(s.subProcs)) { try { p.kill('SIGKILL') } catch (_) {} }
  }

  // ── sessions ──────────────────────────────────────────────────────────────
  function _newSession(fields) {
    const id = crypto.randomBytes(8).toString('hex')
    const s = Object.assign({ id, runs: [], nextRun: 0, subs: new Map(), dir: path.join(cacheDir, id) }, fields)
    sessions.set(id, s)
    return s
  }

  // Probe, plan, register. Resolves the session the renderer needs, or
  // { refused, reason } when the planner cannot serve this source.
  async function open(input, prefs) {
    const { streams, duration, chapters } = await probeStreams(input, execFileFn, opts.probeTimeoutMs)
    const plan = planner.plan(streams, { prefs: prefs || {}, caps: opts.caps })
    if (plan.mode === 'refuse') return { refused: true, reason: plan.reason }
    await _listen()
    const s = _newSession({ input, streams, plan, duration, pair: null })
    return {
      id: s.id,
      duration,
      chapters: chapters || [],
      streamUrl: `http://127.0.0.1:${port}/s/${s.id}.mp4`,
      coverageUrl: `http://127.0.0.1:${port}/s/${s.id}/coverage`,
      mime: plan.mime,
      subtitles: plan.subtitles.sidecars.map(sub => ({ index: sub.index, lang: sub.lang, title: sub.title, url: `http://127.0.0.1:${port}/s/${s.id}/sub/${sub.index}.vtt` })),
      burnable: plan.subtitles.burnable,
      audios: plan.audios,
      plan: { mode: plan.mode, reason: plan.reason, badges: plan.badges, prerollSec: plan.prerollSec, video: plan.video, audio: plan.audio, mime: plan.mime },
    }
  }

  // A session for a video URL plus an audio URL (a YouTube trailer, now that
  // YouTube serves no single file with both). Nothing to probe: the caller
  // asked yt-dlp for H.264 + AAC, which the browser plays as-is.
  async function openPair(videoUrl, audioUrl, o) {
    if (!videoUrl || !audioUrl) throw new Error('a paired session needs both a video and an audio URL')
    await _listen()
    const mime = 'video/mp4; codecs="avc1.640028,mp4a.40.2"'
    const plan = { mode: 'remux', reason: 'paired streams copied', badges: [], prerollSec: 0, video: { copy: true }, audio: { copy: true }, mime }
    const s = _newSession({ input: videoUrl, pair: { video: videoUrl, audio: audioUrl }, streams: [], plan, duration: Number(o && o.duration) || 0 })
    return {
      id: s.id, duration: Number(o && o.duration) || 0,
      streamUrl: `http://127.0.0.1:${port}/s/${s.id}.mp4`, mime,
      subtitles: [], burnable: [], audios: [], plan, paired: true,
    }
  }

  function close(id) {
    const s = sessions.get(id)
    if (!s) return false
    for (const r of s.runs.slice()) { _stopRun(r, 'closed'); _dropRun(s, r) }
    _killSubs(s)
    sessions.delete(id)
    try { fs.rmSync(s.dir, { recursive: true, force: true }) } catch (_) {}
    return true
  }

  function closeAll() { for (const id of Array.from(sessions.keys())) close(id) }

  function shutdown() {
    closeAll()
    if (server) { try { server.close() } catch (_) {} server = null; port = 0 }
  }

  return { open, openPair, close, closeAll, shutdown, coverage, _sessions: sessions, _port: () => port, _handle, _cacheDir: cacheDir }
}

module.exports = { createWebStreamServer, probeStreams }
