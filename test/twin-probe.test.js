'use strict'
// tools/twin-probe.js — the reusable CDP probe that replaced the inline
// `node -e` blobs. Those blobs hid three renderer exceptions in one night
// because they read Runtime.evaluate's `result` and ignored `exceptionDetails`,
// so a page that threw reported `undefined` and looked healthy.
//
// The pure parts are required directly (requiring the module must not connect
// to anything). The exception-surfacing path is proven against a real, tiny
// CDP websocket server that answers Runtime.evaluate with an exceptionDetails
// payload — no Electron anywhere in this file.
const test = require('node:test')
const assert = require('node:assert')
const http = require('http')
const WebSocket = require('ws')

const probe = require('../tools/twin-probe.js')

// ── Arg parsing ──────────────────────────────────────────────────────────────

test('parseArgs reads the full flag set', () => {
	const o = probe.parseArgs([
		'--port', '9344', '--reload', '--wait-ready',
		'--nav', 'video,video-detail:movie:603',
		'--eval', 'state.currentPage', '--json',
	])
	assert.strictEqual(o.port, 9344)
	assert.strictEqual(o.reload, true)
	assert.strictEqual(o.waitReady, true)
	assert.strictEqual(o.json, true)
	assert.deepStrictEqual(o.evals, ['state.currentPage'])
	assert.strictEqual(o.readyTimeoutMs, probe.DEFAULT_READY_TIMEOUT_MS)
})

test('parseArgs requires --port and rejects junk ports', () => {
	assert.throws(() => probe.parseArgs([]), /--port is required/)
	assert.throws(() => probe.parseArgs(['--port', 'abc']), /TCP port/)
	assert.throws(() => probe.parseArgs(['--port', '0']), /TCP port/)
	assert.throws(() => probe.parseArgs(['--port']), /needs a value/)
})

test('parseArgs rejects an unknown flag instead of ignoring it', () => {
	// A typo'd --wait-redy that silently does nothing is how a probe lies about
	// what it checked.
	assert.throws(() => probe.parseArgs(['--port', '9344', '--wait-redy']),
		/unknown argument: --wait-redy/)
})

test('parseNavList splits page from id on the FIRST colon only', () => {
	// A video-detail id is itself colon-shaped; splitting on every colon threw
	// the id away, which is the difference between the page and its error state.
	assert.deepStrictEqual(probe.parseNavList('video,video-detail:movie:603, browse '), [
		{ page: 'video', navId: null },
		{ page: 'video-detail', navId: 'movie:603' },
		{ page: 'browse', navId: null },
	])
	assert.deepStrictEqual(probe.parseNavList(''), [])
})

// ── Readiness predicate ──────────────────────────────────────────────────────

test('READY_EXPR is false (not a throw) on a page where nothing has loaded', () => {
	// Navigating before this is true throws inside the renderer and looks like a
	// dead page. The predicate itself must never be the thing that throws.
	const evalIn = globals => {
		const fn = new Function('state', 'document', 'return ' + probe.READY_EXPR)
		return fn(globals.state, globals.document)
	}
	const noNav = { querySelector: () => null }
	const withNav = { querySelector: s => (s === '.nav-item' ? {} : null) }

	assert.strictEqual(evalIn({ state: undefined, document: noNav }), false)
	assert.strictEqual(evalIn({ state: null, document: withNav }), false)
	assert.strictEqual(evalIn({ state: {}, document: withNav }), false,
		'state with no currentPage is not ready')
	assert.strictEqual(evalIn({ state: { currentPage: 'home' }, document: noNav }), false,
		'no sidebar nav means the renderer has not painted')
	assert.strictEqual(evalIn({ state: { currentPage: 'home' }, document: withNav }), true)
})

// ── Error capture and grouping ───────────────────────────────────────────────

test('isIgnoredError swallows only the clean-shutdown line', () => {
	assert.strictEqual(probe.isIgnoredError(
		'[12345:0919/...] Previous session did not shut down cleanly'), true)
	assert.strictEqual(probe.isIgnoredError('TypeError: x is not a function'), false)
	assert.strictEqual(probe.isIgnoredError(''), false)
})

test('errorShape collapses ids, urls and quotes so one fault is one line', () => {
	const a = probe.errorShape('Failed to fetch https://api.tmdb.org/3/movie/603 (603)')
	const b = probe.errorShape('Failed to fetch https://api.tmdb.org/3/movie/1396 (1396)')
	assert.strictEqual(a, b)
	assert.strictEqual(probe.errorShape('Cannot read "poster" of undefined'),
		'Cannot read "…" of undefined')
	// Only the first line: a stack must not make every throw a unique shape.
	assert.strictEqual(probe.errorShape('TypeError: boom\n    at foo (x.js:1:2)'),
		'TypeError: boom')
})

test('groupErrors counts by shape and drops the ignored line', () => {
	const g = probe.groupErrors([
		{ type: 'exception', text: 'TypeError: boom 1' },
		{ type: 'exception', text: 'TypeError: boom 2' },
		{ type: 'console.error', text: 'Previous session did not shut down cleanly' },
		{ type: 'console.error', text: 'other fault' },
	])
	assert.strictEqual(g.length, 2)
	assert.strictEqual(g[0].count, 2)
	assert.strictEqual(g[0].shape, 'TypeError: boom <n>')
	assert.strictEqual(g[1].count, 1)
	assert.strictEqual(g.reduce((n, x) => n + x.count, 0), 3)
})

// ── Exception surfacing ──────────────────────────────────────────────────────

test('exceptionText reads description, then value, then text', () => {
	assert.strictEqual(probe.exceptionText(
		{ exception: { description: 'TypeError: nope\n at a' } }), 'TypeError: nope\n at a')
	assert.strictEqual(probe.exceptionText({ exception: { value: 'thrown string' } }),
		'thrown string')
	// Reading only `.text` yields the useless constant "Uncaught"; it is the
	// last resort, not the first.
	assert.strictEqual(probe.exceptionText({ text: 'Uncaught' }), 'Uncaught')
	assert.strictEqual(probe.exceptionText(null), '')
})

test('formatEvalThrew prints the exact line a run must never swallow', () => {
	assert.strictEqual(
		probe.formatEvalThrew({ exception: { description: 'TypeError: navigate is not a function' } }),
		'EVAL THREW: TypeError: navigate is not a function')
})

test('pickPageTarget picks the page target', () => {
	assert.strictEqual(probe.pickPageTarget([
		{ type: 'service_worker', webSocketDebuggerUrl: 'ws://x/sw' },
		{ type: 'page', webSocketDebuggerUrl: 'ws://x/page' },
	]), 'ws://x/page')
	assert.strictEqual(probe.pickPageTarget([{ type: 'page' }]), null)
	assert.strictEqual(probe.pickPageTarget(null), null)
})

// ── End to end against a fake CDP server ─────────────────────────────────────

// A CDP endpoint that answers every Runtime.evaluate with an exceptionDetails
// payload, exactly as Chromium does when the page throws. It also returns a
// `result`, which is the trap: a probe reading result.value alone sees
// `undefined` and reports nothing wrong.
function startFakeCdp() {
	return new Promise(resolve => {
		const server = http.createServer((req, res) => {
			if (req.url.startsWith('/json/list')) {
				const port = server.address().port
				res.setHeader('content-type', 'application/json')
				res.end(JSON.stringify([
					{ type: 'background_page', webSocketDebuggerUrl: 'ws://127.0.0.1:1/bg' },
					{ type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1` },
				]))
				return
			}
			res.statusCode = 404
			res.end('')
		})
		const wss = new WebSocket.Server({ server })
		wss.on('connection', sock => {
			sock.on('message', raw => {
				let msg
				try { msg = JSON.parse(raw) } catch (_) { return }
				if (msg.method === 'Runtime.evaluate') {
					sock.send(JSON.stringify({
						id: msg.id,
						result: {
							result: { type: 'undefined' },
							exceptionDetails: {
								exceptionId: 1,
								text: 'Uncaught',
								exception: { className: 'TypeError', description: 'TypeError: state is not defined' },
							},
						},
					}))
					return
				}
				sock.send(JSON.stringify({ id: msg.id, result: {} }))
			})
		})
		server.listen(0, '127.0.0.1', () => resolve({ server, wss, port: server.address().port }))
	})
}

test('a run against a page that throws prints EVAL THREW and counts it', async () => {
	const fake = await startFakeCdp()
	const lines = []
	try {
		const report = await probe.run({
			port: fake.port,
			reload: false,
			waitReady: false,
			readyTimeoutMs: 1000,
			nav: [],
			evals: ['state.currentPage'],
			json: false,
		}, l => lines.push(l))

		const printed = lines.join('\n')
		assert.ok(printed.includes('EVAL THREW: TypeError: state is not defined'),
			'the throw must be printed, not swallowed. Got:\n' + printed)
		// Both evaluates in this run threw: the dry-run read and the --eval.
		assert.ok(report.evalThrew >= 2, 'every throw is counted, got ' + report.evalThrew)
		// And the throw is not silently reported as a value.
		assert.strictEqual(report.evals[0].threw, true)
		assert.strictEqual(report.evals[0].value, undefined)
	} finally {
		fake.wss.close()
		fake.server.close()
	}
})

test('a run reports dryRun and whether the pill is actually in the DOM', async () => {
	// getAppInfo().dryRun being true is not the same as the user being able to
	// SEE that it is true, so the probe reports both, always.
	const fake = await new Promise(resolve => {
		const server = http.createServer((req, res) => {
			const port = server.address().port
			res.end(JSON.stringify([{ type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/d/1` }]))
		})
		const wss = new WebSocket.Server({ server })
		wss.on('connection', sock => {
			sock.on('message', raw => {
				const msg = JSON.parse(raw)
				if (msg.method !== 'Runtime.evaluate') {
					sock.send(JSON.stringify({ id: msg.id, result: {} })); return
				}
				sock.send(JSON.stringify({
					id: msg.id,
					result: { result: { type: 'object', value: { dryRun: true, err: null, pill: false, bodyClass: false } } },
				}))
			})
		})
		server.listen(0, '127.0.0.1', () => resolve({ server, wss, port: server.address().port }))
	})
	const lines = []
	try {
		const report = await probe.run({
			port: fake.port, reload: false, waitReady: false, readyTimeoutMs: 1000,
			nav: [], evals: [], json: false,
		}, l => lines.push(l))
		assert.strictEqual(report.dryRun.dryRun, true)
		assert.strictEqual(report.dryRun.pill, false)
		assert.ok(lines.join('\n').includes('pill=MISSING'),
			'a dry run with no visible pill must say so: ' + lines.join('\n'))
		assert.strictEqual(report.evalThrew, 0)
	} finally {
		fake.wss.close()
		fake.server.close()
	}
})
