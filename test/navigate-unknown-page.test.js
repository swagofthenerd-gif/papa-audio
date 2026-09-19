'use strict'
// navigate() accepted any string. A typo or a stale saved session updated
// state.currentPage, pushed a history entry, repainted the nav highlight and
// saved the session -- then the render if-chain matched nothing and the app
// sat on the previous page's markup under a new identity, with Back pointing
// at a page that had never been left.
//
// The real navigate is lifted and run against a small shell model.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function liftFn(decl) {
	const at = R.indexOf(decl)
	assert.ok(at > -1, decl + ' must still exist in renderer.js')
	// The declaration itself contains `opts = {}`, so start at the brace that
	// opens the BODY, not the first brace in the signature.
	let i = at + decl.length
	let depth = 1
	while (depth > 0 && i < R.length) {
		const c = R[i]
		if (c === '{') depth++
		else if (c === '}') depth--
		i++
	}
	return R.slice(at, i)
}

const NAVIGATE = liftFn('function navigate(page, navId, opts = {}) {')
const PAGES = R.slice(R.indexOf('const NAV_PAGES = new Set(['),
	R.indexOf('])', R.indexOf('const NAV_PAGES = new Set([')) + 2)

function run(page, navId) {
	const log = []
	const env = { log, page, navId }
	return new Function('env', `
		const { log } = env
		const state = { currentPage: 'home', library: [], isOnline: true }
		const navHistory = []
		const navFuture = []
		const _scrollMemory = new Map()
		const SCROLL_MEMORY_CAP = 20
		const NAV_SESSION_CAP = 20
		const VIDEO_PAGES = new Set(['video', 'browse', 'person', 'video-detail', 'shelf', 'diary', 'calendar'])
		const YT_NAV_PAGES = new Set(['yt-album', 'yt-artist', 'yt-see-all', 'yt-playlist'])
		let _homeEditMode = false
		let _dlLastSig = 'sig'
		const document = {
			getElementById() { return { scrollTop: 0, classList: { toggle() {} } } },
			querySelectorAll() { return { forEach() { log.push('nav-highlight') } } },
			body: { classList: { toggle() {} } },
		}
		const window = { api: {
			saveSessionState(s) { log.push('saved:' + s.page) },
			videoWarmCancel() { return Promise.resolve() },
		} }
		const console = { warn(...a) { log.push('warn:' + a.join(' ')) } }
		const requestAnimationFrame = fn => fn()
		function _runNavDismiss() { log.push('dismiss') }
		function _currentNavId() { return null }
		function _pushNavHistory(e) { navHistory.push(e); log.push('history:' + e.page) }
		function _navEntrySlim(e) { return e }
		function _stopInlineTrailer() {}
		function _renderFailure(p) { log.push('render-failure:' + p) }
		function retuneDownloadsPolling() {}
		function updateNavBtns() {}
		function _journeyCrumbUpdate() {}
		function hideContextMenu() {}
		function _restoreScrollTop() {}
		function renderHome() { log.push('render:home') }
		function renderLibrary() { log.push('render:library') }
		${PAGES}
		${NAVIGATE}
		navigate(env.page, env.navId)
		return { page: state.currentPage, history: navHistory.length }
	`)(env)
}

test('a known page still navigates', () => {
	const { log } = { log: [] }
	const out = run('library')
	assert.strictEqual(out.page, 'library')
	assert.strictEqual(out.history, 1)
})

test('an unknown page id changes nothing at all', () => {
	const out = run('libary')
	assert.strictEqual(out.page, 'home', 'state.currentPage must not move to a page that cannot paint')
	assert.strictEqual(out.history, 0, 'and Back must not gain an entry for a page never left')
})

test('an unknown page id is said out loud rather than failing silently', () => {
	const log = []
	const env = { log, page: 'not-a-page', navId: null }
	new Function('env', `
		const { log } = env
		const console = { warn(...a) { log.push(a.join(' ')) } }
		const state = { currentPage: 'home' }
		function _runNavDismiss() { throw new Error('navigate() ran past the guard') }
		${PAGES}
		${NAVIGATE}
		navigate('not-a-page')
	`)(env)
	assert.ok(log.some(l => /refused an unknown page id/.test(l) && /not-a-page/.test(l)), JSON.stringify(log))
})

test('undefined and null are refused, not coerced into a page', () => {
	assert.strictEqual(run(undefined).page, 'home')
	assert.strictEqual(run(null).page, 'home')
	assert.strictEqual(run('').page, 'home')
})

test('every page id the app actually navigates to is in the allow list', () => {
	const ids = new Set()
	for (const f of ['renderer.js', 'slsk-shop-ui.js', 'slsk-album-view.js', 'video-player.js']) {
		const p = path.join(__dirname, '..', 'src', f)
		if (!fs.existsSync(p)) continue
		const src = fs.readFileSync(p, 'utf8')
		for (const m of src.matchAll(/navigate\(\s*'([a-z0-9-]+)'/g)) ids.add(m[1])
	}
	const allowed = new Set(PAGES.match(/'[a-z0-9-]+'/g).map(s => s.slice(1, -1)))
	const missing = [...ids].filter(i => !allowed.has(i))
	assert.deepStrictEqual(missing, [], 'these would now be refused: ' + missing.join(', '))
})
