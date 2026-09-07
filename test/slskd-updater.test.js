'use strict'
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const fs = require('fs')
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')

const m = require('../src/slskd-updater')

const DAY = 24 * 60 * 60 * 1000

// ── Version parsing ──────────────────────────────────────────────────────────

test('parseVersion normalises major.minor.patch and drops build suffixes', () => {
  assert.strictEqual(m.parseVersion('0.22.3'), '0.22.3')
  assert.strictEqual(m.parseVersion('slskd 0.22.3'), '0.22.3')
  assert.strictEqual(m.parseVersion('0.22.3+abc1234'), '0.22.3')
  assert.strictEqual(m.parseVersion('v0.22.3'), '0.22.3')
})

test('parseVersion returns null for junk', () => {
  assert.strictEqual(m.parseVersion(''), null)
  assert.strictEqual(m.parseVersion('unknown'), null)
  assert.strictEqual(m.parseVersion(null), null)
})

test('versionFromApplication reads flat and nested shapes', () => {
  assert.strictEqual(m.versionFromApplication({ version: '0.22.3' }), '0.22.3')
  assert.strictEqual(m.versionFromApplication({ version: { full: '0.22.3+x' } }), '0.22.3')
  assert.strictEqual(m.versionFromApplication({ versionString: '0.22.3' }), '0.22.3')
  assert.strictEqual(m.versionFromApplication({ build: { version: '0.22.3' } }), '0.22.3')
  assert.strictEqual(m.versionFromApplication(null), null)
  assert.strictEqual(m.versionFromApplication({}), null)
})

// ── Semver compare ───────────────────────────────────────────────────────────

test('compareVersions orders correctly and 0 on junk', () => {
  assert.strictEqual(m.compareVersions('0.22.3', '0.22.2'), 1)
  assert.strictEqual(m.compareVersions('0.22.2', '0.22.3'), -1)
  assert.strictEqual(m.compareVersions('1.0.0', '0.99.99'), 1)
  assert.strictEqual(m.compareVersions('0.22.3', '0.22.3'), 0)
  assert.strictEqual(m.compareVersions('junk', '0.22.3'), 0)
})

test('isNewer is strict and false on unparseable', () => {
  assert.strictEqual(m.isNewer('0.22.3', '0.22.2'), true)
  assert.strictEqual(m.isNewer('0.22.3', '0.22.3'), false)
  assert.strictEqual(m.isNewer('junk', '0.22.2'), false)
})

// ── Update policy ────────────────────────────────────────────────────────────

test('isUpdateDue never swaps while transfers are active, even forced', () => {
  assert.deepStrictEqual(
    m.isUpdateDue({ latest: '0.23.0', current: '0.22.0', transfersActive: true }),
    { due: false, reason: 'transfers-active' })
  assert.deepStrictEqual(
    m.isUpdateDue({ latest: '0.23.0', current: '0.22.0', transfersActive: true, force: true }),
    { due: false, reason: 'transfers-active' })
})

test('isUpdateDue: newer available with no transfers is due', () => {
  assert.deepStrictEqual(
    m.isUpdateDue({ latest: '0.23.0', current: '0.22.0', transfersActive: false }),
    { due: true, reason: 'newer-available' })
})

test('isUpdateDue: up to date is not due', () => {
  assert.deepStrictEqual(
    m.isUpdateDue({ latest: '0.22.0', current: '0.22.0', transfersActive: false }),
    { due: false, reason: 'up-to-date' })
})

test('isUpdateDue: unknown current is not swapped automatically, but force acts on newer', () => {
  assert.deepStrictEqual(
    m.isUpdateDue({ latest: '0.23.0', current: null, transfersActive: false }),
    { due: false, reason: 'current-unknown' })
  // force cannot conjure a comparison out of an unreadable current version: with
  // no baseline to beat, isNewer is false and the safe answer is "up-to-date".
  assert.deepStrictEqual(
    m.isUpdateDue({ latest: '0.23.0', current: null, transfersActive: false, force: true }),
    { due: false, reason: 'up-to-date' })
  // But force DOES act when current is known and older.
  assert.deepStrictEqual(
    m.isUpdateDue({ latest: '0.23.0', current: '0.22.0', transfersActive: false, force: true }),
    { due: true, reason: 'newer-available' })
})

// ── Throttle ─────────────────────────────────────────────────────────────────

test('shouldAutoCheck: never-checked is due, then weekly', () => {
  const now = 30 * DAY
  assert.strictEqual(m.shouldAutoCheck({ lastCheckAt: 0, now }), true)
  assert.strictEqual(m.shouldAutoCheck({ lastCheckAt: now - 6 * DAY, now }), false)
  assert.strictEqual(m.shouldAutoCheck({ lastCheckAt: now - 7 * DAY, now }), true)
})

// ── Asset selection ──────────────────────────────────────────────────────────

test('selectAsset picks the linux-x64 zip and reads the tag version', () => {
  const rel = {
    tag_name: '0.22.3',
    assets: [
      { name: 'slskd-0.22.3-linux-arm64.zip', browser_download_url: 'u1', size: 1 },
      { name: 'slskd-0.22.3-linux-x64.zip', browser_download_url: 'u2', size: 999 },
    ],
  }
  const a = m.selectAsset(rel)
  assert.strictEqual(a.version, '0.22.3')
  assert.strictEqual(a.url, 'u2')
  assert.strictEqual(a.assetName, 'slskd-0.22.3-linux-x64.zip')
  assert.strictEqual(a.size, 999)
})

test('selectAsset returns null when no linux-x64 zip exists', () => {
  assert.strictEqual(m.selectAsset({ tag_name: '0.22.3', assets: [{ name: 'checksums.txt', browser_download_url: 'u' }] }), null)
  assert.strictEqual(m.selectAsset({}), null)
  assert.strictEqual(m.selectAsset(null), null)
})

// ── Exec layer: the swap / rollback state machine ────────────────────────────
// A fully-injected updater: a fetch that serves the release JSON and the zip
// bytes, an fsOps double that records the ops, an unzipFn that "extracts" a
// staged binary, and start/stop/application callbacks whose behaviour the test
// scripts to drive success and rollback.

function makeFsOps(state) {
  return {
    existsSync: p => state.files.has(p),
    copyFileSync: (a, b) => { state.ops.push(['copy', a, b]); state.files.add(b) },
    renameSync: (a, b) => { state.ops.push(['rename', a, b]); state.files.delete(a); state.files.add(b) },
    unlinkSync: p => { state.ops.push(['unlink', p]); state.files.delete(p) },
    chmodSync: p => { state.ops.push(['chmod', p]) },
    mkdirSync: () => {},
    writeFileSync: p => { state.files.add(p) },
  }
}

function makeFetch({ release, zip = Buffer.from('zip') } = {}) {
  return async (url) => {
    if (/releases\/latest/.test(url)) {
      return { ok: true, status: 200, json: async () => release }
    }
    // asset download
    return { ok: true, status: 200, arrayBuffer: async () => zip }
  }
}

function baseUpdater(overrides = {}) {
  const state = {
    files: new Set(['/slskd/slskd']),   // the live binary exists
    ops: [],
  }
  const release = {
    tag_name: '0.23.0',
    assets: [{ name: 'slskd-0.23.0-linux-x64.zip', browser_download_url: 'https://x/asset.zip', size: 10 }],
  }
  const opts = {
    binPath: '/slskd/slskd',
    dir: '/slskd',
    fetchFn: makeFetch({ release }),
    fsOps: makeFsOps(state),
    unzipFn: async (_zip, destDir) => { state.files.add(path.join(destDir, 'slskd')) },
    nowFn: () => 1000,
    transfersActiveFn: () => false,
    applicationFn: overrides.applicationFn || (async () => ({ version: '0.22.0' })),
    stopFn: async () => { state.ops.push(['stop']) },
    startFn: async () => { state.ops.push(['start']) },
    ...overrides,
  }
  return { updater: new m.SlskdUpdater(opts), state, release }
}

test('performUpdate: happy path stages, backs up, stops, swaps, starts, verifies, cleans up', async () => {
  // /application reports the OLD version until the swap+start, then the NEW one.
  let started = false
  const { updater, state } = baseUpdater({
    startFn: async function () {},   // replaced below via closure trick
  })
  // Re-wire application + start so verify sees the new version after start.
  updater._startFn = async () => { started = true; state.ops.push(['start']) }
  updater._applicationFn = async () => ({ version: started ? '0.23.0' : '0.22.0' })

  const r = await updater.performUpdate()
  assert.strictEqual(r.ok, true, JSON.stringify(r))
  assert.strictEqual(r.from, '0.22.0')
  assert.strictEqual(r.to, '0.23.0')
  const kinds = state.ops.map(o => o[0])
  // The order that matters: backup(copy) before stop before swap(rename) before start.
  assert.ok(kinds.indexOf('copy') < kinds.indexOf('stop'), 'backup before stop')
  assert.ok(kinds.indexOf('stop') < kinds.indexOf('rename'), 'stop before swap')
  assert.ok(kinds.indexOf('rename') < kinds.indexOf('start'), 'swap before start')
  // The .bak was removed on success.
  assert.ok(!state.files.has('/slskd/slskd.bak'), 'backup deleted after a verified swap')
})

test('performUpdate: verification failure rolls back to the kept binary', async () => {
  let started = false
  const { updater, state } = baseUpdater()
  updater._startFn = async () => { started = true; state.ops.push(['start']) }
  // The daemon NEVER reports the new version, so verify fails and we roll back.
  updater._applicationFn = async () => ({ version: '0.22.0' })
  // Speed the verify loop: a clock that jumps past the verify window immediately.
  let t = 0
  updater._nowFn = () => { t += 20000; return t }

  const r = await updater.performUpdate()
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.rolledBack, true, 'a failed verify must restore the backup: ' + JSON.stringify(r))
  const kinds = state.ops.map(o => o[0])
  // Two renames: the swap, then the rollback restore. Two starts: initial + rollback.
  assert.strictEqual(kinds.filter(k => k === 'rename').length, 2, 'swap then restore')
  assert.strictEqual(kinds.filter(k => k === 'start').length, 2, 'started, then restarted after rollback')
  assert.ok(started)
})

test('performUpdate: refuses when transfers are active and never touches the binary', async () => {
  const { updater, state } = baseUpdater({ transfersActiveFn: () => true })
  const r = await updater.performUpdate()
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.skipped, 'transfers-active')
  assert.deepStrictEqual(state.ops, [], 'no fs or daemon ops when transfers are active')
})

test('performUpdate: up-to-date is a clean skip, no swap', async () => {
  const { updater, state } = baseUpdater({ applicationFn: async () => ({ version: '0.23.0' }) })
  const r = await updater.performUpdate()
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.skipped, 'up-to-date')
  assert.ok(!state.ops.some(o => o[0] === 'rename'), 'nothing swapped when already current')
})

test('performUpdate: a fetch failure before the swap is a no-op', async () => {
  const { updater, state } = baseUpdater({ fetchFn: async () => { throw new Error('offline') } })
  const r = await updater.performUpdate()
  assert.strictEqual(r.ok, false)
  assert.ok(!state.ops.some(o => o[0] === 'rename'), 'no swap on a failed release fetch')
})

// ── currentVersion / binaryVersion via a fake spawn ──────────────────────────

function fakeProc({ code = 0, stdout = '', stderr = '' } = {}) {
  const proc = new EventEmitter()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.kill = () => {}
  setImmediate(() => {
    if (stdout) proc.stdout.write(stdout)
    if (stderr) proc.stderr.write(stderr)
    proc.stdout.end(); proc.stderr.end()
    proc.emit('close', code)
  })
  return proc
}

test('binaryVersion reads `slskd --version`', async () => {
  const u = new m.SlskdUpdater({
    binPath: '/slskd/slskd',
    fsOps: { existsSync: () => true },
    spawnFn: () => fakeProc({ code: 0, stdout: '0.22.3\n' }),
  })
  assert.strictEqual(await u.binaryVersion(), '0.22.3')
})

test('currentVersion prefers the running daemon over the binary probe', async () => {
  const u = new m.SlskdUpdater({
    binPath: '/slskd/slskd',
    fsOps: { existsSync: () => true },
    applicationFn: async () => ({ version: '0.23.0' }),
    spawnFn: () => fakeProc({ code: 0, stdout: '0.22.0\n' }),
  })
  assert.strictEqual(await u.currentVersion(), '0.23.0')
})

// ── Wiring (parsed, like ytdlp-manager's) ────────────────────────────────────

const root = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

test('main wires the slskd updater to the existing daemon machinery', () => {
  const main = root('main.js')
  assert.match(main, /new SlskdUpdater\(/)
  assert.match(main, /transfersActiveFn:\s*\(\)\s*=>\s*_downloadsAreActive\(\)/)
  assert.match(main, /slskdFetch\('GET', '\/application'\)/)
  assert.match(main, /stopFn:.*stopSlskd\(\)/s)
  assert.match(main, /startFn:.*startSlskd\(\)/s)
  assert.match(main, /ipcMain\.handle\('slskd-update-now'/)
  assert.match(main, /safeSend\('slskd-updated'/)
})

test('preload exposes slskd update methods and allows the event', () => {
  const preload = root('preload.js')
  assert.match(preload, /slskdUpdateNow:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('slskd-update-now'\)/)
  assert.match(preload, /'slskd-updated'/)
})
