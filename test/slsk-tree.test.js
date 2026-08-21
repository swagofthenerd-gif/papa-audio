const test = require('node:test')
const assert = require('node:assert')
const { buildTree, listDir, breadcrumbs, parentPath, searchTree, NavHistory } = require('../src/slsk-tree')

// Shaped like a real slskd browse response: full paths, basenames inside.
const DIRS = [
  { name: 'Music\\Rock\\Pink Floyd\\DSOTM', files: [
      { filename: '01 Speak to Me.flac', size: 1000 },
      { filename: '02 Breathe.flac', size: 2000 },
      { filename: 'cover.jpg', size: 50 } ] },
  { name: 'Music\\Rock\\Pink Floyd\\Animals', files: [{ filename: '01 Pigs.flac', size: 3000 }] },
  { name: 'Music\\Jazz\\Miles Davis\\Kind of Blue', files: [{ filename: '01 So What.mp3', size: 500 }] },
  { name: 'Music\\Rock', files: [{ filename: 'readme.txt', size: 10 }] },
]

test('rebuilds the hierarchy from flat full paths', () => {
  const t = buildTree(DIRS)
  assert.deepEqual(listDir(t, '').dirs.map(d => d.name), ['Music'])
  assert.deepEqual(listDir(t, 'Music').dirs.map(d => d.name), ['Jazz', 'Rock'])
  assert.deepEqual(listDir(t, 'Music\\Rock\\Pink Floyd').dirs.map(d => d.name), ['Animals', 'DSOTM'])
})

test('counts and sizes roll up through the tree', () => {
  const t = buildTree(DIRS)
  const music = listDir(t, '').dirs[0]
  assert.equal(music.fileCount, 6)          // 3 (DSOTM) + 1 (Animals) + 1 (Jazz) + 1 (readme)
  assert.equal(music.totalSize, 6560)
  const pf = listDir(t, 'Music\\Rock').dirs.find(d => d.name === 'Pink Floyd')
  assert.equal(pf.fileCount, 4)
})

test('files land in their own folder, with a downloadable full path', () => {
  const t = buildTree(DIRS)
  const l = listDir(t, 'Music\\Rock\\Pink Floyd\\DSOTM')
  assert.deepEqual(l.files.map(f => f.name), ['01 Speak to Me.flac', '02 Breathe.flac', 'cover.jpg'])
  assert.equal(l.files[0].fullPath, 'Music\\Rock\\Pink Floyd\\DSOTM\\01 Speak to Me.flac')
})

test('audioOnly hides the cover art and text files', () => {
  const t = buildTree(DIRS)
  const l = listDir(t, 'Music\\Rock\\Pink Floyd\\DSOTM', { audioOnly: true })
  assert.deepEqual(l.files.map(f => f.name), ['01 Speak to Me.flac', '02 Breathe.flac'])
})

test('a folder can hold both files and subfolders', () => {
  const t = buildTree(DIRS)
  const l = listDir(t, 'Music\\Rock')
  assert.deepEqual(l.dirs.map(d => d.name), ['Pink Floyd'])
  assert.deepEqual(l.files.map(f => f.name), ['readme.txt'])
})

test('unknown paths return null rather than throwing', () => {
  assert.equal(listDir(buildTree(DIRS), 'Nope\\Nothing'), null)
})

test('breadcrumbs and parent', () => {
  assert.deepEqual(breadcrumbs('Music\\Rock').map(b => b.name), ['Library', 'Music', 'Rock'])
  assert.deepEqual(breadcrumbs('Music\\Rock').map(b => b.path), ['', 'Music', 'Music\\Rock'])
  assert.equal(parentPath('Music\\Rock\\Pink Floyd'), 'Music\\Rock')
  assert.equal(parentPath('Music'), '')
  assert.equal(listDir(buildTree(DIRS), '').parent, null)   // root has no parent
})

test('sorting by size puts the biggest first', () => {
  const t = buildTree(DIRS)
  const l = listDir(t, 'Music\\Rock\\Pink Floyd\\DSOTM', { sort: 'size' })
  assert.deepEqual(l.files.map(f => f.size), [2000, 1000, 50])
})

test('history behaves like a browser', () => {
  const h = new NavHistory('')
  assert.equal(h.canBack, false)
  h.go('Music'); h.go('Music\\Rock')
  assert.equal(h.current, 'Music\\Rock')
  assert.equal(h.back(), 'Music')
  assert.equal(h.canForward, true)
  assert.equal(h.forward(), 'Music\\Rock')
  assert.equal(h.back(), 'Music')
  h.go('Music\\Jazz')                       // new branch discards the forward tail
  assert.equal(h.canForward, false)
  assert.equal(h.back(), 'Music')
})

test('history ignores navigating to where you already are', () => {
  const h = new NavHistory('')
  h.go('Music'); h.go('Music')
  assert.equal(h.stack.length, 2)
  assert.equal(h.back(), '')
  assert.equal(h.back(), '')                // clamps at the start
})

test('search spans the whole tree, not just one folder', () => {
  const t = buildTree(DIRS)
  const hits = searchTree(t, 'pink floyd')
  assert.ok(hits.some(h => h.type === 'dir' && h.name === 'Pink Floyd'))
  const files = searchTree(t, 'breathe')
  assert.equal(files[0].type, 'file')
  assert.equal(files[0].name, '02 Breathe.flac')
  assert.deepEqual(searchTree(t, ''), [])
})

test('search respects the result limit', () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ name: `D${i}\\match`, files: [] }))
  assert.equal(searchTree(buildTree(many), 'match', 50).length, 50)
})

test('forward-slash paths from some clients are handled too', () => {
  const t = buildTree([{ name: 'Music/Rock/Album', files: [{ filename: 'a.flac' }] }])
  assert.deepEqual(listDir(t, 'Music\\Rock').dirs.map(d => d.name), ['Album'])
})

test('the explorer is wired into the renderer', () => {
  const fs = require('fs'), path = require('path')
  const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8')
  assert.ok(html.indexOf('slsk-tree.js') < html.indexOf('renderer.js'),
    'slsk-tree.js must load before renderer.js')
  const src = fs.readFileSync(path.join(__dirname, '../src/slsk-tree.js'), 'utf8')
  assert.ok(src.includes('window.PapaSlskTree'), 'renderer cannot require(), needs the global')
  const r = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8')
  assert.ok(r.includes('showSlskUserExplorer'), 'explorer must exist')
  for (const id of ['slskx-back', 'slskx-fwd', 'slskx-up', 'slskx-crumbs', 'slskx-search']) {
    assert.ok(r.includes(id), 'missing control: ' + id)
  }
  // Every entry point must open the explorer, not the old flat list.
  assert.equal((r.match(/showSlskUserLibrary\((u|username)\)/g) || []).length, 0,
    'all call sites should use the explorer')
})

test('folders differing only in case are one folder, not two', () => {
  // Real data from a live browse: "Dark The Suns" and "Dark the Suns" both
  // exist. Treating them as siblings splits an album, and the files look
  // missing from whichever one you happen to open.
  const t = buildTree([
    { name: 'Music\\Dark The Suns\\Album', files: [{ filename: 'a.flac', size: 1 }] },
    { name: 'Music\\Dark the Suns\\Album', files: [{ filename: 'b.flac', size: 1 }] },
  ])
  const l = listDir(t, 'Music')
  assert.equal(l.dirs.length, 1, 'should be one folder, not two')
  const album = listDir(t, l.dirs[0].path + '\\Album')
  assert.deepEqual(album.files.map(f => f.name).sort(), ['a.flac', 'b.flac'])
})

test('the download path keeps the casing the peer actually uses', () => {
  // Merging for display must not corrupt the path we send back to the peer.
  const t = buildTree([
    { name: 'Music\\ARTIST', files: [{ filename: 'x.flac', size: 1 }] },
    { name: 'Music\\artist', files: [{ filename: 'y.flac', size: 1 }] },
  ])
  const files = listDir(t, 'Music\\ARTIST').files
  assert.equal(files.find(f => f.name === 'x.flac').fullPath, 'Music\\ARTIST\\x.flac')
  assert.equal(files.find(f => f.name === 'y.flac').fullPath, 'Music\\artist\\y.flac')
})

test('audio-only keeps every audio format, not just the common ones', () => {
  const { AUDIO_RE } = require('../src/slsk-tree')
  for (const e of ['mp3','flac','wav','aiff','aif','m4a','m4b','aac','ogg','oga','opus',
                   'ape','wv','wma','dsf','dff','mka','ec3','alac','mpc','tta','shn',
                   'ac3','dts','spx','caf','w64']) {
    assert.ok(AUDIO_RE.test('song.' + e), e + ' should count as audio')
  }
  for (const e of ['jpg','png','cue','log','txt','part','m3u','toc','info','accurip','nfo','sfv']) {
    assert.ok(!AUDIO_RE.test('file.' + e), e + ' should not count as audio')
  }
})
