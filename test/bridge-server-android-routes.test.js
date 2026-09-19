'use strict'

// Executing tests for the three routes the Android app calls that the bridge
// never implemented: /api/app-update (services/appUpdate.ts), /api/loudness
// (services/bridge.ts getLoudness) and /api/crash-log (services/crash.ts).
//
// All three are called inside a try/catch that swallows the failure, so a 404
// was silent on the phone: no update check, no ReplayGain, no crash reports.
// Each test asserts the exact field the phone reads, not a shape of our
// choosing.
//
// Same harness as bridge-server-hardening.test.js: the real server booted as a
// child process on an OS-chosen ephemeral port (BRIDGE_PORT=0), bound to
// loopback, with PAPA_BRIDGE_USER_DATA pointed at a temp tree so it never
// touches ~/.config/papa-audio or the user's live bridge on 8765.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const SERVER = path.join(__dirname, '..', 'bridge-server', 'server.js')
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

let tmp, ud, music, base, child
const spawned = []

const TRACK = () => path.join(music, 'album', '01.flac')

function fixture() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-bridge-routes-'))
  ud = path.join(tmp, 'userdata')
  music = path.join(tmp, 'music')
  fs.mkdirSync(path.join(ud, 'artwork'), { recursive: true })
  fs.mkdirSync(path.join(music, 'album'), { recursive: true })
  fs.writeFileSync(TRACK(), 'REALFLACBYTES')
  fs.writeFileSync(path.join(ud, 'bridge-token'), TOKEN)
  fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({ musicFolders: [music] }))
  // The desktop's ReplayGain measurements, exactly as main.js's loudness scan
  // writes them into loudness-map.json: { filePath: { lufs, gainDb, at } }.
  fs.writeFileSync(path.join(ud, 'loudness-map.json'), JSON.stringify({
    [TRACK()]: { lufs: -9.4, gainDb: -8.6, at: 1 },
  }))
}

// PAPA_BRIDGE_APK_DIR is set on the shared instance too (at an empty dir), so
// nothing in this file can be answered by a real APK sitting in the home
// directory. Host state must never decide a test.
let emptyApkDir

function boot(env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER], {
      cwd: path.dirname(SERVER),
      env: {
        ...process.env,
        BRIDGE_PORT: '0',
        BRIDGE_HOST: '127.0.0.1',
        PAPA_BRIDGE_USER_DATA: ud,
        PAPA_BRIDGE_APK_DIR: emptyApkDir,
        BRIDGE_RATE_LIMIT_MAX: '100000',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    spawned.push(proc)
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
    proc.stderr.on('data', () => {})
    proc.on('error', e => { clearTimeout(timer); reject(e) })
    proc.on('exit', code => {
      clearTimeout(timer)
      reject(new Error(`bridge exited ${code} before listening; stdout: ${out}`))
    })
  })
}

const authed = { headers: { Authorization: `Bearer ${TOKEN}` } }
const postJson = (url, body) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify(body),
})

test.before(async () => {
  fixture()
  emptyApkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-apk-none-'))
  const booted = await boot()
  child = booted.proc
  base = booted.base
})

test.after(() => {
  for (const p of spawned) { try { p.kill('SIGKILL') } catch (_) {} }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) {}
  try { fs.rmSync(emptyApkDir, { recursive: true, force: true }) } catch (_) {}
})

test('the booted bridge is serving the temp fixture, not the real one', async () => {
  const folders = await fetch(`${base}/api/folders`, authed)
  assert.deepStrictEqual(await folders.json(), [music])
})

// ── /api/loudness ────────────────────────────────────────────────────────────
// getLoudness() reads ONE field: `res.data?.gain`, a number in dB it feeds to
// gainDbToLinear(). A non-number is cached as "this file has no measurement"
// and never probed again in that session.

test('/api/loudness returns the desktop gainDb as `gain`', async () => {
  const r = await fetch(`${base}/api/loudness?path=${encodeURIComponent(TRACK())}`, authed)
  assert.strictEqual(r.status, 200)
  const body = await r.json()
  assert.strictEqual(typeof body.gain, 'number',
    'the phone reads res.data.gain as a number; anything else means "no measurement"')
  assert.strictEqual(body.gain, -8.6, 'the gain must be the desktop measured gainDb')
})

test('/api/loudness answers gain:null for a track the desktop never measured', async () => {
  const r = await fetch(`${base}/api/loudness?path=${encodeURIComponent('/nowhere/unmeasured.flac')}`, authed)
  assert.strictEqual(r.status, 200)
  assert.strictEqual((await r.json()).gain, null,
    'an unmeasured track must be an honest null, not an invented 0')
})

test('/api/loudness sees a new desktop measurement without a bridge restart', async () => {
  const other = path.join(music, 'album', '02.flac')
  const before = await (await fetch(`${base}/api/loudness?path=${encodeURIComponent(other)}`, authed)).json()
  assert.strictEqual(before.gain, null)
  // The desktop scans it while the bridge is running.
  fs.writeFileSync(path.join(ud, 'loudness-map.json'), JSON.stringify({
    [TRACK()]: { lufs: -9.4, gainDb: -8.6, at: 1 },
    [other]:   { lufs: -14.2, gainDb: -3.8, at: 2 },
  }))
  const after = await (await fetch(`${base}/api/loudness?path=${encodeURIComponent(other)}`, authed)).json()
  assert.strictEqual(after.gain, -3.8,
    'the reader cached the map for the life of the process; a systemd bridge never restarts')
})

test('/api/loudness needs a path and needs the token', async () => {
  assert.strictEqual((await fetch(`${base}/api/loudness`, authed)).status, 400)
  assert.strictEqual((await fetch(`${base}/api/loudness?path=/x.flac`)).status, 401)
})

// ── /api/settings/play-history ───────────────────────────────────────────────
// The phone posts `playedAt` (hooks/usePlayer.ts) and filters Stats on it
// (app/stats.tsx). The desktop reads `ts`, and ../history.js quarantines any
// entry with neither `ts` nor `timestamp` — so a phone play was queued, then
// set aside on the desktop's next pass. Both names have to be on the entry.

const { normaliseHistory } = require('../history')

test('a phone play is stamped with `ts`, so the desktop does not quarantine it', async () => {
  const playedAt = Date.now() - 60000
  const r = await postJson(`${base}/api/settings/play-history`, {
    filePath: TRACK(), artist: 'Tester', title: 'Fixture', playedAt,
  })
  assert.strictEqual(r.status, 202)

  // Read the queued op the way the desktop's ingester does — out of the inbox
  // file, not out of a shape of the test's choosing.
  const queued = JSON.parse(fs.readFileSync(path.join(ud, 'bridge-inbox.json'), 'utf8'))
  const op = queued.ops.filter(o => o.type === 'playHistory.push').pop()
  assert.ok(op, 'the play was never queued at all')
  assert.strictEqual(op.payload.entry.ts, playedAt,
    'the desktop reads `ts`; the phone never sends one')
  assert.strictEqual(op.payload.entry.playedAt, playedAt,
    '`playedAt` must survive — the phone Stats screen filters on it')

  // The actual consequence, through the desktop's own normaliser: a quarantine
  // here is 100% of the phone's listening history disappearing.
  const norm = normaliseHistory([op.payload.entry])
  assert.strictEqual(norm.quarantined.length, 0,
    `the desktop set the entry aside: ${JSON.stringify(norm.quarantined)}`)
  assert.strictEqual(norm.entries[0].ts, playedAt)
})

test('an entry with no usable playedAt still gets a time rather than being dropped', async () => {
  const before = Date.now()
  await postJson(`${base}/api/settings/play-history`, { filePath: TRACK(), title: 'No time' })
  const queued = JSON.parse(fs.readFileSync(path.join(ud, 'bridge-inbox.json'), 'utf8'))
  const op = queued.ops.filter(o => o.type === 'playHistory.push').pop()
  assert.strictEqual(op.payload.entry.title, 'No time')
  assert.ok(op.payload.entry.ts >= before, 'a missing playedAt must become now, not NaN')
  assert.strictEqual(normaliseHistory([op.payload.entry]).quarantined.length, 0)
})

test('GET play-history carries `playedAt` for entries the DESKTOP wrote', async () => {
  // The desktop's own file: `ts` only, which is what main.js writes. The
  // phone's Stats screen filters `h.playedAt >= week` — undefined >= week is
  // false, so a desktop-written history read as zero plays.
  fs.writeFileSync(path.join(ud, 'play-history.json'), JSON.stringify([
    { filePath: TRACK(), title: 'From the desktop', ts: 1700000000000 },
  ]))
  const list = await (await fetch(`${base}/api/settings/play-history`, authed)).json()
  const desktopEntry = list.find(e => e && e.title === 'From the desktop')
  assert.ok(desktopEntry, 'the desktop entry did not reach the phone at all')
  assert.strictEqual(desktopEntry.playedAt, 1700000000000,
    'app/stats.tsx filters on playedAt; a desktop entry has only ts')
  assert.strictEqual(desktopEntry.ts, 1700000000000, '`ts` must not be replaced')
})

// ── /api/crash-log ───────────────────────────────────────────────────────────
// crash.ts POSTs and `.catch(() => {})` the result: it parses nothing, so the
// contract is "accepted, and the report is on disk where it can be read".

test('/api/crash-log writes the phone report to its own log file', async () => {
  const logFile = path.join(ud, 'phone-crash-log.txt')
  try { fs.unlinkSync(logFile) } catch (_) {}
  const report = {
    context: 'global', isFatal: true, message: 'Cannot read property id of undefined',
    stack: 'at Library.tsx:44', appVersion: 'v22 (22)', at: '2026-09-19T10:00:00.000Z',
  }
  const r = await postJson(`${base}/api/crash-log`, report)
  assert.strictEqual(r.status, 200)
  assert.strictEqual((await r.json()).ok, true)

  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n')
  assert.strictEqual(lines.length, 1, 'one report should be one line')
  const stored = JSON.parse(lines[0])
  assert.strictEqual(stored.message, report.message)
  assert.strictEqual(stored.context, 'global')
  assert.strictEqual(stored.isFatal, true)
  assert.strictEqual(stored.stack, 'at Library.tsx:44')
  assert.strictEqual(stored.appVersion, 'v22 (22)')
  assert.strictEqual(stored.source, 'phone')
  assert.ok(stored.receivedAt, 'the bridge must record when it saw the report')

  // The desktop's own crash log has exactly one writer, main.js's
  // _appendCrashLog. The bridge must not become a second one.
  assert.strictEqual(fs.existsSync(path.join(ud, 'app-crashes.log')), false,
    'the bridge wrote into the desktop crash log')
})

test('/api/crash-log appends rather than replacing, and rotates at 1 MB', async () => {
  const logFile = path.join(ud, 'phone-crash-log.txt')
  const rotated = `${logFile}.1`
  try { fs.unlinkSync(rotated) } catch (_) {}
  // Just under the cap, so the next report has to trip the rotation.
  fs.writeFileSync(logFile, 'x'.repeat(1024 * 1024 - 10) + '\n')

  assert.strictEqual((await postJson(`${base}/api/crash-log`,
    { context: 'scan-report', albums: 245 })).status, 200)

  assert.ok(fs.existsSync(rotated), 'the oversized log was not rotated aside')
  const now = fs.readFileSync(logFile, 'utf8').trim().split('\n')
  assert.strictEqual(now.length, 1, 'the fresh log should hold only the new report')
  assert.strictEqual(JSON.parse(now[0]).context, 'scan-report')
  assert.ok(fs.statSync(logFile).size < 1024 * 1024, 'the live log stayed over the cap')

  // And a second report goes after the first, not over it.
  assert.strictEqual((await postJson(`${base}/api/crash-log`,
    { context: 'view-report', tracks: 3 })).status, 200)
  const two = fs.readFileSync(logFile, 'utf8').trim().split('\n')
  assert.strictEqual(two.length, 2, 'the second report replaced the first instead of appending')
  assert.strictEqual(JSON.parse(two[0]).context, 'scan-report')
  assert.strictEqual(JSON.parse(two[1]).context, 'view-report')
})

test('/api/crash-log needs the token', async () => {
  const r = await fetch(`${base}/api/crash-log`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
  assert.strictEqual(r.status, 401)
})

// ── /api/app-update ──────────────────────────────────────────────────────────
// findUpdate() takes res.data straight through and rejects it unless
// `typeof info.versionCode === 'number'`. When it is newer, UpdateBanner renders
// info.versionName and info.notes and downloads base + info.url with ?token=
// appended, as a plain URL with no headers.

test('/api/app-update advertises a published APK in the shape the phone parses', async () => {
  const apkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-apk-'))
  fs.writeFileSync(path.join(apkDir, 'version.json'), JSON.stringify({
    versionCode: 23, versionName: 'v23', notes: 'Local songs actually play now',
  }))
  fs.writeFileSync(path.join(apkDir, 'latest.apk'), 'PKFAKE-APK-BYTES')
  const booted = await boot({ PAPA_BRIDGE_APK_DIR: apkDir })
  try {
    const r = await fetch(`${booted.base}/api/app-update`, authed)
    assert.strictEqual(r.status, 200)
    const info = await r.json()
    assert.strictEqual(typeof info.versionCode, 'number',
      'findUpdate() drops anything without a numeric top-level versionCode')
    assert.strictEqual(info.versionCode, 23)
    assert.strictEqual(info.versionName, 'v23')
    assert.strictEqual(info.notes, 'Local songs actually play now')
    assert.strictEqual(typeof info.url, 'string')
    assert.ok(info.url.startsWith('/'),
      'url is appended to the bridge base, so it must be a path')

    // The download the banner actually performs: a plain URL carrying ?token=,
    // no headers, because expo-file-system cannot attach any.
    const apk = await fetch(`${booted.base}${info.url}?token=${TOKEN}`)
    assert.strictEqual(apk.status, 200, 'the APK download must accept the query token')
    assert.match(apk.headers.get('content-type') || '', /android\.package-archive/)
    assert.strictEqual(await apk.text(), 'PKFAKE-APK-BYTES')

    assert.strictEqual((await fetch(`${booted.base}${info.url}`)).status, 401,
      'the APK must still need the token')
  } finally {
    try { booted.proc.kill('SIGKILL') } catch (_) {}
    fs.rmSync(apkDir, { recursive: true, force: true })
  }
})

test('/api/app-update invents nothing when no APK has been published', async () => {
  const r = await fetch(`${base}/api/app-update`, authed)
  assert.strictEqual(r.status, 200, 'a missing feed is not an error the phone should retry')
  const body = await r.json()
  assert.strictEqual(body.update, null)
  assert.strictEqual(body.versionCode, undefined,
    'no versionCode means findUpdate() returns null, which is the honest answer')
  assert.ok(typeof body.reason === 'string' && body.reason.length,
    'the endpoint must say WHY there is nothing, for a human reading it')
  assert.strictEqual((await fetch(`${base}/api/app-update/apk?token=${TOKEN}`)).status, 404)
})

test('/api/app-update refuses to advertise a manifest with no APK beside it', async () => {
  const apkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-apk-orphan-'))
  fs.writeFileSync(path.join(apkDir, 'version.json'),
    JSON.stringify({ versionCode: 99, versionName: 'v99' }))
  const booted = await boot({ PAPA_BRIDGE_APK_DIR: apkDir })
  try {
    const body = await (await fetch(`${booted.base}/api/app-update`, authed)).json()
    assert.strictEqual(body.versionCode, undefined,
      'advertising a version whose APK is missing sends the phone to a 404 download')
    assert.strictEqual(body.update, null)
  } finally {
    try { booted.proc.kill('SIGKILL') } catch (_) {}
    fs.rmSync(apkDir, { recursive: true, force: true })
  }
})

test('/api/app-update needs the token', async () => {
  assert.strictEqual((await fetch(`${base}/api/app-update`)).status, 401)
})
