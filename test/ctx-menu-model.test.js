const test = require('node:test')
const assert = require('node:assert')
const M = require('../src/ctx-menu-model')

const ids = ctx => M.menuItemsFor(ctx).map(i => i.id)
const byId = (ctx, id) => M.menuItemsFor(ctx).find(i => i.id === id)

test('a playlist row offers to remove from the PLAYLIST, not from the disk', () => {
  // This is the bug the model exists to prevent.
  const got = ids({ kind: 'playlist-track', listName: 'Road Trip', hasPath: true })
  assert.ok(got.includes('ctx-remove-playlist'))
  const remove = byId({ kind: 'playlist-track', listName: 'Road Trip' }, 'ctx-remove-playlist')
  assert.equal(remove.label, 'Remove from “Road Trip”')
  assert.equal(remove.danger, false, 'removing from a list is not destructive')
})

test('a queue row offers to remove from the queue', () => {
  const got = ids({ kind: 'queue-item', hasPath: true })
  assert.ok(got.includes('ctx-remove-queue'))
  assert.equal(byId({ kind: 'queue-item' }, 'ctx-remove-queue').danger, false)
})

test('a liked row offers to unlike, worded as a list removal', () => {
  const it = byId({ kind: 'liked-track', hasPath: true }, 'ctx-unlike')
  assert.equal(it.label, 'Remove from Liked Songs')
  assert.equal(it.danger, false)
})

test('list removal and disk deletion are both offered, and clearly different', () => {
  const items = M.menuItemsFor({ kind: 'playlist-track', listName: 'Mix', hasPath: true })
  const remove = items.find(i => i.id === 'ctx-remove-playlist')
  const trash = items.find(i => i.id === 'ctx-trash')
  assert.ok(remove && trash, 'both must be available — they are different intents')
  assert.equal(remove.danger, false)
  assert.equal(trash.danger, true)
  assert.match(trash.label, /Trash/)
  assert.doesNotMatch(remove.label, /Trash|Delete/)
})

test('danger is set for disk deletion and NOTHING else', () => {
  const kinds = ['album', 'track', 'playlist-track', 'queue-item', 'liked-track', 'artist', 'folder-node', 'search-result']
  for (const kind of kinds) {
    for (const it of M.menuItemsFor({ kind, artist: 'X', hasPath: true, listName: 'L' })) {
      assert.equal(it.danger, M.DISK_SCOPED[it.id] === true,
        `${kind}/${it.id}: danger must mean disk-scoped and nothing else`)
    }
  }
})

test('a stream (YouTube) row never offers a disk delete', () => {
  const got = ids({ kind: 'yt-track', artist: 'X' })
  assert.ok(!got.includes('ctx-trash'))
  assert.ok(!got.includes('ctx-show-folder'))
  assert.ok(!got.includes('ctx-copy-path'))
})

test('an item with no path on disk never offers disk actions', () => {
  const got = ids({ kind: 'playlist-track', hasPath: false, listName: 'Mix' })
  assert.ok(!got.includes('ctx-trash'))
  assert.ok(got.includes('ctx-remove-playlist'), 'it can still leave the playlist')
})

test('albums now DO offer Show in folder (it silently did nothing before)', () => {
  const got = ids({ kind: 'album', artist: 'Pink Floyd', hasPath: true })
  assert.ok(got.includes('ctx-show-folder'))
})

test('only albums carry the like toggle, and it reflects current state', () => {
  assert.equal(byId({ kind: 'album', hasPath: true, isLiked: false }, 'ctx-like').label, 'Like')
  assert.equal(byId({ kind: 'album', hasPath: true, isLiked: true }, 'ctx-like').label, 'Unlike')
  assert.ok(!ids({ kind: 'track', hasPath: true }).includes('ctx-like'))
})

test('a folder node offers folder actions but no playback or playlist actions', () => {
  const got = ids({ kind: 'folder-node', hasPath: true })
  assert.deepEqual(got, ['ctx-rename', 'ctx-move', 'ctx-copy-path', 'ctx-show-folder', 'ctx-trash'])
})

test('View artist is hidden when the artist is unknown, and on the artist page', () => {
  assert.ok(!ids({ kind: 'track', hasPath: true }).includes('ctx-artist'))
  assert.ok(!ids({ kind: 'artist', artist: 'X', hasPath: true }).includes('ctx-artist'))
  assert.ok(ids({ kind: 'track', artist: 'X', hasPath: true }).includes('ctx-artist'))
})

test('confirmation wording matches what was actually clicked', () => {
  assert.match(M.deleteTitleFor({ kind: 'album' }, 12), /this album/)
  assert.match(M.deleteTitleFor({ kind: 'artist' }, 400), /everything by this artist/)
  assert.match(M.deleteTitleFor({ kind: 'folder-node' }, 9), /this folder/)
  assert.equal(M.deleteTitleFor({ kind: 'track' }, 1), 'Move 1 file to Trash?')
  assert.equal(M.deleteTitleFor({ kind: 'track' }, 3), 'Move 3 files to Trash?')
})

test('every item has a non-empty label', () => {
  for (const kind of ['album', 'track', 'playlist-track', 'queue-item', 'liked-track', 'artist', 'folder-node']) {
    for (const it of M.menuItemsFor({ kind, artist: 'X', hasPath: true })) {
      assert.ok(it.label && it.label.length, `${kind}/${it.id} has no label`)
    }
  }
})

test('only things that ARE a folder offer rename and move', () => {
  // A track inside an album is not a folder; offering "Rename folder" there
  // would rename the album out from under the rest of its tracks.
  for (const kind of ['album', 'folder-node']) {
    const got = ids({ kind, artist: 'X', hasPath: true })
    assert.ok(got.includes('ctx-rename'), kind)
    assert.ok(got.includes('ctx-move'), kind)
  }
  for (const kind of ['track', 'playlist-track', 'queue-item', 'liked-track', 'artist', 'search-result']) {
    const got = ids({ kind, artist: 'X', hasPath: true, listName: 'L' })
    assert.ok(!got.includes('ctx-rename'), kind + ' must not offer rename')
    assert.ok(!got.includes('ctx-move'), kind + ' must not offer move')
  }
})

test('rename and move are not marked destructive', () => {
  for (const id of ['ctx-rename', 'ctx-move']) {
    assert.equal(byId({ kind: 'album', hasPath: true }, id).danger, false)
  }
})

test('anything file-backed can be retagged; a bare folder cannot', () => {
  // Tags live in files. A folder node has no file to write to.
  for (const kind of ['album', 'track', 'playlist-track', 'liked-track', 'search-result']) {
    assert.ok(ids({ kind, artist: 'X', hasPath: true, listName: 'L' }).includes('ctx-edit-tags'), kind)
  }
  assert.ok(!ids({ kind: 'folder-node', hasPath: true }).includes('ctx-edit-tags'))
  assert.ok(!ids({ kind: 'yt-track', artist: 'X' }).includes('ctx-edit-tags'))
})

test('editing tags is not marked destructive', () => {
  assert.equal(byId({ kind: 'album', hasPath: true }, 'ctx-edit-tags').danger, false)
})
