'use strict'
// Shared release-title parsing for the torrent providers. Indexers hand back a
// single scene-style filename, so quality, audio layout and language have to be
// read out of that string. Pure, no I/O — tested directly.

const QUALITY_PATTERNS = [
  [/\b(2160p|4k|uhd)\b/i, '2160p'],
  [/\b1080p\b/i, '1080p'],
  [/\b720p\b/i, '720p'],
  [/\b(480p|sd)\b/i, '480p'],
]

// Order matters: 7.1 must be tested before 5.1 so "DDP5.1" inside a 7.1 title
// cannot win, and Atmos/TrueHD imply multichannel even without a digit pair.
// The digit pairs are matched without a leading \b on purpose: release names
// glue the codec to the layout ("AAC2.0", "DDP5.1", "TrueHD7.1"), and a word
// boundary before the digit never fires there.
const AUDIO_PATTERNS = [
  [/(7\.1|\b8ch\b)/i, '7.1'],
  [/(5\.1|\b6ch\b|\b(dts|ac3|eac3|atmos|truehd)\b)/i, '5.1'],
  [/(2\.0|\b2ch\b|\bstereo\b)/i, 'stereo'],
]

function parseQuality(title) {
  const t = String(title == null ? '' : title)
  for (const [re, value] of QUALITY_PATTERNS) if (re.test(t)) return value
  return 'unknown'
}

// null means "not stated", which the ranker treats as not-surround rather than
// guessing. A wrong 5.1 claim is worse than an honest unknown: the user picks
// a source expecting surround and gets stereo.
function parseAudioLayout(title) {
  const t = String(title == null ? '' : title)
  for (const [re, value] of AUDIO_PATTERNS) if (re.test(t)) return value
  return null
}

// Cam rips, telesyncs and screeners are genuinely bad picture and sound —
// a filmed cinema screen, not a source encode. They are kept (a movie with
// nothing else should still be playable) but flagged, so the ranker can drop
// them below everything and the UI can warn before one is picked.
const LOW_QUALITY = /\b(cam|camrip|hdcam|ts|telesync|hdts|tc|telecine|scr|screener|dvdscr|workprint|hq[\s._-]?cam)\b/i

function isLowQualitySource(title) {
  return LOW_QUALITY.test(String(title == null ? '' : title))
}

function parseDub(title) {
  return /\b(dual[\s._-]?audio|dub|english[\s._-]?dub)\b/i.test(String(title || ''))
}

function parseSub(title) {
  return /\b(sub(bed|s)?|softsub|hardsub|multi[\s._-]?sub)\b/i.test(String(title || ''))
}

// A magnet built from a bare info hash. Trackers are the well-known public
// ones; without them a hash-only magnet has no way to find peers.
const PUBLIC_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
]

function magnetFromHash(infoHash, displayName) {
  if (typeof infoHash !== 'string' || !infoHash.length) return null
  let magnet = `magnet:?xt=urn:btih:${infoHash}`
  if (displayName) magnet += `&dn=${encodeURIComponent(displayName)}`
  for (const tr of PUBLIC_TRACKERS) magnet += `&tr=${encodeURIComponent(tr)}`
  return magnet
}

module.exports = { parseQuality, parseAudioLayout, isLowQualitySource, parseDub, parseSub, magnetFromHash, PUBLIC_TRACKERS }
