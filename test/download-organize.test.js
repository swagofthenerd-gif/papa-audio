'use strict'
// The pure verification/organize logic (roadmap #49 + #50): folder grouping,
// verdict shapes, target-path building and collision-safe move planning.
const test = require('node:test')
const assert = require('node:assert')

const org = require('../src/download-organize')

test('folderPathOf and groupKey handle both path separators', () => {
  assert.strictEqual(org.folderPathOf('Music\\Artist - Album\\01.flac'), 'Music/Artist - Album')
  assert.strictEqual(org.folderOf('a/b/Artist - Album/02.flac'), 'Artist - Album')
  assert.strictEqual(org.groupKey('bob', 'x/Album/1.flac'), 'bob::x/Album')
})

test('surroundLabel recognises the common tokens', () => {
  assert.strictEqual(org.surroundLabel('DSOTM [5.1] FLAC'), '5.1')
  assert.strictEqual(org.surroundLabel('Album 7 1 remix'), '7.1')
  assert.strictEqual(org.surroundLabel('Atmos edition'), 'surround')
  assert.strictEqual(org.surroundLabel('plain stereo album'), null)
})

test('buildGroups counts the enqueued tracks per folder', () => {
  const groups = org.buildGroups([
    { username: 'u', filename: 'X/Pink Floyd - Meddle/01.flac' },
    { username: 'u', filename: 'X/Pink Floyd - Meddle/02.flac' },
    { username: 'u', filename: 'X/Other - Album/01.flac' },
    { username: 'u', filename: 'loose.flac' },   // no folder — ignored
  ])
  assert.strictEqual(groups.size, 2)
  const meddle = groups.get('u::X/Pink Floyd - Meddle')
  assert.strictEqual(meddle.expected, 2)
  assert.strictEqual(meddle.folder, 'Pink Floyd - Meddle')
})

test('a surround label on any file promotes the whole group', () => {
  const groups = org.buildGroups([
    { username: 'u', filename: 'A/Album 5.1/01.flac' },
    { username: 'u', filename: 'A/Album 5.1/02.flac' },
  ])
  assert.strictEqual(groups.get('u::A/Album 5.1').surroundLabel, '5.1')
})

test('isGroupComplete only when every enqueued file succeeded', () => {
  const groups = org.buildGroups([
    { username: 'u', filename: 'A/Alb/1.flac' },
    { username: 'u', filename: 'A/Alb/2.flac' },
  ])
  const g = groups.get('u::A/Alb')
  assert.strictEqual(org.isGroupComplete(g, new Set(['A/Alb/1.flac'])), false)
  assert.strictEqual(org.isGroupComplete(g, new Set(['A/Alb/1.flac', 'A/Alb/2.flac'])), true)
})

test('verdict shape: clean album', () => {
  const v = org.verdict([
    { filename: '1.flac', ok: true, channels: 2 },
    { filename: '2.flac', ok: true, channels: 2 },
  ], 2, null)
  assert.deepStrictEqual(v, { ok: true, problems: [] })
})

test('verdict flags a corrupt (unprobeable) file', () => {
  const v = org.verdict([
    { filename: '1.flac', ok: true, channels: 2 },
    { filename: '2.flac', ok: false, channels: 0 },
  ], 2, null)
  assert.strictEqual(v.ok, false)
  assert.deepStrictEqual(v.problems, [{ type: 'corrupt', filename: '2.flac' }])
})

test('verdict flags a missing track against the enqueued count', () => {
  const v = org.verdict([{ filename: '1.flac', ok: true, channels: 2 }], 3, null)
  assert.strictEqual(v.ok, false)
  assert.deepStrictEqual(v.problems, [{ type: 'missing', expected: 3, found: 1 }])
})

test('verdict flags a stereo track hiding in a surround-labelled album', () => {
  const v = org.verdict([
    { filename: '1.flac', ok: true, channels: 6 },
    { filename: '2.flac', ok: true, channels: 2 },   // the offender
  ], 2, '5.1')
  assert.strictEqual(v.ok, false)
  assert.deepStrictEqual(v.problems, [
    { type: 'channels', filename: '2.flac', channels: 2, label: '5.1' },
  ])
})

test('targetFolderName builds "Artist - Album" and sanitizes', () => {
  assert.strictEqual(org.targetFolderName({ artist: 'AC/DC', album: 'Back: In Black' }, 'orig'),
    'AC DC - Back In Black')
  assert.strictEqual(org.targetFolderName({ artist: '', album: 'Only Album' }, 'orig'), 'Only Album')
  // Nothing usable → fall back to the original folder name.
  assert.strictEqual(org.targetFolderName({ artist: '', album: '' }, 'Fallback Folder'), 'Fallback Folder')
})

test('planMoves builds destinations under the target folder', () => {
  const { targetDir, moves } = org.planMoves({
    files: ['/dl/loosefolder/01.flac', '/dl/loosefolder/02.flac'],
    downloadRoot: '/dl',
    targetName: 'Miles - Kind of Blue',
    pathJoin: require('path').join,
    basename: require('path').basename,
  })
  assert.strictEqual(targetDir, '/dl/Miles - Kind of Blue')
  assert.deepStrictEqual(moves, [
    { from: '/dl/loosefolder/01.flac', to: '/dl/Miles - Kind of Blue/01.flac' },
    { from: '/dl/loosefolder/02.flac', to: '/dl/Miles - Kind of Blue/02.flac' },
  ])
})

test('planMoves skips a file already sitting in its destination', () => {
  const { moves } = org.planMoves({
    files: ['/dl/Miles - Kind of Blue/01.flac'],
    downloadRoot: '/dl',
    targetName: 'Miles - Kind of Blue',
    pathJoin: require('path').join,
    basename: require('path').basename,
  })
  assert.deepStrictEqual(moves, [])
})
