'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')

// main.js cannot be required without booting Electron, so trayMenuTemplate is
// re-declared here from its source and exercised directly. Kept a pure function
// in main precisely so its shape is testable this way.
function loadTrayMenuTemplate() {
  const start = MAIN.indexOf('function trayMenuTemplate(')
  assert.ok(start >= 0, 'trayMenuTemplate must exist in main.js')
  const end = MAIN.indexOf('\n}', start) + 2
  // eslint-disable-next-line no-new-func
  return new Function(MAIN.slice(start, end) + '\nreturn trayMenuTemplate')()
}
const trayMenuTemplate = loadTrayMenuTemplate()

// ── Menu shape (roadmap #21): Play/Pause, Next, Previous, Show, Quit ─────────

test('the menu has the five controls plus a separator, in order', () => {
  const labels = trayMenuTemplate(false).map(i => i.type === 'separator' ? '---' : i.label)
  assert.deepStrictEqual(labels, ['Play', 'Next', 'Previous', '---', 'Show Papa Audio', 'Quit'])
})

test('the first item toggles between Play and Pause with the play state', () => {
  assert.strictEqual(trayMenuTemplate(false)[0].label, 'Play')
  assert.strictEqual(trayMenuTemplate(true)[0].label, 'Pause')
})

test('every actionable item has a stable id the click wiring keys off', () => {
  const ids = trayMenuTemplate(true).filter(i => i.type !== 'separator').map(i => i.id)
  assert.deepStrictEqual(ids, ['playpause', 'next', 'previous', 'show', 'quit'])
})

// ── Store key + close behaviour ──────────────────────────────────────────────

test('minimizeToTray defaults to OFF wherever it is read', () => {
  // Every read of the key must pass `false` as the default so the feature is
  // opt-in, per the contract.
  const reads = [...MAIN.matchAll(/store\.get\('minimizeToTray'(?:,\s*([^)]*))?\)/g)]
  assert.ok(reads.length >= 1, 'minimizeToTray must be read somewhere')
  for (const m of reads) {
    assert.strictEqual((m[1] || '').trim(), 'false', 'default must be false (OFF)')
  }
})

test('the hide-to-tray decision requires a live tray and honours the key', () => {
  const fn = MAIN.slice(
    MAIN.indexOf('function _shouldHideToTray()'),
    MAIN.indexOf('function _shouldHideToTray()') + 400)
  assert.match(fn, /if \(!tray\) return false/, 'no tray means never hide')
  assert.match(fn, /minimizeToTray/)
})

test('window-all-closed is guarded so hide-to-tray does not quit the app', () => {
  const handler = MAIN.slice(
    MAIN.indexOf("app.on('window-all-closed'"),
    MAIN.indexOf("app.on('window-all-closed'") + 300)
  assert.match(handler, /_shouldHideToTray\(\)/, 'must consult the shared decision')
  assert.match(handler, /app\.isQuitting/, 'an explicit quit must still quit')
})

test('the close IPC and the window close handler both route through the decision', () => {
  assert.match(MAIN, /if \(_shouldHideToTray\(\)\) mainWindow\?\.hide\(\)/)
  assert.match(MAIN, /if \(!app\.isQuitting && _shouldHideToTray\(\)\) \{/)
})

// ── IPC + preload ────────────────────────────────────────────────────────────

test('papa-tray-set persists the flag and reflects the stored state', () => {
  const handler = MAIN.slice(
    MAIN.indexOf("ipcMain.handle('papa-tray-set'"),
    MAIN.indexOf("ipcMain.handle('papa-tray-set'") + 400)
  assert.match(handler, /store\.set\('minimizeToTray', enabled\)/)
  assert.match(handler, /enabled: store\.get\('minimizeToTray', false\)/)
})

test('preload exposes papaTraySet', () => {
  assert.match(PRELOAD, /papaTraySet:.*invoke\('papa-tray-set'/)
})

test('get-general-settings surfaces minimizeToTray', () => {
  assert.match(MAIN, /minimizeToTray: store\.get\('minimizeToTray', false\)/)
})

// ── Tray creation must not crash the e2e / headless launch ───────────────────

test('createTray is wrapped so a missing SNI host cannot crash startup', () => {
  const fn = MAIN.slice(MAIN.indexOf('function createTray()'), MAIN.indexOf('function trayMenuTemplate'))
  assert.match(fn, /try \{/)
  assert.match(fn, /catch \(e\)/)
})

// ── The menu is rebuilt in place on a play-state change ──────────────────────

test('the paused event rebuilds the tray menu in place', () => {
  assert.match(MAIN, /p\.on\('paused',.*updateTrayMenu\(playerIsPlaying\(\)\)/)
})

test('updateTrayMenu swaps the context menu rather than recreating the tray', () => {
  const fn = MAIN.slice(
    MAIN.indexOf('function updateTrayMenu('),
    MAIN.indexOf('function updateTrayMenu(') + 700)
  assert.match(fn, /tray\.setContextMenu/, 'in-place update via setContextMenu')
  assert.doesNotMatch(fn, /new Tray\(/, 'must not recreate the Tray object')
})
