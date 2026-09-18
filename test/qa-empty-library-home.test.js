'use strict'
// L12 — the empty-library state had a dead end and a lie.
//
// 1. Home with state.library = [] printed "No music found / Add FLAC files to
//    your music folder." and nothing to press. Someone who answered the first-run
//    wizard with "Set up later" had no route back to it from the app's front page.
// 2. Liked Songs counted state.likedTracks (the raw saved file PATHS) as
//    "Local Likes", while the list below it only shows the ones the library can
//    resolve — so an empty or unscanned library read "1 Local Likes" over
//    "0 songs". The same wrong divisor also skewed Avg Length.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function lift(source, name) {
  const m = new RegExp(`\\n(async )?function ${name}\\(`).exec(source)
  assert.ok(m, `${name} not found in the renderer`)
  const start = m.index + 1
  const end = source.indexOf('\n}\n', start)
  assert.ok(end > start, `${name} has no closing brace`)
  return source.slice(start, end + 2)
}

// The empty-Home block, evaluated rather than pattern-matched.
function emptyHomeHtml(source, { musicFolders = [] } = {}) {
  const at = source.indexOf('  const allHTML = state.library.length ?')
  assert.ok(at > -1, 'the Your Library / empty branch must still exist')
  const end = source.indexOf('\n\n', at)
  const expr = source.slice(at + '  const allHTML = '.length, end)
  return vm.runInNewContext('(' + expr + ')', {
    state: { library: [], musicFolders },
    albumCard: () => '',
  })
}

// ── 1. The call to action ───────────────────────────────────────────────────

test('empty Home offers a way to add music, not just a statement of fact', () => {
  const html = emptyHomeHtml(RENDERER)
  assert.match(html, /No music found/)
  assert.match(html, /id="home-add-music"/, 'there was nothing to press')
  assert.match(html, /Add your music/)
})

test('the copy tells apart "no folders yet" from "folders with nothing in them"', () => {
  const none = emptyHomeHtml(RENDERER, { musicFolders: [] })
  const some = emptyHomeHtml(RENDERER, { musicFolders: ['/mnt/data/MUSIC'] })
  assert.match(none, /nowhere to look yet/)
  assert.match(some, /Nothing turned up in the folders you added/)
  assert.notStrictEqual(none, some)
})

test('the button is bound where every other Home control is bound', () => {
  assert.match(RENDERER, /getElementById\('home-add-music'\)\?\.addEventListener\('click', _addMusicFromHome\)/)
})

test('pressing it picks a folder, un-defers the wizard, and scans', async () => {
  const calls = { scans: 0, deferred: null, loading: 0, folders: 0 }
  const ctx = {
    console,
    state: { musicFolders: [] },
    window: { api: { addMusicFolder: async () => { calls.folders++; return ['/mnt/data/MUSIC'] } } },
    _setSetupDeferred(v) { calls.deferred = v },
    renderFolders() {},
    showLoading() { calls.loading++ },
    fullScan: async () => { calls.scans++ },
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext(lift(RENDERER, '_addMusicFromHome'), ctx)
  await vm.runInContext('_addMusicFromHome()', ctx)
  assert.strictEqual(calls.folders, 1)
  assert.deepStrictEqual(ctx.state.musicFolders, ['/mnt/data/MUSIC'])
  assert.strictEqual(calls.deferred, false, 'the person has now answered the wizard the other way')
  assert.strictEqual(calls.scans, 1)
})

test('cancelling the folder picker changes nothing', async () => {
  const calls = { scans: 0, deferred: 'untouched' }
  const ctx = {
    console,
    state: { musicFolders: [] },
    window: { api: { addMusicFolder: async () => null } },
    _setSetupDeferred(v) { calls.deferred = v },
    renderFolders() {}, showLoading() {},
    fullScan: async () => { calls.scans++ },
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext(lift(RENDERER, '_addMusicFromHome'), ctx)
  await vm.runInContext('_addMusicFromHome()', ctx)
  assert.strictEqual(calls.scans, 0)
  assert.strictEqual(calls.deferred, 'untouched')
  assert.deepStrictEqual(ctx.state.musicFolders, [])
})

test('a picker that throws does not take Home down with it', async () => {
  const ctx = {
    console,
    state: { musicFolders: [] },
    window: { api: { addMusicFolder: async () => { throw new Error('no dialog') } } },
    _setSetupDeferred() {}, renderFolders() {}, showLoading() {},
    fullScan: async () => {},
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext(lift(RENDERER, '_addMusicFromHome'), ctx)
  await vm.runInContext('_addMusicFromHome()', ctx)
})

// ── 2. The Liked Songs count ────────────────────────────────────────────────

// The two numbers as renderLikedSongs derives them, lifted by their own
// expressions so the test reads the real arithmetic.
function likedCounts(source, { likedPaths, libraryPaths }) {
  const byPath = new Map(libraryPaths.map(p => [p, { filePath: p, duration: 120 }]))
  const tracks = likedPaths.map(p => byPath.get(p)).filter(Boolean)
  const m = /\n  var totalLikedLocal = ([^\n]+)\n/.exec(source)
  assert.ok(m, 'the Local Likes count must still be one expression')
  const total = vm.runInNewContext(m[1], { tracks, state: { likedTracks: likedPaths } })
  return { listed: tracks.length, header: total }
}

test('the header count matches the list below it when the library is empty', () => {
  const c = likedCounts(RENDERER, {
    likedPaths: ['/mnt/data/MUSIC/a/karma.flac'],
    libraryPaths: [],
  })
  assert.strictEqual(c.listed, 0)
  assert.strictEqual(c.header, 0, 'the header used to say 1 over a list of 0')
})

test('and when only some of the liked files are in the library', () => {
  const c = likedCounts(RENDERER, {
    likedPaths: ['/a.flac', '/gone.flac', '/b.flac'],
    libraryPaths: ['/a.flac', '/b.flac'],
  })
  assert.strictEqual(c.header, 2)
  assert.strictEqual(c.header, c.listed)
})

test('a fully resolvable library is unchanged', () => {
  const c = likedCounts(RENDERER, {
    likedPaths: ['/a.flac', '/b.flac'],
    libraryPaths: ['/a.flac', '/b.flac', '/c.flac'],
  })
  assert.strictEqual(c.header, 2)
})

// ── Mutation checks ─────────────────────────────────────────────────────────

test('MUTATION: taking the CTA back out leaves the dead end', () => {
  const broken = RENDERER.replace('      <button id="home-add-music">Add your music</button>\n', '')
  assert.notStrictEqual(broken, RENDERER, 'the mutation applied')
  assert.doesNotMatch(emptyHomeHtml(broken), /home-add-music/, 'this is the reported bug')
})

test('MUTATION: counting the raw paths again puts the mismatch back', () => {
  const broken = RENDERER.replace('  var totalLikedLocal = tracks.length',
    '  var totalLikedLocal = state.likedTracks.length')
  assert.notStrictEqual(broken, RENDERER, 'the mutation applied')
  const c = likedCounts(broken, { likedPaths: ['/karma.flac'], libraryPaths: [] })
  assert.strictEqual(c.header, 1)
  assert.strictEqual(c.listed, 0, 'this is the reported bug: 1 Local Likes over 0 songs')
})
