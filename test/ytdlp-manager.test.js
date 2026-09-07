'use strict'
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const fs = require('fs')
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')

const m = require('../src/ytdlp-manager')
const { MpvEngine } = require('../mpv-engine')
const { VideoEngine } = require('../video-engine')

const DAY = 24 * 60 * 60 * 1000

// ── Discovery order ──────────────────────────────────────────────────────────

test('candidatePaths puts ~/.local/bin first, /usr/bin next, PATH last', () => {
  const c = m.candidatePaths('/home/u')
  assert.deepStrictEqual(c, [
    path.join('/home/u', '.local', 'bin', 'yt-dlp'),
    '/usr/bin/yt-dlp',
    'yt-dlp',
  ])
})

test('pickBinary chooses ~/.local/bin when it exists', () => {
  const c = m.candidatePaths('/home/u')
  const local = c[0]
  const picked = m.pickBinary(c, p => p === local)
  assert.strictEqual(picked, local)
})

test('pickBinary falls through to /usr/bin when only that exists', () => {
  const c = m.candidatePaths('/home/u')
  const picked = m.pickBinary(c, p => p === '/usr/bin/yt-dlp')
  assert.strictEqual(picked, '/usr/bin/yt-dlp')
})

test('pickBinary falls back to the bare PATH name when nothing on disk', () => {
  const c = m.candidatePaths('/home/u')
  const picked = m.pickBinary(c, () => false)
  assert.strictEqual(picked, 'yt-dlp')
})

test('YtdlpManager.binaryPath uses the injected existence check and home', () => {
  const local = path.join('/home/u', '.local', 'bin', 'yt-dlp')
  const mgr = new m.YtdlpManager({ homeDir: '/home/u', existsFn: p => p === local })
  assert.strictEqual(mgr.binaryPath(), local)
})

// ── Version parsing ──────────────────────────────────────────────────────────

test('parseVersionDate reads yt-dlp date versions as UTC timestamps', () => {
  assert.strictEqual(m.parseVersionDate('2026.08.19'), Date.UTC(2026, 7, 19))
  // A trailing build suffix is tolerated.
  assert.strictEqual(m.parseVersionDate('2026.08.19.123456'), Date.UTC(2026, 7, 19))
})

test('parseVersionDate returns null for junk and impossible dates', () => {
  assert.strictEqual(m.parseVersionDate(''), null)
  assert.strictEqual(m.parseVersionDate('unknown'), null)
  assert.strictEqual(m.parseVersionDate('2026.13.40'), null)
  assert.strictEqual(m.parseVersionDate(null), null)
})

// ── Staleness policy ─────────────────────────────────────────────────────────

test('isUpdateDue: a fresh version that passes the probe is not due', () => {
  const now = Date.UTC(2026, 7, 20)
  const r = m.isUpdateDue({ versionDate: Date.UTC(2026, 7, 19), probeOk: true, now })
  assert.deepStrictEqual(r, { due: false, reason: 'fresh' })
})

test('isUpdateDue: a version older than 21 days is due even if it resolves', () => {
  const versionDate = Date.UTC(2026, 6, 1)
  const now = versionDate + 22 * DAY
  const r = m.isUpdateDue({ versionDate, probeOk: true, now })
  assert.strictEqual(r.due, true)
  assert.strictEqual(r.reason, 'version-stale')
})

test('isUpdateDue: exactly at the 21-day boundary is due', () => {
  const versionDate = Date.UTC(2026, 6, 1)
  const now = versionDate + 21 * DAY
  assert.strictEqual(m.isUpdateDue({ versionDate, probeOk: true, now }).due, true)
})

test('isUpdateDue: one day short of 21 is not due', () => {
  const versionDate = Date.UTC(2026, 6, 1)
  const now = versionDate + 20 * DAY
  assert.strictEqual(m.isUpdateDue({ versionDate, probeOk: true, now }).due, false)
})

test('isUpdateDue: a probe failure forces an update regardless of age', () => {
  const now = Date.UTC(2026, 7, 20)
  const r = m.isUpdateDue({ versionDate: now, probeOk: false, now })
  assert.deepStrictEqual(r, { due: true, reason: 'health-check-failed' })
})

test('isUpdateDue: an unknown version is treated as due', () => {
  const now = Date.UTC(2026, 7, 20)
  const r = m.isUpdateDue({ versionDate: null, probeOk: true, now })
  assert.deepStrictEqual(r, { due: true, reason: 'version-unknown' })
})

test('isUpdateDue: a custom staleAfterDays is honoured', () => {
  const versionDate = Date.UTC(2026, 6, 1)
  const now = versionDate + 8 * DAY
  assert.strictEqual(m.isUpdateDue({ versionDate, probeOk: true, now, staleAfterDays: 7 }).due, true)
  assert.strictEqual(m.isUpdateDue({ versionDate, probeOk: true, now, staleAfterDays: 30 }).due, false)
})

// ── Throttle: scheduled auto-check ───────────────────────────────────────────

test('shouldAutoCheck: a never-checked binary is always due', () => {
  assert.strictEqual(m.shouldAutoCheck({ lastCheckAt: 0, now: Date.now() }), true)
  assert.strictEqual(m.shouldAutoCheck({ lastCheckAt: null, now: Date.now() }), true)
})

test('shouldAutoCheck: within the interval is throttled, past it is due', () => {
  const now = 10 * DAY
  // Default interval is 3 days.
  assert.strictEqual(m.shouldAutoCheck({ lastCheckAt: now - 2 * DAY, now }), false)
  assert.strictEqual(m.shouldAutoCheck({ lastCheckAt: now - 3 * DAY, now }), true)
  assert.strictEqual(m.shouldAutoCheck({ lastCheckAt: now - 4 * DAY, now }), true)
})

// ── Cap: playback-error immediate update ─────────────────────────────────────

test('canImmediateUpdate: never-updated is allowed, then capped to once a day', () => {
  const now = 10 * DAY
  assert.strictEqual(m.canImmediateUpdate({ lastUpdateAt: 0, now }), true)
  assert.strictEqual(m.canImmediateUpdate({ lastUpdateAt: now - 1000, now }), false)
  assert.strictEqual(m.canImmediateUpdate({ lastUpdateAt: now - 23 * 60 * 60 * 1000, now }), false)
  assert.strictEqual(m.canImmediateUpdate({ lastUpdateAt: now - DAY, now }), true)
})

// ── Spawn-arg construction (pure) ────────────────────────────────────────────

test('versionArgs is just --version', () => {
  assert.deepStrictEqual(m.versionArgs(), ['--version'])
})

test('probeArgs is a simulate + get-url resolve of the stable probe id', () => {
  const a = m.probeArgs()
  assert.ok(a.includes('--simulate'), 'must simulate, never download')
  assert.ok(a.includes('--get-url'), 'must ask for the resolved URL')
  assert.ok(a.includes('--no-playlist'))
  assert.strictEqual(a[a.length - 1], m.PROBE_VIDEO_ID)
  // The `--` separator guards a video id that starts with a dash.
  assert.ok(a.includes('--'))
})

test('probeArgs accepts a custom video id', () => {
  const a = m.probeArgs('abc12345678')
  assert.strictEqual(a[a.length - 1], 'abc12345678')
})

test('updateArgs is exactly pip install --user --upgrade yt-dlp', () => {
  const [bin, args] = m.updateArgs('pip3')
  assert.strictEqual(bin, 'pip3')
  assert.deepStrictEqual(args, ['install', '--user', '--upgrade', 'yt-dlp'])
})

// ── mpv option form ──────────────────────────────────────────────────────────

test('ytdlPathArg produces the documented ytdl_hook script-opt', () => {
  assert.strictEqual(
    m.ytdlPathArg('/home/u/.local/bin/yt-dlp'),
    '--script-opts-append=ytdl_hook-ytdl_path=/home/u/.local/bin/yt-dlp')
})

test('ytdlPathArg uses -append, not the clobbering --script-opts', () => {
  const arg = m.ytdlPathArg('/x/yt-dlp')
  assert.ok(arg.startsWith('--script-opts-append='),
    'must append so any other script-opt survives')
  assert.ok(!/^--script-opts=/.test(arg))
})

test('ytdlPathArg returns null when no path is given', () => {
  assert.strictEqual(m.ytdlPathArg(null), null)
  assert.strictEqual(m.ytdlPathArg(''), null)
  assert.strictEqual(m.ytdlPathArg(undefined), null)
})

// ── Engine spawn args carry the pinned yt-dlp ────────────────────────────────

test('MpvEngine._args pins ytdl_hook to the configured yt-dlp', () => {
  const eng = new MpvEngine({ config: { ytdlPath: '/home/u/.local/bin/yt-dlp' } })
  const a = eng._args('/tmp/sock')
  assert.ok(a.includes('--script-opts-append=ytdl_hook-ytdl_path=/home/u/.local/bin/yt-dlp'),
    'music engine must pin the discovered binary')
})

test('MpvEngine._args adds no ytdl_hook opt when no path is set', () => {
  const eng = new MpvEngine({})
  const a = eng._args('/tmp/sock')
  assert.ok(!a.some(x => x.includes('ytdl_hook-ytdl_path')),
    'no path → mpv keeps its own PATH search, no stray opt')
})

test('VideoEngine._args pins ytdl_hook to the configured yt-dlp', () => {
  const eng = new VideoEngine({ config: { ytdlPath: '/usr/bin/yt-dlp' } })
  const a = eng._args('/tmp/sock')
  assert.ok(a.includes('--script-opts-append=ytdl_hook-ytdl_path=/usr/bin/yt-dlp'),
    'video engine must pin the discovered binary too')
})

test('VideoEngine._args adds no ytdl_hook opt when no path is set', () => {
  const eng = new VideoEngine({})
  const a = eng._args('/tmp/sock')
  assert.ok(!a.some(x => x.includes('ytdl_hook-ytdl_path')))
})

test('the pinned opt is a single script-opts-append, not a plain --script-opts', () => {
  // A plain --script-opts=… would wipe any script-opt mpv already had; the whole
  // point of -append is that it does not. Neither engine may emit the plain form
  // for this.
  for (const eng of [
    new MpvEngine({ config: { ytdlPath: '/x/yt-dlp' } }),
    new VideoEngine({ config: { ytdlPath: '/x/yt-dlp' } }),
  ]) {
    const a = eng._args('/tmp/sock')
    assert.ok(!a.some(x => /^--script-opts=ytdl_hook/.test(x)),
      'must never use the clobbering --script-opts= form')
    const appends = a.filter(x => x.includes('ytdl_hook-ytdl_path'))
    assert.strictEqual(appends.length, 1, 'exactly one pin, no duplicates')
  }
})

// ── Exec layer: real spawn seam, fake process ────────────────────────────────

function fakeProc({ code = 0, stdout = '', stderr = '', errorEvent = null } = {}) {
  const proc = new EventEmitter()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.kill = () => {}
  setImmediate(() => {
    if (errorEvent) { proc.emit('error', errorEvent); return }
    if (stdout) proc.stdout.write(stdout)
    if (stderr) proc.stderr.write(stderr)
    proc.stdout.end()
    proc.stderr.end()
    proc.emit('close', code)
  })
  return proc
}

test('readVersion parses the first line and dates it', async () => {
  const mgr = new m.YtdlpManager({
    existsFn: () => true,
    spawnFn: () => fakeProc({ code: 0, stdout: '2026.08.19\n' }),
  })
  const r = await mgr.readVersion()
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.version, '2026.08.19')
  assert.strictEqual(r.versionDate, Date.UTC(2026, 7, 19))
})

test('readVersion reports failure when yt-dlp exits non-zero', async () => {
  const mgr = new m.YtdlpManager({
    existsFn: () => true,
    spawnFn: () => fakeProc({ code: 1, stderr: 'boom' }),
  })
  const r = await mgr.readVersion()
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.version, null)
  assert.strictEqual(r.versionDate, null)
})

test('probe succeeds only when a real URL comes back', async () => {
  const ok = new m.YtdlpManager({
    existsFn: () => true,
    spawnFn: () => fakeProc({ code: 0, stdout: 'https://rr3---googlevideo.com/x\n' }),
  })
  assert.strictEqual((await ok.probe()).ok, true)

  // Exit 0 but no URL (partial breakage) is not a healthy resolve.
  const bad = new m.YtdlpManager({
    existsFn: () => true,
    spawnFn: () => fakeProc({ code: 0, stdout: 'nothing useful\n' }),
  })
  assert.strictEqual((await bad.probe()).ok, false)
})

test('update refuses and never spawns when pip is absent', async () => {
  let spawned = false
  const mgr = new m.YtdlpManager({
    pipBinary: null,               // feature-detect says: no pip
    spawnFn: () => { spawned = true; return fakeProc({}) },
  })
  const r = await mgr.update()
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.unavailable, true)
  assert.strictEqual(spawned, false, 'must not spawn pip when there is no pip')
})

test('update runs pip install --user --upgrade yt-dlp when pip is present', async () => {
  const calls = []
  const mgr = new m.YtdlpManager({
    pipBinary: 'pip3',
    spawnFn: (bin, args) => { calls.push([bin, args]); return fakeProc({ code: 0, stdout: 'Successfully installed yt-dlp' }) },
  })
  const r = await mgr.update()
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(calls[0], ['pip3', ['install', '--user', '--upgrade', 'yt-dlp']])
})

test('pipAvailable caches the injected value and never spawns for it', async () => {
  let spawned = false
  const mgr = new m.YtdlpManager({ pipBinary: null, spawnFn: () => { spawned = true; return fakeProc({}) } })
  assert.strictEqual(await mgr.pipAvailable(), null)
  assert.strictEqual(spawned, false)
})

// ── Renderer / preload wiring (parsed, like ipc-channel-wiring) ───────────────

const root = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

test('preload exposes the status/update methods and allows the events', () => {
  const preload = root('preload.js')
  assert.match(preload, /ytdlpStatus:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('ytdlp-status'\)/)
  assert.match(preload, /ytdlpUpdateNow:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('ytdlp-update-now'\)/)
  assert.match(preload, /'ytdlp-updated'/)
  assert.match(preload, /'ytdlp-recovered'/)
})

test('main registers the two IPC handlers and schedules the startup check', () => {
  const main = root('main.js')
  assert.match(main, /ipcMain\.handle\('ytdlp-status'/)
  assert.match(main, /ipcMain\.handle\('ytdlp-update-now'/)
  assert.match(main, /_ytdlpAutoCheck\(\)/, 'the startup check must be armed')
})

test('main pins both engines to the discovered yt-dlp', () => {
  const main = root('main.js')
  assert.match(main, /engineConfig\.ytdlPath\s*=\s*ytdlp\.binaryPath\(\)/)
  assert.match(main, /new VideoEngine\(\{ config: \{ ytdlPath: ytdlp\.binaryPath\(\) \} \}\)/)
})
