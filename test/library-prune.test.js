const test = require('node:test')
const assert = require('node:assert')
const P = require('../src/library-prune')

const gone = (...p) => P.buildRemap(p, [])
const moved = (from, to) => P.buildRemap([], [{ from, to }])

test('liked tracks drop deleted paths and follow renamed ones', () => {
  const del = P.pruneLikedTracks(['/a', '/b'], gone('/a'))
  assert.deepEqual(del.value, ['/b'])
  assert.equal(del.removed, 1)

  const mv = P.pruneLikedTracks(['/a', '/b'], moved('/a', '/z'))
  assert.deepEqual(mv.value, ['/z', '/b'])
  assert.equal(mv.renamed, 1)
})

test('play counts MERGE on rename rather than clobbering', () => {
  // The same song, same plays — losing them to a folder rename is a real loss.
  const r = P.prunePlayCounts({ '/a': 3, '/z': 2 }, moved('/a', '/z'))
  assert.equal(r.value['/z'], 5)
})

test('play history drops deleted entries and keeps their other fields on rename', () => {
  const hist = [{ filePath: '/a', title: 'A', ts: 1 }, { filePath: '/b', ts: 2 }]
  const del = P.prunePlayHistory(hist, gone('/b'))
  assert.deepEqual(del.value.map(e => e.filePath), ['/a'])

  const mv = P.prunePlayHistory(hist, moved('/a', '/z'))
  assert.equal(mv.value[0].filePath, '/z')
  assert.equal(mv.value[0].title, 'A', 'other fields must survive the remap')
  assert.equal(mv.value[0].ts, 1)
})

test('an emptied playlist is KEPT, never auto-deleted', () => {
  const pls = [{ id: 'p1', name: 'Road Trip', tracks: [{ filePath: '/a' }] }]
  const r = P.prunePlaylists(pls, gone('/a'))
  assert.equal(r.value.length, 1, 'the playlist itself must survive')
  assert.deepEqual(r.value[0].tracks, [])
  assert.deepEqual(r.affected, [{ id: 'p1', name: 'Road Trip', removed: 1, renamed: 0 }])
})

test('playlists report per-playlist counts so the user can be told which', () => {
  const pls = [
    { id: 'p1', name: 'A', tracks: [{ filePath: '/a' }, { filePath: '/b' }] },
    { id: 'p2', name: 'B', tracks: [{ filePath: '/c' }] },
  ]
  const r = P.prunePlaylists(pls, gone('/a', '/b'))
  assert.equal(r.affected.length, 1)
  assert.equal(r.affected[0].name, 'A')
  assert.equal(r.affected[0].removed, 2)
})

test('YouTube entries with no filePath are never touched', () => {
  const pls = [{ id: 'p', name: 'Mix', tracks: [{ videoId: 'yt1' }, { filePath: '/a' }] }]
  const r = P.prunePlaylists(pls, gone('/a'))
  assert.equal(r.value[0].tracks.length, 1)
  assert.equal(r.value[0].tracks[0].videoId, 'yt1')
})

test('the _auto saved queue is pruned like any other, and its index clamped', () => {
  const qs = [{ id: '_auto', name: 'Session', index: 2, tracks: [{ filePath: '/a' }, { filePath: '/b' }, { filePath: '/c' }] }]
  const r = P.pruneSavedQueues(qs, gone('/b', '/c'))
  assert.equal(r.value[0].tracks.length, 1)
  assert.equal(r.value[0].index, 0, 'index must stay inside the shortened list')
  assert.equal(r.affected[0].id, '_auto')
})

test('resume state is cleared on delete and follows on rename', () => {
  assert.equal(P.prunePlaybackState({ filePath: '/a', position: 30 }, gone('/a')).value, null)
  const mv = P.prunePlaybackState({ filePath: '/a', position: 30 }, moved('/a', '/z'))
  assert.equal(mv.value.filePath, '/z')
  assert.equal(mv.value.position, 30, 'position must survive a move')
})

test('untouched state is returned unchanged', () => {
  const snap = {
    likedTracks: ['/keep'], playCounts: { '/keep': 1 },
    playHistory: [{ filePath: '/keep' }], playlists: [{ id: 'p', name: 'P', tracks: [{ filePath: '/keep' }] }],
    savedQueues: [], playbackState: { filePath: '/keep', position: 1 },
  }
  const r = P.pruneAll(snap, gone('/other'))
  assert.equal(r.summary.touched, 0)
  assert.deepEqual(r.next.likedTracks, ['/keep'])
  assert.equal(r.next.playbackState.filePath, '/keep')
})

test('pruneAll covers all seven stores in one pass', () => {
  const snap = {
    likedTracks: ['/a'], playCounts: { '/a': 4 }, playHistory: [{ filePath: '/a' }],
    playlists: [{ id: 'p', name: 'P', tracks: [{ filePath: '/a' }] }],
    savedQueues: [{ id: '_auto', name: 'S', index: 0, tracks: [{ filePath: '/a' }] }],
    playbackState: { filePath: '/a', position: 5 },
  }
  const r = P.pruneAll(snap, gone('/a'))
  assert.deepEqual(r.next.likedTracks, [])
  assert.deepEqual(r.next.playCounts, {})
  assert.deepEqual(r.next.playHistory, [])
  assert.deepEqual(r.next.playlists[0].tracks, [])
  assert.deepEqual(r.next.savedQueues[0].tracks, [])
  assert.equal(r.next.playbackState, null)
  assert.equal(r.summary.touched, 6)
})

test('separators are normalized but case is NOT (fuseblk is case-sensitive)', () => {
  assert.equal(P.normalizePath('/m//x\\y.flac'), '/m/x/y.flac')
  const r = P.pruneLikedTracks(['/m/Song.flac'], gone('/m/song.flac'))
  assert.deepEqual(r.value, ['/m/Song.flac'], 'a case difference is a different file')
})

test('the summary reads as plain language, and says nothing when nothing changed', () => {
  const snap = {
    likedTracks: ['/a'], playCounts: {}, playHistory: [],
    playlists: [{ id: 'p', name: 'Road Trip', tracks: [{ filePath: '/a' }] }],
    savedQueues: [], playbackState: null,
  }
  const msg = P.describeSummary(P.pruneAll(snap, gone('/a')).summary)
  assert.match(msg, /1 liked/)
  assert.match(msg, /Road Trip/)
  assert.equal(P.describeSummary(P.pruneAll(snap, gone('/nothing')).summary), '')
})

test('a rename colliding with an existing like dedups in EITHER order', () => {
  // Guarding only the renamed branch left a duplicate whenever the renamed
  // path happened to be listed first. Liked tracks are a set.
  const map = P.buildRemap([], [{ from: '/m/A.flac', to: '/m/B.flac' }])
  assert.deepEqual(P.pruneLikedTracks(['/m/B.flac', '/m/A.flac'], map).value, ['/m/B.flac'])
  assert.deepEqual(P.pruneLikedTracks(['/m/A.flac', '/m/B.flac'], map).value, ['/m/B.flac'])
})

test('a saved queue emptied by a prune gets index -1, not an out-of-bounds 0', () => {
  const map = P.buildRemap(['/m/A.flac'], [])
  const q = P.pruneSavedQueues([{ id: 'q', tracks: [{ filePath: '/m/A.flac' }], index: 0 }], map)
  assert.deepEqual(q.value[0].tracks, [])
  assert.equal(q.value[0].index, -1, 'index 0 against an empty array is out of bounds')
})
