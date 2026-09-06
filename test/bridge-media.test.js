'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  buildAlbumIndex, transcodeDecision, transcodeArgs, TRANSCODE_FORMATS,
} = require('../bridge-server/media-lib')

// A library-cache fixture in the shape buildAlbums() produces and the Android
// bridge serves.
const ALBUMS = [
  {
    id: 'alb1', name: 'First', artist: 'A', artPath: '/mnt/data/MUSIC/A/First/cover.jpg',
    tracks: [
      { id: 't1', title: 'One', filePath: '/mnt/data/MUSIC/A/First/01.flac' },
      { id: 't2', title: 'Two', filePath: '/mnt/data/MUSIC/A/First/02.flac' },
    ],
  },
  {
    id: 'alb2', name: 'No Art', artist: 'B', artPath: null,
    tracks: [{ id: 't3', title: 'Three', filePath: '/mnt/data/MUSIC/B/03.mp3' }],
  },
]

// ── Album index (roadmap #64): id → path lookups from the library cache ──────

test('buildAlbumIndex maps album ids to art paths and track ids to files', () => {
  const { artById, trackById } = buildAlbumIndex(ALBUMS)
  assert.strictEqual(artById.get('alb1'), '/mnt/data/MUSIC/A/First/cover.jpg')
  assert.strictEqual(trackById.get('t1'), '/mnt/data/MUSIC/A/First/01.flac')
  assert.strictEqual(trackById.get('t3'), '/mnt/data/MUSIC/B/03.mp3')
})

test('an album with no artPath contributes no art entry', () => {
  const { artById } = buildAlbumIndex(ALBUMS)
  assert.strictEqual(artById.has('alb2'), false)
})

test('a missing id is a clean undefined, and junk input never throws', () => {
  const { artById, trackById } = buildAlbumIndex(ALBUMS)
  assert.strictEqual(artById.get('nope'), undefined)
  assert.strictEqual(trackById.get('nope'), undefined)
  assert.deepStrictEqual([...buildAlbumIndex(null).artById], [])
  assert.deepStrictEqual([...buildAlbumIndex([null, {}, { tracks: 'x' }]).trackById], [])
})

// ── Transcode decision: the gate + ffmpeg presence + supported format ────────

test('a supported format with ffmpeg present and the gate on is honoured', () => {
  const d = transcodeDecision({ fmt: 'mp3', bridgeTranscode: true, ffmpegAvailable: true })
  assert.strictEqual(d.ok, true)
  assert.strictEqual(d.spec, TRANSCODE_FORMATS.mp3)
})

test('the gate being off refuses with a 403 and a reason', () => {
  const d = transcodeDecision({ fmt: 'mp3', bridgeTranscode: false, ffmpegAvailable: true })
  assert.strictEqual(d.ok, false)
  assert.strictEqual(d.status, 403)
  assert.match(d.reason, /disabled/i)
})

test('missing ffmpeg refuses politely with a 501', () => {
  const d = transcodeDecision({ fmt: 'mp3', bridgeTranscode: true, ffmpegAvailable: false })
  assert.strictEqual(d.ok, false)
  assert.strictEqual(d.status, 501)
  assert.match(d.reason, /ffmpeg/i)
})

test('an unsupported format is a 400', () => {
  const d = transcodeDecision({ fmt: 'flacx', bridgeTranscode: true, ffmpegAvailable: true })
  assert.strictEqual(d.ok, false)
  assert.strictEqual(d.status, 400)
})

// ── ffmpeg argv: 320k mp3 to stdout ──────────────────────────────────────────

test('transcodeArgs builds a 320k mp3 pipe to stdout', () => {
  const args = transcodeArgs('/mnt/data/MUSIC/A/First/01.flac', TRANSCODE_FORMATS.mp3)
  assert.ok(args.includes('-i'))
  assert.ok(args.includes('/mnt/data/MUSIC/A/First/01.flac'))
  assert.deepStrictEqual(
    [args[args.indexOf('-b:a') + 1], args[args.indexOf('-c:a') + 1]],
    ['320k', 'libmp3lame'])
  assert.strictEqual(args[args.length - 1], 'pipe:1')
  assert.ok(args.includes('-vn'), 'embedded cover art is dropped')
})

// ── Server wiring: routes, art decoration, version bump, auth ────────────────

const fs = require('fs')
const path = require('path')
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'bridge-server', 'server.js'), 'utf8')

test('the id-keyed art and stream routes exist', () => {
  assert.match(SERVER, /app\.get\('\/art\/:albumId\.jpg'/)
  assert.match(SERVER, /app\.get\('\/stream\/:trackId'/)
})

test('album payloads carry an artUrl pointing at the id-keyed endpoint', () => {
  assert.match(SERVER, /artUrl: `\/art\/\$\{a\.id\}\.jpg`/)
  assert.match(SERVER, /withArtUrls\(cached\)/)
  assert.match(SERVER, /withArtUrls\(albums\)/)
})

test('the announced version is bumped and capabilities are reported', () => {
  assert.match(SERVER, /BRIDGE_VERSION = '1\.1\.0'/)
  assert.match(SERVER, /capabilities: bridgeCapabilities\(\)/)
})

test('the new routes are behind the auth gate', () => {
  // The guard must cover the id-keyed prefixes, not just the exact old paths.
  assert.match(SERVER, /req\.path\.startsWith\('\/stream\/'\)/)
  assert.match(SERVER, /req\.path\.startsWith\('\/art\/'\)/)
})

test('a client hangup kills the ffmpeg child so a transcode is not orphaned', () => {
  assert.match(SERVER, /req\.on\('close', \(\) => \{ try \{ ff\.kill/)
})
