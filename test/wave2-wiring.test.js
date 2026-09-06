'use strict'
// Wave-2 backend wiring: the contract handlers exist, are shaped right, and the
// property plumbing reaches mpv. These are structural greps — the behaviour of
// the pure logic is covered in the sibling test files.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
const ENGINE = fs.readFileSync(path.join(__dirname, '..', 'mpv-engine.js'), 'utf8')

test('mpvAbLoop is exposed and wires mpv ab-loop-a / ab-loop-b', () => {
  assert.match(PRELOAD, /mpvAbLoop:\s*\(range\)\s*=>\s*ipcRenderer\.invoke\('mpv-ab-loop', range\)/)
  assert.match(MAIN, /ipcMain\.handle\('mpv-ab-loop'/)
  assert.match(MAIN, /player\.setAbLoop/)
  // The engine drives mpv's native properties.
  assert.match(ENGINE, /async setAbLoop\(/)
  assert.match(ENGINE, /'ab-loop-a'/)
  assert.match(ENGINE, /'ab-loop-b'/)
  // null clears both endpoints.
  assert.match(ENGINE, /'ab-loop-a', 'no'/)
})

test('mpvReplaygainMode sets the property AND persists to playerSettings', () => {
  assert.match(PRELOAD, /mpvReplaygainMode:\s*\(mode\)\s*=>\s*ipcRenderer\.invoke\('mpv-replaygain-mode', mode\)/)
  const handler = MAIN.slice(MAIN.indexOf("ipcMain.handle('mpv-replaygain-mode'"),
    MAIN.indexOf("ipcMain.handle('mpv-replaygain-mode'") + 600)
  // runtime property set on the MUSIC engine
  assert.match(handler, /player\.setReplaygain/)
  // persisted so the next spawn uses it
  assert.match(handler, /store\.set\('playerSettings'/)
  // 'off' maps to mpv's 'no'
  assert.match(handler, /'off'.*\?.*'no'|mode === 'track'.*'track'.*'album'.*'album'.*'no'/s)
  // The engine folds replaygain into its spawn args, so persistence really does
  // reach the next spawn.
  assert.match(ENGINE, /--replaygain=\$\{this\.config\.replaygain\}/)
})

test('tagWriteBatch is exposed and returns the contract shape', () => {
  assert.match(PRELOAD, /tagWriteBatch:\s*\(edits\)\s*=>\s*ipcRenderer\.invoke\('tag-write-batch', \{ edits \}\)/)
  assert.match(MAIN, /ipcMain\.handle\('tag-write-batch'/)
  assert.match(MAIN, /flacTags\.writeBatch/)
})

test('the wave-2 feature toggles are persisted with the right defaults', () => {
  const cfg = MAIN.slice(MAIN.indexOf('function _videoConfig()'),
    MAIN.indexOf('function _videoConfig()') + 400)
  assert.match(cfg, /diaryAutoLog:\s*saved\.diaryAutoLog !== false/)         // default ON
  assert.match(cfg, /airingNotifications:\s*saved\.airingNotifications !== false/) // default ON
  assert.match(cfg, /autoOrganizeDownloads:\s*saved\.autoOrganizeDownloads === true/) // default OFF
})

test('slskVerifyStatus is exposed and reads the persisted verdict', () => {
  assert.match(PRELOAD, /slskVerifyStatus:\s*\(p\)\s*=>\s*ipcRenderer\.invoke\('slsk-verify-status', p\)/)
  assert.match(MAIN, /ipcMain\.handle\('slsk-verify-status'/)
  assert.match(MAIN, /sideStores\.slskVerify\.get/)
})

test('verification runs AFTER completion, not on a timer', () => {
  // The completion sweep is called from the tick's reconcile path, and there is
  // no setInterval/setTimeout driving the verify pass.
  assert.match(MAIN, /await dlCheckCompletedGroups\(\)/)
  const verify = MAIN.slice(MAIN.indexOf('async function dlVerifyGroup('),
    MAIN.indexOf('async function dlVerifyGroup(') + 2000)
  assert.doesNotMatch(verify, /setInterval|setTimeout/)
})

test('auto-organize never runs on a failed verdict or when off', () => {
  const verify = MAIN.slice(MAIN.indexOf('const verdict = dlOrganize.verdict'),
    MAIN.indexOf('const verdict = dlOrganize.verdict') + 800)
  // The move is gated on BOTH a clean verdict and the setting being on.
  assert.match(verify, /if \(verdict\.ok && _videoConfig\(\)\.autoOrganizeDownloads/)
})

test('auto-organize is collision-safe and never deletes', () => {
  const org = MAIN.slice(MAIN.indexOf('async function dlOrganizeGroup('),
    MAIN.indexOf('async function dlOrganizeGroup(') + 2500)
  // A target that already exists is skipped, not overwritten.
  assert.match(org, /if \(fs\.existsSync\(m\.to\)\)/)
  // The only unlink is on the source AFTER a successful cross-device copy, or on
  // a failed copy's partial target — never a blind delete of a source.
  assert.match(org, /fs\.copyFileSync\(m\.from, m\.to\)\s*\n\s*fs\.unlinkSync\(m\.from\)/)
})

test('parseAlbumFolder is required for organize (not reimplemented)', () => {
  const org = MAIN.slice(MAIN.indexOf('async function dlOrganizeGroup('),
    MAIN.indexOf('async function dlOrganizeGroup(') + 2500)
  assert.match(org, /shelves\.parseAlbumFolder/)
})
