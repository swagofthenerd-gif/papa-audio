const test = require('node:test')
const assert = require('node:assert')
const H = require('../src/library-health')

const find = (list, id) => list.find(f => f.id === id)
const album = (id, over = {}) => Object.assign({ id, artist: 'A', name: 'B', tracks: [] }, over)

test('cover art and .cue files are NEVER treated as junk', () => {
  // The scanner parses .cue, and folder art is displayed — sweeping all
  // non-audio would delete things the app depends on.
  assert.equal(H.classifyFile('/m/folder.jpg'), 'artwork')
  assert.equal(H.classifyFile('/m/cover.png'), 'artwork')
  assert.equal(H.classifyFile('/m/album.cue'), 'keep')
  assert.equal(H.classifyFile('/m/song.lrc'), 'keep')
})

test('installers and rip artefacts are junk', () => {
  for (const p of ['/m/Setup.exe', '/m/x.nfo', '/m/rip.log', '/m/a.accurip', '/m/x.zip', '/m/notes.txt']) {
    assert.equal(H.classifyFile(p), 'junk', p)
  }
})

test('audio is audio, whatever the container', () => {
  for (const p of ['/m/a.flac', '/m/a.MP3', '/m/a.m4a', '/m/a.opus', '/m/a.dts', '/m/a.ac3']) {
    assert.equal(H.classifyFile(p), 'audio', p)
  }
})

test('playlists are their own category, not junk', () => {
  assert.equal(H.classifyFile('/m/list.m3u'), 'playlist')
  const f = H.assessLibrary([], { nonAudio: [{ path: '/m/list.m3u', bytes: 100 }] })
  assert.equal(find(f, 'junk'), undefined)
  assert.equal(find(f, 'playlists').severity, 'low')
})

test('zero-byte audio is flagged high, and is offered for removal', () => {
  const f = H.assessLibrary([album('a', { tracks: [
    { filePath: '/m/ok.flac', fileSize: 5e6, channels: 2, duration: 200 },
    { filePath: '/m/dead.flac', fileSize: 0, channels: 0, duration: 0 },
  ]})], {})
  const broken = find(f, 'broken')
  assert.equal(broken.severity, 'high')
  assert.deepEqual(broken.paths, ['/m/dead.flac'])
  assert.equal(broken.fixAction.kind, 'trash')
})

test('a file with no channels and no duration counts as broken even if sized', () => {
  const f = H.assessLibrary([album('a', { tracks: [
    { filePath: '/m/x.flac', fileSize: 9e6, channels: 0, duration: 0 },
  ]})], {})
  assert.deepEqual(find(f, 'broken').paths, ['/m/x.flac'])
})

test('a healthy track is never flagged', () => {
  const f = H.assessLibrary([album('a', { tracks: [
    { filePath: '/m/ok.flac', fileSize: 30e6, channels: 6, duration: 300, trackNumber: 1 },
  ]})], {})
  assert.equal(find(f, 'broken'), undefined)
})

test('tag problems are REPORTED but never auto-fixable', () => {
  // Deleting an untagged album would be the opposite of what the user wants.
  const f = H.assessLibrary([album('a', { artist: 'Unknown Artist', name: 'Unknown Album' })], {})
  const u = find(f, 'untagged')
  assert.equal(u.fixAction, null, 'must not offer a destructive fix')
  assert.deepEqual(u.paths, ['a'])
})

test('mixed channel layouts and track-number gaps are reported, not fixed', () => {
  const mixed = H.assessLibrary([album('a', { tracks: [
    { filePath: '/m/1.flac', channels: 2, fileSize: 1e6, duration: 9, trackNumber: 1 },
    { filePath: '/m/2.flac', channels: 6, fileSize: 1e6, duration: 9, trackNumber: 2 },
  ]})], {})
  assert.equal(find(mixed, 'mixed-channels').fixAction, null)

  const gappy = H.assessLibrary([album('b', { tracks: [
    { filePath: '/m/1.flac', channels: 2, fileSize: 1e6, duration: 9, trackNumber: 1 },
    { filePath: '/m/5.flac', channels: 2, fileSize: 1e6, duration: 9, trackNumber: 5 },
  ]})], {})
  assert.equal(find(gappy, 'missing-tracks').count, 1)
})

test('a complete album with sequential numbering has no gap finding', () => {
  const f = H.assessLibrary([album('a', { tracks: [1, 2, 3].map(n => (
    { filePath: '/m/' + n + '.flac', channels: 2, fileSize: 1e6, duration: 9, trackNumber: n })) })], {})
  assert.equal(find(f, 'missing-tracks'), undefined)
})

test('empty folders and orphaned partials are both offered for removal', () => {
  const f = H.assessLibrary([], {
    emptyDirs: ['/m/gone'],
    partials: [{ path: '/inc/a.part', bytes: 5e9 }],
  })
  assert.equal(find(f, 'empty-dirs').fixAction.kind, 'trash')
  assert.equal(find(f, 'partials').bytes, 5e9)
})

test('findings sort worst-first', () => {
  const f = H.assessLibrary([album('a', {
    artist: 'Unknown Artist',
    tracks: [{ filePath: '/m/d.flac', fileSize: 0, channels: 0, duration: 0 }],
  })], { emptyDirs: ['/m/x'] })
  assert.equal(f[0].severity, 'high')
  assert.equal(f[f.length - 1].severity, 'low')
})

test('reclaimable counts only what can actually be fixed', () => {
  const f = H.assessLibrary([album('a', { artist: 'Unknown Artist' })], {
    nonAudio: [{ path: '/m/Setup.exe', bytes: 1000 }],
  })
  assert.equal(H.reclaimable(f), 1000, 'tag findings contribute nothing')
})

test('an entirely healthy library reports nothing', () => {
  const f = H.assessLibrary([album('a', { tracks: [
    { filePath: '/m/1.flac', fileSize: 30e6, channels: 2, duration: 200, trackNumber: 1 },
  ]})], { nonAudio: [{ path: '/m/cover.jpg', bytes: 500 }] })
  assert.deepEqual(f, [])
})
