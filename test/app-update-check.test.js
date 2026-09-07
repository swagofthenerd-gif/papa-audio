'use strict'
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const fs = require('fs')

const m = require('../src/app-update-check')

const DAY = 24 * 60 * 60 * 1000

// ── Semver ───────────────────────────────────────────────────────────────────

test('parseSemver tolerates a leading v and pre/build suffixes', () => {
  assert.deepStrictEqual(m.parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3 })
  assert.deepStrictEqual(m.parseSemver('v1.2.3'), { major: 1, minor: 2, patch: 3 })
  assert.deepStrictEqual(m.parseSemver('1.2.3-beta.1'), { major: 1, minor: 2, patch: 3 })
  assert.strictEqual(m.parseSemver('junk'), null)
})

test('compareSemver orders and returns 0 on junk', () => {
  assert.strictEqual(m.compareSemver('1.2.3', '1.2.2'), 1)
  assert.strictEqual(m.compareSemver('1.2.3', '1.3.0'), -1)
  assert.strictEqual(m.compareSemver('2.0.0', '1.9.9'), 1)
  assert.strictEqual(m.compareSemver('1.2.3', '1.2.3'), 0)
  assert.strictEqual(m.compareSemver('junk', '1.2.3'), 0)
})

test('isNewer is strict and silent on garbage', () => {
  assert.strictEqual(m.isNewer('1.2.4', '1.2.3'), true)
  assert.strictEqual(m.isNewer('1.2.3', '1.2.3'), false)
  assert.strictEqual(m.isNewer('junk', '1.2.3'), false)
})

// ── Staleness ────────────────────────────────────────────────────────────────

test('isCheckDue: never-checked is due, then weekly', () => {
  const now = 30 * DAY
  assert.strictEqual(m.isCheckDue({ lastCheckAt: 0, now }), true)
  assert.strictEqual(m.isCheckDue({ lastCheckAt: now - 6 * DAY, now }), false)
  assert.strictEqual(m.isCheckDue({ lastCheckAt: now - 7 * DAY, now }), true)
})

// ── Exec layer ───────────────────────────────────────────────────────────────

test('check(): a 404 is an honest "no release channel yet", not an error', async () => {
  const c = new m.AppUpdateCheck({
    currentVersion: '1.0.0',
    fetchFn: async () => ({ ok: false, status: 404 }),
  })
  const r = await c.check()
  assert.deepStrictEqual(r, { ok: true, noReleaseChannel: true })
})

test('check(): a newer release is reported with its url', async () => {
  const c = new m.AppUpdateCheck({
    currentVersion: '1.0.0',
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'v1.1.0', html_url: 'https://x/rel' }) }),
  })
  const r = await c.check()
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.available, true)
  assert.strictEqual(r.latest, '1.1.0')
  assert.strictEqual(r.url, 'https://x/rel')
})

test('check(): the same version reports not available', async () => {
  const c = new m.AppUpdateCheck({
    currentVersion: '1.1.0',
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ tag_name: '1.1.0' }) }),
  })
  const r = await c.check()
  assert.strictEqual(r.available, false)
  assert.strictEqual(r.latest, '1.1.0')
})

test('check(): a network failure is a soft error, never a throw', async () => {
  const c = new m.AppUpdateCheck({
    currentVersion: '1.0.0',
    fetchFn: async () => { throw new Error('offline') },
  })
  const r = await c.check()
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /offline/)
})

test('check(): no fetch available degrades honestly', async () => {
  // The constructor falls back to global fetch when none is passed; force the
  // no-fetch state directly to exercise the honest-degrade guard without a real
  // network call.
  const c = new m.AppUpdateCheck({ currentVersion: '1.0.0' })
  c._fetchFn = null
  const r = await c.check()
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /no fetch/)
})

// ── Wiring ───────────────────────────────────────────────────────────────────

const root = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

test('main is a NOTIFIER: it opens the release page, never self-updates silently', () => {
  const main = root('main.js')
  assert.match(main, /new AppUpdateCheck\(/)
  assert.match(main, /ipcMain\.handle\('app-update-check-now'/)
  assert.match(main, /safeSend\('app-update-available'/)
})

test('preload allows the app-update event and exposes the check method', () => {
  const preload = root('preload.js')
  assert.match(preload, /appUpdateCheckNow:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('app-update-check-now'\)/)
  assert.match(preload, /'app-update-available'/)
})

test('the renderer offers a release-page button, not a silent install', () => {
  const r = root('src/renderer.js')
  assert.match(r, /app-update-available/)
  assert.match(r, /openExternal/)
})
