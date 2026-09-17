'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  buildAlbumIndex, transcodeDecision, transcodeArgs, TRANSCODE_FORMATS,
  createTtlCache, safeSegments,
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

// ── Search cache: TTL *and* a hard cap ───────────────────────────────────────
// The bridge's Soulseek search cache holds up to 5000 slskd responses per
// entry, so an unbounded map is real memory on a server that runs for days.

test('the cache evicts the oldest entry once the cap is reached', () => {
  let clock = 1000
  const c = createTtlCache({ ttlMs: 60000, max: 3, now: () => clock })
  for (const k of ['a', 'b', 'c']) { c.set(k, k); clock += 10 }
  assert.strictEqual(c.size, 3)

  c.set('d', 'd') // all four are fresh — only the cap can hold the size down
  assert.strictEqual(c.size, 3, 'a burst of fresh entries grew the cache past its cap')
  assert.strictEqual(c.get('a'), null, 'the oldest entry should have been evicted')
  assert.strictEqual(c.get('d'), 'd')
})

test('a burst far past the cap still leaves exactly cap entries', () => {
  let clock = 0
  const c = createTtlCache({ ttlMs: 60000, max: 10, now: () => clock })
  for (let i = 0; i < 500; i++) { c.set('q' + i, i); clock += 1 }
  assert.strictEqual(c.size, 10)
  assert.strictEqual(c.get('q499'), 499)
  assert.strictEqual(c.get('q0'), null)
})

test('an entry past its TTL reads back as a miss and is dropped', () => {
  let clock = 0
  const c = createTtlCache({ ttlMs: 100, max: 50, now: () => clock })
  c.set('k', 'v')
  clock = 99
  assert.strictEqual(c.get('k'), 'v')
  clock = 201
  assert.strictEqual(c.get('k'), null)
  assert.strictEqual(c.size, 0)
})

test('re-setting a key refreshes it rather than leaving a stale duplicate', () => {
  let clock = 0
  const c = createTtlCache({ ttlMs: 60000, max: 2, now: () => clock })
  c.set('a', 1); clock += 10
  c.set('b', 2); clock += 10
  c.set('a', 3); clock += 10 // 'a' is now the newest, so 'b' is the eviction target
  c.set('c', 4)
  assert.strictEqual(c.size, 2)
  assert.strictEqual(c.get('a'), 3)
  assert.strictEqual(c.get('b'), null)
})

// ── Untrusted Soulseek filenames ─────────────────────────────────────────────

test('safeSegments drops the segments that walk out of a directory', () => {
  assert.deepStrictEqual(safeSegments('../../etc/passwd'), ['etc', 'passwd'])
  assert.deepStrictEqual(safeSegments('a/./b/../c'), ['a', 'b', 'c'])
  assert.deepStrictEqual(safeSegments('peer\\Album\\01.flac'), ['peer', 'Album', '01.flac'])
  assert.deepStrictEqual(safeSegments(''), [])
  assert.deepStrictEqual(safeSegments(null), [])
})

test('safeSegments leaves ordinary names, including dotfiles and dotted names, alone', () => {
  assert.deepStrictEqual(safeSegments('A..B/..hidden/x.flac'), ['A..B', '..hidden', 'x.flac'])
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
