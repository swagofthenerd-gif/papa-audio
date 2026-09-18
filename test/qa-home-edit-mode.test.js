'use strict'
// L3 — Home's "Customize" mode had no way out but its own Done button.
//
// _homeEditMode is a plain module flag. Escape did not touch it, and
// navigate() never cleared it, so clicking the gear and then a sidebar item
// left the flag set: coming back to Home half an hour later still showed the
// reorder/hide control bar stapled over every row, including hidden ones.
//
// Escape now leaves the mode (it is a page-level layer like every other one on
// that ladder), and leaving Home ends it.
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

function slice(source, from, to) {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  assert.ok(a > -1 && b > a, `slice ${from} .. ${to} not found`)
  return source.slice(a, b)
}

// The Escape ladder, lifted out of the global keydown handler so the real
// branch order runs — Escape must not reach Home's mode while a modal is up.
function liftEscapeLadder(source) {
  const at = source.indexOf('    // Escape\n    if (e.key === \'Escape\') {')
  assert.ok(at > -1, 'the Escape ladder must still exist')
  const end = source.indexOf('\n      return\n    }\n', at)
  assert.ok(end > at)
  return 'function _onEscape(e) {\n' + source.slice(source.indexOf('{', at) + 1, end + 15) + '\n}\n'
}

const PAGES = ['home', 'library', 'artists', 'album', 'artist', 'search', 'downloads',
  'soulseek', 'playlists', 'playlist', 'smartlist', 'manage', 'stats', 'trail', 'wrapped',
  'liked', 'yt-album', 'yt-artist', 'yt-see-all', 'yt-playlist', 'explore', 'video',
  'browse', 'person', 'video-detail', 'shelf', 'diary', 'calendar']
const RENDER_FN = {
  home: 'renderHome', library: 'renderLibrary', artists: 'renderArtists', album: 'renderAlbum',
  artist: 'renderArtist', search: 'renderSearch', downloads: 'renderDownloads',
  soulseek: 'renderSoulseekHub', playlists: 'renderPlaylists', playlist: 'renderPlaylist',
  smartlist: 'renderSmartList', manage: 'renderManage', stats: 'renderStats', trail: 'renderTrail',
  wrapped: 'renderWrapped', liked: 'renderLikedSongs', 'yt-album': 'renderYtAlbum',
  'yt-artist': 'renderYtArtist', 'yt-see-all': 'renderYtSeeAll', 'yt-playlist': 'renderYtPlaylist',
  explore: 'renderExplore', video: 'renderVideo', browse: 'renderBrowse', person: 'renderPerson',
  'video-detail': 'renderVideoDetail', shelf: 'renderShelf', diary: 'renderDiary',
  calendar: 'renderCalendar',
}

function harness(source, { modalOpen = false, focus = null, cmdPaletteOpen = false } = {}) {
  const els = {
    'tb-search': { id: 'tb-search', value: 'x', blur() {} },
    sidebar: { id: 'sidebar', closest: () => null },
    'player-bar': { id: 'player-bar', closest: () => null },
    content: { id: 'content', focus() {} },
    'cmd-palette': { id: 'cmd-palette', style: { display: cmdPaletteOpen ? 'flex' : 'none' } },
    'shortcuts-modal': { style: { display: 'none' } },
    'shortcuts-config-modal': { style: { display: 'none' } },
    'np-modal': { classList: { contains: () => false } },
    'ctx-menu': { style: { display: 'none' } },
  }
  const calls = { renderedHome: 0, toggledPalette: 0, hidNowPlaying: 0 }
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    _homeEditMode: false,
    state: { currentPage: 'home', modalOpen, library: [] },
    _scrollMemory: new Map(),
    document: {
      getElementById: id => els[id] || null,
      querySelectorAll: () => [],
      activeElement: focus ? els[focus] : null,
      body: { classList: { toggle() {} } },
    },
    window: { PapaJourney: null, api: { saveSessionState() {} } },
    requestAnimationFrame(fn) { fn() },
    chatState: { open: false },
    _lyricsDrawerOpen: false,
    toggleCommandPalette() { calls.toggledPalette++ },
    toggleChatSidebar() {}, toggleShortcutsModal() {}, toggleShortcutsConfig() {},
    closeLyricsDrawer() {}, closeNpQueue() {}, toggleNpFullArt() {},
    hideNowPlayingModal() { calls.hidNowPlaying++ },
    hideContextMenu() {},
    _restoreScrollTop() {}, _renderFailure() {}, _stopInlineTrailer() {},
    _dlLastSig: '', retuneDownloadsPolling() {}, updateNavBtns() {}, _journeyCrumbUpdate() {},
    calls,
  }
  for (const page of PAGES) ctx[RENDER_FN[page]] = function () {}
  ctx.renderHome = function () { calls.renderedHome++ }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext([
    slice(source, 'const NAV_HISTORY_CAP', '// ── Overlay dismissal on navigation'),
    slice(source, '// ── Overlay dismissal on navigation', 'let _playCountTimer'),
    'const SCROLL_MEMORY_CAP = 200',
    slice(source, 'const VIDEO_PAGES = new Set(', '\nfunction navigate('),
    lift(source, 'navigate'),
    lift(source, '_currentNavId'),
    liftEscapeLadder(source),
  ].join('\n'), ctx)
  return {
    ctx, calls,
    editing: () => vm.runInContext('_homeEditMode', ctx),
    setEditing: (v) => vm.runInContext('_homeEditMode = ' + !!v, ctx),
    escape: () => vm.runInContext('_onEscape({ key: "Escape" })', ctx),
  }
}

test('Escape leaves Customize mode and repaints Home', () => {
  const h = harness(RENDERER, { focus: null })
  h.setEditing(true)
  h.escape()
  assert.strictEqual(h.editing(), false, 'Done was the only way out')
  assert.ok(h.calls.renderedHome > 0, 'and the controls have to actually come off the page')
})

test('Escape does nothing extra when Customize is not on', () => {
  const h = harness(RENDERER)
  h.escape()
  assert.strictEqual(h.calls.renderedHome, 0, 'no gratuitous repaint of Home')
})

test('Escape on another page does not touch the flag', () => {
  const h = harness(RENDERER)
  h.setEditing(true)
  h.ctx.state.currentPage = 'library'
  h.escape()
  assert.strictEqual(h.calls.renderedHome, 0, 'Home is not even on screen')
})

test('a modal still wins the Escape — Customize is below it on the ladder', () => {
  const h = harness(RENDERER, { modalOpen: true })
  h.setEditing(true)
  h.escape()
  assert.strictEqual(h.calls.hidNowPlaying, 1, 'the Now Playing modal closed first')
  assert.strictEqual(h.editing(), true, 'and one Escape peeled exactly one layer')
})

test('and so does the Omnibox', () => {
  const h = harness(RENDERER, { cmdPaletteOpen: true })
  h.setEditing(true)
  h.escape()
  assert.strictEqual(h.calls.toggledPalette, 1)
  assert.strictEqual(h.editing(), true)
})

test('leaving Home ends Customize mode', () => {
  const h = harness(RENDERER)
  h.setEditing(true)
  h.ctx.navigate('library')
  assert.strictEqual(h.editing(), false,
    'it used to still be on when the user came back to Home')
})

test('and every page off Home does it, not just the sidebar ones', () => {
  for (const page of ['library', 'downloads', 'video', 'soulseek', 'playlists']) {
    const h = harness(RENDERER)
    h.setEditing(true)
    h.ctx.navigate(page)
    assert.strictEqual(h.editing(), false, page)
  }
})

test('navigating to Home itself does not cancel the mode', () => {
  // Home re-renders itself while reordering rows; that must not drop the mode.
  const h = harness(RENDERER)
  h.setEditing(true)
  h.ctx.navigate('home')
  assert.strictEqual(h.editing(), true)
})

// ── Mutation checks ─────────────────────────────────────────────────────────

test('MUTATION: without the navigate() reset the mode survives the trip again', () => {
  const broken = RENDERER.replace("  if (page !== 'home') _homeEditMode = false\n", '')
  assert.notStrictEqual(broken, RENDERER, 'the mutation applied')
  const h = harness(broken)
  h.setEditing(true)
  h.ctx.navigate('library')
  assert.strictEqual(h.editing(), true, 'this is the reported bug')
})

test('MUTATION: without the Escape branch Done is the only exit again', () => {
  const broken = RENDERER.replace(
    /      if \(_homeEditMode && state\.currentPage === 'home'\) \{\n        _homeEditMode = false\n        renderHome\(\)\n        return\n      \}\n/,
    '')
  assert.notStrictEqual(broken, RENDERER, 'the mutation applied')
  const h = harness(broken)
  h.setEditing(true)
  h.escape()
  assert.strictEqual(h.editing(), true, 'this is the reported bug')
})
