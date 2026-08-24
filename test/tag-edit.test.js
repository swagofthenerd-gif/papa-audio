const test = require('node:test')
const assert = require('node:assert')
const T = require('../src/tag-edit')

const M = T.MIXED

test('the album key matches how main derives album ids', () => {
  // If this drifts, every edit mints an id nothing else recognises.
  assert.equal(T.albumKeyOf({ albumArtist: 'Pink Floyd', album: 'Animals' }), 'pink floyd_animals')
  assert.equal(T.albumKeyOf({ artist: 'Pink Floyd', album: 'Animals' }), 'pink floyd_animals')
  assert.equal(T.albumKeyOf({ albumArtist: 'PINK FLOYD', album: 'ANIMALS' }), 'pink floyd_animals')
})

test('album artist wins over artist, as it does in the scanner', () => {
  assert.equal(T.albumKeyOf({ albumArtist: 'Various', artist: 'Someone', album: 'X' }), 'various_x')
})

test('only changed fields are written', () => {
  const orig = { title: 'A', artist: 'B', album: 'C' }
  assert.deepEqual(T.diffTags(orig, { title: 'A', artist: 'Z' }), { artist: 'Z' })
  assert.deepEqual(T.diffTags(orig, { title: 'A' }), {})
})

test('a field left as MIXED is never written', () => {
  // Otherwise editing one field of a multi-track selection would stamp an
  // em dash into every other tag.
  const out = T.diffTags({ title: 'A', artist: 'B' }, { title: M, artist: 'Z' })
  assert.deepEqual(out, { artist: 'Z' })
})

test('clearing a field to empty IS a change', () => {
  assert.deepEqual(T.diffTags({ genre: 'Rock' }, { genre: '' }), { genre: '' })
})

test('unknown fields are ignored rather than written blindly', () => {
  assert.deepEqual(T.diffTags({}, { title: 'A', bogus: 'x' }), { title: 'A' })
})

test('shared values show through, differing ones come back as MIXED', () => {
  const c = T.commonTags([
    { artist: 'Pink Floyd', album: 'Animals', title: 'Dogs' },
    { artist: 'Pink Floyd', album: 'Animals', title: 'Pigs' },
  ])
  assert.equal(c.artist, 'Pink Floyd')
  assert.equal(c.album, 'Animals')
  assert.equal(c.title, M)
})

test('bulk apply skips files that would not change', () => {
  const tracks = [
    { filePath: '/a.flac', artist: 'Old' },
    { filePath: '/b.flac', artist: 'New' },
  ]
  const out = T.bulkApply(tracks, { artist: 'New' })
  assert.deepEqual(out, [{ filePath: '/a.flac', tags: { artist: 'New' } }])
})

test('renumbering writes 1..N in list order, skipping files already correct', () => {
  const tracks = [
    { filePath: '/a.flac', track: '7' },   // -> 1
    { filePath: '/b.flac', track: '' },    // -> 2
    { filePath: '/c.flac', track: '3' },   // already 3, left alone
  ]
  const out = T.bulkApply(tracks, {}, { renumber: true })
  assert.deepEqual(out, [
    { filePath: '/a.flac', tags: { track: '1' } },
    { filePath: '/b.flac', tags: { track: '2' } },
  ])
})

test('renumbering leaves a file alone when its number is already right', () => {
  const out = T.bulkApply([{ filePath: '/a.flac', track: '1' }], {}, { renumber: true })
  assert.deepEqual(out, [], 'no rewrite means no needless re-encode of a big FLAC')
})

test('changing the artist moves the album identity', () => {
  const m = T.migrationFor(
    { albumArtist: 'Unknown Artist', album: 'Animals' },
    { albumArtist: 'Pink Floyd', album: 'Animals' })
  assert.equal(m.changed, true)
  assert.equal(m.oldKey, 'unknown artist_animals')
  assert.equal(m.newKey, 'pink floyd_animals')
})

test('changing only the track title does NOT move the album identity', () => {
  // No migration should be attempted for an edit that cannot change the id.
  const m = T.migrationFor(
    { albumArtist: 'Pink Floyd', album: 'Animals' },
    { albumArtist: 'Pink Floyd', album: 'Animals' })
  assert.equal(m.changed, false)
})

test('the key after an edit accounts for album artist taking precedence', () => {
  const track = { albumArtist: 'Old AA', artist: 'Old A', album: 'Alb' }
  assert.equal(T.albumKeyAfter(track, { albumartist: 'New AA' }), 'new aa_alb')
  // artist alone must not override an existing album artist
  assert.equal(T.albumKeyAfter(track, { artist: 'New A' }), 'old aa_alb')
  assert.equal(T.albumKeyAfter(track, { album: 'New Alb' }), 'old aa_new alb')
})

test('artist decides the key when there is no album artist', () => {
  const track = { albumArtist: '', artist: 'Old A', album: 'Alb' }
  assert.equal(T.albumKeyAfter(track, { artist: 'New A' }), 'new a_alb')
})

test('a MIXED album artist does not corrupt the key', () => {
  const track = { albumArtist: 'Real', album: 'Alb' }
  assert.equal(T.albumKeyAfter(track, { albumartist: M }), 'real_alb')
})

test('placeholder tag values are recognised', () => {
  assert.equal(T.looksUnknown('Unknown Artist'), true)
  assert.equal(T.looksUnknown(''), true)
  assert.equal(T.looksUnknown('Pink Floyd'), false)
})

test('clearing the album artist falls back to the track artist, not the old value', () => {
  // A cleared field is an edit, not an absence. Treating blank as "untouched"
  // made the migration compute the OLD key, so likes/ratings/artwork detached
  // on the next rescan -- the exact failure this module exists to prevent.
  const track = { albumArtist: 'Various Artists', artist: 'Pink Floyd', album: 'Animals' }
  assert.equal(T.albumKeyAfter(track, { albumartist: '' }), 'pink floyd_animals')
  const m = T.migrationFor(track, { albumArtist: '', artist: 'Pink Floyd', album: 'Animals' })
  assert.equal(m.changed, true)
  assert.equal(m.newKey, 'pink floyd_animals')
})

test('clearing both artist fields is honoured rather than silently ignored', () => {
  const track = { albumArtist: 'Various Artists', artist: 'Pink Floyd', album: 'Animals' }
  assert.equal(T.albumKeyAfter(track, { albumartist: '', artist: '' }), '_animals')
})
