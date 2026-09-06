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

module.exports = {
  buildAlbumIndex,
  transcodeDecision,
  transcodeArgs,
  TRANSCODE_FORMATS,
}
