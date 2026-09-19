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

// The ReplayGain handler, run rather than read. The version this replaced took
// a fixed 600-character window off the front of the handler and matched strings
// in it; a comment growing above the code was enough to break it, which is what
// happened. Nothing about the 600 characters was ever the contract.
const bitPerfect = require('../src/bit-perfect')

function replaygainHandler({ settings = {}, ready = true, engineThrows = false } = {}) {
  const a = MAIN.indexOf("ipcMain.handle('mpv-replaygain-mode'")
  assert.ok(a > -1, 'the mpv-replaygain-mode handler must still exist')
  const b = MAIN.indexOf('\n// Whether a queued track is genuinely gone', a)
  assert.ok(b > a, 'and must still be followed by the track-exists note')
  const stored = []
  const sent = []
  // The registration itself is what is run; the handler it registers is caught
  // here, so the channel name is part of what is being checked.
  let caught = null
  const names = ['ipcMain', 'getPlayerSettings', 'bitPerfect', 'store', 'playerReady', 'player']
  new Function(...names, MAIN.slice(a, b))(
    { handle: (channel, fn) => { if (channel === 'mpv-replaygain-mode') caught = fn } },
    () => ({ ...settings }), bitPerfect,
    { set: (k, v) => stored.push({ k, v }) },
    () => ready,
    { setReplaygain: async m => { sent.push(m); if (engineThrows) throw new Error('mpv is gone') } },
  )
  assert.ok(caught, 'the handler must register itself on mpv-replaygain-mode')
  return { call: mode => caught(null, mode), stored, sent }
}

test('mpvReplaygainMode is exposed on the bridge', () => {
  assert.match(PRELOAD, /mpvReplaygainMode:\s*\(mode\)\s*=>\s*ipcRenderer\.invoke\('mpv-replaygain-mode', mode\)/)
})

test('choosing a ReplayGain mode sets it on the running engine and persists it', async () => {
  const h = replaygainHandler({ settings: { bitPerfect: false, volume: 70 } })
  const r = await h.call('album')
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(h.sent, ['album'], 'the running mpv is told at once')
  assert.deepStrictEqual(h.stored, [{ k: 'playerSettings', v: { bitPerfect: false, volume: 70, replaygain: 'album' } }],
    'and it is persisted beside the rest of the settings, not instead of them')
})

test("'off' reaches mpv as mpv's own word for off", async () => {
  const h = replaygainHandler({ settings: { bitPerfect: false } })
  await h.call('off')
  assert.deepStrictEqual(h.sent, ['no'], "mpv says 'no', not 'off'")
  assert.strictEqual(h.stored[0].v.replaygain, 'no')
})

test('bit-perfect mode holds ReplayGain off the engine, and says so', async () => {
  // Three places used to hold three different answers — the running mpv, the
  // spawn config and the store — and the badge read the store, so it could
  // claim bit-perfect while ReplayGain was scaling the samples.
  const h = replaygainHandler({ settings: { bitPerfect: true } })
  const r = await h.call('track')
  assert.deepStrictEqual(h.sent, ['no'], 'nothing may scale the samples in bit-perfect mode')
  assert.strictEqual(r.suppressed, true, 'and the override is reported, not silent')
  assert.match(r.reason, /Bit-perfect/)
  assert.strictEqual(h.stored[0].v.replaygain, 'track',
    'the dropdown keeps showing what he asked for')
})

test('a dead engine still records the choice, and does not talk to it', async () => {
  const h = replaygainHandler({ settings: { bitPerfect: false }, ready: false })
  const r = await h.call('track')
  assert.strictEqual(r.ok, false)
  assert.deepStrictEqual(h.sent, [], 'no command is sent into a dead engine')
  assert.strictEqual(h.stored[0].v.replaygain, 'track', 'but the setting survives to the next spawn')
})

test('an engine that refuses is reported, not swallowed', async () => {
  const h = replaygainHandler({ settings: { bitPerfect: false }, engineThrows: true })
  const r = await h.call('track')
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /mpv is gone/)
})

test('the persisted mode really does reach the next spawn', () => {
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
    MAIN.indexOf('const verdict = dlOrganize.verdict') + 1100)   // grew with the Replace assessment line
  // The move is gated on BOTH a clean verdict and the setting being on.
  assert.match(verify, /if \(verdict\.ok && _videoConfig\(\)\.autoOrganizeDownloads/)
})

// ── Auto-organize, run for real against a real directory ───────────────────
// This was two assert.match calls looking for `fs.existsSync(m.to)` and the
// copy/unlink pair. Both spellings can survive a rewrite that deletes the
// user's music: adding `fs.unlinkSync(m.to)` above the existsSync check leaves
// every asserted string exactly where it was. Since this moves files the user
// has already waited hours to download, it is run against a real temp tree and
// the assertions are on what is on disk afterwards.
const os = require('node:os')
const dlOrganize = require('../src/download-organize')
const shelves = require('../src/slsk-shelves')

function liftOrganize(root, fsOver = {}) {
  const a = MAIN.indexOf('async function dlOrganizeGroup(')
  assert.ok(a > -1, 'dlOrganizeGroup must still exist in main.js')
  const b = MAIN.indexOf('\n// W2-UI contract:', a)
  assert.ok(b > a, 'and must still be followed by the W2-UI contract note')
  const logs = []
  const rescans = []
  const fn = new Function('require', 'fs', 'path', 'dlOrganize', 'sideStores',
    '_scheduleLibraryRescan', `${MAIN.slice(a, b)}\nreturn dlOrganizeGroup`)(
    m => (m === './src/slsk-shelves' ? shelves : require(m)),
    Object.assign(Object.create(fs), fsOver), path, dlOrganize,
    { slskOrganizeLog: { update: f => { logs.push(f(logs.at(-1) || [])) } } },
    () => rescans.push(1),
  )
  return { organize: fn, logs, rescans, root }
}

// The download folder and the library are not always the same filesystem — on
// this machine they routinely are not — so rename fails with EXDEV and the
// copy-then-delete fallback is the path that actually runs.
const exdev = () => { const e = new Error('cross-device link not permitted'); e.code = 'EXDEV'; throw e }

// A completed download sitting loose in the download root.
function downloaded(files, folder = 'Aphex Twin - Selected Ambient Works 85-92 [FLAC]') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-org-'))
  const made = []
  for (const [name, body] of Object.entries(files)) {
    const fp = path.join(root, name)
    fs.mkdirSync(path.dirname(fp), { recursive: true })
    fs.writeFileSync(fp, body)
    made.push(fp)
  }
  return { root, files: made, group: { key: 'g1', folder, folderPath: folder } }
}

const cleanup = d => fs.rmSync(d, { recursive: true, force: true })

test('organizing moves the download into its own album folder', async () => {
  const d = downloaded({ '01 Xtal.flac': 'AAA', '02 Tha.flac': 'BBB' })
  const h = liftOrganize(d.root)
  await h.organize(d.group, d.files, d.root)

  for (const f of d.files) assert.ok(!fs.existsSync(f), 'the loose copy is gone')
  const dirs = fs.readdirSync(d.root, { withFileTypes: true }).filter(e => e.isDirectory())
  assert.strictEqual(dirs.length, 1, 'exactly one album folder was made')
  const inside = fs.readdirSync(path.join(d.root, dirs[0].name)).sort()
  assert.deepStrictEqual(inside, ['01 Xtal.flac', '02 Tha.flac'].sort())
  assert.strictEqual(fs.readFileSync(path.join(d.root, dirs[0].name, '01 Xtal.flac'), 'utf8'), 'AAA',
    'and the bytes are the bytes that were downloaded')
  assert.strictEqual(h.rescans.length, 1, 'the library is told to look again')
  cleanup(d.root)
})

test('a track already at the destination is left alone, never overwritten', () => {
  // The whole risk: the destination is the user's library. A file already there
  // is a file they already have, possibly a better rip than the one arriving.
  const d = downloaded({ '01 Xtal.flac': 'NEW' })
  const h = liftOrganize(d.root)
  const plan = dlOrganize.planMoves({
    files: d.files, downloadRoot: d.root,
    targetName: dlOrganize.targetFolderName(shelves.parseAlbumFolder([d.group.folder]), d.group.folder),
  })
  fs.mkdirSync(plan.targetDir, { recursive: true })
  fs.writeFileSync(plan.moves[0].to, 'ALREADY-HERE')

  return h.organize(d.group, d.files, d.root).then(() => {
    assert.strictEqual(fs.readFileSync(plan.moves[0].to, 'utf8'), 'ALREADY-HERE',
      'the file that was already there must survive untouched')
    assert.ok(fs.existsSync(d.files[0]), 'and the arriving copy is not destroyed either')
    cleanup(d.root)
  })
})

test('nothing is ever deleted without arriving somewhere first', async () => {
  // Every byte that goes in comes out, somewhere. Run over a mixed case: one
  // file that can move, one whose destination is occupied.
  const d = downloaded({ '01 Xtal.flac': 'AAA', '02 Tha.flac': 'BBB' })
  const h = liftOrganize(d.root)
  const plan = dlOrganize.planMoves({
    files: d.files, downloadRoot: d.root,
    targetName: dlOrganize.targetFolderName(shelves.parseAlbumFolder([d.group.folder]), d.group.folder),
  })
  fs.mkdirSync(plan.targetDir, { recursive: true })
  fs.writeFileSync(plan.moves[0].to, 'OCCUPIED')

  await h.organize(d.group, d.files, d.root)
  const bodies = []
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name)
      if (e.isDirectory()) walk(fp)
      else bodies.push(fs.readFileSync(fp, 'utf8'))
    }
  }
  walk(d.root)
  assert.ok(bodies.includes('AAA'), 'the arriving track whose slot was taken still exists')
  assert.ok(bodies.includes('BBB'), 'and so does the one that moved')
  assert.ok(bodies.includes('OCCUPIED'), 'and so does what was already there')
  cleanup(d.root)
})

test('organizing a folder that is already in place does nothing at all', async () => {
  // Already sitting under the exact name organize would choose. Re-running must
  // not shuffle it around, and must not report a move that did not happen.
  const raw = 'Aphex Twin - Selected Ambient Works 85-92 [FLAC]'
  const folder = dlOrganize.targetFolderName(shelves.parseAlbumFolder([raw]), raw)
  assert.ok(folder, 'the folder name must still parse')
  const d = downloaded({ [path.join(folder, '01 Xtal.flac')]: 'AAA' }, folder)
  const h = liftOrganize(d.root)
  await h.organize(d.group, d.files, d.root)
  assert.strictEqual(fs.readFileSync(d.files[0], 'utf8'), 'AAA', 'moving a folder into itself must be a no-op')
  assert.strictEqual(h.rescans.length, 0, 'and nothing to tell the library about')
  cleanup(d.root)
})

test('a run that moves nothing writes no log entry', async () => {
  const d = downloaded({ '01 Xtal.flac': 'AAA' })
  const h = liftOrganize(d.root)
  await h.organize({ key: 'g', folder: '', folderPath: '' }, d.files, d.root)
  assert.deepStrictEqual(h.logs, [], 'an unparseable folder name organizes nothing')
  assert.ok(fs.existsSync(d.files[0]), 'and touches nothing')
  cleanup(d.root)
})

test('the organize log records where things went, and is capped', async () => {
  const d = downloaded({ '01 Xtal.flac': 'AAA' })
  const h = liftOrganize(d.root)
  await h.organize(d.group, d.files, d.root)
  const entry = h.logs.at(-1).at(-1)
  assert.strictEqual(entry.key, 'g1')
  assert.ok(entry.targetDir)
  assert.strictEqual(entry.moves[0].moved, true)
  assert.match(MAIN.slice(MAIN.indexOf('async function dlOrganizeGroup(')), /list\.slice\(-500\)/)
  cleanup(d.root)
})

test('across filesystems the track is copied before the original is dropped', async () => {
  const d = downloaded({ '01 Xtal.flac': 'AAA' })
  const h = liftOrganize(d.root, { renameSync: exdev })
  await h.organize(d.group, d.files, d.root)
  assert.ok(!fs.existsSync(d.files[0]), 'the source is cleaned up once the copy landed')
  const dir = fs.readdirSync(d.root, { withFileTypes: true }).find(e => e.isDirectory())
  assert.strictEqual(fs.readFileSync(path.join(d.root, dir.name, '01 Xtal.flac'), 'utf8'), 'AAA',
    'and every byte arrived')
  assert.strictEqual(h.logs.at(-1).at(-1).moves[0].crossDevice, true)
  cleanup(d.root)
})

test('a cross-filesystem copy that fails leaves the download where it was', async () => {
  // The unforgivable outcome: the source deleted and the copy incomplete. The
  // user waited hours for these files and there is no second copy anywhere.
  const d = downloaded({ '01 Xtal.flac': 'AAA' })
  const h = liftOrganize(d.root, {
    renameSync: exdev,
    copyFileSync: (from, to) => { fs.writeFileSync(to, 'HALF'); throw new Error('ENOSPC') },
  })
  await h.organize(d.group, d.files, d.root)
  assert.ok(fs.existsSync(d.files[0]), 'the download must still be there')
  assert.strictEqual(fs.readFileSync(d.files[0], 'utf8'), 'AAA', 'and intact')
  const dir = fs.readdirSync(d.root, { withFileTypes: true }).find(e => e.isDirectory())
  assert.ok(!fs.existsSync(path.join(d.root, dir.name, '01 Xtal.flac')),
    'and the half-written target is cleaned up, not left to look like a good file')
  cleanup(d.root)
})

test('parseAlbumFolder is required for organize (not reimplemented)', () => {
  const org = MAIN.slice(MAIN.indexOf('async function dlOrganizeGroup('),
    MAIN.indexOf('async function dlOrganizeGroup(') + 2500)
  assert.match(org, /shelves\.parseAlbumFolder/)
})
