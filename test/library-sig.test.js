const test = require('node:test')
const assert = require('node:assert')
const S = require('../src/library-sig')

function album(id, paths) {
  return { id, tracks: paths.map(p => ({ filePath: p })) }
}

test('removing a track from a SURVIVING album changes the signature', () => {
  // The original bug: the old signature was album ids only, so this case
  // compared equal and the deleted track stayed on screen.
  const before = [album('a', ['/m/x/1.flac', '/m/x/2.flac'])]
  const after = [album('a', ['/m/x/1.flac'])]
  assert.notEqual(S.librarySignature(before), S.librarySignature(after))
})

test('reordering the same tracks is not a change', () => {
  const before = [album('a', ['/m/x/1.flac', '/m/x/2.flac'])]
  const after = [album('a', ['/m/x/2.flac', '/m/x/1.flac'])]
  assert.equal(S.librarySignature(before), S.librarySignature(after))
})

test('reordering albums is not a change', () => {
  const a = album('a', ['/m/a.flac'])
  const b = album('b', ['/m/b.flac'])
  assert.equal(S.librarySignature([a, b]), S.librarySignature([b, a]))
})

test('adding an album changes the signature', () => {
  const before = [album('a', ['/m/a.flac'])]
  const after = [album('a', ['/m/a.flac']), album('b', ['/m/b.flac'])]
  assert.notEqual(S.librarySignature(before), S.librarySignature(after))
})

test('two different paths of the same length still differ', () => {
  // Guards against a digest that only sums lengths.
  const before = [album('a', ['/m/aaa.flac'])]
  const after = [album('a', ['/m/bbb.flac'])]
  assert.notEqual(S.librarySignature(before), S.librarySignature(after))
})

test('diff reports the exact removed paths', () => {
  const before = [album('a', ['/m/1.flac', '/m/2.flac', '/m/3.flac'])]
  const after = [album('a', ['/m/2.flac'])]
  const d = S.libraryDiff(before, after)
  assert.deepEqual(d.removedPaths, ['/m/1.flac', '/m/3.flac'])
  assert.deepEqual(d.changedAlbums, ['a'])
  assert.deepEqual(d.removedAlbums, [])
  assert.equal(d.changed, true)
})

test('diff reports a whole album disappearing, with all its paths', () => {
  const before = [album('a', ['/m/1.flac']), album('b', ['/m/2.flac', '/m/3.flac'])]
  const after = [album('a', ['/m/1.flac'])]
  const d = S.libraryDiff(before, after)
  assert.deepEqual(d.removedAlbums, ['b'])
  assert.deepEqual(d.removedPaths, ['/m/2.flac', '/m/3.flac'])
})

test('a file moved between albums is not reported as removed', () => {
  // It still exists on disk, so pruning must not treat it as gone.
  const before = [album('a', ['/m/1.flac'])]
  const after = [album('b', ['/m/1.flac'])]
  const d = S.libraryDiff(before, after)
  assert.deepEqual(d.removedPaths, [])
  assert.deepEqual(d.removedAlbums, ['a'])
  assert.deepEqual(d.addedAlbums, ['b'])
})

test('an identical library reports no change', () => {
  const lib = [album('a', ['/m/1.flac', '/m/2.flac'])]
  const d = S.libraryDiff(lib, lib.map(a => album(a.id, S.trackPaths(a))))
  assert.equal(d.changed, false)
})

test('empty and missing inputs are safe', () => {
  assert.equal(S.librarySignature(null), '0:')
  assert.equal(S.librarySignature([]), '0:')
  assert.deepEqual(S.libraryDiff(null, null).removedPaths, [])
  assert.deepEqual(S.trackPaths({ tracks: [{}, { filePath: '/m/1.flac' }] }), ['/m/1.flac'])
})
