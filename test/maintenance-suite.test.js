'use strict'
// Cross-cutting wiring for the self-maintenance suite: the master toggle gates
// every scheduler, the e2e profile no-ops, the panel is wired end to end, and the
// IPC surface is complete. Parsed against source, in the style of the other
// wiring tests, so a future refactor that drops a handler fails loudly here.
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const fs = require('fs')

const root = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const MAIN = root('main.js')
const PRELOAD = root('preload.js')
const RENDERER = root('src/renderer.js')
const HTML = root('src/index.html')

// ── Master toggle + scheduler gating ─────────────────────────────────────────

test('autoMaintenance defaults ON and gates every scheduler', () => {
  assert.match(MAIN, /function _autoMaintenanceOn/)
  assert.match(MAIN, /store\.get\('autoMaintenance', true\)/)
  // The scheduler arms behind a guard that reads the toggle at fire time.
  assert.match(MAIN, /function _armMaintenanceSchedulers/)
  assert.match(MAIN, /if \(_autoMaintenanceOn\(\)\)/)
})

test('the schedulers are armed at startup', () => {
  assert.match(MAIN, /_armMaintenanceSchedulers\(\)/)
})

test('the e2e profile makes every scheduler no-op cleanly', () => {
  assert.match(MAIN, /const _maintE2E = process\.env\.PAPA_E2E === '1'/)
  // The arm function returns early under e2e.
  const fn = MAIN.slice(MAIN.indexOf('function _armMaintenanceSchedulers'))
  assert.match(fn.slice(0, 200), /if \(_maintE2E\) return/)
})

test('every scheduled component has its own throttle constant', () => {
  // Each policy module owns a CHECK/REFRESH interval so a scheduler firing on
  // every launch is safe.
  assert.match(root('src/slskd-updater.js'), /CHECK_INTERVAL_MS = 7 \* 24/)
  assert.match(root('src/tracker-list.js'), /REFRESH_INTERVAL_MS = 7 \* 24/)
  assert.match(root('src/source-health.js'), /CHECK_INTERVAL_MS = 3 \* 24/)
  assert.match(root('src/sysdeps-advisor.js'), /CHECK_INTERVAL_MS = 30 \* 24/)
  assert.match(root('src/app-update-check.js'), /CHECK_INTERVAL_MS = 7 \* 24/)
})

// ── IPC surface ──────────────────────────────────────────────────────────────

test('main registers the full maintenance IPC surface', () => {
  for (const ch of [
    'maintenance-status', 'maintenance-get-auto', 'maintenance-set-auto',
    'slskd-update-now', 'slskd-set-auto-update',
    'trackers-refresh-now', 'sources-canary-now',
    'sysdeps-check-now', 'app-update-check-now',
  ]) {
    assert.match(MAIN, new RegExp(`ipcMain\\.handle\\('${ch}'`), `missing handler: ${ch}`)
  }
})

test('preload exposes the maintenance methods', () => {
  for (const fn of [
    'maintenanceStatus', 'maintenanceGetAuto', 'maintenanceSetAuto',
    'slskdUpdateNow', 'slskdSetAutoUpdate',
    'trackersRefreshNow', 'sourcesCanaryNow',
    'sysdepsCheckNow', 'appUpdateCheckNow',
  ]) {
    assert.match(PRELOAD, new RegExp(`${fn}:`), `missing preload method: ${fn}`)
  }
})

// ── Panel ────────────────────────────────────────────────────────────────────

test('the Maintenance settings section exists in the HTML', () => {
  assert.match(HTML, /id="maintenance-settings"/)
  assert.match(HTML, /id="maint-auto"/)
  assert.match(HTML, /id="maint-list"/)
})

test('the renderer initialises the Maintenance panel and escapes its output', () => {
  assert.match(RENDERER, /_initMaintenanceSettings\(\)/)
  assert.match(RENDERER, /async function _initMaintenanceSettings/)
  // Uses esc() for interpolation, per house style.
  const fn = RENDERER.slice(RENDERER.indexOf('async function _initMaintenanceSettings'))
  assert.match(fn.slice(0, 6000), /esc\(/)
})

test('the panel wires all six items to their handlers', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('async function _initMaintenanceSettings'))
  const block = fn.slice(0, 8000)
  for (const call of [
    'ytdlpUpdateNow', 'slskdUpdateNow', 'trackersRefreshNow',
    'sourcesCanaryNow', 'sysdepsCheckNow', 'appUpdateCheckNow',
  ]) {
    assert.match(block, new RegExp(call), `panel does not wire ${call}`)
  }
})
