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

// A magnet built from a bare info hash.
//
// This list is load-bearing, not decoration. Nyaa and apibay both return only
// an info hash, so the magnet is assembled here — and a magnet with no usable
// tracker can find peers by DHT alone, which is slow, often rate-limited, and
// blocked on plenty of networks. The symptom is a torrent that never fetches
// its metadata: the add() callback never fires and playback sits there.
//
// nyaa.tracker.wf is the one that matters most for anime: every nyaa release
// announces there, and its absence is the difference between a swarm of
// hundreds and nothing at all. open.stealth.si and tracker.dler.org play the
// same role for the public index that apibay serves.
const PUBLIC_TRACKERS = [
  // Anime — nyaa's own tracker.
  'http://nyaa.tracker.wf:7777/announce',
  // The public set that TPB releases announce to.
  'udp://open.stealth.si:80/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
  'udp://opentracker.i2p.rocks:6969/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  // WebTorrent can also use WebSocket trackers, which reach browser peers the
  // UDP swarm never sees.
  'wss://tracker.openwebtorrent.com',
]

function magnetFromHash(infoHash, displayName) {
  if (typeof infoHash !== 'string' || !infoHash.length) return null
  let magnet = `magnet:?xt=urn:btih:${infoHash}`
  if (displayName) magnet += `&dn=${encodeURIComponent(displayName)}`
  for (const tr of PUBLIC_TRACKERS) magnet += `&tr=${encodeURIComponent(tr)}`
  return magnet
}

// Normalise a torrent's size to bytes for the sources list. Indexers report it
// two ways: a raw byte count (apibay, animetosho, knaben, solidtorrents, yts)
// or a human string like "4.2 GiB" / "700 MB" (nyaa's RSS). Both binary (GiB,
// 1024) and decimal (GB, 1000) suffixes appear in the wild; the suffix decides.
// Returns null when unparseable so the row can dim gracefully rather than
// invent a size.
const _SIZE_UNITS = {
  b: 1,
  kb: 1e3, kib: 1024,
  mb: 1e6, mib: 1024 ** 2,
  gb: 1e9, gib: 1024 ** 3,
  tb: 1e12, tib: 1024 ** 4,
}

function parseSizeBytes(raw) {
  if (raw == null) return null
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null
  const m = String(raw).trim().match(/^([\d.,]+)\s*([a-z]+)?$/i)
  if (!m) return null
  const num = Number(m[1].replace(/,/g, ''))
  if (!Number.isFinite(num) || num <= 0) return null
  const unit = (m[2] || 'b').toLowerCase()
  const mult = _SIZE_UNITS[unit]
  if (!mult) return null
  return Math.round(num * mult)
}

// The ONE size formatter for Movies & TV. Every provider used to render its own
// gigabytes at 1e9 while the source row beside it rendered the same bytes at
// 1024**3, so a single row carried two different numbers both labelled "GB"
// (audit N11 — 3.7 GB next to 4.0 GB for the same file). One definition,
// binary like the rest of the app, shared by the providers and the renderer's
// source rows. Returns null for an unknown size so a label can omit it instead
// of inventing a zero.
const { size: _fmtVideoSize } = require('../src/video-format.js')

function fmtSize(raw) {
  const n = typeof raw === 'number' ? raw : parseSizeBytes(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return _fmtVideoSize(n)
}

module.exports = { parseQuality, parseAudioLayout, isLowQualitySource, parseDub, parseSub, magnetFromHash, parseSizeBytes, fmtSize, PUBLIC_TRACKERS }
