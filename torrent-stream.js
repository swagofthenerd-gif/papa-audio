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
      // Two shapes carry a pid: the stream cache (s-<pid>-…) and the hover
      // thumbnail cache the video engine drops beside a reused torrent
      // (thumbs-<pid>-<ts>); both accumulate across crashes without this.
      const owner = /^s-(\d+)-/.exec(name) || /^thumbs-(\d+)-/.exec(name)
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
// Subtitles travelling inside the pack. The video list deliberately filters
// these out, so they get a door of their own: listed by subtitleFiles(),
// fetched by serveSubtitle().
const SUBTITLE_EXT = /\.(srt|ass|ssa|vtt)$/i
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
  const text = String(name || '').replace(NON_EPISODE_TOKEN, ' ')
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

// Non-credit openings/endings, specials and revision tags carry a digit of
// their own -- "NCED1", "OP2", "Ver.2" -- that reads exactly like an episode
// number to the regex below. Stripped before parsing so a batch pack's
// ending-theme clip is never mistaken for the next episode.
const NON_EPISODE_TOKEN = /\b(?:nc)?(?:op|ed)\d*\b|\bova\d*\b|\bver(?:sion)?\.?\s*\d+\b/gi

// The episode number a filename states, or null.
function episodeNumberOf(name) {
  const t = String(name || '').replace(NON_EPISODE_TOKEN, ' ')
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
// How much of the destination to demand immediately after a jump. Enough to
// start playing and cover the error in the time-to-byte estimate, small enough
// that the swarm is not asked for a minute of video before the first frame.
const SEEK_URGENT_BYTES = 8 * 1024 * 1024

// How much of the NEXT episode to fetch while the current one plays. Enough to
// cover the opening -- titles and the first scene -- so pressing Next starts on
// bytes that are already here instead of on a resolve and a cold swarm.
// Deliberately modest: this is bandwidth taken from the episode being watched
// right now, and a stall in the current one to save a wait on the next is a bad
// trade in every direction.
const PREFETCH_BYTES = 24 * 1024 * 1024

const DEFAULT_PREBUFFER_BYTES = 12 * 1024 * 1024

// 'download' fires once per received chunk — hundreds a second on a healthy
// swarm — and every progress emit here crosses the IPC bridge to the renderer.
// A progress readout needs ~4/s, the same rate the video engine's own state
// stream runs at. Trailing-edge: the last chunk of a burst always produces an
// emit, and the numbers are read fresh from the torrent at emit time, so what
// is reported is exact even though most chunks report nothing.
const PROGRESS_THROTTLE_MS = 250

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
// Each extension is one more timeoutMs, so the real ceiling is
// timeoutMs * (MAX_TIMEOUT_EXTENSIONS + 1) — and only ever while peers are
// connected or bytes are arriving.
const MAX_TIMEOUT_EXTENSIONS = 3

function removeDir(dir) {
  if (!dir) return
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) {}
}

class TorrentStreamer extends EventEmitter {
  constructor({ client, timeoutMs = 20000, prebufferBytes = DEFAULT_PREBUFFER_BYTES, prebufferTimeoutMs = 45000, progressThrottleMs = PROGRESS_THROTTLE_MS, downloadLimitBps = null, seedWhileWatching = true, announceFn = null } = {}) {
    super()
    if (!client || typeof client.add !== 'function') {
      throw new TypeError('TorrentStreamer requires a webtorrent client with an add() method')
    }
    this.client = client
    // Optional curated-tracker merge: given the magnet's own announce list (null
    // here — the magnet carries its own), return the announce array to add. Kept
    // as an injected seam so the streamer stays decoupled from the tracker-list
    // module and is testable without it. When absent, no announce override is set
    // and WebTorrent uses only the magnet's own trackers.
    this._announceFn = typeof announceFn === 'function' ? announceFn : null
    this.timeoutMs = timeoutMs
    this.prebufferBytes = prebufferBytes
    this.prebufferTimeoutMs = prebufferTimeoutMs
    // The bandwidth cap and the seed-back switch are held here so they can be
    // asked for before a stream even exists, and applied to the client as soon
    // as one does. WebTorrent throttles the CLIENT, not a single torrent (one
    // ThrottleGroup for all of down, one for all of up — webtorrent/index.js),
    // so this class only owns the intent; getTorrentClient() is shared, and a
    // cap set here caps every torrent the app is running. Honest about that in
    // the docs on setDownloadLimit().
    this._downloadLimitBps = null
    this._seedWhileWatching = seedWhileWatching !== false
    this._fileIndex = 0
    this._file = null
    // Which other file in the pack has already had its opening requested.
    this._prefetched = null
    // The index whose ENTIRE file is being pulled down in the background, and
    // where that stood last time it was asked. Distinct from _prefetched, which
    // only ever grabs the opening.
    this._predownload = null
    this._prebufferTimer = null
    this._storeDir = null
    // Where served subtitles land when this stream has no _storeDir of its
    // own — a reused torrent's directory belongs to whoever added it.
    this._subDir = null
    this._want = null
    this._torrent = null
    // True only when THIS streamer created the torrent (the add() branch). A
    // reused torrent belongs to whoever added it, so its data and store are
    // never ours to destroy — we only remove our own listeners and close our
    // server. Getting this wrong deletes another consumer's downloaded pieces.
    this._ownsTorrent = false
    // The 'ready' handler attached when reusing a not-yet-ready torrent, kept
    // so stop() can remove it if we are torn down before ready fires.
    this._reusedReady = null
    this._server = null
    this._timer = null
    this._extensions = 0
    this._settled = false
    this._pendingReject = null
    // Timing seam for tests; production uses PROGRESS_THROTTLE_MS (~4/s).
    this._progressThrottleMs = progressThrottleMs
    this._progressTimer = null
    this._lastProgressAt = 0
    const emitDownloadProgress = () => {
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
    this._onDownload = () => {
      if (!this._torrent) return
      const now = Date.now()
      const since = now - this._lastProgressAt
      if (since >= this._progressThrottleMs) {
        this._lastProgressAt = now
        emitDownloadProgress()
        return
      }
      // Mid-burst: coalesce into one trailing emit. The byte counts are the
      // torrent's own, read when the timer fires, so nothing is lost by
      // swallowing the chunks in between.
      if (this._progressTimer) return
      this._progressTimer = setTimeout(() => {
        this._progressTimer = null
        this._lastProgressAt = Date.now()
        emitDownloadProgress()
      }, this._progressThrottleMs - since)
      this._progressTimer.unref?.()
    }
    // A cap passed to the constructor is applied to the client immediately —
    // the client is shared and long-lived, so it takes effect for whatever is
    // already running and stays in force until changed.
    if (downloadLimitBps != null) this.setDownloadLimit(downloadLimitBps)
  }

  // Cap the download rate, in bytes per second, or lift the cap with null / a
  // negative number. Returns the limit now in force (null when uncapped).
  //
  // The mechanism is WebTorrent's own client.throttleDownload — a real
  // token-bucket rate limiter on every peer connection, not piece-selection
  // pacing. The one caveat worth stating plainly: it is CLIENT-wide. The app
  // shares one WebTorrent client across every stream and background download
  // (getTorrentClient in main.js), and WebTorrent keeps a single throttle group
  // for all of them, so a cap set on one streamer caps the whole client. There
  // is no per-torrent throttle in this version to offer instead.
  setDownloadLimit(bps) {
    const n = Number(bps)
    const limit = (bps == null || !isFinite(n) || n < 0) ? null : Math.floor(n)
    this._downloadLimitBps = limit
    try {
      if (typeof this.client.throttleDownload === 'function') {
        // -1 is WebTorrent's "disabled" sentinel; a real cap is the byte rate.
        this.client.throttleDownload(limit == null ? -1 : limit)
      }
    } catch (_) { /* throttling is best-effort; never fail playback over it */ }
    return this._downloadLimitBps
  }

  downloadLimit() {
    return this._downloadLimitBps
  }

  // Whether the app shares back to the swarm while watching. Off suppresses
  // uploads via WebTorrent's client.throttleUpload(0) — the connections stay
  // open (dropping them would cost peers we still need to download from), but
  // nothing is sent out. Same client-wide caveat as the download cap: one
  // WebTorrent client, one upload throttle group, so this governs every torrent
  // the app is running, not this stream alone. Returns the state now in force.
  setSeedWhileWatching(on) {
    this._seedWhileWatching = on !== false
    try {
      if (typeof this.client.throttleUpload === 'function') {
        // 0 chokes uploads to nothing; -1 lifts the choke entirely.
        this.client.throttleUpload(this._seedWhileWatching ? -1 : 0)
      }
    } catch (_) { /* best-effort; never fail playback over a seed toggle */ }
    return this._seedWhileWatching
  }

  seedWhileWatching() {
    return this._seedWhileWatching
  }

  static buildFileUrl(port, fileIndex, fileName) {
    return buildFileUrl(port, fileIndex, fileName)
  }

  // The stream's own cache directory, or null when the torrent was reused from
  // elsewhere and its directory belongs to whoever added it. Used by the
  // thumbnailer (Player #5) to nest its frames inside the same directory the
  // teardown sweep already removes; a null return means "make your own and clean
  // it up yourself".
  storeDir() {
    return this._storeDir || null
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
    // A complete-series batch holds every season in its own subfolder, each
    // numbered from 01 again. Flattened by name alone the strip read
    // "1 1 1 2 2 2…" — the seasons interleaved by episode number, with the
    // Extras folder's credit-less openings mixed in as unnumbered entries.
    // The folder IS the season: carry it as `group`, filter junk on the whole
    // path (Extras/ lives in the path, not the filename), and order groups by
    // their first appearance in the torrent, which is how packs list seasons.
    const groupOrder = new Map()
    const groupOf = (f) => {
      const parts = String(f.path || f.name || '').split(/[/\\]/)
      // parts = [torrent root, …folders…, filename]; the immediate parent
      // names the season. A file at the root of the torrent's own folder
      // belongs to no group.
      return parts.length >= 3 ? parts[parts.length - 2] : ''
    }
    return torrent.files
      .map((f, index) => ({
        index,
        name: f.name || '',
        path: f.path || f.name || '',
        length: Number(f.length) || 0,
      }))
      .filter(f => VIDEO_EXT.test(f.name) && !JUNK.test(f.path) &&
        !/\bnc(?:op|ed)\d*\b/i.test(f.name))
      .map(f => {
        const group = groupOf(f)
        if (!groupOrder.has(group)) groupOrder.set(group, groupOrder.size)
        return {
          index: f.index,
          name: f.name,
          group,
          length: f.length,
          episode: episodeNumberOf(f.name),
          url: buildFileUrl(port, f.index, f.name),
          current: f.index === this._fileIndex,
        }
      })
      .sort((a, b) => {
        const g = groupOrder.get(a.group) - groupOrder.get(b.group)
        if (g) return g
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
    // Whatever was prefetched is either the file now playing or no longer next.
    this._prefetched = null
    // A whole-file predownload survives an episode switch: it was an explicit
    // "fetch that file" and the file it names has not changed. Only the
    // per-index bookkeeping tied to what is *playing* (the prefetch marker)
    // resets here.
    this._prioritiseHead(torrent, file)
    return buildFileUrl(addr.port, index, file.name)
  }

  // A live reading of the swarm, null when nothing is active. The 'progress'
  // events push these same numbers; this is the pull side, for anything that
  // asks on its own schedule instead of listening.
  stats() {
    const torrent = this._torrent
    if (!torrent) return null
    const downloadedBytes = Number(torrent.downloaded) || 0
    const totalBytes = Number(torrent.length) || 0
    const uploadedBytes = Number(torrent.uploaded) || 0
    // WebTorrent's own ratio is uploaded / (received || length). Prefer it when
    // present, but never trust a NaN or Infinity through to the UI — recompute
    // from what is actually here. Zero downloaded means an undefined ratio, and
    // 0 reads better on a panel than ∞.
    const rawRatio = Number(torrent.ratio)
    const ratio = isFinite(rawRatio)
      ? rawRatio
      : (downloadedBytes > 0 ? uploadedBytes / downloadedBytes : 0)
    return {
      speedBps: Number(torrent.downloadSpeed) || 0,
      peers: Number(torrent.numPeers) || 0,
      downloadedBytes,
      totalBytes,
      progress: totalBytes ? Math.min(1, downloadedBytes / totalBytes) : 0,
      // Seed-back (App #42): what has gone back out to the swarm, how fast right
      // now, and the share ratio.
      uploadedBytes,
      uploadSpeedBps: Number(torrent.uploadSpeed) || 0,
      ratio: isFinite(ratio) ? ratio : 0,
    }
  }

  // The subtitles riding inside the pack. files() filters to video on purpose,
  // which made a pack's .srt/.ass/.vtt unreachable — the one subtitle that
  // matches the release exactly was in the torrent and could never be handed
  // to mpv. Indices are positions in the torrent's FULL file list, so they
  // stay valid for serveSubtitle() no matter what files() filtered out.
  subtitleFiles() {
    const torrent = this._torrent
    if (!torrent || !Array.isArray(torrent.files)) return []
    return torrent.files
      .map((f, index) => ({ index, name: (f && f.name) || '', size: Number(f && f.length) || 0 }))
      .filter(f => SUBTITLE_EXT.test(f.name))
  }

  // Fetch one subtitle out of the torrent and put it on disk where mpv's
  // sub-add can reach it — mpv reads the video over HTTP but a subtitle wants
  // to be a file. Only that file's pieces are asked for, and urgently: the
  // whole thing is kilobytes, wanted before the next line of dialogue, so it
  // costs the stream nothing. The copy lands under the stream's own cache
  // directory and is cleaned up with everything else. Resolves the absolute
  // path once the bytes are verified and written.
  async serveSubtitle(index) {
    const torrent = this._torrent
    const files = (torrent && torrent.files) || []
    const file = files[index]
    if (!file || !SUBTITLE_EXT.test(file.name || '')) {
      throw { code: 'NO_SUBTITLE', message: `No subtitle file at index ${index}` }
    }
    // Deliberately NOT selectFile(): the video keeps playing, untouched; the
    // subtitle's pieces are simply asked for alongside it.
    try {
      if (typeof file.select === 'function') file.select()
      if (typeof torrent.critical === 'function' &&
          typeof file._startPiece === 'number' && typeof file._endPiece === 'number') {
        torrent.critical(file._startPiece, file._endPiece)
      }
    } catch (_) { /* prioritisation is an optimisation, never fatal */ }
    const buf = await new Promise((resolve, reject) => {
      // getBuffer waits for the pieces and verifies them; the stream fallback
      // covers a torrent implementation without it.
      if (typeof file.getBuffer === 'function') {
        file.getBuffer((err, data) => (err ? reject(err) : resolve(data)))
        return
      }
      const chunks = []
      const rs = file.createReadStream()
      rs.on('data', c => chunks.push(c))
      rs.on('end', () => resolve(Buffer.concat(chunks)))
      rs.on('error', reject)
    })
    if (!this._storeDir && !this._subDir) this._subDir = newStreamDir()
    const dir = path.join(this._storeDir || this._subDir, 'subs')
    fs.mkdirSync(dir, { recursive: true })
    // The index keeps two same-named subtitles from different folders of the
    // pack from overwriting each other.
    const dest = path.join(dir, `${index}-${path.basename(file.name)}`)
    fs.writeFileSync(dest, buf)
    return dest
  }

  async start({ magnet, fileIndex = 0, season = null, episode = null } = {}) {
    // Captured before stop(), which clears it.
    const want = episode != null ? { season, episode } : null
    this.stop()
    this._want = want
    this._settled = false
    return new Promise((resolve, reject) => {
      this._pendingReject = reject
      this._extensions = 0
      this._timer = setTimeout(() => this._onTimeout(reject), this.timeoutMs)

      const add = () => {
        if (this._settled) return
        let torrent
        try {
          // An explicit path, so the data lands somewhere this class owns and can
          // delete. Without it WebTorrent picks its own directory and nothing
          // ever cleans it up.
          this._storeDir = newStreamDir()
          // We created it, so its store and directory are ours to destroy.
          this._ownsTorrent = true
          try { fs.mkdirSync(this._storeDir, { recursive: true }) } catch (_) {}
          // Merge the curated tracker list into the announce list so a fresh
          // stream finds peers fast. A throwing/absent announceFn leaves the
          // magnet's own trackers untouched — this must never block a stream.
          const addOpts = { path: this._storeDir }
          if (this._announceFn) {
            try {
              const announce = this._announceFn(null)
              if (Array.isArray(announce) && announce.length) addOpts.announce = announce
            } catch (_) { /* fall back to the magnet's own trackers */ }
          }
          torrent = this.client.add(magnet, addOpts,
            t => this._onReady(t, fileIndex, resolve, reject))
        } catch (err) {
          this._settle(reject, { code: 'CLIENT_ERROR', message: err.message })
          return
        }
        if (torrent) this._torrent = torrent
      }

      // Adding a magnet the client already holds raises WebTorrent's duplicate
      // error, which surfaces long after add() and dressed up as a torrent
      // that found nobody. The usual way in: stop this stream and start the
      // same one again while the previous destroy() is still in flight — a
      // dying torrent stays in client.torrents until its 'close' fires. Same
      // probe main.js's _torrentAdd runs before adding a download.
      let existing = null
      try {
        if (typeof this.client.get === 'function') existing = this.client.get(magnet)
      } catch (_) { /* an unparsable magnet gets its real error from add() */ }
      if (existing && existing.destroyed) {
        // Mid-destroy: wait it out. The connect deadline above keeps running,
        // so a close that never comes still fails cleanly instead of hanging.
        existing.once('close', add)
        return
      }
      if (existing) {
        // Same magnet, alive — added by another part of the app. Reuse it: the
        // swarm is already connected, so this is the fastest start there is.
        // No _storeDir either; the directory belongs to whoever added it, and
        // _ownsTorrent stays false so stop()/_onTimeout never destroy its data.
        this._torrent = existing
        if (existing.ready) this._onReady(existing, fileIndex, resolve, reject)
        else {
          // Kept on the instance so a stop() before 'ready' can remove it —
          // otherwise the closure (and its reference to `existing`) leaks.
          this._reusedReady = () => this._onReady(existing, fileIndex, resolve, reject)
          existing.once('ready', this._reusedReady)
        }
        return
      }
      add()
    })
  }

  _onReady(torrent, fileIndex, resolve, reject) {
    if (this._settled) return
    // The reused-ready handler (if any) has now fired; drop the ref so stop()
    // does not try to remove a listener that is already gone.
    this._reusedReady = null
    this._torrent = torrent
    this._predownload = null

    // Re-assert the bandwidth intent now that a torrent (and its client) is
    // live: the switches can be set before anything is streaming, and a client
    // that was fresh then would not have carried them. Idempotent — throttling
    // the client twice with the same rate is a no-op.
    if (this._downloadLimitBps != null) this.setDownloadLimit(this._downloadLimitBps)
    if (!this._seedWhileWatching) this.setSeedWhileWatching(false)

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
    this._prefetched = null
    this._fileIndex = index
    this._file = file

    // Everything else in the pack is dead weight. A season pack or a batch
    // release would otherwise download all of it in parallel with the episode
    // being watched, splitting the connection for no benefit.
    //
    // Deselecting each other file is not enough on its own: unless the caller
    // passes WebTorrent a BEP53 `so` option (this class never does, since the
    // file to play is picked only after metadata arrives), WebTorrent's own
    // constructor already made a selection covering the WHOLE torrent at
    // priority 0 -- "start off selecting the entire torrent with low
    // priority" (webtorrent/lib/torrent.js). Per-file deselect() calls only
    // remove a selection matching that exact file's own (from, to) range, so
    // they never touch it. Left in place it does two things at once: quietly
    // downloads the entire pack in the background regardless of what is
    // playing, and -- because it was created first and priority ties keep
    // insertion order -- sits ahead of prefetchFile()'s own low-priority
    // selection, so the swarm works through the whole torrent from piece 0
    // before ever reaching the next episode's window. Confirmed live: with
    // the current episode fully downloaded and idle peers holding the next
    // episode's data, prefetchFile() still pulled zero bytes in two minutes
    // until this was cancelled.
    try {
      for (let i = 0; i < files.length; i++) {
        if (i !== index && typeof files[i].deselect === 'function') files[i].deselect()
      }
      if (typeof file.select === 'function') file.select()
      if (typeof torrent.deselect === 'function' && torrent.pieces) {
        torrent.deselect(0, torrent.pieces.length - 1, false)
      }
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

  // Fetch the opening of another file in the same torrent while this one plays.
  //
  // A season pack already holds every episode and the swarm is already
  // connected, so the next episode's first minutes can arrive quietly in the
  // background. Without it, pressing Next -- or letting up-next run -- drops
  // the viewer onto an empty file and a spinner, on a torrent that had the
  // bytes available the whole time.
  //
  // Two things keep this from hurting the episode actually being watched. The
  // window is small, and the pieces are selected at the lowest priority with no
  // critical marking at all: WebTorrent serves them only when nothing more
  // urgent is outstanding. The current file's own selection is left exactly as
  // it was, so this can only ever use bandwidth that was going spare.
  prefetchFile(index) {
    try {
      const torrent = this._torrent
      const files = (torrent && torrent.files) || []
      const file = files[index]
      if (!file || index === this._fileIndex) return false
      if (this._prefetched === index) return false     // already asked for

      const pieceLength = Number(torrent.pieceLength) || 0
      const start = file._startPiece
      const endPiece = file._endPiece
      if (!pieceLength || typeof start !== 'number' || typeof endPiece !== 'number') return false

      const wanted = Math.max(1, Math.ceil(PREFETCH_BYTES / pieceLength))
      const end = Math.min(endPiece, start + wanted - 1)
      // Priority 0, and no critical() call. Lowest possible claim on the swarm.
      if (typeof torrent.select === 'function') torrent.select(start, end, 0)
      this._prefetched = index
      return true
    } catch (_) {
      // An optimisation. Failing here costs a wait, never playback.
      return false
    }
  }

  // Pull an ENTIRE file down in the background, not just its opening.
  //
  // prefetchFile() grabs the first minutes so pressing Next starts instantly;
  // this is the other half of App #40 — "get the whole next episode ready" —
  // for the viewer who wants the file complete on disk before they reach it, or
  // who is about to lose the connection. Every piece of the file is selected,
  // still at the lowest priority and never critical, so the episode playing now
  // keeps every peer it wants and this uses only the bandwidth going spare.
  //
  // One file at a time: a second call for a different index cancels the first,
  // because two whole-file low-priority selections would split the spare
  // bandwidth between them and neither would finish. Returns true if the
  // selection was placed.
  predownloadFile(index) {
    try {
      const torrent = this._torrent
      const files = (torrent && torrent.files) || []
      const file = files[index]
      if (!file) return false
      if (this._predownload && this._predownload.index === index) return true

      const start = file._startPiece
      const endPiece = file._endPiece
      if (typeof start !== 'number' || typeof endPiece !== 'number') return false

      // A previous whole-file predownload of a different file is abandoned, so
      // the spare bandwidth is not split between two of them.
      if (this._predownload && this._predownload.index !== index) this.cancelPredownload()

      // The whole file, priority 0, no critical marking. Lowest possible claim.
      if (typeof torrent.select === 'function') torrent.select(start, endPiece, 0)
      this._predownload = { index, start, end: endPiece }
      return true
    } catch (_) {
      // An optimisation. Failing here costs a wait, never playback.
      return false
    }
  }

  // Stop pulling the whole file down. The pieces already on disk stay — they
  // cost nothing to keep and may be exactly what the viewer reaches next; only
  // the standing request for the rest is withdrawn. Returns true if there was
  // one to cancel.
  cancelPredownload() {
    const pd = this._predownload
    this._predownload = null
    if (!pd) return false
    try {
      const torrent = this._torrent
      // deselect matches an exact (from, to, priority) triple, which is why the
      // range and priority placed above are recorded and passed back verbatim.
      if (torrent && typeof torrent.deselect === 'function') {
        torrent.deselect(pd.start, pd.end, 0)
      }
    } catch (_) { /* withdrawing a selection is best-effort */ }
    return true
  }

  // How far the whole-file predownload has got: the file index, bytes present,
  // and the file's total. null when nothing is predownloading. Bytes are
  // counted across the whole file, not just the contiguous head — a background
  // fill has no reason to arrive in order, and the viewer wants to know how much
  // of the episode is here, wherever it landed.
  predownloadProgress() {
    const pd = this._predownload
    const torrent = this._torrent
    if (!pd || !torrent) return null
    const files = (torrent && torrent.files) || []
    const file = files[pd.index]
    if (!file) return null
    const total = Number(file.length) || 0
    let bytes = 0
    const pieceLength = Number(torrent.pieceLength) || 0
    if (pieceLength && torrent.bitfield && typeof torrent.bitfield.get === 'function' &&
        typeof file._startPiece === 'number' && typeof file._endPiece === 'number') {
      for (let i = file._startPiece; i <= file._endPiece; i++) {
        if (torrent.bitfield.get(i)) bytes += pieceLength
      }
      // The last piece of the file is usually short, and the first may share a
      // piece with the file before it; clamp so a whole-piece count never
      // reports more bytes than the file actually has.
      if (bytes > total) bytes = total
    }
    return { index: pd.index, bytes, total }
  }

  // Everything the "keep this episode" copy (#44) needs about one file: its
  // display name, its absolute on-disk path in this stream's cache, its total
  // length, and how many bytes are actually present. Works for ANY file index,
  // not only the one predownloading — the currently-playing file is usually
  // fully on disk with no predownload standing. Returns null when the file or
  // store dir is unknown. Byte counting mirrors predownloadProgress so
  // "complete" means the same thing in both places.
  fileInfo(index) {
    try {
      const torrent = this._torrent
      const files = (torrent && torrent.files) || []
      const file = files[index]
      if (!file) return null
      const total = Number(file.length) || 0
      let downloaded = 0
      const pieceLength = Number(torrent.pieceLength) || 0
      if (pieceLength && torrent.bitfield && typeof torrent.bitfield.get === 'function' &&
          typeof file._startPiece === 'number' && typeof file._endPiece === 'number') {
        for (let i = file._startPiece; i <= file._endPiece; i++) {
          if (torrent.bitfield.get(i)) downloaded += pieceLength
        }
        if (downloaded > total) downloaded = total
      }
      // file.path is the torrent-relative path (may include a folder). The
      // absolute path is that under this stream's store dir. When no store dir
      // was created (an externally-added torrent), fall back to torrent.path.
      const rel = file.path || file.name
      const base = this._storeDir || (torrent && torrent.path) || null
      const fullPath = base && rel ? path.join(base, rel) : null
      return { index, name: file.name || null, path: fullPath, total, downloaded }
    } catch (_) {
      return null
    }
  }

  // Where the viewer just jumped to, as a fraction of the film.
  //
  // Without this the swarm carries on filling in from wherever it had reached,
  // and the player sits waiting for bytes nobody is asking for while the ones
  // it needs are requested at ordinary priority behind them. The head is
  // prioritised once when the stream starts and then never again, so every seek
  // away from the beginning was served at the back of the queue.
  //
  // Time is mapped to bytes linearly. That is not exact on a variable-bitrate
  // encode, but it is close enough to put the swarm within a few seconds of the
  // right place, and the window covers the error.
  seekToFraction(fraction) {
    try {
      const torrent = this._torrent
      const file = this._file
      if (!torrent || !file) return false
      const pieceLength = Number(torrent.pieceLength) || 0
      const startPiece = file._startPiece
      const endPiece = file._endPiece
      if (!pieceLength || typeof startPiece !== 'number' || typeof endPiece !== 'number') return false

      const f = Number(fraction)
      if (!isFinite(f)) return false
      const clamped = Math.max(0, Math.min(1, f))
      const offset = Math.floor((Number(file.length) || 0) * clamped)
      const target = Math.min(endPiece, startPiece + Math.floor(offset / pieceLength))

      // Everything from the jump onward is what the viewer is going to watch,
      // so that is what the torrent should be asking for.
      if (typeof torrent.select === 'function') torrent.select(target, endPiece, 1)
      // And the first few seconds of it are needed now, not eventually.
      const urgent = Math.max(1, Math.ceil(SEEK_URGENT_BYTES / pieceLength))
      if (typeof torrent.critical === 'function') {
        torrent.critical(target, Math.min(endPiece, target + urgent - 1))
      }
      this._lastSeekPiece = target
      return true
    } catch (_) {
      // Prioritisation is an optimisation. A failure here means a slower seek,
      // never a broken one.
      return false
    }
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

  _clearProgressTimer() {
    if (this._progressTimer) {
      clearTimeout(this._progressTimer)
      this._progressTimer = null
    }
  }

  // The deadline is for getting nowhere, not for taking a while. Giving up at a
  // fixed thirty seconds failed torrents that were working perfectly: a large
  // season pack routinely needs longer than that to find peers, fetch metadata
  // and allocate ten multi-gigabyte files, and it needs longer still when the
  // cache is on a mounted Windows drive. Measured here, the same pack was ready
  // in 2.7s with the cache in memory and 13.3s on that drive, with peers
  // connected the whole time in both.
  //
  // So while something is actually happening — peers connected, or bytes
  // arriving — the deadline is extended rather than enforced. Only a torrent
  // that has found nobody at all is a torrent with no seeders.
  _onTimeout(reject) {
    if (this._settled) return
    const torrent = this._torrent
    const peers = (torrent && torrent.numPeers) || 0
    const downloaded = (torrent && torrent.downloaded) || 0

    // Peers that send nothing are not "something happening": after one
    // grace extension, the deadline is only extended while bytes keep
    // arriving (nine connected peers and 0 bytes for 80 s, seen live).
    const grew = downloaded > (this._lastTimeoutDownloaded || 0)
    this._lastTimeoutDownloaded = downloaded
    if ((peers > 0 || downloaded > 0) && this._extensions < MAX_TIMEOUT_EXTENSIONS && (grew || this._extensions < 1)) {
      this._extensions++
      this.emit('progress', {
        phase: 'connecting', peers, downloaded,
        waitedMs: this.timeoutMs * this._extensions,
      })
      this._timer = setTimeout(() => this._onTimeout(reject), this.timeoutMs)
      return
    }

    this._torrent = null
    if (this._server) {
      try { this._server.close(() => {}) } catch {}
      this._server = null
    }
    // Two different failures, and telling them apart is the difference between
    // "the release is dead, pick another" and "this is slow, it may still be
    // worth waiting". Reporting the first when the second was true is what made
    // a torrent with 433 reported seeders read as having none.
    const waited = Math.round((this.timeoutMs * (this._extensions + 1)) / 1000)
    const err = peers > 0
      ? { code: 'SLOW_START', message: `Found ${peers} peer${peers === 1 ? '' : 's'} but the stream did not start within ${waited}s` }
      : { code: 'NO_SEEDERS', message: `Nobody is sharing this right now (searched for ${waited}s)` }
    this._settle(reject, err)
    // The same teardown stop() does, for the same reason. Destroying without
    // destroyStore left whatever pieces had arrived on disk, and nothing ever
    // came back for the directory — the exact leak the per-stream directory
    // exists to prevent, reopened on the give-up path.
    const ownsTorrent = this._ownsTorrent
    this._ownsTorrent = false
    const reusedReady = this._reusedReady
    this._reusedReady = null
    const storeDir = this._storeDir
    this._storeDir = null
    if (torrent) {
      // A pending reused 'ready' handler is detached so its closure does not
      // outlive this give-up.
      if (reusedReady) { try { torrent.removeListener('ready', reusedReady) } catch {} }
      // A reused torrent belongs to another consumer: only ours is destroyed,
      // and only ours has a store to remove.
      if (!ownsTorrent) return
      try {
        torrent.destroy({ destroyStore: true }, () => removeDir(storeDir))
      } catch (_) {
        removeDir(storeDir)
      }
      removeDir(storeDir)
      setTimeout(() => removeDir(storeDir), 1500).unref?.()
    } else {
      removeDir(storeDir)
    }
  }

  _settle(reject, err) {
    if (this._settled) return
    this._settled = true
    this._pendingReject = null
    this._clearTimer()
    this._clearPrebufferTimer()
    this._clearProgressTimer()
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

  // A caller awaiting start() must not hang forever when stop() races the
  // 'ready' callback. Settle the pending promise with a deliberate, distinct
  // code so the caller can tell a stop apart from a real failure.
  _settlePendingStop() {
    const reject = this._pendingReject
    this._pendingReject = null
    if (reject) reject({ code: 'STOPPED', message: 'stopped before ready' })
  }

  stop() {
    this._settled = true
    this._clearTimer()
    this._clearPrebufferTimer()
    this._clearProgressTimer()
    this._file = null
    // The torrent is about to be destroyed; the standing whole-file selection
    // goes with it, so only the bookkeeping needs clearing.
    this._predownload = null
    this._prefetched = null
    const server = this._server
    this._server = null
    if (server) {
      try { server.close(() => {}) } catch {}
    }
    const torrent = this._torrent
    this._torrent = null
    const ownsTorrent = this._ownsTorrent
    this._ownsTorrent = false
    const reusedReady = this._reusedReady
    this._reusedReady = null
    const storeDir = this._storeDir
    this._storeDir = null
    // Subtitles served off a reused torrent live in a directory of their own;
    // it goes the same way the cache does.
    const subDir = this._subDir
    this._subDir = null
    removeDir(subDir)
    if (torrent) {
      try { torrent.removeListener('download', this._onDownload) } catch {}
      // A pending reused 'ready' handler is torn down too, or its closure (and
      // the torrent it captures) outlives this streamer.
      if (reusedReady) { try { torrent.removeListener('ready', reusedReady) } catch {} }
      if (!ownsTorrent) {
        // A reused torrent belongs to another consumer. Destroying it — let
        // alone with destroyStore — would delete data still in use. We only
        // detach; there is no store of ours to remove.
        return this._settlePendingStop()
      }
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
    this._settlePendingStop()
  }
}

module.exports = { TorrentStreamer, PREFETCH_BYTES, PROGRESS_THROTTLE_MS, buildFileUrl, pickVideoFile, matchesWantedEpisode, episodeNumberOf, DEFAULT_STREAM_ROOT, streamRoot, setStreamRoot, purgeOrphanStreams, newStreamDir, headBytesReady, VIDEO_EXT, SUBTITLE_EXT }
