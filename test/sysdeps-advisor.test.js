'use strict'
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const fs = require('fs')
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')

const m = require('../src/sysdeps-advisor')

const DAY = 24 * 60 * 60 * 1000

// ── Version parsing ──────────────────────────────────────────────────────────

test('parseVersion reads mpv and ffmpeg version banners', () => {
  assert.deepStrictEqual(m.parseVersion('mpv 0.37.0'), { major: 0, minor: 37 })
  assert.deepStrictEqual(m.parseVersion('mpv v0.40.0-dirty'), { major: 0, minor: 40 })
  assert.deepStrictEqual(m.parseVersion('ffmpeg version 6.1.1 Copyright...'), { major: 6, minor: 1 })
})

test('parseVersion handles ffmpeg git "n7" builds with no minor', () => {
  assert.deepStrictEqual(m.parseVersion('ffmpeg version n7 built with gcc'), { major: 7, minor: 0 })
})

test('parseVersion returns null for junk', () => {
  assert.strictEqual(m.parseVersion(''), null)
  assert.strictEqual(m.parseVersion('command not found'), null)
})

// ── Floor comparison ─────────────────────────────────────────────────────────

test('meetsFloor: at or above passes, below fails, null fails', () => {
  const floor = m.FLOORS.mpv   // 0.37
  assert.strictEqual(m.meetsFloor({ major: 0, minor: 37 }, floor), true)
  assert.strictEqual(m.meetsFloor({ major: 0, minor: 40 }, floor), true)
  assert.strictEqual(m.meetsFloor({ major: 0, minor: 32 }, floor), false)
  assert.strictEqual(m.meetsFloor(null, floor), false)
})

test('meetsFloor: a higher major always passes an older-major floor', () => {
  assert.strictEqual(m.meetsFloor({ major: 7, minor: 0 }, m.FLOORS.ffmpeg), true)
  assert.strictEqual(m.meetsFloor({ major: 5, minor: 9 }, m.FLOORS.ffmpeg), false)
})

// ── Advice verdicts ──────────────────────────────────────────────────────────

test('adviseFor: a healthy binary needs no advice', () => {
  const v = m.adviseFor('mpv', { present: true, version: { major: 0, minor: 40 } })
  assert.strictEqual(v.ok, true)
  assert.strictEqual(v.reason, 'ok')
  assert.strictEqual(v.advice, null)
})

test('adviseFor: a missing binary gives an install command', () => {
  const v = m.adviseFor('ffmpeg', { present: false }, 'linux')
  assert.strictEqual(v.ok, false)
  assert.strictEqual(v.reason, 'missing')
  assert.match(v.advice, /dnf install ffmpeg/)
})

test('adviseFor: an outdated binary gives an update command and the version', () => {
  const v = m.adviseFor('mpv', { present: true, version: { major: 0, minor: 32 } }, 'linux')
  assert.strictEqual(v.ok, false)
  assert.strictEqual(v.reason, 'outdated')
  assert.strictEqual(v.version, '0.32')
  assert.match(v.advice, /dnf update mpv/)
})

// Roadmap 008: the advice matches the OS. A Mac never sees dnf.
test('adviseFor: the command matches the platform it will be run on', () => {
  assert.match(m.adviseFor('mpv', { present: false }, 'darwin').advice, /^brew install mpv$/)
  assert.match(m.adviseFor('mpv', { present: true, version: { major: 0, minor: 32 } }, 'darwin').advice, /^brew upgrade mpv$/)
  assert.match(m.adviseFor('ffmpeg', { present: false }, 'win32').advice, /^winget install ffmpeg/)
  assert.match(m.adviseFor('ffmpeg', { present: true, version: { major: 4, minor: 4 } }, 'win32').advice, /^winget upgrade ffmpeg$/)
  for (const p of ['darwin', 'win32']) {
    for (const a of Object.values(m.ADVICE_BY_PLATFORM[p])) assert.doesNotMatch(a, /dnf|apt|sudo/, p + ' never shows a Linux command')
  }
  // Default is the running process, and an unknown platform gets the Linux table.
  assert.strictEqual(m.adviseFor('mpv', { present: false }).advice, m.adviseFor('mpv', { present: false }, process.platform).advice)
  assert.match(m.adviseFor('mpv', { present: false }, 'freebsd').advice, /dnf install mpv/)
})

test('the advice never names a package-manager INSTALL of a running upgrade', () => {
  // The whole contract is advisory: the strings must be commands the USER runs,
  // and the module must never itself spawn a package manager. Guard the text.
  for (const a of Object.values(m.ADVICE)) {
    assert.match(a, /^sudo /, 'Linux advice is a copyable sudo command')
  }
  for (const table of Object.values(m.ADVICE_BY_PLATFORM)) {
    for (const a of Object.values(table)) assert.match(a, /^(sudo|brew|winget) /, 'every line is a command the user runs')
  }
})

// ── Staleness ────────────────────────────────────────────────────────────────

test('isCheckDue: never-checked is due, then monthly', () => {
  const now = 90 * DAY
  assert.strictEqual(m.isCheckDue({ lastCheckAt: 0, now }), true)
  assert.strictEqual(m.isCheckDue({ lastCheckAt: now - 20 * DAY, now }), false)
  assert.strictEqual(m.isCheckDue({ lastCheckAt: now - 30 * DAY, now }), true)
})

// ── Exec layer: never spawns a package manager, only version probes ───────────

function fakeProc({ code = 0, stdout = '', stderr = '', errorEvent = null } = {}) {
  const proc = new EventEmitter()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.kill = () => {}
  setImmediate(() => {
    if (errorEvent) { proc.emit('error', errorEvent); return }
    if (stdout) proc.stdout.write(stdout)
    if (stderr) proc.stderr.write(stderr)
    proc.stdout.end(); proc.stderr.end()
    proc.emit('close', code)
  })
  return proc
}

test('check() only spawns mpv --version and ffmpeg -version', async () => {
  const calls = []
  const adv = new m.SysDepsAdvisor({
    spawnFn: (bin, args) => {
      calls.push([bin, args])
      return fakeProc({ code: 0, stdout: bin === 'mpv' ? 'mpv 0.40.0' : 'ffmpeg version 7.0' })
    },
  })
  const out = await adv.check()
  assert.deepStrictEqual(calls[0], ['mpv', ['--version']])
  assert.deepStrictEqual(calls[1], ['ffmpeg', ['-version']])
  // No dnf/apt/pip ever spawned.
  assert.ok(!calls.some(([bin]) => /dnf|apt|pip|yum|pacman/.test(bin)), 'never spawns a package manager')
  assert.strictEqual(out.mpv.ok, true)
  assert.strictEqual(out.ffmpeg.ok, true)
})

test('check() reports a missing binary (ENOENT) as not present', async () => {
  const adv = new m.SysDepsAdvisor({
    spawnFn: () => fakeProc({ errorEvent: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }),
  })
  const out = await adv.check()
  assert.strictEqual(out.mpv.present, false)
  assert.strictEqual(out.mpv.reason, 'missing')
})

// ── Wiring ───────────────────────────────────────────────────────────────────

const root = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

test('main wires the advisor as advisory-only with a check-now handler', () => {
  const main = root('main.js')
  assert.match(main, /new SysDepsAdvisor\(/)
  assert.match(main, /ipcMain\.handle\('sysdeps-check-now'/)
  // Never spawns a package manager from the wiring either.
  assert.ok(!/spawn\([^)]*['"]dnf['"]/.test(main), 'main never spawns dnf')
})
