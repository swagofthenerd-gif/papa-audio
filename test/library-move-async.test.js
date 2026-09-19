'use strict'
// A cross-device move (library on one disk, destination on another) fell back
// to fs.cpSync — so a multi-GB album copied on the MAIN THREAD. mpv's IPC, the
// tray, every other IPC handler and the UI were frozen for the whole copy,
// indistinguishable from a hang.
//
// This runs the real library-move-path handler, lifted from main.js, with a
// copy that takes time, and watches whether the main thread gets a turn while
// it runs.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const { callSource, MAIN_PATH } = require('./helpers/lift-ipc')
const MAIN = fs.readFileSync(MAIN_PATH, 'utf8')

function runMove({ crossDevice, cpFails = false, dryRun = false }) {
  const order = []
  let captured = null
  const EXDEV = Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
  const fakeFs = {
    existsSync: () => false,
    mkdirSync() {},
    renameSync() { if (crossDevice) throw EXDEV },
    promises: {
      async cp() {
        order.push('cp-start')
        // A real multi-gigabyte copy; here, long enough for the loop to breathe.
        await new Promise(r => setTimeout(r, 40))
        order.push('cp-end')
        if (cpFails) throw new Error('disk filled up')
      },
      async rm() { order.push('rm') },
    },
  }
  const ctx = {
    DRY_RUN: dryRun, path, fs, console: { log() {}, error() {}, warn() {} },
    Promise, Math, Number, String, Boolean, JSON, Object, Array, Error, Date,
    setTimeout, clearTimeout,
    ipcMain: { handle(_ch, fn) { captured = fn } },
    libPathAllowed: () => true,
    libRoots: () => ['/mnt/data/MUSIC'],
    dirSizeAsync: async () => 1000,
    freeSpaceAt: () => null,
    _opBegin: () => 'op-1',
    _opUpdate() { order.push('journal-copy-phase') },
    _opEnd() { order.push('op-end') },
    shell: { trashItem: async () => { order.push('trash-source') } },
    _scheduleLibraryRescan() { order.push('rescan') },
  }
  ctx.fs = fakeFs
  const refusal = MAIN.slice(MAIN.indexOf('function _dryRunRefusal(what) {'),
    MAIN.indexOf('\n}', MAIN.indexOf('function _dryRunRefusal(what) {')) + 2)
  vm.createContext(ctx)
  vm.runInContext(refusal + '\n' + callSource(MAIN, 'library-move-path'), ctx)
  return { order, run: () => captured({}, { from: '/mnt/data/MUSIC/a', to: '/mnt/data/MUSIC/b' }) }
}

test('a cross-device move does not block the main thread', async () => {
  const m = runMove({ crossDevice: true })
  const beats = []
  // Stands in for mpv's IPC ticker, the tray refresh, the next IPC handler —
  // anything at all that needs the main thread while the copy runs.
  const heart = setInterval(() => beats.push(Date.now()), 5)
  let out
  try { out = await m.run() } finally { clearInterval(heart) }

  assert.strictEqual(out.ok, true)
  assert.strictEqual(out.path, path.resolve('/mnt/data/MUSIC/b'))
  assert.ok(m.order.includes('cp-start') && m.order.includes('trash-source'),
    'the copy fallback did run: ' + m.order.join(', '))
  assert.ok(beats.length >= 3,
    'the main thread must keep running during the copy; it got ' + beats.length + ' turns')
  assert.strictEqual(m.order[0], 'journal-copy-phase',
    'the journal still records the copy phase before it starts')
})

test('a same-device move still just renames', async () => {
  const m = runMove({ crossDevice: false })
  const out = await m.run()
  assert.strictEqual(out.ok, true)
  assert.strictEqual(m.order.includes('cp-start'), false,
    'a plain rename must not fall back to copying')
})

test('a copy that fails still cleans up and closes the journal', async () => {
  const m = runMove({ crossDevice: true, cpFails: true })
  const out = await m.run()
  assert.strictEqual(out.ok, false)
  assert.match(out.error, /disk filled up/)
  assert.ok(m.order.includes('op-end'), 'the journal entry must be closed')
})

test('the dry run still refuses before anything moves', async () => {
  const m = runMove({ crossDevice: true, dryRun: true })
  const out = await m.run()
  assert.strictEqual(out.ok, false)
  assert.strictEqual(out.dryRun, true)
  assert.deepStrictEqual(m.order, [])
})

test('nothing synchronous is left on the copy path', () => {
  const body = callSource(MAIN, 'library-move-path')
  assert.doesNotMatch(body, /fs\.cpSync/, 'the whole point')
  assert.match(body, /await fs\.promises\.cp\(/)
})
