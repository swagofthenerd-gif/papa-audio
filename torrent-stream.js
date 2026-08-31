'use strict'
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

// Streamed video is watched once and then wanted gone. Without an explicit
// path WebTorrent writes into its own default under the system temp directory
// and nothing ever removes it, so every film ever streamed accumulates there —
// on this machine /tmp is a tmpfs, so that was 19 GB of RAM before playback
// stopped working entirely for want of space.
//
// Each stream therefore gets its own directory, and it is deleted when the
// stream stops.
// The default is the temporary directory because it is the one place that
// always exists and is always writable. It is not a good default on this
// machine: /tmp is a tmpfs, so the cache is held in RAM, and a season pack can
// approach the memory limit while it is playing legitimately. Point
// setStreamRoot at a real disk and it goes there instead.
const DEFAULT_STREAM_ROOT = path.join(os.tmpdir(), 'papa-video-streams')
let _streamRoot = DEFAULT_STREAM_ROOT

function streamRoot() {
  return _streamRoot
}

// Returns the root actually in use, which is not always the one asked for: a
// drive that is not mounted leaves behind an empty mountpoint that looks like
// a perfectly good directory until something tries to write to it. So the
// location is proved by writing to it, not by checking that the path exists,
// and anything unusable falls back to the default rather than failing playback.
function setStreamRoot(dir) {
  if (!dir) {
    _streamRoot = DEFAULT_STREAM_ROOT
    return _streamRoot
  }
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, '.papa-write-probe')
    fs.writeFileSync(probe, 'papa')
    fs.unlinkSync(probe)
    _streamRoot = dir
  } catch (_) {
    _streamRoot = DEFAULT_STREAM_ROOT
  }
  return _streamRoot
}

function newStreamDir() {
  return path.join(_streamRoot, `s-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)
}

// Directories from streams that never got to clean up after themselves — a
// crash, a kill, a power cut. Called at startup, so one bad exit cannot leave
// data behind for good.
function purgeOrphanStreams({ keep = null } = {}) {
  let removed = 0
  let bytes = 0
  // Both roots, always. Moving the cache to a disk must not strand whatever
  // the previous location is still holding — on this machine that was gigabytes
  // sitting in RAM, which nothing would ever have come back for.
  const roots = _streamRoot === DEFAULT_STREAM_ROOT
    ? [_streamRoot]
    : [_streamRoot, DEFAULT_STREAM_ROOT]
  for (const root of roots) {
    let entries = []
    try { entries = fs.readdirSync(root) } catch (_) { continue }
    for (const name of entries) {
      const dir = path.join(root, name)
      if (keep && dir === keep) continue
      // A directory belonging to a process that is still running is in use.
      const owner = /^s-(\d+)-/.exec(name)
      if (owner) {
        const pid = Number(owner[1])
        if (pid !== process.pid && isProcessAlive(pid)) continue
      }
      try {
        bytes += dirSize(dir)
        fs.rmSync(dir, { recursive: true, force: true })
        removed++
      } catch (_) { /* a directory we cannot remove is not worth failing over */ }
    }
  }
  return { removed, bytes }
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e && e.code === 'EPERM' }
}

function dirSize(dir) {
  let total = 0
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return 0 }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) total += dirSize(full)
    else { try { total += fs.statSync(full).size } catch (_) {} }
  }
  return total
}

function buildFileUrl(port, fileIndex, fileName) {
  return `http://127.0.0.1:${port}/${fileIndex}/${encodeURIComponent(fileName)}`
}

const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|mov|webm|ts|m2ts|wmv|flv|ogv)$/i
// Release packs carry samples, trailers and extras. A "sample" is a real video
// file, just not the one anybody wants, and it is small enough to look like a
// fast start while playing the wrong thing.
const JUNK = /(^|[\/\\._-])(sample|trailer|extras?|featurette|behindthescenes)([\/\\._-]|$)/i

// Index 0 was hardcoded. In a multi-file torrent that is very often a .nfo, a
// .txt or a sample clip — so playback either failed outright or streamed the
// wrong file while the real one was never prioritised. The right pick is the
// largest non-junk video file.
// Does this filename name the episode being asked for?
//
// Dubbed anime is released almost exclusively as season and batch packs rather
// than per-episode, so a pack is usually the only dub there is. Taking the
// largest file out of a twelve-episode pack hands back an arbitrary episode,
// which is why packs are worthless without this.
function matchesWantedEpisode(name, want) {
  const n = Number(want && want.episode)
  if (!Number.isFinite(n) || n < 0) return false
  const text = String(name || '')
  const s = Number(want && want.season)
  // SxxEyy is unambiguous, so when a season is known it has to agree.
  const sxe = /s(\d{1,3})[\s._-]?e(\d{1,4})/i.exec(text)
  if (sxe) {
    if (Number(sxe[2]) !== n) return false
    if (Number.isFinite(s) && s > 0 && Number(sxe[1]) !== s) return false
    return true
  }
  // Otherwise a bare episode number, bounded on both sides so 9 never matches
  // inside 109, and a year like 2009 is never mistaken for one.
  return new RegExp(`(?:^|[\\s._\\-\\[(])(?:e|ep|episode\\s*)?0*${n}(?:v\\d)?(?:$|[\\s._\\-\\])])`, 'i').test(text)
}

// The episode number a filename states, or null.
function episodeNumberOf(name) {
  const t = String(name || '')
  const sxe = /s\d{1,3}[\s._-]?e(\d{1,4})/i.exec(t)
  if (sxe) return Number(sxe[1])
  const bare = /(?:^|[\s._\-\[(])(?:e|ep|episode\s*)?(\d{1,4})(?:v\d)?(?:$|[\s._\-\])])/i.exec(t)
  if (!bare) return null
  const n = Number(bare[1])
  // A four-digit number in a filename is a year far more often than an
  // episode, and 0 is not an episode.
  if (!Number.isFinite(n) || n <= 0 || n > 2000) return null
  return n
}

function pickVideoFile(files, want) {
  const list = Array.isArray(files) ? files : []
  if (!list.length) return -1
  const scored = list
    .map((f, index) => ({ index, name: (f && f.name) || '', length: Number(f && f.length) || 0 }))
    .filter(f => VIDEO_EXT.test(f.name))
  const usable = scored.filter(f => !JUNK.test(f.name))
  const pool = usable.length ? usable : scored

  // In a pack the requested episode is the answer, never the biggest file.
  if (want && want.episode != null && pool.length > 1) {
    const matches = pool.filter(f => matchesWantedEpisode(f.name, want))
    // Several matches means the pack holds more than one version of the
    // episode — a v2, or two encodes; the largest of those is the right pick.
    if (matches.length) return matches.reduce((a, b) => (b.length > a.length ? b : a)).index
  }
  if (!pool.length) {
    // No recognisable video extension: fall back to the largest file rather
    // than blindly taking index 0.
    let best = 0
    for (let i = 1; i < list.length; i++) {
      if ((Number(list[i] && list[i].length) || 0) > (Number(list[best] && list[best].length) || 0)) best = i
    }
    return best
  }
  return pool.reduce((a, b) => (b.length > a.length ? b : a)).index
}

// How much of the head of the file must be on disk before mpv is launched.
// Starting mpv at zero bytes is what made playback look like it was "buffering
// slowly": mpv opened, found nothing, and stalled on its own.
const DEFAULT_PREBUFFER_BYTES = 12 * 1024 * 1024

// Bytes of the file's leading pieces that are verified and present.
function headBytesReady(torrent, file) {
  if (!torrent || !file || !torrent.bitfield) return 0
  const pieceLength = Number(torrent.pieceLength) || 0
  if (!pieceLength) return 0
  const start = file._startPiece
  const end = file._endPiece
  if (typeof start !== 'number' || typeof end !== 'number') return 0
  let bytes = 0
  for (let i = start; i <= end; i++) {
    if (!torrent.bitfield.get(i)) break // contiguous from the head only
    bytes += pieceLength
  }
  return bytes
}

// Removing the directory as well as destroying the store: destroyStore clears
// the files, this clears what held them.
function removeDir(dir) {
  if (!dir) return
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) {}
}

class TorrentStreamer extends EventEmitter {
  constructor({ client, timeoutMs = 20000, prebufferBytes = DEFAULT_PREBUFFER_BYTES, prebufferTimeoutMs = 45000 } = {}) {
    super()
    if (!client || typeof client.add !== 'function') {
      throw new TypeError('TorrentStreamer requires a webtorrent client with an add() method')
    }
    this.client = client
    this.timeoutMs = timeoutMs
    this.prebufferBytes = prebufferBytes
    this.prebufferTimeoutMs = prebufferTimeoutMs
    this._fileIndex = 0
    this._file = null
    this._prebufferTimer = null
    this._storeDir = null
    this._want = null
    this._torrent = null
    this._server = null
    this._timer = null
    this._settled = false
    this._pendingReject = null
    this._onDownload = () => {
      const torrent = this._torrent
      if (!torrent) return
      const downloaded = torrent.downloaded ?? 0
      const total = torrent.length ?? 0
      this.emit('progress', {
        phase: 'download',
        downloaded,
        total,
        speed: torrent.downloadSpeed ?? 0,
        percent: total ? downloaded / total : 0,
        peers: torrent.numPeers ?? 0,
      })
    }
  }

  static buildFileUrl(port, fileIndex, fileName) {
    return buildFileUrl(port, fileIndex, fileName)
  }

  // Every playable file in the torrent, with whatever episode number can be
  // read out of its name. A season pack already holds every episode, so
  // switching between them costs nothing: same torrent, same peers, no new
  // resolve — just a different URL from the server that is already running.
  files() {
    const torrent = this._torrent
    const addr = this._server && this._server.address && this._server.address()
    if (!torrent || !Array.isArray(torrent.files) || !addr) return []
    const port = addr.port
    return torrent.files
      .map((f, index) => ({ index, name: f.name || '', length: Number(f.length) || 0 }))
      .filter(f => VIDEO_EXT.test(f.name) && !JUNK.test(f.name))
      .map(f => ({
        index: f.index,
        name: f.name,
        length: f.length,
        episode: episodeNumberOf(f.name),
        url: buildFileUrl(port, f.index, f.name),
        current: f.index === this._fileIndex,
      }))
      .sort((a, b) => {
        // Episode order where it is known; anything unnumbered goes last in
        // name order rather than being interleaved arbitrarily.
        if (a.episode == null && b.episode == null) return a.name.localeCompare(b.name)
        if (a.episode == null) return 1
        if (b.episode == null) return -1
        return a.episode - b.episode
      })
  }

  // Switch to another file in the same torrent. The server is already serving
  // it, so this is only a matter of moving the download priority and pointing
  // the player somewhere else.
  selectFile(index) {
    const torrent = this._torrent
    const files = (torrent && torrent.files) || []
    const file = files[index]
    const addr = this._server && this._server.address && this._server.address()
    if (!file || !addr) return null
    try {
      for (let i = 0; i < files.length; i++) {
        if (i !== index && typeof files[i].deselect === 'function') files[i].deselect()
      }
      if (typeof file.select === 'function') file.select()
    } catch (_) { /* selection is an optimisation, never fatal */ }
    this._fileIndex = index
    this._file = file
    this._prioritiseHead(torrent, file)
    return buildFileUrl(addr.port, index, file.name)
  }

  async start({ magnet, fileIndex = 0, season = null, episode = null } = {}) {
    // Captured before stop(), which clears it.
    const want = episode != null ? { season, episode } : null
    this.stop()
    this._want = want
    this._settled = false
    return new Promise((resolve, reject) => {
      this._pendingReject = reject
      this._timer = setTimeout(() => this._onTimeout(reject), this.timeoutMs)

      let torrent
      try {
        // An explicit path, so the data lands somewhere this class owns and can
        // delete. Without it WebTorrent picks its own directory and nothing
        // ever cleans it up.
        this._storeDir = newStreamDir()
        try { fs.mkdirSync(this._storeDir, { recursive: true }) } catch (_) {}
        torrent = this.client.add(magnet, { path: this._storeDir },
          t => this._onReady(t, fileIndex, resolve, reject))
      } catch (err) {
        this._settle(reject, { code: 'CLIENT_ERROR', message: err.message })
        return
      }
      if (torrent) this._torrent = torrent
    })
  }

  _onReady(torrent, fileIndex, resolve, reject) {
    if (this._settled) return
    this._torrent = torrent

    // The caller's fileIndex is only a hint, and it means nothing for a pack:
    // when a specific episode is wanted the file has to be found by name.
    const files = (torrent && torrent.files) || []
    let index = Number.isInteger(fileIndex) && files[fileIndex] ? fileIndex : -1
    if (this._want || index === -1 || !VIDEO_EXT.test(files[index].name || '')) {
      const picked = pickVideoFile(files, this._want)
      if (picked >= 0) index = picked
    }
    const file = files[index]
    if (!file) {
      this._settle(reject, { code: 'NO_FILE', message: `No file at index ${fileIndex}` })
      return
    }
    this._fileIndex = index
    this._file = file

    // Everything else in the pack is dead weight. A season pack or a batch
    // release would otherwise download all of it in parallel with the episode
    // being watched, splitting the connection for no benefit.
    try {
      for (let i = 0; i < files.length; i++) {
        if (i !== index && typeof files[i].deselect === 'function') files[i].deselect()
      }
      if (typeof file.select === 'function') file.select()
    } catch (_) { /* selection is an optimisation, never fatal */ }

    // Streaming wants the front of the file first. WebTorrent's default is
    // rarest-first, which is right for archiving and wrong for playback: it
    // scatters pieces across the file so the player has nothing contiguous to
    // read. Marking the head critical pulls it down in order.
    this._prioritiseHead(torrent, file)

    let server
    try {
      server = torrent.createServer()
    } catch (err) {
      this._settle(reject, { code: 'SERVER_ERROR', message: err.message })
      return
    }

    this._server = server
    server.once('error', err => {
      this._settle(reject, { code: 'SERVER_ERROR', message: err.message })
    })
    server.listen(0, '127.0.0.1', () => {
      if (this._settled) {
        try { server.close(() => {}) } catch {}
        return
      }
      const port = server.address().port
      // The URL must name the file that was actually picked, not the caller's
      // guess, or the server serves a different file than the one prioritised.
      const url = buildFileUrl(port, index, file.name)
      torrent.on('download', this._onDownload)
      // The connect timeout has done its job — peers are found and the server
      // is up. From here the prebuffer window has its own, longer deadline.
      this._clearTimer()
      this._awaitPrebuffer(torrent, file, () => {
        if (this._settled) return
        this._settled = true
        this._pendingReject = null
        this.emit('ready', { url })
        resolve({ url })
      })
    })
  }

  // Marks the leading pieces of the file critical so they arrive in order and
  // first. Re-armed as playback advances would be better still, but the head is
  // what decides how long the user stares at a black screen.
  _prioritiseHead(torrent, file) {
    try {
      const pieceLength = Number(torrent.pieceLength) || 0
      const start = file._startPiece
      if (typeof start !== 'number' || !pieceLength) return
      const wanted = Math.max(1, Math.ceil(this.prebufferBytes / pieceLength))
      const end = Math.min(file._endPiece, start + wanted - 1)
      if (typeof torrent.select === 'function') torrent.select(start, file._endPiece, 1)
      if (typeof torrent.critical === 'function') torrent.critical(start, end)
    } catch (_) { /* prioritisation is an optimisation, never fatal */ }
  }

  // Holds back the 'ready' event until enough of the head is on disk for mpv to
  // start playing instead of immediately stalling. Progress is reported the
  // whole time, so the panel shows real percentages rather than a spinner.
  _awaitPrebuffer(torrent, file, done) {
    const need = Number(this.prebufferBytes) || 0
    if (need <= 0) return done()
    // If progress cannot be measured at all (no bitfield / no piece length),
    // waiting would just burn the whole deadline for nothing. Start immediately
    // and let mpv's own cache absorb it.
    if (!torrent || !torrent.bitfield || !(Number(torrent.pieceLength) > 0)) return done()
    const total = Number(file.length) || 0
    // A file smaller than the prebuffer target only has to finish.
    const target = total > 0 ? Math.min(need, total) : need
    const deadline = Date.now() + this.prebufferTimeoutMs

    const check = () => {
      if (this._settled) return
      const ready = headBytesReady(torrent, file)
      if (ready >= target || Date.now() >= deadline) {
        this._clearPrebufferTimer()
        done()
        return
      }
      this.emit('progress', {
        phase: 'prebuffer',
        downloaded: ready,
        total: target,
        speed: torrent.downloadSpeed ?? 0,
        percent: target ? Math.min(1, ready / target) : 0,
        peers: torrent.numPeers ?? 0,
      })
      this._prebufferTimer = setTimeout(check, 400)
    }
    check()
  }

  _clearPrebufferTimer() {
    if (this._prebufferTimer) {
      clearTimeout(this._prebufferTimer)
      this._prebufferTimer = null
    }
  }

  _onTimeout(reject) {
    if (this._settled) return
    const torrent = this._torrent
    this._torrent = null
    if (this._server) {
      try { this._server.close(() => {}) } catch {}
      this._server = null
    }
    this._settle(reject, { code: 'NO_SEEDERS', message: `No seeders after ${this.timeoutMs}ms` })
    if (torrent) {
      try { torrent.destroy(() => {}) } catch {}
    }
  }

  _settle(reject, err) {
    if (this._settled) return
    this._settled = true
    this._pendingReject = null
    this._clearTimer()
    this._clearPrebufferTimer()
    if (this.listenerCount('error') > 0) {
      this.emit('error', err)
    }
    reject(err)
  }

  _clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
  }

  stop() {
    this._settled = true
    this._clearTimer()
    this._clearPrebufferTimer()
    this._file = null
    const server = this._server
    this._server = null
    if (server) {
      try { server.close(() => {}) } catch {}
    }
    const torrent = this._torrent
    this._torrent = null
    const storeDir = this._storeDir
    this._storeDir = null
    if (torrent) {
      try { torrent.removeListener('download', this._onDownload) } catch {}
      // destroyStore is the whole point: without it the downloaded pieces stay
      // on disk after the torrent object is gone.
      try {
        torrent.destroy({ destroyStore: true }, () => removeDir(storeDir))
      } catch (_) {
        removeDir(storeDir)
      }
      // destroy() is asynchronous and, on a pack with many files, can take
      // longer than the process has left — an exit right after stop() would
      // leave the whole cache behind, which is the leak this class exists to
      // prevent. Removing the directory directly does not need the callback,
      // and rm with force is a no-op once destroy has already cleared it.
      removeDir(storeDir)
      setTimeout(() => removeDir(storeDir), 1500).unref?.()
    } else {
      removeDir(storeDir)
    }
    // A caller awaiting start() must not hang forever when stop() races the
    // 'ready' callback. Settle the pending promise with a deliberate, distinct
    // code so the caller can tell a stop apart from a real failure.
    const reject = this._pendingReject
    this._pendingReject = null
    if (reject) reject({ code: 'STOPPED', message: 'stopped before ready' })
  }
}

module.exports = { TorrentStreamer, buildFileUrl, pickVideoFile, matchesWantedEpisode, episodeNumberOf, DEFAULT_STREAM_ROOT, streamRoot, setStreamRoot, purgeOrphanStreams, newStreamDir, headBytesReady, VIDEO_EXT }
