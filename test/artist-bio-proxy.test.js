'use strict'
// The artist biography had been dead since July.
//
// index.html's CSP has no `connect-src`, so `default-src 'self'` applied and
// Chromium refused the renderer's fetch to en.wikipedia.org — two
// "Refused to connect" errors per artist page, and every artist silently
// showing no bio. Widening the CSP so the renderer can talk to the internet is
// the wrong trade for one biography, so the lookup moved into main next to the
// other catalogue fetches.
//
// Main's handler is lifted and run for real against a stubbed fetch; the
// renderer's loadArtistBio is lifted and run against a stubbed window.api.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const { runHandler, MAIN_PATH } = require('./helpers/lift-ipc.js')

const MAIN = fs.readFileSync(MAIN_PATH, 'utf8')
const RSRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')

function fetchStub(impl) {
	const seen = []
	const fn = async (url, opts) => { seen.push({ url, opts }); return impl(url, opts) }
	fn.seen = seen
	return fn
}

const okBody = body => ({ ok: true, status: 200, json: async () => body })

// lift-ipc lifts the handle() call, not the module-level consts it closes over.
const BIO_TIMEOUT_MS = Number(/const ARTIST_BIO_TIMEOUT_MS = (\d+)/.exec(MAIN)[1])

function run(globals, args, timeoutMs) {
	return runHandler('artist-bio', {
		globals: Object.assign({ ARTIST_BIO_TIMEOUT_MS: BIO_TIMEOUT_MS }, globals),
		args, timeoutMs,
	})
}

// ── main: the handler ────────────────────────────────────────────────────────

test('the handler returns the extract and thumbnail from the summary endpoint', async () => {
	const f = fetchStub(() => okBody({ extract: 'Radiohead are an English rock band.', thumbnail: { source: 'https://x/rh.jpg' } }))
	const r = await run({ fetch: f }, { artist: 'Radiohead' })
	assert.strictEqual(r.result.ok, true)
	assert.strictEqual(r.result.extract, 'Radiohead are an English rock band.')
	assert.strictEqual(r.result.thumbnail, 'https://x/rh.jpg')
	assert.strictEqual(f.seen.length, 1)
	assert.strictEqual(f.seen[0].url, 'https://en.wikipedia.org/api/rest_v1/page/summary/Radiohead')
})

test('a name with a slash or space is encoded, not pasted into the path', async () => {
	const f = fetchStub(() => okBody({ extract: 'x' }))
	await run({ fetch: f }, { artist: 'AC/DC' })
	assert.strictEqual(f.seen[0].url, 'https://en.wikipedia.org/api/rest_v1/page/summary/AC%2FDC')
})

test('a disambiguation page is not printed as a biography', async () => {
	// "Air", "Bush", "Muse" and "Chicago" all resolve to one.
	const f = fetchStub(() => okBody({ type: 'disambiguation', extract: 'Air may refer to the following.' }))
	const r = await run({ fetch: f }, { artist: 'Air' })
	assert.strictEqual(r.result.ok, true)
	assert.strictEqual(r.result.extract, null)
})

test('a 404 answers { ok:false } — it never throws at the renderer', async () => {
	const f = fetchStub(() => ({ ok: false, status: 404, json: async () => ({}) }))
	const r = await run({ fetch: f }, { artist: 'Nobody' })
	assert.strictEqual(r.result.ok, false)
	assert.strictEqual(r.error, null)
})

test('a thrown fetch answers { ok:false }, not a rejected invoke', async () => {
	const f = fetchStub(() => { throw new Error('getaddrinfo ENOTFOUND') })
	const r = await run({ fetch: f }, { artist: 'Radiohead' })
	assert.strictEqual(r.result.ok, false)
	assert.strictEqual(r.result.reason, 'network')
	assert.strictEqual(r.error, null)
})

test('an empty artist name never reaches the network', async () => {
	const f = fetchStub(() => okBody({ extract: 'x' }))
	const r = await run({ fetch: f }, { artist: '  ' })
	assert.strictEqual(r.result.ok, false)
	assert.strictEqual(f.seen.length, 0)
})

test('the lookup is bounded to 6 s — a hung endpoint aborts', async () => {
	// A biography the user has stopped waiting for is worth nothing.
	const m = /const ARTIST_BIO_TIMEOUT_MS = (\d+)/.exec(MAIN)
	assert.ok(m, 'the timeout must be a named constant')
	assert.ok(Number(m[1]) <= 6000, 'budget must be 6 s or less, got ' + m[1])

	let aborted = false
	const f = fetchStub((url, opts) => new Promise((_, reject) => {
		opts.signal.addEventListener('abort', () => {
			aborted = true
			const e = new Error('aborted'); e.name = 'AbortError'; reject(e)
		})
	}))
	// Run with a clock that fires the abort timer immediately.
	const r = await run({
		fetch: f,
		setTimeout: (fn) => { setImmediate(fn); return 1 },
		clearTimeout: () => {},
	}, { artist: 'Radiohead' }, 1000)
	assert.strictEqual(aborted, true, 'the abort must actually reach the request')
	assert.strictEqual(r.result.ok, false)
	assert.strictEqual(r.result.reason, 'timeout')
})

// ── the CSP the move exists because of ───────────────────────────────────────

test('the CSP still has no connect-src — the fix is the proxy, not a widening', () => {
	const csp = /content="([^"]*)"/.exec(/Content-Security-Policy" content="([^"]*)"/.exec(HTML)[0])[1]
	assert.ok(!/connect-src/.test(csp),
		'if a connect-src ever appears, someone widened the CSP instead of proxying: ' + csp)
})

test('the renderer no longer fetches wikipedia directly', () => {
	assert.ok(!/fetch\('https:\/\/en\.wikipedia\.org/.test(RSRC),
		'a renderer fetch to wikipedia is refused by the CSP and cannot work')
})

// ── renderer: loadArtistBio against a stubbed window.api ─────────────────────

function liftLoadArtistBio() {
	const start = RSRC.indexOf('\nasync function loadArtistBio(')
	assert.ok(start > -1)
	const end = RSRC.indexOf('\n// Artist bio + similar-artist chips', start)
	assert.ok(end > start)
	return RSRC.slice(start, end)
}

function openArtistPage(artistBio) {
	const el = { style: { display: '' }, innerHTML: '', querySelector: () => null }
	const bag = new Map()
	const ctx = vm.createContext({
		Map, Set, String, Number, Math, Date, JSON, Promise, console,
		setTimeout, clearTimeout, AbortController, encodeURIComponent,
		document: {
			getElementById: id => (id === 'artist-bio' ? el : null),
		},
		esc: s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
		_cacheGet: (_m, k) => bag.get(k),
		_cacheSet: (_m, k, v) => bag.set(k, v),
		_bioCache: bag,
		_BIO_CACHE_CAP: 50,
		state: { currentPage: 'artist', currentArtistName: 'Radiohead', isOnline: true },
		window: { api: { artistBio } },
	})
	vm.runInContext(liftLoadArtistBio() + '\nvar __fn = loadArtistBio', ctx, { filename: 'renderer.js' })
	return { run: ctx.__fn, el, bag, state: ctx.state }
}

test('the renderer paints the bio it gets back from main', async () => {
	const p = openArtistPage(async ({ artist }) => {
		assert.strictEqual(artist, 'Radiohead')
		return { ok: true, extract: 'An English rock band.', thumbnail: null }
	})
	await p.run('Radiohead')
	assert.match(p.el.innerHTML, /An English rock band\./)
	assert.strictEqual(p.el.style.display, '')
})

test('{ ok:false } does not throw and the section says it could not be fetched', async () => {
	const p = openArtistPage(async () => ({ ok: false, reason: 'network' }))
	await assert.doesNotReject(() => p.run('Radiohead'))
	assert.match(p.el.innerHTML, /could not be fetched/i,
		'a failed lookup must read differently from "this artist has no bio": ' + p.el.innerHTML)
	assert.strictEqual(p.el.style.display, '')
})

test('an artist Wikipedia genuinely has nothing on hides the section', async () => {
	const p = openArtistPage(async () => ({ ok: true, extract: null, thumbnail: null }))
	await p.run('Radiohead')
	assert.strictEqual(p.el.style.display, 'none')
})

test('a failure while OFFLINE is not cached as "no bio" for the session', async () => {
	let calls = 0
	const p = openArtistPage(async () => { calls++; return { ok: false, reason: 'network' } })
	p.state.isOnline = false
	await p.run('Radiohead')
	assert.strictEqual(calls, 1)
	// A second visit while still offline asks again rather than serving a
	// cached "no bio": going offline once used to cost that artist its bio for
	// the rest of the session.
	await p.run('Radiohead')
	assert.strictEqual(calls, 2)
})
