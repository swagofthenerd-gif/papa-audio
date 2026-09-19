'use strict'

// Executing tests for the LAN bridge (bridge-server/server.js).
//
// These do NOT read the server as text. They boot the real server as a child
// process against a throwaway library fixture, on an OS-chosen ephemeral port
// (BRIDGE_PORT=0, bound to loopback) so they never contend with the user's real
// bridge on 8765, and with PAPA_BRIDGE_USER_DATA pointed at a temp tree so they
// never read or write ~/.config/papa-audio.
//
// Three defects are covered, each with a matching "and normal traffic still
// works" control so a fix that simply denies everything cannot pass:
//   1. an unhandled read-stream 'error' killed the whole process
//   2. /events was the one unauthenticated route
//   3. the library-root check was a string prefix, not directory containment

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const SERVER = path.join(__dirname, '..', 'bridge-server', 'server.js')
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90' // 32 hex, the shape the server accepts

// ── Fixture ──────────────────────────────────────────────────────────────────
// tmp/
//   userdata/            PAPA_BRIDGE_USER_DATA
//     config.json        the electron-store file the server reads
//     bridge-token       a known token, so the test can authenticate
//     artwork/ok.jpg     inside the allowed artwork cache
//     artwork-private/   SIBLING of artwork — string-prefix bait
//   music/               the one configured library folder
//     album/01.flac      a real (tiny) file
//     baddir/            a directory: stat() succeeds, read() fails EISDIR
//   music-private/       SIBLING of music — string-prefix bait
let tmp, ud, music, child, base
const spawned = [] // every child this file starts, so after() can reap them all

function fixture() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-bridge-test-'))
  ud = path.join(tmp, 'userdata')
  music = path.join(tmp, 'music')
  fs.mkdirSync(path.join(ud, 'artwork'), { recursive: true })
  fs.mkdirSync(path.join(ud, 'artwork-private'), { recursive: true })
  fs.mkdirSync(path.join(music, 'album'), { recursive: true })
  fs.mkdirSync(path.join(music, 'baddir'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'music-private'), { recursive: true })
  fs.writeFileSync(F.track, 'REALFLACBYTES')
  fs.writeFileSync(F.secretTrack, 'SECRET-TRACK')
  fs.writeFileSync(F.art, 'JPEGOK')
  fs.writeFileSync(F.secretArt, 'SECRET-ART')
  fs.writeFileSync(path.join(ud, 'bridge-token'), TOKEN)
  // config.json holds ONLY the settings keys now. The desktop retired
  // libraryCache/playlists/likedTracks/... out of it on 2026-08-27 (see
  // ../src/store-migration.js), so the fixture must not contain them — a
  // bridge that still reads them from here would otherwise pass on a fixture
  // that no longer resembles the user's profile.
  fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({
    musicFolders: [music],
  }))
  // The side files, exactly as ../side-store.js writes them: the bare JSON
  // value at <USER_DATA>/<kebab-case>.json.
  fs.writeFileSync(path.join(ud, 'library-cache.json'), JSON.stringify([
    {
      id: 'alb1', name: 'Fixture', artist: 'Tester', artPath: F.art,
      tracks: [
        { id: 't1', filePath: F.track },
        { id: 'tdir', filePath: F.dir },
        { id: 'tescape', filePath: F.secretTrack },
      ],
    },
    { id: 'albescape', name: 'Bait', artist: 'Tester', artPath: F.secretArt, tracks: [] },
  ]))
  fs.writeFileSync(path.join(ud, 'playlists.json'), JSON.stringify([
    { id: 'pl1', name: 'From the desktop', tracks: [] },
  ]))
  fs.writeFileSync(path.join(ud, 'liked-tracks.json'), JSON.stringify([F.track]))
  fs.writeFileSync(path.join(ud, 'play-counts.json'), JSON.stringify({ [F.track]: 3 }))
}

// Paths are referenced before fixture() runs, so they are lazy getters over the
// `tmp` the fixture creates.
const F = {
  get track()       { return path.join(music, 'album', '01.flac') },
  get dir()         { return path.join(music, 'baddir') },
  get secretTrack() { return path.join(tmp, 'music-private', 'secret.flac') },
  get art()         { return path.join(ud, 'artwork', 'ok.jpg') },
  get secretArt()   { return path.join(ud, 'artwork-private', 'leak.jpg') },
}

// Boot the real server and resolve to { proc, base } once it announces a port.
// `env` overlays the defaults, so one test can ask for a different rate limit
// without disturbing the shared instance the rest of the file uses.
function boot(env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER], {
      cwd: path.dirname(SERVER),
      env: {
        ...process.env,
        BRIDGE_PORT: '0',            // never 8765 — the real bridge may be live
        BRIDGE_HOST: '127.0.0.1',    // loopback only; nothing reaches the LAN
        PAPA_BRIDGE_USER_DATA: ud,
        // This file makes dozens of requests from one address; lift the limiter
        // out of the way by default so it can never throttle the suite itself.
        BRIDGE_RATE_LIMIT_MAX: '100000',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    spawned.push(proc)
    // The suite runs test files in parallel and some of them assert on real
    // timings. A booting bridge pulls in express, music-metadata and
    // youtubei.js, so hand it the lowest priority the scheduler will give and
    // let those neighbours have the CPU.
    try { os.setPriority(proc.pid, 19) } catch (_) {}
    let out = ''
    const timer = setTimeout(() => {
      reject(new Error('bridge did not announce a port in 30s; stdout: ' + out))
    }, 30000)
    proc.stdout.on('data', d => {
      out += d.toString()
      const m = /BRIDGE_LISTENING (\d+)/.exec(out)
      if (m) { clearTimeout(timer); resolve({ proc, base: `http://127.0.0.1:${m[1]}` }) }
    })
    proc.stderr.on('data', () => {}) // the server logs stream failures here
    proc.on('error', e => { clearTimeout(timer); reject(e) })
    proc.on('exit', code => {
      clearTimeout(timer)
      reject(new Error(`bridge exited ${code} before listening; stdout: ${out}`))
    })
  })
}

// Media/SSE URL with the token as a query param (the form a player or an
// EventSource has to use, since neither can attach a header).
const media = p => `${base}${p}${p.includes('?') ? '&' : '?'}token=${TOKEN}`
// Header auth, the form the Android app's axios client uses for /api/*.
const authed = { headers: { Authorization: `Bearer ${TOKEN}` } }

// Is the child still running? exitCode stays null until the process exits.
const alive = () => child.exitCode === null && child.signalCode === null

test.before(async () => {
  fixture()
  const booted = await boot()
  child = booted.proc
  base = booted.base
})

test.after(() => {
  for (const p of spawned) { try { p.kill('SIGKILL') } catch (_) {} }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) {}
})

// ── Sanity: the fixture really is wired to the temp tree ─────────────────────

test('the booted bridge is serving the temp fixture, not the real library', async () => {
  const health = await fetch(`${base}/api/health`)
  assert.strictEqual(health.status, 200)

  const folders = await fetch(`${base}/api/folders`, authed)
  assert.strictEqual(folders.status, 200)
  assert.deepStrictEqual(await folders.json(), [music],
    'the server must be reading the temp config.json, not ~/.config/papa-audio')
})

// ── 1. A read-stream error must not take the process down ────────────────────
// A directory is the deterministic trigger: stat() succeeds so the route gets
// past its existence check, then read() fails EISDIR asynchronously — exactly
// the shape of a file deleted, unmounted or chmod'd mid-request.

test('an unreadable file fails that one request, not the whole bridge', async () => {
  // /art sets headers without flushing, so the error is still recoverable and
  // the client gets an honest 500 instead of a dead socket.
  const r = await fetch(media('/art?path=' + encodeURIComponent(F.dir)))
  assert.strictEqual(r.status, 500)
  assert.match((await r.json()).error, /stream failed/i)

  assert.ok(alive(), 'the bridge process died on an unreadable file')
})

test('a read error mid-stream aborts that response and the bridge keeps serving', async () => {
  // /stream flushes headers (and a Content-Length) before piping, so the only
  // honest answer to a mid-body failure is an aborted transfer.
  let aborted = false
  try {
    const r = await fetch(media('/stream?path=' + encodeURIComponent(F.dir)))
    await r.arrayBuffer()
  } catch (_) {
    aborted = true
  }
  assert.ok(aborted, 'a failed stream must abort, not deliver a silent truncation')
  assert.ok(alive(), 'the bridge process died mid-stream')

  // The real regression: LAN playback stayed dead until the desktop app was
  // restarted. Prove the next request still works.
  const after = await fetch(media('/stream?path=' + encodeURIComponent(F.track)))
  assert.strictEqual(after.status, 200)
  assert.strictEqual(await after.text(), 'REALFLACBYTES')
})

test('the id-keyed stream route survives an unreadable file too', async () => {
  let aborted = false
  try {
    const r = await fetch(media('/stream/tdir'))
    await r.arrayBuffer()
  } catch (_) { aborted = true }
  assert.ok(aborted)
  assert.ok(alive(), 'the bridge process died on /stream/:trackId')

  const health = await fetch(`${base}/api/health`)
  assert.strictEqual(health.status, 200)
})

// ── 2. /events must be authenticated like everything else ────────────────────

test('/events without a token is refused', async () => {
  const r = await fetch(`${base}/events`)
  assert.strictEqual(r.status, 401, '/events must not be an open activity feed')
  assert.match((await r.json()).error, /unauthorized/i)
})

test('/events with a wrong token is refused', async () => {
  const r = await fetch(`${base}/events?token=` + 'f'.repeat(32))
  assert.strictEqual(r.status, 401)
  await r.text()
})

test('/events with the real token still streams (via ?token=, as EventSource must)', async () => {
  const ac = new AbortController()
  const r = await fetch(media('/events'), { signal: ac.signal })
  try {
    assert.strictEqual(r.status, 200)
    assert.match(r.headers.get('content-type') || '', /text\/event-stream/)
    const { value } = await r.body.getReader().read()
    assert.match(Buffer.from(value).toString(), /event: connected/)
  } finally {
    ac.abort()
  }
})

test('/api/health stays public so a client can probe an unpaired bridge', async () => {
  const r = await fetch(`${base}/api/health`)
  assert.strictEqual(r.status, 200)
  assert.strictEqual((await r.json()).ok, true)
})

// ── 3. The library root is a directory boundary, not a string prefix ──────────

test('a sibling directory that shares the library prefix is refused', async () => {
  // /tmp/x/music-private/secret.flac string-starts-with /tmp/x/music.
  const r = await fetch(media('/stream?path=' + encodeURIComponent(F.secretTrack)))
  assert.strictEqual(r.status, 403, 'the sibling-prefix escape is still open')
  const body = await r.text()
  assert.doesNotMatch(body, /SECRET-TRACK/)
})

test('".." spelled into a sibling of the library is refused', async () => {
  const via = path.join(music, '..', 'music-private', 'secret.flac')
  const r = await fetch(media('/stream?path=' + encodeURIComponent(via)))
  assert.strictEqual(r.status, 403)
  await r.text()
})

test('".." pointing somewhere unrelated is refused (it always was — resolve eats it)', async () => {
  const r = await fetch(media('/stream?path=' + encodeURIComponent(music + '/../../etc/passwd')))
  assert.strictEqual(r.status, 403)
  await r.text()
})

test('the sibling of the artwork cache is refused on /art', async () => {
  const r = await fetch(media('/art?path=' + encodeURIComponent(F.secretArt)))
  assert.strictEqual(r.status, 403)
  assert.doesNotMatch(await r.text(), /SECRET-ART/)
})

test('a library-cache entry pointing outside the library is refused by id too', async () => {
  const s = await fetch(media('/stream/tescape'))
  assert.strictEqual(s.status, 403)
  assert.doesNotMatch(await s.text(), /SECRET-TRACK/)

  const a = await fetch(media('/art/albescape.jpg'))
  assert.strictEqual(a.status, 403)
  assert.doesNotMatch(await a.text(), /SECRET-ART/)
})

// The control that keeps the containment fix honest: denying everything would
// pass every test above.
test('real library files are still served by path and by id', async () => {
  const byPath = await fetch(media('/stream?path=' + encodeURIComponent(F.track)))
  assert.strictEqual(byPath.status, 200)
  assert.strictEqual(await byPath.text(), 'REALFLACBYTES')

  const byId = await fetch(media('/stream/t1'))
  assert.strictEqual(byId.status, 200)
  assert.strictEqual(await byId.text(), 'REALFLACBYTES')

  const artByPath = await fetch(media('/art?path=' + encodeURIComponent(F.art)))
  assert.strictEqual(artByPath.status, 200)
  assert.strictEqual(await artByPath.text(), 'JPEGOK')

  const artById = await fetch(media('/art/alb1.jpg'))
  assert.strictEqual(artById.status, 200)
  assert.strictEqual(await artById.text(), 'JPEGOK')
})

// ── Download-path resolution takes its segments from an untrusted peer ───────

test('a ".." in a Soulseek filename cannot walk out of the download folder', async () => {
  // downloadDir falls back to the first music folder, so "../music-private/…"
  // used to path.join() its way to a real file outside it and hand back the
  // resolved path.
  const r = await fetch(
    `${base}/api/slsk/resolve?username=peer&filename=` +
      encodeURIComponent('../music-private/secret.flac'), authed)
  assert.strictEqual(r.status, 200)
  const body = await r.json()
  assert.strictEqual(body.path, null, 'a ".." filename resolved outside the download folder')
})

test('a normal Soulseek filename still resolves to the downloaded file', async () => {
  // The control: segment filtering must not break the ordinary case.
  const r = await fetch(
    `${base}/api/slsk/resolve?username=peer&filename=` +
      encodeURIComponent('peer\\album\\01.flac'), authed)
  assert.strictEqual((await r.json()).path, F.track)
})

// ── Range handling (found while auditing the same routes) ────────────────────

test('a suffix range (bytes=-N) returns the last N bytes, not a NaN response', async () => {
  const r = await fetch(media('/stream?path=' + encodeURIComponent(F.track)), {
    headers: { Range: 'bytes=-5' },
  })
  assert.strictEqual(r.status, 206)
  assert.strictEqual(r.headers.get('content-range'), 'bytes 8-12/13')
  assert.strictEqual(await r.text(), 'BYTES')
})

test('an open-ended range is clamped to the end of the file', async () => {
  const r = await fetch(media('/stream?path=' + encodeURIComponent(F.track)), {
    headers: { Range: 'bytes=4-' },
  })
  assert.strictEqual(r.status, 206)
  assert.strictEqual(r.headers.get('content-range'), 'bytes 4-12/13')
  assert.strictEqual(await r.text(), 'FLACBYTES')
})

test('a range past the end of the file is a 416, not an over-long Content-Length', async () => {
  const r = await fetch(media('/stream?path=' + encodeURIComponent(F.track)), {
    headers: { Range: 'bytes=9999-' },
  })
  assert.strictEqual(r.status, 416)
  assert.strictEqual(r.headers.get('content-range'), 'bytes */13')
  await r.text()
})

test('an end past EOF is clamped rather than promising bytes that do not exist', async () => {
  const r = await fetch(media('/stream?path=' + encodeURIComponent(F.track)), {
    headers: { Range: 'bytes=0-9999' },
  })
  assert.strictEqual(r.status, 206)
  assert.strictEqual(r.headers.get('content-length'), '13')
  assert.strictEqual(await r.text(), 'REALFLACBYTES')
})

test('the id-keyed stream route honours ranges the same way', async () => {
  const r = await fetch(media('/stream/t1'), { headers: { Range: 'bytes=-5' } })
  assert.strictEqual(r.status, 206)
  assert.strictEqual(await r.text(), 'BYTES')

  const past = await fetch(media('/stream/t1'), { headers: { Range: 'bytes=500-' } })
  assert.strictEqual(past.status, 416)
  await past.text()
})

// ── The rate limiter must key on the real peer, not a header the peer picks ──
// Exhausting the limiter poisons every later request to that server for a full
// minute, so this runs last and against its own short-lived instance with the
// limit turned right down.

test('a forged X-Forwarded-For does not buy a fresh rate-limit budget', async () => {
  const LIMIT = 5
  const { proc, base: rlBase } = await boot({ BRIDGE_RATE_LIMIT_MAX: String(LIMIT) })
  try {
    const statuses = []
    // One request past the limit, each claiming to come from a different client.
    for (let i = 0; i <= LIMIT; i++) {
      const r = await fetch(`${rlBase}/api/folders`, {
        headers: { ...authed.headers, 'X-Forwarded-For': `10.9.9.${i + 1}` },
      })
      statuses.push(r.status)
      await r.text()
    }
    assert.ok(statuses.slice(0, LIMIT).every(s => s === 200),
      `the first ${LIMIT} requests should be allowed, got ${statuses}`)
    assert.strictEqual(statuses[LIMIT], 429,
      'a forged X-Forwarded-For bought an unlimited request budget')
  } finally {
    proc.kill('SIGKILL')
  }
})

// ── C3. The bridge reads the desktop's SideStore files, not retired config keys ─
// On 2026-08-27 the desktop moved libraryCache, playlists, likedTracks,
// playCounts, playHistory, savedQueues, recentlyPlayed and playbackState into
// one small JSON file each, and retireLegacyKeys() deletes them from
// config.json. The bridge kept reading config.json, so on the phone the library
// was empty, every /art and /stream/:id 404'd, and a like went into a key
// nothing reads. The fixture above deliberately has NO legacy keys in
// config.json — these tests fail on the old code because there is nothing to
// read there.

test('the library comes from library-cache.json, with no legacy key in config', async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ud, 'config.json'), 'utf8'))
  assert.ok(!('libraryCache' in cfg), 'the fixture must mirror the real profile: no retired keys')

  const r = await fetch(`${base}/api/library`, authed)
  assert.strictEqual(r.status, 200)
  const body = await r.json()
  assert.strictEqual(body.cached, true)
  assert.strictEqual(body.albums.length, 2)
  assert.strictEqual(body.albums[0].id, 'alb1')
  assert.strictEqual(body.albums[0].artUrl, '/art/alb1.jpg')
})

test('art and audio resolve by id from the side file (200 / 206), not 404', async () => {
  const art = await fetch(media('/art/alb1.jpg'))
  assert.strictEqual(art.status, 200, '/art/<id>.jpg 404s when the bridge reads the retired key')
  assert.strictEqual(await art.text(), 'JPEGOK')

  const ranged = await fetch(media('/stream/t1'), { headers: { Range: 'bytes=0-3' } })
  assert.strictEqual(ranged.status, 206)
  assert.strictEqual(await ranged.text(), 'REAL')
})

test('playlists and liked tracks are served from their side files', async () => {
  const pls = await (await fetch(`${base}/api/settings/playlists`, authed)).json()
  assert.deepStrictEqual(pls.map(p => p.id), ['pl1'])

  const liked = await (await fetch(`${base}/api/settings/liked-tracks`, authed)).json()
  assert.deepStrictEqual(liked, [F.track])

  const counts = await (await fetch(`${base}/api/settings/play-counts`, authed)).json()
  assert.strictEqual(counts[F.track], 3)
})

test('a phone mutation never writes a legacy key back into config.json', async () => {
  const before = fs.statSync(path.join(ud, 'config.json')).size

  const r = await fetch(`${base}/api/settings/playlists`, {
    method: 'POST',
    headers: { ...authed.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'pl2', name: 'From the phone', tracks: [] }),
  })
  assert.strictEqual(r.status, 202, 'a queued mutation is accepted, not silently "ok"')
  assert.strictEqual((await r.json()).queued, true)

  const cfg = JSON.parse(fs.readFileSync(path.join(ud, 'config.json'), 'utf8'))
  assert.ok(!('playlists' in cfg), 'the bridge wrote `playlists` back into config.json')
  assert.ok(!('libraryCache' in cfg))
  assert.strictEqual(fs.statSync(path.join(ud, 'config.json')).size, before,
    'config.json was rewritten by a playlist POST')

  // The desktop's playlists.json must be untouched — one writer per store.
  const side = JSON.parse(fs.readFileSync(path.join(ud, 'playlists.json'), 'utf8'))
  assert.deepStrictEqual(side.map(p => p.id), ['pl1'],
    'the bridge became a second writer on the desktop’s playlists.json')

  // ...but the phone still sees what it just did, via the inbox overlay.
  const after = await (await fetch(`${base}/api/settings/playlists`, authed)).json()
  assert.deepStrictEqual(after.map(p => p.id).sort(), ['pl1', 'pl2'])
})

test('a scan does not push the library back into config.json', async () => {
  const before = fs.readFileSync(path.join(ud, 'config.json'), 'utf8')
  const r = await fetch(`${base}/api/library/scan`, { method: 'POST', ...authed })
  assert.strictEqual(r.status, 200)
  const body = await r.json()
  assert.strictEqual(body.persisted, false)
  assert.strictEqual(fs.readFileSync(path.join(ud, 'config.json'), 'utf8'), before,
    'the scan rewrote config.json — this is what left the 1.4-2.6 MB config.json.tmp-* orphans')
})

test('/api/library/cache is gone (the phone must not overwrite the desktop cache)', async () => {
  const r = await fetch(`${base}/api/library/cache`, {
    method: 'POST',
    headers: { ...authed.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ albums: [] }),
  })
  assert.strictEqual(r.status, 404)
  await r.text()
  const side = JSON.parse(fs.readFileSync(path.join(ud, 'library-cache.json'), 'utf8'))
  assert.strictEqual(side.length, 2, 'library-cache.json was overwritten by the phone')
})

test('a side file the desktop rewrites is picked up without a bridge restart', async () => {
  const file = path.join(ud, 'liked-tracks.json')
  const original = fs.readFileSync(file, 'utf8')
  try {
    fs.writeFileSync(file, JSON.stringify([F.track, '/mnt/data/MUSIC/new.flac']))
    const liked = await (await fetch(`${base}/api/settings/liked-tracks`, authed)).json()
    assert.strictEqual(liked.length, 2, 'the bridge cached the side file for the life of the process')
  } finally {
    fs.writeFileSync(file, original)
  }
})
