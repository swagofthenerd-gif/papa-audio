'use strict'
// H2 — five dialogs outlived the page they were opened from.
//
// navigate() closes every overlay that registered a dismisser (_runNavDismiss),
// but none of the four .addpl-overlay dialogs (New playlist with folder, Import
// from text, the name-input dialog behind Rename and New folder, and Add to
// playlist) ever registered. Open one, click a sidebar item, and it floated
// over a page it had nothing to do with. _showNewPlaylistWithFolder had no
// re-entry guard either, so a double click built two stacked copies with only
// the top one reachable. The Soulseek Account modal (.modal-overlay) had
// neither, and ignored Escape on top of that.
//
// The real builders run here against a small DOM, and the real navigate()
// closes them.
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

// ── A DOM just big enough for these dialogs ─────────────────────────────────
// Elements hold their innerHTML as a string (the dialogs build markup that way)
// and hand out a stub for any selector asked of them, so every
// querySelector('#nim-ok').addEventListener(...) lands somewhere real.
function makeDom() {
  const listeners = {}
  function Stub(sel) {
    return {
      _sel: sel, value: '', textContent: '', disabled: false, focused: 0,
      isConnected: true,
      dataset: {}, style: { display: '' }, classList: { add() {}, remove() {}, toggle() {} },
      _l: {},
      addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn) },
      removeEventListener() {},
      fire(t, ev) { for (const fn of this._l[t] || []) fn(ev || {}) },
      focus() { this.focused++; document.activeElement = this },
      querySelector: () => null, querySelectorAll: () => [],
      remove() {},
    }
  }
  function El(tag) {
    const stubs = new Map()
    return {
      tagName: tag, id: '', className: '', innerHTML: '', isConnected: false,
      _stubs: stubs, _l: {},
      querySelector(sel) {
        if (!stubs.has(sel)) stubs.set(sel, Stub(sel))
        return stubs.get(sel)
      },
      querySelectorAll() { return [] },
      addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn) },
      removeEventListener() {},
      fire(t, ev) { for (const fn of this._l[t] || []) fn(ev || {}) },
      remove() {
        this.isConnected = false
        const i = document.body.children.indexOf(this)
        if (i > -1) document.body.children.splice(i, 1)
      },
    }
  }
  const document = {
    // Focus is part of a dialog's lifecycle: something owned it before the
    // dialog opened, and has to own it again after the dialog is gone.
    activeElement: null,
    body: {
      children: [],
      appendChild(el) { el.isConnected = true; this.children.push(el); return el },
    },
    createElement: (tag) => El(tag),
    getElementById(id) { return document.body.children.find(c => c.id === id) || null },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn) },
    removeEventListener(t, fn) {
      const a = listeners[t] || []
      const i = a.indexOf(fn)
      if (i > -1) a.splice(i, 1)
    },
    _fire(t, ev) { for (const fn of (listeners[t] || []).slice()) fn(ev) },
    _listenerCount(t) { return (listeners[t] || []).length },
  }
  document.body.classList = { toggle() {} }
  return document
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

function harness(source) {
  const document = makeDom()
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    document,
    state: {
      currentPage: 'playlists', playlists: [], playlistFolders: [], smartPlaylists: [],
      library: [],
    },
    slsk: { status: { username: 'sherrybaaz', connected: false } },
    _scrollMemory: new Map(),
    window: {
      PapaJourney: null,
      PapaMusicTools: { parseImportLines: () => [], playlistAddPlan: () => ({ fresh: [], dupes: [] }) },
      api: {
        saveSessionState() {}, savePlaylist() {}, slskConfigure: async () => ({ ok: true }),
        openExternal() {},
      },
    },
    requestAnimationFrame(fn) { fn() },
    setTimeout() { return 0 }, clearTimeout() {},
    esc: s => String(s == null ? '' : s),
    showSnackbar() {}, _plCollage: () => '', _persistPlaylistFolders() {},
    _restoreScrollTop() {}, _renderFailure() {}, _stopInlineTrailer() {},
    _dlLastSig: '', retuneDownloadsPolling() {}, updateNavBtns() {},
    _journeyCrumbUpdate() {}, hideContextMenu() {},
    refreshSlskStatus: async () => {}, renderSoulseekRow: () => '', bindSlskSearchEvents() {},
    runSlskSearch() {}, pushUndo() {}, _trapFocus: () => () => {},
  }
  for (const page of PAGES) ctx[RENDER_FN[page]] = function () {}
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext([
    slice(source, 'const NAV_HISTORY_CAP', '// ── Overlay dismissal on navigation'),
    slice(source, '// ── Overlay dismissal on navigation', 'let _playCountTimer'),
    'const SCROLL_MEMORY_CAP = 200',
    slice(source, 'const VIDEO_PAGES = new Set(', '\nfunction navigate('),
    lift(source, 'navigate'),
    lift(source, '_currentNavId'),
    lift(source, '_showNewPlaylistWithFolder'),
    lift(source, 'showImportPlaylistDialog'),
    lift(source, 'showNameInputModal'),
    lift(source, 'showAddToPlaylistModal'),
    lift(source, 'showSlskConfigModal'),
  ].join('\n'), ctx)
  return { ctx, document, overlays: () => document.body.children.map(c => c.className) }
}

// Each dialog, as the app opens it.
const DIALOGS = {
  'New playlist (with folder)': (c) => c._showNewPlaylistWithFolder(),
  'Import playlist from text': (c) => c.showImportPlaylistDialog(),
  'Rename / New folder (name input)': (c) => c.showNameInputModal('Rename playlist', 'Name', () => {}),
  'Add to playlist': (c) => c.showAddToPlaylistModal([{ id: 't1', title: 'Karma Police', filePath: '/a.flac' }]),
  'Soulseek Account': (c) => c.showSlskConfigModal('radiohead'),
}

for (const [name, open] of Object.entries(DIALOGS)) {
  test(`${name}: navigating away closes it`, () => {
    const h = harness(RENDERER)
    open(h.ctx)
    assert.strictEqual(h.document.body.children.length, 1, 'the dialog opened')
    h.ctx.navigate('home')
    assert.deepStrictEqual(h.overlays(), [],
      'it used to float over Home with nothing to do with it')
  })

  test(`${name}: opening it twice leaves exactly one`, () => {
    const h = harness(RENDERER)
    open(h.ctx)
    open(h.ctx)
    assert.strictEqual(h.document.body.children.length, 1)
  })

  test(`${name}: reopening after a navigation still works`, () => {
    // The unregister half: if close() left its dismisser in the set, the set
    // would grow without bound and a later navigation would try to remove a
    // node that is long gone.
    const h = harness(RENDERER)
    open(h.ctx)
    h.ctx.navigate('home')
    open(h.ctx)
    assert.strictEqual(h.document.body.children.length, 1)
    h.ctx.navigate('library')
    assert.deepStrictEqual(h.overlays(), [])
  })
}

test('Escape closes the Soulseek Account modal', () => {
  const h = harness(RENDERER)
  h.ctx.showSlskConfigModal('radiohead')
  assert.strictEqual(h.document.body.children.length, 1)
  let prevented = 0
  h.document._fire('keydown', { key: 'Escape', preventDefault() { prevented++ } })
  assert.deepStrictEqual(h.overlays(), [], 'Escape used to do nothing at all here')
  assert.strictEqual(prevented, 1)
})

test('and the Escape listener comes off with the modal', () => {
  const h = harness(RENDERER)
  const before = h.document._listenerCount('keydown')
  h.ctx.showSlskConfigModal('radiohead')
  assert.strictEqual(h.document._listenerCount('keydown'), before + 1)
  h.ctx.navigate('home')
  assert.strictEqual(h.document._listenerCount('keydown'), before,
    'a navigation-closed modal must not leave its key handler behind')
})

test('the dialogs carry the classes the app looks for when asking "is a modal up?"', () => {
  const h = harness(RENDERER)
  h.ctx._showNewPlaylistWithFolder()
  assert.strictEqual(h.document.body.children[0].className, 'addpl-overlay')
  h.ctx.navigate('home')
  h.ctx.showSlskConfigModal('q')
  assert.strictEqual(h.document.body.children[0].className, 'modal-overlay')
})

// ── Mutation checks ─────────────────────────────────────────────────────────

const REGISTER_LINES = [
  ['New playlist (with folder)', '  var close = function() { _unregisterNavDismiss(close); overlay.remove() }\n  _registerNavDismiss(close)\n'],
  ['Import playlist from text', '  var close = function () { _unregisterNavDismiss(close); overlay.remove() }\n  _registerNavDismiss(close)\n'],
  ['Soulseek Account', "  document.addEventListener('keydown', _onCfgKey)\n  _registerNavDismiss(_closeCfg)\n"],
]

for (const [name, line] of REGISTER_LINES) {
  test(`MUTATION: dropping ${name}'s registration leaves it over the next page`, () => {
    const broken = RENDERER.replace(line, line.replace(/\n  _registerNavDismiss\([^)]*\)\n/, '\n'))
    assert.notStrictEqual(broken, RENDERER, 'the mutation applied')
    const h = harness(broken)
    DIALOGS[name](h.ctx)
    h.ctx.navigate('home')
    assert.strictEqual(h.document.body.children.length, 1, 'this is the reported bug')
  })
}

test('MUTATION: dropping the name-input and add-to-playlist registrations too', () => {
  let broken = RENDERER
    .replace('  overlay._papaClose = close\n  _registerNavDismiss(close)\n  const confirm = () => {',
      '  const confirm = () => {')
    .replace('  overlay._papaClose = close\n  _registerNavDismiss(close)\n  const addTo',
      '  const addTo')
  assert.notStrictEqual(broken, RENDERER, 'the mutation applied')
  for (const name of ['Rename / New folder (name input)', 'Add to playlist']) {
    const h = harness(broken)
    DIALOGS[name](h.ctx)
    h.ctx.navigate('home')
    assert.strictEqual(h.document.body.children.length, 1, name + ': this is the reported bug')
  }
})

test('MUTATION: dropping the New-playlist re-entry guard stacks two dialogs again', () => {
  const broken = RENDERER.replace(
    "  if (_open) { _open.querySelector('#npfm-name')?.focus(); return }\n", '')
  assert.notStrictEqual(broken, RENDERER, 'the mutation applied')
  const h = harness(broken)
  h.ctx._showNewPlaylistWithFolder()
  h.ctx._showNewPlaylistWithFolder()
  assert.strictEqual(h.document.body.children.length, 2, 'this is the reported bug')
})

test('MUTATION: dropping the Soulseek Escape handler brings the trapped modal back', () => {
  const broken = RENDERER.replace(
    "  const _onCfgKey = e => { if (e.key === 'Escape') { e.preventDefault(); _closeCfg() } }\n  document.addEventListener('keydown', _onCfgKey)\n",
    "  const _onCfgKey = () => {}\n")
  assert.notStrictEqual(broken, RENDERER, 'the mutation applied')
  const h = harness(broken)
  h.ctx.showSlskConfigModal('radiohead')
  h.document._fire('keydown', { key: 'Escape', preventDefault() {} })
  assert.strictEqual(h.document.body.children.length, 1, 'this is the reported bug')
})

// ── The Soulseek Account modal's focus, open and close ──────────────────────
// It took no focus on open (focus stayed on the Settings button behind the
// overlay) and gave none back on close (it landed on whatever the browser
// picked next). Live: activeElement never left the Settings button while the
// dialog was up, and after Escape it was on an unrelated button.

// A control on the page behind the modal: the thing that opened it.
function settingsButton(document) {
  return {
    tagName: 'BUTTON', isConnected: true, focused: 0,
    focus() { this.focused++; document.activeElement = this },
  }
}

test('the Soulseek Account modal takes focus into the username field', () => {
  const h = harness(RENDERER)
  const opener = settingsButton(h.document)
  opener.focus()
  h.ctx.showSlskConfigModal('radiohead')
  const user = h.document.body.children[0].querySelector('#slsk-cfg-user')
  assert.strictEqual(h.document.activeElement, user,
    'focus used to stay on the opener behind the overlay')
  assert.ok(user.focused > 0)
})

test('and hands it back to the opener when Escape closes it', () => {
  const h = harness(RENDERER)
  const opener = settingsButton(h.document)
  opener.focus()
  h.ctx.showSlskConfigModal('radiohead')
  h.document._fire('keydown', { key: 'Escape', preventDefault() {} })
  assert.deepStrictEqual(h.overlays(), [], 'it closed')
  assert.strictEqual(h.document.activeElement, opener,
    'focus used to land on an unrelated button')
})

test('Cancel restores the opener too, not just Escape', () => {
  const h = harness(RENDERER)
  const opener = settingsButton(h.document)
  opener.focus()
  h.ctx.showSlskConfigModal('radiohead')
  h.document.body.children[0].querySelector('#slsk-cfg-cancel').fire('click')
  assert.deepStrictEqual(h.overlays(), [])
  assert.strictEqual(h.document.activeElement, opener)
})

test('an opener that is gone by closing time is left alone', () => {
  // The guard that keeps the restore from focusing a detached node.
  const h = harness(RENDERER)
  const opener = settingsButton(h.document)
  opener.focus()
  h.ctx.showSlskConfigModal('radiohead')
  opener.isConnected = false
  const before = opener.focused
  h.document._fire('keydown', { key: 'Escape', preventDefault() {} })
  assert.strictEqual(opener.focused, before, 'a removed opener must not be focused')
})

test('the modal installs a focus trap so Tab cannot walk the page behind it', () => {
  const h = harness(RENDERER)
  const trapped = []
  h.ctx._trapFocus = (container, opts) => { trapped.push(opts && opts.initial); return () => {} }
  h.ctx.showSlskConfigModal('radiohead')
  assert.deepStrictEqual(trapped, ['#slsk-cfg-user'])
})

test('MUTATION: dropping the opener restore drops focus on close again', () => {
  const broken = RENDERER.replace(
    "    if (opener && opener.isConnected && typeof opener.focus === 'function') {\n      try { opener.focus() } catch (_) {}\n    }\n",
    '')
  assert.notStrictEqual(broken, RENDERER, 'the mutation applied')
  const h = harness(broken)
  const opener = settingsButton(h.document)
  opener.focus()
  h.ctx.showSlskConfigModal('radiohead')
  h.document._fire('keydown', { key: 'Escape', preventDefault() {} })
  assert.notStrictEqual(h.document.activeElement, opener, 'this is the reported bug')
})

test('MUTATION: reading the opener after the dialog is focused breaks the restore', () => {
  const line = '  const opener = document.activeElement\n'
  const broken = RENDERER
    .replace(line, '')
    .replace('  // This one had neither:', line + '  // This one had neither:')
  assert.notStrictEqual(broken, RENDERER, 'the mutation applied')
  const h = harness(broken)
  const opener = settingsButton(h.document)
  opener.focus()
  h.ctx.showSlskConfigModal('radiohead')
  h.document._fire('keydown', { key: 'Escape', preventDefault() {} })
  assert.notStrictEqual(h.document.activeElement, opener,
    'the capture has to happen before the dialog exists')
})
