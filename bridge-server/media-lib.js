'use strict'
// Bridge media helpers (roadmap #64) — the pure, testable half of the Android
// bridge's artwork + transcode additions. No express, no ffmpeg, no filesystem:
// the server wires these decisions to real I/O; the logic lives here so it can be
// exercised with fixtures under the main repo's test runner.

// Build id → path lookups from a library-cache album list (the same shape
// buildAlbums() produces and store.libraryCache holds). Albums carry an `id` and
// an `artPath`; each track carries an `id` and a `filePath`. Returns plain Maps
// so a missing id is a clean `undefined` rather than a prototype surprise.
function buildAlbumIndex(albums) {
  const artById = new Map()
  const trackById = new Map()
  for (const album of Array.isArray(albums) ? albums : []) {
    if (!album || typeof album !== 'object') continue
    if (album.id && album.artPath) artById.set(String(album.id), album.artPath)
    for (const track of Array.isArray(album.tracks) ? album.tracks : []) {
      if (track && track.id && track.filePath) {
        trackById.set(String(track.id), track.filePath)
      }
    }
  }
  return { artById, trackById }
}

// The formats the bridge will transcode to, and the ffmpeg codec/bitrate for
// each. Only mp3 for now (320k CBR, the widely-compatible choice the contract
// asks for); the map is the extension point for adding aac/opus later.
const TRANSCODE_FORMATS = {
  mp3: { ext: 'mp3', mime: 'audio/mpeg', codec: 'libmp3lame', bitrate: '320k' },
}

// Decide whether a transcode request is honoured, and why not when it is not.
// Every "no" carries a plain-English reason so the server can answer the client
// politely (a 4xx with a message) instead of failing opaquely.
//   fmt              — the requested target format (e.g. 'mp3')
//   bridgeTranscode  — the config gate (default ON; false = feature disabled)
//   ffmpegAvailable  — whether ffmpeg was found on PATH
function transcodeDecision({ fmt, bridgeTranscode, ffmpegAvailable }) {
  if (bridgeTranscode === false) {
    return { ok: false, status: 403, reason: 'Transcoding is disabled in settings.' }
  }
  const spec = TRANSCODE_FORMATS[String(fmt || '').toLowerCase()]
  if (!spec) {
    return { ok: false, status: 400, reason: `Unsupported transcode format: ${fmt}` }
  }
  if (!ffmpegAvailable) {
    return { ok: false, status: 501, reason: 'ffmpeg is not installed; cannot transcode.' }
  }
  return { ok: true, spec }
}

// The ffmpeg argv that turns `inputPath` into a streamed transcode for `spec`.
// -vn drops any embedded cover art (a picture stream in the mp3 container makes
// some clients choke), -f names the container, and the output goes to stdout
// (`pipe:1`) so the server can pipe it straight to the HTTP response.
function transcodeArgs(inputPath, spec) {
  return [
    '-hide_banner', '-loglevel', 'error',
    '-i', inputPath,
    '-vn',
    '-c:a', spec.codec,
    '-b:a', spec.bitrate,
    '-f', spec.ext === 'mp3' ? 'mp3' : spec.ext,
    'pipe:1',
  ]
}

// A small TTL cache with a hard entry cap.
//
// The bridge's Soulseek search cache used to "bound" itself by sweeping entries
// older than the TTL once the map passed 200 — which deletes nothing at all
// when all 200 entries are fresh, so a burst of distinct searches grew the map
// (and the thousands of slskd responses held inside each entry) without limit
// on a server that runs for days. Evicting the oldest survivor once the cap is
// reached is what actually bounds it.
//
// `now` is injectable so the TTL can be exercised without sleeping.
function createTtlCache({ ttlMs, max, now = Date.now }) {
  const entries = new Map() // key -> { value, ts }; Map keeps insertion order
  return {
    get(key) {
      const e = entries.get(key)
      if (!e) return null
      if (now() - e.ts > ttlMs) { entries.delete(key); return null }
      return e.value
    },
    set(key, value) {
      entries.delete(key) // re-insert so the newest key sorts last
      entries.set(key, { value, ts: now() })
      const cutoff = now() - ttlMs
      for (const [k, e] of entries) if (e.ts < cutoff) entries.delete(k)
      // Everything left is fresh, so the cap can only be held by dropping the
      // oldest — the step the old sweep-only version was missing.
      while (entries.size > max) entries.delete(entries.keys().next().value)
    },
    get size() { return entries.size },
  }
}

// Strip the segments that let a remote filename walk out of the download
// directory. slskd filenames arrive as `user\\folder\\file.flac` from an
// untrusted peer; joining those segments straight onto the download dir let a
// crafted name probe for files anywhere on disk.
function safeSegments(filename) {
  return String(filename || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(seg => seg && seg !== '.' && seg !== '..')
}

module.exports = {
  buildAlbumIndex,
  transcodeDecision,
  transcodeArgs,
  createTtlCache,
  safeSegments,
  TRANSCODE_FORMATS,
}
