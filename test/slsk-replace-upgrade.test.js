'use strict'
// "Upgrade" from the shelf used to mean "download a second copy"; the old one
// stayed and had to be hunted down in Manage. Replace downloads, VERIFIES, then
// offers Trash — and only when the new copy is whole and has the same number of
// songs. Albums come with bonus tracks or a missing closer; swapping on a count
// mismatch loses music, so that case keeps both and says why.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function liftAssess(albums) {
  const start = MAIN.indexOf('function _assessReplace(')
  const src = MAIN.slice(start, MAIN.indexOf('\n}\n', start) + 3)
  const sb = { sideStores: { libraryCache: { get: () => albums } } }
  vm.runInNewContext(src + '\nthis._assessReplace = _assessReplace', sb)
  return sb._assessReplace
}
const probesOk = n => Array.from({ length: n }, (_, i) => ({ ok: true, filePath: `/dl/${i}.flac` }))
const mine = { id: 'alb1', artist: 'Camel', name: 'Mirage', tracks: [{ filePath: '/m/1.flac' }, { filePath: '/m/2.flac' }, { filePath: '/m/3.flac' }] }

test('same track count and a clean verdict → replace is ok and names the old files', () => {
  const r = liftAssess([mine])({ replaceLibId: 'alb1' }, { ok: true }, probesOk(3))
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(r.oldPaths, ['/m/1.flac', '/m/2.flac', '/m/3.flac'])
  assert.strictEqual(r.newCount, 3); assert.strictEqual(r.oldCount, 3)
})

test('more songs in the new copy → not ok, both kept, reason states both counts', () => {
  const r = liftAssess([mine])({ replaceLibId: 'alb1' }, { ok: true }, probesOk(5))
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /5 tracks, yours has 3/)
})

test('fewer songs → not ok', () => {
  const r = liftAssess([mine])({ replaceLibId: 'alb1' }, { ok: true }, probesOk(2))
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /2 tracks, yours has 3/)
})

test('a failed verification is never ok even with matching counts', () => {
  const r = liftAssess([mine])({ replaceLibId: 'alb1' }, { ok: false, problems: ['x'] }, probesOk(3))
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /did not pass verification/)
})

test('an unreadable new file does not count as a track', () => {
  const probes = probesOk(3); probes[1] = { ok: false, filePath: '/dl/1.flac' }
  const r = liftAssess([mine])({ replaceLibId: 'alb1' }, { ok: true }, probes)
  assert.strictEqual(r.ok, false)
})

test('the album gone from the library → not ok, nothing to trash', () => {
  const r = liftAssess([])({ replaceLibId: 'alb1' }, { ok: true }, probesOk(3))
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.oldPaths, undefined)
})

test('the renderer offers Trash only on ok, and answers through the store', async () => {
  // The answer now goes through slsk-replace-resolve, not a bare trash call:
  // the main process bins the files and records the answer in one step, so a
  // question he has already answered cannot come back after a restart.
  const start = RENDERER.indexOf('function _replaceName(')
  const src = RENDERER.slice(start, RENDERER.indexOf('async function _renderPendingReplacements', start))
  const said = [], resolved = []
  const sb = {
    showSnackbar: (text, label, fn) => said.push({ text, label, fn }),
    window: { api: { slskReplaceResolve: async (p) => { resolved.push(p); return { ok: true, moved: 3 } } } },
    _renderPendingReplacements: () => {},
  }
  vm.runInNewContext(src + '\nthis.offer = _offerUpgradeReplace', sb)

  sb.offer({ key: 'k1', folder: 'F', replace: { ok: false, reason: 'the new copy has 5 tracks, yours has 3 — both kept', artist: 'Camel', album: 'Mirage' } })
  assert.strictEqual(said.length, 1)
  assert.strictEqual(said[0].label, '', 'no action on a mismatch')
  assert.match(said[0].text, /both kept/)

  sb.offer({ key: 'k2', folder: 'F', replace: { ok: true, newCount: 3, artist: 'Camel', album: 'Mirage', oldPaths: ['/m/1.flac'] } })
  assert.strictEqual(said[1].label, 'Move to Trash')
  assert.match(said[1].text, /waiting under Downloads/i, 'the durable copy of the question is named')
  await said[1].fn(); await new Promise(r => setTimeout(r, 5))
  // Objects made inside the vm carry the vm's own Object.prototype, which
  // deepStrictEqual rejects; compare contents, not realm.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(resolved)), [{ key: 'k2', action: 'trash' }],
    'exactly one resolve, naming the record — not a loose path list')
})

test('the only path files leave by is the guarded trasher', () => {
  // library-trash-paths used to inline the trashing; it now delegates, and the
  // replace flow uses the same function. Neither may grow its own copy.
  assert.match(MAIN, /async function _trashPathsGuarded\(paths\)/)
  const guarded = MAIN.slice(MAIN.indexOf('async function _trashPathsGuarded('),
    MAIN.indexOf('ipcMain.handle(\'library-trash-paths\''))
  assert.ok(guarded.includes('shell.trashItem'), 'it is what actually trashes')
  assert.ok(guarded.includes('libPathAllowed'), 'and it keeps the allowlist')
  const handler = MAIN.slice(MAIN.indexOf('ipcMain.handle(\'library-trash-paths\''), MAIN.indexOf('ipcMain.handle(\'library-trash-paths\'') + 300)
  assert.ok(!handler.includes('shell.trashItem'), 'the handler no longer trashes on its own')
  assert.ok(handler.includes('_trashPathsGuarded'))
  const resolve = MAIN.slice(MAIN.indexOf("ipcMain.handle('slsk-replace-resolve'"), MAIN.indexOf("ipcMain.handle('slsk-replace-resolve'") + 900)
  assert.ok(resolve.includes('_trashPathsGuarded'), 'and so does the replace answer')
})

test('the shelf sends replaceLibId with every file of a Replace, and main keeps it on the group', () => {
  const SHOP = fs.readFileSync(path.join(__dirname, '..', 'src', 'slsk-shop-ui.js'), 'utf8')
  const at = SHOP.indexOf("btn.classList.contains('slsh-replace')")
  assert.ok(at > -1, 'the Replace branch exists')
  assert.match(SHOP.slice(at, at + 600), /replaceLibId: String\(a\.matchedLibId\)/)
  assert.match(MAIN, /replaceLibId: typeof it\.replaceLibId === 'string' \? it\.replaceLibId : null/)
  assert.match(MAIN, /if \(group\.replaceLibId\) record\.replace = _assessReplace\(group, verdict, probes\)/)
})
