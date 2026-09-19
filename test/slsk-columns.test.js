const test = require('node:test')
const assert = require('node:assert')
const T = require('../src/slsk-tree')
const C = require('../src/slsk-columns')

const dirs = [
  { name: 'Music\\Rock\\Pink Floyd\\1975 WYWH', files: [{ filename: 'Music\\Rock\\Pink Floyd\\1975 WYWH\\01.flac', size: 4e8, bitDepth: 24, sampleRate: 96000 }, { filename: 'Music\\Rock\\Pink Floyd\\1975 WYWH\\02.flac', size: 3e8, bitDepth: 24, sampleRate: 96000 }, { filename: 'Music\\Rock\\Pink Floyd\\1975 WYWH\\rip.log', size: 100 }] },
  { name: 'Music\\Jazz\\Miles', files: [{ filename: 'Music\\Jazz\\Miles\\a.flac', size: 1e8 }] },
]
const tree = T.buildTree(dirs)

test('columnsFor gives one column per path level plus the root', () => {
  const cols = C.columnsFor(tree, 'Music\\Rock\\Pink Floyd', {})
  assert.deepEqual(cols.map(c => c.path), ['', 'Music', 'Music\\Rock', 'Music\\Rock\\Pink Floyd'])
  assert.deepEqual(cols[3].rows.map(r => r.name), ['1975 WYWH'])
})

test('inspectorModel calls a leaf with 2+ audio files an album and lists extras', () => {
  const node = T.getNode(tree, 'Music\\Rock\\Pink Floyd\\1975 WYWH')
  const m = C.inspectorModel(node, new Map())
  assert.equal(m.kind, 'album')
  assert.equal(m.tracks.length, 2)
  assert.equal(m.extras.log, true)
})

test('inspectorModel calls a folder with subfolders a folder with a roll-up', () => {
  const m = C.inspectorModel(T.getNode(tree, 'Music'), new Map())
  assert.equal(m.kind, 'folder')
  assert.equal(m.fileCount, 4)
})

test('inspectorModel for a file carries exact figures', () => {
  const node = T.getNode(tree, 'Music\\Rock\\Pink Floyd\\1975 WYWH')
  const m = C.inspectorModel(node.files[0], new Map())
  assert.equal(m.kind, 'file')
  assert.equal(m.bitDepth, 24)
})

// The search column is only as good as the mapping: a file hit's `path` from
// searchTree is the folder that HOLDS it, and that is where a click must land.
test('searchRows maps folder and file hits to rows a click can navigate', () => {
  const rows = C.searchRows(tree, 'miles')
  const dir = rows.find(r => r.kind === 'dir')
  assert.ok(dir, 'the Miles folder itself is a hit')
  assert.equal(dir.name, 'Miles')
  assert.equal(dir.dirPath, 'Music\\Jazz\\Miles')

  const fileRows = C.searchRows(tree, 'a.flac').filter(r => r.kind === 'file')
  assert.equal(fileRows.length, 1)
  assert.equal(fileRows[0].name, 'a.flac')
  // Not 'Music\\Jazz\\Miles\\a.flac' — navigating to a file path finds nothing.
  assert.equal(fileRows[0].dirPath, 'Music\\Jazz\\Miles')
  assert.equal(fileRows[0].file.size, 1e8)
})

test('surroundRows lists every surround-labelled folder, fullest first', () => {
  const surTree = T.buildTree([
    { name: 'Music\\Dark Side Of The Moon [SACD 5.1]', files: [{ filename: 'x\\1.flac', size: 1 }, { filename: 'x\\2.flac', size: 1 }] },
    { name: 'Music\\Wish You Were Here (DVD-Audio)', files: [{ filename: 'y\\1.flac', size: 1 }] },
    { name: 'Music\\Plain Stereo Album', files: [{ filename: 'z\\1.flac', size: 1 }] },
    { name: 'Music\\Empty 5.1 Folder', files: [] },
  ])
  const detect = s => (/5\.1|SACD|DVD-Audio/i.test(String(s)) ? { kind: 'surround', label: '5.1' } : null)
  const rows = C.surroundRows(surTree, detect)
  assert.deepEqual(rows.map(r => r.name), [
    'Dark Side Of The Moon [SACD 5.1]',
    'Wish You Were Here (DVD-Audio)',
  ])
  assert.equal(rows[0].fileCount, 2)
  assert.equal(rows[0].label, '5.1')
  assert.equal(rows[0].kind, 'dir')
})

test('surroundRows is inert without a detector rather than throwing', () => {
  assert.deepEqual(C.surroundRows(tree, null), [])
})
