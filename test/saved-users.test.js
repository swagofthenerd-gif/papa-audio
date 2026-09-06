const test = require('node:test')
const assert = require('node:assert')
const { isSaved, saveUser, removeUser, toggleUser, touchUser, recordBrowse, sortUsers } = require('../src/saved-users')

test('saving, finding and removing', () => {
  let l = saveUser([], 'doperst13', { note: 'great 5.1 collection' })
  assert.equal(l.length, 1)
  assert.ok(isSaved(l, 'doperst13'))
  assert.equal(l[0].note, 'great 5.1 collection')
  l = removeUser(l, 'doperst13')
  assert.deepEqual(l, [])
})

test('lookup tolerates the wrong case, storage keeps what was given', () => {
  const l = saveUser([], 'DoperST13')
  assert.ok(isSaved(l, 'doperst13'))
  assert.ok(isSaved(l, 'DOPERST13'))
  assert.equal(l[0].username, 'DoperST13')
})

test('saving twice updates rather than duplicating, and keeps savedAt', () => {
  const first = saveUser([], 'bob', { note: 'a', fileCount: 10 })
  const again = saveUser(first, 'bob', { note: 'b' })
  assert.equal(again.length, 1)
  assert.equal(again[0].note, 'b')
  assert.equal(again[0].savedAt, first[0].savedAt, 'original save time is preserved')
  assert.equal(again[0].fileCount, 10, 'known metadata survives a note-only update')
})

test('toggle adds then removes', () => {
  let l = toggleUser([], 'bob')
  assert.ok(isSaved(l, 'bob'))
  l = toggleUser(l, 'bob')
  assert.ok(!isSaved(l, 'bob'))
})

test('empty and whitespace usernames are rejected', () => {
  assert.deepEqual(saveUser([], '   '), [])
  assert.deepEqual(saveUser([], null), [])
})

test('notes are capped so a paste cannot bloat the store', () => {
  const l = saveUser([], 'bob', { note: 'x'.repeat(500) })
  assert.equal(l[0].note.length, 200)
})

test('touch only affects users already saved', () => {
  assert.deepEqual(touchUser([], 'bob'), [])
  const l = touchUser(saveUser([], 'bob'), 'bob')
  assert.ok(l[0].lastBrowsedAt > 0)
})

test('most recently browsed sorts first', () => {
  const list = [
    { username: 'old',    savedAt: 1000, lastBrowsedAt: null },
    { username: 'recent', savedAt: 500,  lastBrowsedAt: 9000 },
    { username: 'mid',    savedAt: 2000, lastBrowsedAt: null },
  ]
  assert.deepEqual(sortUsers(list).map(u => u.username), ['recent', 'mid', 'old'])
})

test('newly saved users appear at the top', () => {
  let l = saveUser([], 'first')
  l = saveUser(l, 'second')
  assert.equal(l[0].username, 'second')
})

test('operations never mutate the input array', () => {
  const orig = saveUser([], 'bob')
  const copy = JSON.parse(JSON.stringify(orig))
  saveUser(orig, 'jane'); removeUser(orig, 'bob'); sortUsers(orig)
  assert.deepEqual(orig, copy)
})

// ── Friend diffs: recordBrowse rolls the last count into prevFileCount ───────

test('recordBrowse only touches saved users', () => {
  assert.deepEqual(recordBrowse([], 'ghost', { fileCount: 5 }), [],
    'a user who is not saved has no diff to keep')
})

test('the first browse has no previous count to diff against', () => {
  let l = saveUser([], 'bob')
  l = recordBrowse(l, 'bob', { fileCount: 100, dirCount: 4 })
  assert.equal(l[0].fileCount, 100)
  assert.equal(l[0].prevFileCount, null, 'nothing came before the first browse')
  assert.ok(l[0].lastBrowsedAt > 0)
})

test('a second browse rolls the old count into prevFileCount', () => {
  let l = saveUser([], 'bob')
  l = recordBrowse(l, 'bob', { fileCount: 100 })
  l = recordBrowse(l, 'bob', { fileCount: 140 })
  assert.equal(l[0].fileCount, 140, 'the fresh count is current')
  assert.equal(l[0].prevFileCount, 100, 'the previous count is kept for the diff')
})

test('a note-only save does not disturb the diff record', () => {
  let l = saveUser([], 'bob')
  l = recordBrowse(l, 'bob', { fileCount: 100 })
  l = recordBrowse(l, 'bob', { fileCount: 140 })
  l = saveUser(l, 'bob', { note: 'nice collection' })
  assert.equal(l[0].fileCount, 140)
  assert.equal(l[0].prevFileCount, 100, 'editing a note must not lose the diff')
  assert.equal(l[0].note, 'nice collection')
})

test('recordBrowse does not mutate the input array', () => {
  const orig = saveUser([], 'bob', { fileCount: 10 })
  const copy = JSON.parse(JSON.stringify(orig))
  recordBrowse(orig, 'bob', { fileCount: 20 })
  assert.deepEqual(orig, copy)
})

test('saved users are wired end to end', () => {
  const fs = require('fs'), path = require('path')
  const R = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
  const html = R('src/index.html')
  assert.ok(html.indexOf('saved-users.js') < html.indexOf('renderer.js'),
    'saved-users.js must load before renderer.js')
  assert.ok(R('src/saved-users.js').includes('window.PapaSavedUsers'),
    'renderer cannot require(), needs the global')

  const pre = R('preload.js')
  for (const m of ['slskSavedUsers', 'slskSaveUser', 'slskUnsaveUser', 'slskTouchUser']) {
    assert.ok(pre.includes(m), 'preload missing ' + m)
  }
  const main = R('main.js')
  for (const ch of ['slsk-saved-users', 'slsk-save-user', 'slsk-unsave-user', 'slsk-touch-user']) {
    assert.ok(main.includes(`ipcMain.handle('${ch}'`), 'main missing handler ' + ch)
  }
  const r = R('src/renderer.js')
  // Roadmap #62 split: the explorer's save (☆) button moved to slsk-shop-ui.js;
  // the saved-libraries dialog and the search-header entry point stay in renderer.
  assert.ok(R('src/slsk-shop-ui.js').includes('slskx-star'), 'explorer needs the save button')
  assert.ok(r.includes('showSlskSavedUsers'), 'saved-libraries dialog must exist')
  assert.ok(r.includes('slsk-saved-btn'), 'search header needs an entry point')
})
