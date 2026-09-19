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
//     baddir.flac/       a directory: stat() succeeds, read() fails EISDIR
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
  // Named with a music extension on purpose: /stream now enforces the
  // MUSIC_EXT allow-list, and this fixture's job is to get PAST every check and
  // then fail at read() with EISDIR.
  fs.mkdirSync(path.join(music, 'baddir.flac'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'music-private'), { recursive: true })
  fs.writeFileSync(F.track, 'REALFLACBYTES')
  fs.writeFileSync(F.secretTrack, 'SECRET-TRACK')
  fs.writeFileSync(F.art, 'JPEGOK')
  fs.writeFileSync(F.notes, 'PRIVATE-NOTES')
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
  get dir()         { return path.join(music, 'baddir.flac') },
  get secretTrack() { return path.join(tmp, 'music-private', 'secret.flac') },
  // Inside the library root, but not audio: the MUSIC_EXT allow-list's job.
  get notes()       { return path.join(music, 'album', 'notes.txt') },
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

// ── H4. A token holder must not be able to read the disk or the API keys ──────
// The pairing token is a LAN secret, not an admin credential: a phone, a guest
// on the wifi, or anything that scraped the 0644 token file held it. Each of
// these was a way from "holds the token" to "reads any file / takes the AI
// keys / rewrites the desktop's config".

test('POST /api/folders is gone — the allow-list is not writable over the LAN', async () => {
  const r = await fetch(`${base}/api/folders`, {
    method: 'POST',
    headers: { ...authed.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder: '/' }),
  })
  assert.strictEqual(r.status, 404, 'adding "/" to musicFolders makes /stream a file browser')
  await r.text()

  // And the allow-list really is unchanged, so /stream still refuses the world.
  const folders = await (await fetch(`${base}/api/folders`, authed)).json()
  assert.deepStrictEqual(folders, [music])
  const etc = await fetch(media('/stream?path=' + encodeURIComponent('/etc/hostname')))
  assert.strictEqual(etc.status, 403)
  await etc.text()
})

test('DELETE /api/folders is gone too', async () => {
  const r = await fetch(`${base}/api/folders?folder=` + encodeURIComponent(music), {
    method: 'DELETE', ...authed,
  })
  assert.strictEqual(r.status, 404)
  await r.text()
  assert.deepStrictEqual(await (await fetch(`${base}/api/folders`, authed)).json(), [music])
})

test('a non-audio file inside the library is refused by /stream', async () => {
  assert.ok(fs.existsSync(F.notes))
  const r = await fetch(media('/stream?path=' + encodeURIComponent(F.notes)))
  assert.strictEqual(r.status, 403, 'containment is not an allow-list; /stream serves AUDIO')
  assert.doesNotMatch(await r.text(), /PRIVATE-NOTES/)
})

test('GET /api/settings/agent-keys is gone — the AI keys are not a bridge resource', async () => {
  const r = await fetch(`${base}/api/settings/agent-keys`, authed)
  assert.strictEqual(r.status, 404)
  const body = await r.text()
  assert.doesNotMatch(body, /apiKeys|anthropic|openai/i)
})

test('POST /api/settings/agent-keys is gone as well', async () => {
  const r = await fetch(`${base}/api/settings/agent-keys`, {
    method: 'POST',
    headers: { ...authed.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ anthropic: 'sk-attacker' }),
  })
  assert.strictEqual(r.status, 404)
  await r.text()
  const cfg = JSON.parse(fs.readFileSync(path.join(ud, 'config.json'), 'utf8'))
  assert.ok(!('apiKeys' in cfg), 'the LAN rewrote the desktop’s API keys')
})

test('an albumId that walks out of the artwork cache is refused', async () => {
  const escape = path.join(tmp, 'pwned')
  const r = await fetch(`${base}/api/fetch-album-art`, {
    method: 'POST',
    headers: { ...authed.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ albumId: '../../pwned', artist: 'x', album: 'y' }),
  })
  assert.strictEqual(r.status, 400, 'a traversing albumId must be refused, not answered 200 null')
  await r.text()
  assert.ok(!fs.existsSync(escape + '.jpg'), 'a file was written outside the artwork cache')
})

test('a real-shaped albumId is still accepted (the control)', async () => {
  // Pre-seed the cache so the route answers from disk and never reaches iTunes.
  const id = 'a'.repeat(32)
  fs.writeFileSync(path.join(ud, 'artwork', `${id}.jpg`), 'CACHEDART')
  const r = await fetch(`${base}/api/fetch-album-art`, {
    method: 'POST',
    headers: { ...authed.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ albumId: id, artist: 'Tester', album: 'Fixture' }),
  })
  assert.strictEqual(r.status, 200)
  assert.strictEqual((await r.json()).artPath, path.join(ud, 'artwork', `${id}.jpg`))
})

test('the Android local-scan id shape (short base36) is still accepted', async () => {
  const id = '1f4x9z'
  fs.writeFileSync(path.join(ud, 'artwork', `${id}.jpg`), 'CACHEDART')
  const r = await fetch(`${base}/api/fetch-album-art`, {
    method: 'POST',
    headers: { ...authed.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ albumId: id, artist: 'Tester', album: 'Fixture' }),
  })
  assert.strictEqual(r.status, 200)
})

test('the token file is not world-readable', async () => {
  const mode = fs.statSync(path.join(ud, 'bridge-token')).mode & 0o777
  assert.strictEqual(mode, 0o600, `bridge-token is ${mode.toString(8)}; any local account could pair`)
})

test('a wrong token is refused whatever its length (constant-time compare)', async () => {
  // The observable contract of the timingSafeEqual switch: every wrong token
  // is refused identically, including one that shares a long prefix with the
  // real one and one of a different length.
  const nearMiss = TOKEN.slice(0, 31) + (TOKEN[31] === '0' ? '1' : '0')
  for (const bad of [nearMiss, TOKEN + 'ff', TOKEN.slice(0, 8), '']) {
    const r = await fetch(`${base}/api/folders`, {
      headers: { Authorization: `Bearer ${bad}` },
    })
    assert.strictEqual(r.status, 401, `token "${bad.slice(0, 8)}…" was accepted`)
    await r.text()
  }
  // The control: the real token still works.
  assert.strictEqual((await fetch(`${base}/api/folders`, authed)).status, 200)
})

// ── M7. An upstream slskd failure must not be reported as success ─────────────
// slskFetch never looked at res.ok, so a 400 on a DELETE became {ok:true} (the
// cancel the phone thinks stuck and which never stuck), a 400 on a POST became
// a download that was never queued, and a 500 on a GET became an empty
// transfers list that reads as "nothing is downloading".
//
// These run against a LOCAL STUB, never the user's real slskd on :5030.

const http = require('http')

// A stand-in slskd. `plan` maps a path prefix to the status (and body) to
// answer with, so one test can make the daemon fail on demand.
function slskdStub(plan) {
  const seen = []
  const srv = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    if (req.url.startsWith('/api/v0/session')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ token: 'stub-token' }))
    }
    const hit = plan.find(p => req.url.startsWith('/api/v0' + p.path) &&
      (!p.method || p.method === req.method))
    if (!hit) { res.writeHead(404); return res.end('{}') }
    res.writeHead(hit.status, { 'Content-Type': 'application/json' })
    res.end(typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body ?? {}))
  })
  return new Promise(resolve => {
    srv.listen(0, '127.0.0.1', () => resolve({
      srv, seen, url: `http://127.0.0.1:${srv.address().port}/api/v0`,
    }))
  })
}

async function withStubbedSlskd(plan, fn) {
  const stub = await slskdStub(plan)
  const { proc, base: b } = await boot({ BRIDGE_SLSKD_BASE: stub.url })
  try { await fn(b, stub) } finally {
    proc.kill('SIGKILL')
    await new Promise(r => stub.srv.close(r))
  }
}

test('a 400 from slskd on a cancel is reported, not answered {ok:true}', async () => {
  await withStubbedSlskd(
    [{ path: '/transfers/downloads/', method: 'DELETE', status: 400, body: { message: 'no such transfer' } }],
    async (b) => {
      const r = await fetch(`${b}/api/slsk/transfers/peer/abc`, { method: 'DELETE', ...authed })
      assert.strictEqual(r.status, 502, 'a failed cancel was reported as a successful one')
      const body = await r.json()
      assert.strictEqual(body.upstreamStatus, 400)
    })
})

test('a 400 from slskd on a download is reported, not answered {ok:true}', async () => {
  await withStubbedSlskd(
    [{ path: '/transfers/downloads/', method: 'POST', status: 400, body: { message: 'bad request' } }],
    async (b) => {
      const r = await fetch(`${b}/api/slsk/download`, {
        method: 'POST',
        headers: { ...authed.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'peer', filename: 'x.flac', size: 1 }),
      })
      assert.strictEqual(r.status, 502, 'a download that was never queued reported ok')
      assert.strictEqual((await r.json()).upstreamStatus, 400)
    })
})

test('a 500 from slskd on the transfer list is an error, not an empty list', async () => {
  await withStubbedSlskd(
    [{ path: '/transfers/downloads', method: 'GET', status: 500, body: { message: 'boom' } }],
    async (b) => {
      const r = await fetch(`${b}/api/slsk/transfers`, authed)
      assert.strictEqual(r.status, 502, '"slskd is broken" was indistinguishable from "nothing is downloading"')
      assert.strictEqual((await r.json()).upstreamStatus, 500)
    })
})

test('a healthy slskd still yields a flat transfer list and an active count', async () => {
  // The control. It also pins the SHAPE: the Android Transfer type is a flat
  // file record, and the raw nested users->directories->files array slskd
  // returns filtered down to nothing on every screen that read it.
  const downloads = [{
    username: 'peer',
    directories: [{
      directory: 'Album',
      files: [
        { id: 'f1', filename: 'Album\\01.flac', size: 100, bytesTransferred: 50, state: 'InProgress' },
        { id: 'f2', filename: 'Album\\02.flac', size: 100, bytesTransferred: 100, state: 'Completed, Succeeded' },
        { id: 'f3', filename: 'Album\\03.flac', size: 100, bytesTransferred: 0, state: 'Queued, Remotely' },
      ],
    }],
  }]
  await withStubbedSlskd(
    [{ path: '/transfers/downloads', method: 'GET', status: 200, body: downloads }],
    async (b) => {
      const list = await (await fetch(`${b}/api/slsk/transfers`, authed)).json()
      assert.strictEqual(list.length, 3)
      assert.deepStrictEqual(Object.keys(list[0]).sort(), [
        'averageSpeed', 'bytesTransferred', 'elapsed', 'filename', 'id',
        'remainingTime', 'size', 'state', 'username',
      ])
      assert.strictEqual(list[0].username, 'peer')

      const count = await (await fetch(`${b}/api/slsk/active-count`, authed)).json()
      assert.strictEqual(count.count, 2, 'the badge count must match the tab’s own isActive filter')
    })
})

test('/api/slsk/active-count exists (the phone was getting a 404 and showing 0)', async () => {
  await withStubbedSlskd(
    [{ path: '/transfers/downloads', method: 'GET', status: 200, body: [] }],
    async (b) => {
      const r = await fetch(`${b}/api/slsk/active-count`, authed)
      assert.strictEqual(r.status, 200)
      assert.deepStrictEqual(await r.json(), { count: 0 })
    })
})

test('/api/library/delete-file exists and refuses honestly rather than 404-ing', async () => {
  const r = await fetch(`${base}/api/library/delete-file`, {
    method: 'POST',
    headers: { ...authed.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: F.track }),
  })
  assert.strictEqual(r.status, 501, 'the route must exist and say why it cannot act')
  const body = await r.json()
  assert.strictEqual(body.ok, false)
  assert.match(body.error, /desktop/i)
  // The critical part: it must NOT have deleted the file behind the trash's back.
  assert.ok(fs.existsSync(F.track), 'the bridge unlinked a library file')
})

// ── L5. Operational sharp edges ───────────────────────────────────────────────

test('thumbnails and stream ranges are not rate-limited; API calls still are', async () => {
  const LIMIT = 3
  const { proc, base: b } = await boot({ BRIDGE_RATE_LIMIT_MAX: String(LIMIT) })
  try {
    // A library screen with 245 albums is 245 art requests in a burst. Every
    // one past the 60th came back as a JSON 429 into an <Image>.
    for (let i = 0; i < LIMIT * 4; i++) {
      const r = await fetch(`${b}/art/alb1.jpg?token=${TOKEN}`)
      assert.strictEqual(r.status, 200, `art request ${i + 1} was rate-limited`)
      await r.text()
    }
    // Same for the range requests a single seek produces.
    for (let i = 0; i < LIMIT * 4; i++) {
      const r = await fetch(`${b}/stream/t1?token=${TOKEN}`, { headers: { Range: 'bytes=0-1' } })
      assert.strictEqual(r.status, 206, `range request ${i + 1} was rate-limited`)
      await r.text()
    }
    // The control: the limiter is still doing its job on the API surface.
    const statuses = []
    for (let i = 0; i <= LIMIT; i++) {
      const r = await fetch(`${b}/api/folders`, authed)
      statuses.push(r.status)
      await r.text()
    }
    assert.strictEqual(statuses[LIMIT], 429, `the API limiter stopped working: ${statuses}`)
  } finally { proc.kill('SIGKILL') }
})

test('a port already in use exits once with a clear reason, not a crash loop', async () => {
  const first = await boot()
  const port = new URL(first.base).port
  try {
    const clash = spawn(process.execPath, [SERVER], {
      cwd: path.dirname(SERVER),
      env: { ...process.env, BRIDGE_PORT: port, BRIDGE_HOST: '127.0.0.1', PAPA_BRIDGE_USER_DATA: ud },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    spawned.push(clash)
    let err = ''
    clash.stderr.on('data', d => { err += d.toString() })
    clash.stdout.on('data', () => {})
    const code = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the clashing bridge never exited: ' + err)), 15000)
      clash.on('exit', c => { clearTimeout(t); resolve(c) })
    })
    assert.strictEqual(code, 1, 'EADDRINUSE must exit non-zero, not throw an uncaught error')
    assert.match(err, /already in use/i, `no plain reason in stderr: ${err.slice(0, 300)}`)
    assert.doesNotMatch(err, /UnhandledPromiseRejection|at Server\.emit/,
      'the failure is still an uncaught exception rather than a handled one')
  } finally { first.proc.kill('SIGKILL') }
})

test('SIGTERM shuts the bridge down instead of leaving timers holding the loop', async () => {
  const { proc } = await boot()
  const exited = new Promise(resolve => proc.on('exit', () => resolve(true)))
  // Well inside the server's own 5s force-exit backstop: the point is that the
  // loop DRAINS, not that the backstop eventually fires.
  const timedOut = new Promise(resolve => setTimeout(() => resolve(false), 3000).unref())
  proc.kill('SIGTERM')
  const clean = await Promise.race([exited, timedOut])
  assert.ok(clean, 'the process was still alive 3s after SIGTERM — an interval is holding the event loop')
})

// ── yt-dlp: one resolve per videoId, one download per videoId ────────────────

test('concurrent stream requests for one video spawn yt-dlp once, not N times', async () => {
  const { EventEmitter } = require('events')
  const { PassThrough } = require('stream')
  const registerYouTube = require('../bridge-server/youtube')

  // A no-op express stand-in: this exercises the module, not the HTTP layer.
  const routes = {}
  const fakeApp = {
    get: (p, h) => { routes['GET ' + p] = h },
    post: (p, h) => { routes['POST ' + p] = h },
  }
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-yt-'))
  const yt = registerYouTube(fakeApp, {
    sseSend() {}, getDownloadDir: () => cacheDir, cacheDir, scheduleRescan() {},
  })

  let spawns = 0
  yt._setSpawn(() => {
    spawns++
    const proc = new EventEmitter()
    proc.stdout = new PassThrough()
    proc.stderr = new PassThrough()
    proc.kill = () => {}
    setTimeout(() => {
      proc.stdout.end('https://example.invalid/audio\n')
      proc.emit('close', 0)
    }, 40)
    return proc
  })

  try {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => yt.resolveAudioUrl('VID1')))
    assert.strictEqual(spawns, 1, `six concurrent range requests spawned ${spawns} yt-dlp processes`)
    for (const r of results) assert.deepStrictEqual(r, { ok: true, url: 'https://example.invalid/audio' })
    assert.strictEqual(yt._inflight.size, 0, 'the in-flight entry was never cleared')
  } finally {
    yt._setSpawn(null)
    fs.rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('a failed resolve is retryable (the in-flight entry is cleared either way)', async () => {
  const { EventEmitter } = require('events')
  const { PassThrough } = require('stream')
  const registerYouTube = require('../bridge-server/youtube')
  const fakeApp = { get() {}, post() {} }
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-yt-'))
  const yt = registerYouTube(fakeApp, {
    sseSend() {}, getDownloadDir: () => cacheDir, cacheDir, scheduleRescan() {},
  })
  let spawns = 0
  yt._setSpawn(() => {
    spawns++
    const proc = new EventEmitter()
    proc.stdout = new PassThrough()
    proc.stderr = new PassThrough()
    proc.kill = () => {}
    setTimeout(() => { proc.stderr.end('nope'); proc.stdout.end(''); proc.emit('close', 1) }, 20)
    return proc
  })
  try {
    const a = await yt.resolveAudioUrl('VID2')
    assert.strictEqual(a.ok, false)
    const b = await yt.resolveAudioUrl('VID2')
    assert.strictEqual(b.ok, false)
    assert.strictEqual(spawns, 2, 'a failed resolve was cached as in-flight and never retried')
  } finally {
    yt._setSpawn(null)
    fs.rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('a second download request for the same video does not start a second yt-dlp', async () => {
  const registerYouTube = require('../bridge-server/youtube')
  const routes = {}
  const fakeApp = {
    get: (p, h) => { routes['GET ' + p] = h },
    post: (p, h) => { routes['POST ' + p] = h },
  }
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-yt-'))
  const yt = registerYouTube(fakeApp, {
    sseSend() {}, getDownloadDir: () => cacheDir, cacheDir, scheduleRescan() {},
  })
  try {
    // Put the videoId in the state the route checks: already downloading.
    yt.ytDownloads.set('VID3', {
      videoId: 'VID3', title: 'T', artist: '', pct: 42, state: 'downloading', at: Date.now(),
    })
    let status = 0, payload = null
    const res = {
      status(c) { status = c; return this },
      json(b) { payload = b; return this },
    }
    await routes['POST /api/youtube/download']({ body: { videoId: 'VID3' } }, res)
    assert.strictEqual(status, 202, 'a duplicate download request started a second yt-dlp on the same file')
    assert.strictEqual(payload.alreadyDownloading, true)
    assert.strictEqual(payload.pct, 42)
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true })
  }
})
