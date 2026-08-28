'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const CODE = MAIN
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')

// ── Item 59: one safe send, used everywhere ─────────────────────────────────

test('nothing pushes to the renderer except through the helper', () => {
  // webContents.send throws if the window is gone, and during the close race
  // that reached only the blanket uncaughtException handler. One of four call
  // sites was wrapped; the rest were not.
  assert.strictEqual([...CODE.matchAll(/webContents\.send\(/g)].length, 0,
    'every send goes through safeSend, which resolves the webContents itself')
  // The single real send lives inside the helper, after both liveness checks.
  const sends = [...CODE.matchAll(/\bwc\.send\(/g)]
  assert.strictEqual(sends.length, 1)
  const helper = CODE.slice(CODE.indexOf('function safeSend('), CODE.indexOf('function resetChannelSeq('))
  assert.ok(helper.includes('wc.send(channel, payload,'), 'the send carries the sequence alongside the payload')
})

test('safeSend checks the window and the webContents, and never throws', () => {
  const fn = CODE.slice(CODE.indexOf('function safeSend('), CODE.indexOf('function resetChannelSeq('))
  assert.match(fn, /mainWindow\.isDestroyed\(\)/)
  assert.match(fn, /wc\.isDestroyed\(\)/)
  assert.match(fn, /catch/)
})

// ── Items 53 and 200: one engine-ready check ────────────────────────────────

test('the close confirmation asks the engine, not the renderer', () => {
  // executeJavaScript('state.isPlaying') rejected if the renderer had reloaded or
  // died, and the catch silently closed the app — skipping the confirmation
  // during active playback.
  assert.doesNotMatch(CODE, /executeJavaScript\('state\.isPlaying'\)/)
  const close = CODE.slice(CODE.indexOf("mainWindow.on('close'"), CODE.indexOf("mainWindow.on('closed'"))
  assert.match(close, /playerIsPlaying\(\)/)
})

test('every engine entry point shares one readiness check', () => {
  // `if (!player)` passed even when the client inside it was null, which is how
  // a media key or the tray could act on a dead engine.
  assert.match(CODE, /function playerReady\(\)/)
  const ready = CODE.slice(CODE.indexOf('function playerReady()'), CODE.indexOf('function playerIsPlaying()'))
  assert.match(ready, /player\.alive !== false/, 'a truthy player is not a live one')
  const wrap = CODE.slice(CODE.indexOf('const wrap = fn =>'), CODE.indexOf('const wrap = fn =>') + 400)
  assert.match(wrap, /if \(!playerReady\(\)\)/)
})

test('playerIsPlaying reads mpv rather than a mirror of it', () => {
  const fn = CODE.slice(CODE.indexOf('function playerIsPlaying()'), CODE.indexOf('function sendPlayerEvent('))
  assert.match(fn, /player\.getState\(\)/)
  assert.match(fn, /st\.paused === false/)
  assert.match(fn, /catch/, 'asking a dying engine must not throw at the close handler')
})

// ── Item 106: every path-taking handler goes through the guard ─────────────

test('the path guard is lexical, so it works for a file that does not exist', () => {
  const fn = CODE.slice(CODE.indexOf('function pathIsOurs('), CODE.indexOf('function libPathInRoots('))
  assert.match(fn, /path\.resolve/)
  assert.doesNotMatch(fn, /realpath/, 'realpath fails for a path that does not exist yet')
})

test('the guard is side-effect free', () => {
  // _downloadDir() creates directories and warns; a guard must not.
  const fn = CODE.slice(CODE.indexOf('function papaRoots('), CODE.indexOf('function pathIsOurs('))
  assert.doesNotMatch(fn, /mkdir|_downloadDir\(\)|console\./)
})

test('the four unguarded path handlers now refuse paths outside the app folders', () => {
  for (const [channel, until] of [
    ["ipcMain.handle('slsk-show-in-folder'", "ipcMain.handle('open-external'"],
    ["ipcMain.handle('verify-surround'", "ipcMain.handle('verify-surround-folder'"],
    ["ipcMain.handle('verify-surround-folder'", "ipcMain.handle('get-audio-devices'"],
  ]) {
    const at = CODE.indexOf(channel)
    assert.ok(at > 0, `${channel} not found`)
    const end = CODE.indexOf(until, at)
    const body = CODE.slice(at, end > at ? end : at + 900)
    assert.match(body, /pathIsOurs\(/, `${channel} takes a path and does not check it`)
  }
  // transcode is the one that WRITES, so both ends are checked.
  const fn = CODE.slice(CODE.indexOf('function transcodeFile('), CODE.indexOf('function transcodeFile(') + 900)
  assert.match(fn, /pathIsOurs\(filePath\)/)
  assert.match(fn, /pathIsOurs\(outDir\)/)
})

// ── Item 139: peer paths never land in the library root ───────────────────

test('the download folder fallback is a subfolder, not the library root', () => {
  const fn = CODE.slice(CODE.indexOf('function _downloadDir()'), CODE.indexOf("ipcMain.handle('slsk-get-download-dir'"))
  assert.match(fn, /DOWNLOAD_SUBDIR/)
  assert.doesNotMatch(fn, /return cfg\.downloadDir \|\| folders\[0\]/, 'that is the bug')
  assert.match(fn, /mkdirSync/, 'the fallback has to exist, not be assumed')
})

// ── Item 170: a scan on a dead mount has no natural end ──────────────────

test('the scan has a deadline and reports what it skipped', () => {
  assert.match(CODE, /SCAN_DEADLINE_MS/)
  const fn = CODE.slice(CODE.indexOf('async function _performScanOnce('), CODE.indexOf('async function _performScanOnce(') + 1600)
  assert.match(fn, /overDeadline\(\)/)
  assert.match(fn, /console\.error/, 'stopping early has to say so')
})

// ── Tier 0 regressions from the 125-item round ──────────────────────────────

test('nothing that waits on a person is deadlined', () => {
  // A deadline on a dialog does not protect against a wedged handler, it cancels
  // the user. add-music-folder commits the folder BEFORE it returns, so a
  // rejected invoke left main and the renderer disagreeing about the library.
  const tbl = CODE.slice(CODE.indexOf('const IPC_TIMEOUT_OVERRIDES = {'), CODE.indexOf('const _ipcRawHandle'))
  const humanWaiting = []
  for (const m of CODE.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)) {
    const nxt = CODE.indexOf('ipcMain.', m.index + 10)
    const body = CODE.slice(m.index, nxt > 0 ? nxt : m.index + 2500)
    if (/showOpenDialog|showSaveDialog|showMessageBox|new BrowserWindow/.test(body)) humanWaiting.push(m[1])
  }
  assert.ok(humanWaiting.length >= 5, `expected several, found ${humanWaiting}`)
  const missing = humanWaiting.filter(ch => !new RegExp(`'${ch}': 0`).test(tbl))
  assert.deepStrictEqual(missing, [], 'these wait on a person and must be exempt with 0')
})

test('the tray tooltip has exactly one writer', () => {
  // update-now-playing used to set it directly while the engine-event refresh —
  // reading a _trayTrack nothing fed — overwrote it with a bare "Papa Audio".
  const sets = [...CODE.matchAll(/tray\.setToolTip\(/g)]
  assert.strictEqual(sets.length, 2, 'createTray plus refreshTrayTooltip, nothing else')
  const nowPlaying = CODE.slice(CODE.indexOf("ipcMain.on('update-now-playing'"), CODE.indexOf("ipcMain.on('update-now-playing'") + 900)
  assert.doesNotMatch(nowPlaying, /tray\.setToolTip\(/, 'it must go through refreshTrayTooltip')
  assert.match(nowPlaying, /_trayTrack = data\.title/, 'and it must feed the name it already has')
})

test('a background search is never cancelled by a UI search', () => {
  assert.match(CODE, /const BACKGROUND_GENERATION = -1/)
  const fn = CODE.slice(CODE.indexOf('async function cancelSearchesExcept'), CODE.indexOf('async function cancelSearchesExcept') + 700)
  assert.match(fn, /info\.generation <= BACKGROUND_GENERATION\) continue/)
})

test('the search registry is cleaned in a finally', () => {
  // Any slskdFetch in the polling loop can throw; the cleanup used to sit after
  // the loop, so a thrown search leaked its id forever.
  const h = CODE.slice(CODE.indexOf("ipcMain.handle('slsk-search'"), CODE.indexOf("ipcMain.handle('slsk-download'"))
  const fin = h.lastIndexOf('} finally {')
  assert.ok(fin > 0, 'the handler needs a finally')
  const tail = h.slice(fin)
  assert.match(tail, /_liveSearches\.delete\(id\)/)
  assert.match(tail, /_cancelledSearches\.delete\(id\)/)
})
