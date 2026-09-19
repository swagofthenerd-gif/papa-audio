'use strict'
// H1 — Back, Forward and session restore into an online-source page landed on a
// permanent error.
//
// navigate('yt-artist', 'UC...') rendered fine, but _currentNavId() had no case
// for the yt-* pages, so the history entry navigate() pushed carried navId:null.
// Pressing Back then called renderYtArtist(null): a skeleton, then "Couldn't
// load artist: Invalid artist id" behind a Retry button that re-asked with the
// same null forever. _NEEDS_NAV_ID omitted them too, so a session saved on one
// of those pages reopened straight into the same dead end instead of Home.
//
// These tests run the real navigate(), _currentNavId(), navigateBack() and
// _restoreNavStacks() against stubbed renderers and look at what got rendered
// with what id.
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

// Every page renderer navigate() can reach, so a stub exists for each and the
// test can read back which one ran with which id.
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
  const rendered = []
  const saved = []
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    state: { currentPage: null },
    _scrollMemory: new Map(),
    rendered, saved,
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
      body: { classList: { toggle() {} } },
    },
    window: { PapaJourney: null, api: { saveSessionState: (s) => saved.push(s) } },
    requestAnimationFrame(fn) { fn() },
    _restoreScrollTop() {},
    _renderFailure(page, err) { rendered.push(['RENDER-FAILURE', page, String(err)]) },
    _stopInlineTrailer() {},
    _dlLastSig: '',
    retuneDownloadsPolling() {}, updateNavBtns() {}, _journeyCrumbUpdate() {},
    hideContextMenu() {},
  }
  for (const page of PAGES) {
    ctx[RENDER_FN[page]] = function (navId) { rendered.push([page, navId === undefined ? null : navId]) }
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext([
    slice(source, 'const NAV_HISTORY_CAP', '// ── Overlay dismissal on navigation'),
    slice(source, '// ── Overlay dismissal on navigation', 'let _playCountTimer'),
    'const SCROLL_MEMORY_CAP = 200',
    slice(source, 'const VIDEO_PAGES = new Set(', '\nfunction navigate('),
    lift(source, 'navigate'),
    lift(source, '_currentNavId'),
    lift(source, 'navigateBack'),
    lift(source, 'navigateForward'),
  ].join('\n'), ctx)
  const stacks = vm.runInContext('({ navHistory, navFuture })', ctx)
  return { ctx, rendered, saved, stacks, run: (code) => vm.runInContext(code, ctx) }
}

const YT_CASES = [
  ['yt-artist', 'UCxyz_channel'],
  ['yt-album', 'MPREb_album123'],
  ['yt-see-all', 'album::radiohead'],
  ['yt-playlist', 'PL_playlist999'],
  ['wrapped', '2024'],
]

for (const [page, id] of YT_CASES) {
  test(`${page} records its id in the history entry it pushes`, () => {
    const h = harness(RENDERER)
    h.ctx.navigate(page, id)
    h.ctx.navigate('library')
    assert.strictEqual(h.stacks.navHistory.at(-1).page, page)
    assert.strictEqual(h.stacks.navHistory.at(-1).navId, id,
      'a null here is the bug: Back would re-render the page with no id')
  })

  test(`Back into ${page} re-renders it with the id, not null`, () => {
    const h = harness(RENDERER)
    h.ctx.navigate(page, id)
    h.ctx.navigate('library')
    h.rendered.length = 0
    h.ctx.navigateBack()
    assert.strictEqual(h.rendered.length, 1)
    assert.strictEqual(h.rendered[0][0], page)
    assert.strictEqual(h.rendered[0][1], id)
  })

  test(`Forward back out of ${page} keeps the id too`, () => {
    const h = harness(RENDERER)
    h.ctx.navigate(page, id)
    h.ctx.navigate('library')
    h.ctx.navigateBack()       // back to the yt page
    h.ctx.navigateBack()       // ...and off it again? no: history is empty now
    h.rendered.length = 0
    h.ctx.navigateForward()
    assert.strictEqual(h.rendered.length, 1)
    assert.strictEqual(h.rendered[0][0], 'library')
    // The entry Forward pushed back onto history is the yt page WITH its id.
    assert.strictEqual(h.stacks.navHistory.at(-1).navId, id)
  })

  test(`the session saved on ${page} carries the id`, () => {
    const h = harness(RENDERER)
    h.ctx.navigate(page, id)
    assert.strictEqual(h.saved.at(-1).navId, id)
  })
}

test('leaving a yt page clears the id, so the next page is not tagged with it', () => {
  const h = harness(RENDERER)
  h.ctx.navigate('yt-artist', 'UCxyz_channel')
  h.ctx.navigate('library')
  assert.strictEqual(h.ctx._currentNavId(), null)
  assert.strictEqual(h.ctx.state.currentYtNavId, null)
})

test('the four yt pages are dead ends without an id, so a restore drops them', () => {
  const h = harness(RENDERER)
  h.run(`_restoreNavStacks({ history: [
    { page: 'yt-artist', navId: null },
    { page: 'yt-album', navId: null },
    { page: 'yt-see-all', navId: null },
    { page: 'yt-playlist', navId: null },
    { page: 'yt-artist', navId: 'UCkeep' },
    { page: 'home', navId: null },
  ], future: [] })`)
  assert.strictEqual(h.stacks.navHistory.map(e => e.page + ':' + e.navId).join('|'),
    'yt-artist:UCkeep|home:null')
})

test('wrapped with no year is NOT a dead end — it opens the current one', () => {
  const h = harness(RENDERER)
  h.run(`_restoreNavStacks({ history: [{ page: 'wrapped', navId: null }], future: [] })`)
  assert.strictEqual(h.stacks.navHistory.length, 1,
    'renderWrapped falls back to this year, so an id-less entry still renders')
})

// ── Mutation checks ─────────────────────────────────────────────────────────

test('MUTATION: dropping the _currentNavId branch makes Back render null again', () => {
  const broken = RENDERER.replace(
    '  if (YT_NAV_PAGES.has(state.currentPage)) return state.currentYtNavId\n', '')
  assert.notStrictEqual(broken, RENDERER, 'the mutation applied')
  const h = harness(broken)
  h.ctx.navigate('yt-artist', 'UCxyz_channel')
  h.ctx.navigate('library')
  h.rendered.length = 0
  h.ctx.navigateBack()
  assert.strictEqual(h.rendered.length, 1)
  assert.strictEqual(h.rendered[0][0], 'yt-artist')
  assert.ok(!h.rendered[0][1], 'this is the reported bug: rendered with no id')
})

test('MUTATION: not recording the id in navigate() is the same bug one step earlier', () => {
  const broken = RENDERER.replace(
    /\n  state\.currentYtNavId {5}= YT_NAV_PAGES\.has\(page\) \? \(navId \?\? null\) : null/, '')
  assert.notStrictEqual(broken, RENDERER, 'the mutation applied')
  const h = harness(broken)
  h.ctx.navigate('yt-album', 'MPREb_album123')
  h.ctx.navigate('library')
  assert.ok(!h.stacks.navHistory.at(-1).navId, 'no id was recorded, so Back gets nothing')
})

test('MUTATION: taking the yt pages back out of _NEEDS_NAV_ID re-admits dead entries', () => {
  const broken = RENDERER.replace(
    "'yt-album', 'yt-artist', 'yt-see-all', 'yt-playlist', 'soulseek-explore']", "'soulseek-explore']")
  assert.notStrictEqual(broken, RENDERER, 'the mutation applied')
  const h = harness(broken)
  h.run(`_restoreNavStacks({ history: [{ page: 'yt-artist', navId: null }], future: [] })`)
  assert.strictEqual(h.stacks.navHistory.length, 1, 'the dead entry survives again')
})
