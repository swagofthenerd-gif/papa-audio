'use strict'
// The saved page, scroll offset and Back/Forward stacks come back on every
// boot -- not only when the MUSIC library cache is non-empty. This drives the
// real _bootRestore() (lifted from the renderer with _restoreNavStacks and
// fullScan) against a stubbed window.api, so it sees behaviour, not text.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

// A top-level function's source, `async` keyword included, up to its closing
// brace at column 0.
function lift(name) {
  const m = new RegExp(`\\n(async )?function ${name}\\(`).exec(RENDERER)
  assert.ok(m, `${name} not found in the renderer`)
  const start = m.index + 1
  const end = RENDERER.indexOf('\n}\n', start)
  assert.ok(end > start, `${name} has no closing brace`)
  return RENDERER.slice(start, end + 2)
}

// The nav-stack block: caps, the two stacks, _NEEDS_NAV_ID, _restoreNavStacks.
const NAV_BLOCK = RENDERER.slice(RENDERER.indexOf('const NAV_HISTORY_CAP'),
  RENDERER.indexOf('// ── Overlay dismissal on navigation'))

// One boot, fully stubbed. Returns what the boot did.
async function boot({ cached, session, folders = [], scan, uncleanExit = false }) {
  const calls = { navigate: [], scanLibrary: 0, showLoading: 0, timers: [], snackbars: [] }
  // navHistory/navFuture are `const` in the lifted block, so they never become
  // properties of the context object; they are read out of the vm below.
  let stacks = { navHistory: [], navFuture: [] }
  const ctx = {
    console: { log() {}, error() {}, warn() {} },
    state: { library: [], musicFolders: folders, currentPage: null, _unavailableRoots: [] },
    _scrollMemory: new Map(),
    _uncleanExit: uncleanExit,
    window: { api: {
      getLibraryCache: async () => cached,
      getSessionState: async () => session,
      scanLibrary: async () => { calls.scanLibrary++; return scan || { albums: [] } },
    } },
    navigate(page, navId, opts) {
      calls.navigate.push({ page, navId, opts, library: ctx.state.library.length,
        history: stacks.navHistory.map(e => e.page).join(','),
        future: stacks.navFuture.map(e => e.page).join(',') })
      ctx.state.currentPage = page
    },
    showLoading() { calls.showLoading++ },
    setTimeout(fn, ms) { calls.timers.push({ name: fn.name, ms }) },
    showSnackbar(msg) { calls.snackbars.push(msg) },
    checkFollowedArtistsForNew() {}, syncLibraryExt() {}, backgroundSync() {},
    restorePlaybackState() {}, _offerCrashRestore() {}, fetchMissingArtwork() {},
    _reportUnavailableRoots() {}, _plural: (n, w) => n + ' ' + w + (n === 1 ? '' : 's'),
  }
  vm.createContext(ctx)
  vm.runInContext(NAV_BLOCK + lift('_bootRestore') + lift('fullScan'), ctx)
  stacks = vm.runInContext('({ navHistory, navFuture })', ctx)
  await vm.runInContext('_bootRestore()', ctx)
  return { calls, ctx, stacks }
}

const SAVED = {
  page: 'video-detail', navId: 'tmdb:tv:31911', scrollTop: 640,
  history: [{ page: 'home', navId: null }, { page: 'video', navId: 'tokyo revengers' }],
  future: [{ page: 'shelf', navId: 'trending' }],
}

// No music folders, nothing cached: the normal state for a Movies & TV user.
// null is the cache after a wipe or a failed read; [] is an empty scan.
for (const cached of [[], null]) test(`a ${cached ? 'empty' : 'missing'} library cache still reopens the saved page, stacks and scroll`, async () => {
  const { calls, ctx } = await boot({ cached, session: SAVED })
  assert.strictEqual(calls.navigate.length, 1, 'exactly one landing')
  const nav = calls.navigate[0]
  assert.strictEqual(nav.page, 'video-detail')
  assert.strictEqual(nav.navId, 'tmdb:tv:31911')
  // JSON: the opts object comes from the vm realm, where deepStrictEqual
  // rejects the foreign Object prototype.
  assert.strictEqual(JSON.stringify(nav.opts), '{"skipHistory":true,"restoreScroll":true}')
  // The stacks were rebuilt BEFORE the landing, so Back is live immediately.
  assert.strictEqual(nav.history, 'home,video')
  assert.strictEqual(nav.future, 'shelf')
  // The persisted offset was seeded for restoreScroll to read.
  assert.strictEqual(ctx._scrollMemory.get('video-detail:tmdb:tv:31911'), 640)
  // And nothing was scanned or spun for a library that does not exist.
  assert.strictEqual(calls.scanLibrary, 0)
  assert.strictEqual(calls.showLoading, 0)
  assert.strictEqual(calls.timers.length, 0, 'no library timers without a library')
})

test('folders but no cache: scan first, then land on the saved page, not Home', async () => {
  const albums = [{ id: 'a1' }, { id: 'a2' }]
  const { calls, ctx } = await boot({
    cached: [], folders: ['/mnt/data/MUSIC'], session: SAVED, scan: { albums },
  })
  assert.strictEqual(calls.showLoading, 1, 'the spinner shows while scanning')
  assert.strictEqual(calls.scanLibrary, 1)
  // fullScan no longer forces Home: one landing, the saved page, after the scan.
  assert.strictEqual(calls.navigate.length, 1)
  assert.strictEqual(calls.navigate[0].page, 'video-detail')
  assert.strictEqual(calls.navigate[0].library, 2, 'the scan landed before the page did')
  assert.strictEqual(ctx.state.library.length, 2)
  assert.strictEqual(calls.snackbars.length, 1, 'the scan still reports its count')
})

test('a boot scan that fails still lands the saved page instead of stranding the spinner', async () => {
  const { calls } = await boot({
    cached: [], folders: ['/mnt/data/MUSIC'], session: SAVED, scan: { failed: true, error: 'EIO' },
  })
  assert.strictEqual(calls.navigate.map(n => n.page).join(','), 'video-detail')
})

test('the needs-a-navId guard still applies with no library: an id-less album page falls back to Home', async () => {
  const { calls } = await boot({ cached: [], session: { page: 'album', navId: null, scrollTop: 10 } })
  assert.strictEqual(calls.navigate.length, 1)
  assert.strictEqual(calls.navigate[0].page, 'home')
  assert.strictEqual(calls.navigate[0].navId, null)
  assert.strictEqual(JSON.stringify(calls.navigate[0].opts), '{"skipHistory":true,"restoreScroll":true}')
})

test('no session at all lands on Home with empty stacks', async () => {
  const { calls, stacks } = await boot({ cached: [], session: null })
  assert.strictEqual(calls.navigate.length, 1)
  assert.strictEqual(calls.navigate[0].page, 'home')
  assert.strictEqual(stacks.navHistory.length + stacks.navFuture.length, 0)
})

test('a cached library restores the page the same way and still schedules its follow-ups', async () => {
  const cached = [{ id: 'a1' }]
  const { calls, ctx } = await boot({ cached, session: SAVED })
  assert.strictEqual(calls.navigate.length, 1)
  assert.strictEqual(calls.navigate[0].page, 'video-detail')
  assert.strictEqual(calls.navigate[0].history, 'home,video')
  assert.strictEqual(ctx.state.library, cached)
  assert.strictEqual(calls.scanLibrary, 0, 'a cached library is not rescanned in the foreground')
  assert.deepStrictEqual(calls.timers.map(t => t.name), ['backgroundSync', 'restorePlaybackState'])
})

test('after an unclean exit the crash banner is offered instead of a silent queue restore', async () => {
  const { calls } = await boot({ cached: [{ id: 'a1' }], session: SAVED, uncleanExit: true })
  assert.deepStrictEqual(calls.timers.map(t => t.name), ['backgroundSync', '_offerCrashRestore'])
})

test('fullScan still lands on Home for every caller that does not opt out', async () => {
  // Add-folder, remove-folder, the wizard: they end on Home as before.
  const { ctx, calls } = await boot({ cached: [{ id: 'a1' }], session: SAVED })
  calls.navigate.length = 0
  await vm.runInContext('fullScan()', ctx)
  assert.strictEqual(calls.navigate.map(n => n.page).join(','), 'home')
  calls.navigate.length = 0
  await vm.runInContext('fullScan({ land: false })', ctx)
  assert.strictEqual(calls.navigate.length, 0)
})

test('init hands off to _bootRestore as its last step, after the video store is hydrated', () => {
  const initAt = RENDERER.indexOf('async function init()')
  const storeAt = RENDERER.indexOf('await (window.PapaVideoStore?.init?.()', initAt)
  const handoff = RENDERER.indexOf('\n  await _bootRestore()\n}\n', initAt)
  assert.ok(initAt > -1 && storeAt > initAt && handoff > storeAt,
    'Continue Watching needs the store ready before the landing page renders')
  assert.strictEqual(RENDERER.indexOf('_bootRestore()', initAt), handoff + 9, 'one call, and it is the last statement')
})
