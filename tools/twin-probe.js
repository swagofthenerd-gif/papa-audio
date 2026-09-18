#!/usr/bin/env node
'use strict'

// ── Papa Audio twin probe ────────────────────────────────────────────────────
// A read-only CDP probe for an ALREADY-RUNNING twin. It never launches and
// never kills Electron; you start the twin yourself and point this at its
// --remote-debugging-port.
//
//   node tools/twin-probe.js --port 9344 --wait-ready
//   node tools/twin-probe.js --port 9344 --wait-ready --nav video,video-detail:movie:603
//   node tools/twin-probe.js --port 9344 --eval "state.currentPage" --json
//
// It exists because the inline `node -e` blobs it replaces hid three renderer
// exceptions in one night. Every lesson below is paid for:
//
//   * Runtime.evaluate returns exceptionDetails ALONGSIDE a result. A probe
//     that reads `result.value` and ignores exceptionDetails reports
//     `undefined` for a page that actually threw. Every evaluate here surfaces
//     the throw as `EVAL THREW: <text>` and counts it.
//   * Navigating before the renderer is ready throws inside navigate() and
//     looks exactly like a dead page. --wait-ready waits for the renderer to
//     actually exist (state, state.currentPage, the sidebar) and prints how
//     long that took, so "slow start" can never again be read as "bug".
//   * A probe run against a credentialed twin is a safety incident waiting to
//     happen, so every run reports getAppInfo().dryRun and whether the DRY RUN
//     pill is actually in the DOM.
//
// The pure helpers at the top are exported so test/twin-probe.test.js can
// exercise them without connecting to anything.

const http = require('http')
const WebSocket = require('ws')

const DEFAULT_READY_TIMEOUT_MS = 60000
const NAV_SETTLE_MS = 5000
const POLL_MS = 200

// The one line a fresh twin profile always emits and which means nothing: the
// profile was copied, not shut down. Ignored everywhere errors are collected.
const IGNORED_ERROR_PATTERNS = [
	'previous session did not shut down cleanly',
]

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

// Parse argv (the slice AFTER node + script). Unknown flags are an error
// rather than a silent no-op: a typo'd --wait-redy that quietly does nothing is
// how a probe lies about what it checked.
function parseArgs(argv) {
	const out = {
		port: null,
		reload: false,
		waitReady: false,
		readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
		nav: [],
		evals: [],
		json: false,
	}
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		const need = () => {
			const v = argv[++i]
			if (v === undefined) throw new Error(`${a} needs a value`)
			return v
		}
		if (a === '--port') {
			const v = Number(need())
			if (!Number.isInteger(v) || v <= 0 || v > 65535) {
				throw new Error('--port must be a TCP port number')
			}
			out.port = v
		} else if (a === '--reload') {
			out.reload = true
		} else if (a === '--wait-ready') {
			out.waitReady = true
		} else if (a === '--ready-timeout') {
			const v = Number(need())
			if (!Number.isFinite(v) || v <= 0) {
				throw new Error('--ready-timeout must be milliseconds')
			}
			out.readyTimeoutMs = v
		} else if (a === '--nav') {
			out.nav = parseNavList(need())
		} else if (a === '--eval') {
			out.evals.push(need())
		} else if (a === '--json') {
			out.json = true
		} else {
			throw new Error(`unknown argument: ${a}`)
		}
	}
	if (out.port === null) throw new Error('--port is required')
	return out
}

// "video,video-detail:movie:603" → [{page:'video',navId:null},
//                                   {page:'video-detail',navId:'movie:603'}]
// Only the FIRST colon separates page from id: a video-detail id is itself
// colon-shaped ("movie:603"), and splitting on every colon threw away the id,
// which is the difference between a real page and the error state.
function parseNavList(spec) {
	return String(spec || '')
		.split(',')
		.map(s => s.trim())
		.filter(Boolean)
		.map(entry => {
			const i = entry.indexOf(':')
			if (i === -1) return { page: entry, navId: null }
			return { page: entry.slice(0, i), navId: entry.slice(i + 1) || null }
		})
}

// The readiness predicate, as an expression safe to evaluate on a page where
// nothing has loaded yet: `typeof state` never throws, and the && chain stops
// before touching a property of undefined. Concretely: the renderer's state
// object exists, it has settled on a page, and the sidebar nav is painted.
const READY_EXPR =
	"(typeof state !== 'undefined' && !!state && !!state.currentPage " +
	"&& !!document.querySelector('.nav-item'))"

function isIgnoredError(text) {
	const t = String(text || '').toLowerCase()
	return IGNORED_ERROR_PATTERNS.some(p => t.includes(p))
}

// Collapse an error message to its SHAPE so two occurrences of the same fault
// with different ids group together: numbers, quoted strings and urls are the
// parts that vary. Without this, one failing loop prints 200 lines that look
// like 200 distinct bugs.
function errorShape(text) {
	return String(text || '')
		.split('\n')[0]
		.replace(/https?:\/\/\S+/g, '<url>')
		.replace(/"[^"]*"/g, '"…"')
		.replace(/'[^']*'/g, "'…'")
		.replace(/\b\d+\b/g, '<n>')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 140)
}

// Group captured entries by shape, newest-count-first. Entries whose text is
// ignored are dropped here, in one place, so no caller can forget.
function groupErrors(entries) {
	const byShape = new Map()
	for (const e of entries || []) {
		const text = String((e && e.text) || '')
		if (isIgnoredError(text)) continue
		const shape = errorShape(text)
		if (!shape) continue
		const hit = byShape.get(shape)
		if (hit) { hit.count++; continue }
		byShape.set(shape, { shape, count: 1, type: (e && e.type) || 'error', sample: text.slice(0, 400) })
	}
	return Array.from(byShape.values()).sort((a, b) => b.count - a.count)
}

// Pull the human-readable message out of a CDP exceptionDetails payload. CDP
// puts the useful text in three different places depending on how the throw
// happened; reading only `.text` yields the useless constant "Uncaught".
function exceptionText(details) {
	if (!details) return ''
	const ex = details.exception
	if (ex) {
		if (ex.description) return String(ex.description)
		if (ex.value !== undefined && ex.value !== null) return String(ex.value)
		if (ex.className) return String(ex.className)
	}
	if (details.text) return String(details.text)
	return 'unknown renderer exception'
}

// The one line that must never be swallowed.
function formatEvalThrew(details) {
	return 'EVAL THREW: ' + exceptionText(details)
}

// First CDP target of type "page" with a websocket url.
function pickPageTarget(targets) {
	if (!Array.isArray(targets)) return null
	const page = targets.find(t => t && t.type === 'page' && t.webSocketDebuggerUrl)
	return page ? page.webSocketDebuggerUrl : null
}

// ── Impure plumbing ──────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function fetchJson(url, timeoutMs) {
	return new Promise((resolve, reject) => {
		const req = http.get(url, res => {
			let body = ''
			res.on('data', c => { body += c })
			res.on('end', () => {
				try { resolve(JSON.parse(body)) } catch (e) { reject(e) }
			})
		})
		req.on('error', reject)
		req.setTimeout(timeoutMs || 3000, () => req.destroy(new Error('json/list timeout')))
	})
}

// A minimal CDP client. Read-only by construction: it exposes Runtime.evaluate
// and Page.reload and nothing else. No Input domain, no Target manipulation —
// if --click is ever added it goes here, deliberately, not by accident.
class Probe {
	// `say` is where an EVAL THREW line goes. Injectable rather than hardwired
	// to console.log so --json keeps it inside the JSON and the test can read it
	// back: a line only console.log can emit is a line no test can assert on.
	constructor(wsUrl, say) {
		this.say = say || console.log
		this.ws = new WebSocket(wsUrl, { perMessageDeflate: false })
		this._id = 0
		this._pending = new Map()
		this.errors = []          // { type, text } — exceptions + console errors
		this.evalThrewCount = 0
		this.ws.on('message', raw => this._onMessage(raw))
	}

	open() {
		return new Promise((resolve, reject) => {
			this.ws.once('open', resolve)
			this.ws.once('error', reject)
		})
	}

	_onMessage(raw) {
		let msg
		try { msg = JSON.parse(raw) } catch (_) { return }
		if (msg.id && this._pending.has(msg.id)) {
			const { resolve, reject } = this._pending.get(msg.id)
			this._pending.delete(msg.id)
			if (msg.error) reject(new Error(msg.error.message || 'CDP error'))
			else resolve(msg.result)
			return
		}
		if (msg.method === 'Runtime.exceptionThrown') {
			const d = (msg.params && msg.params.exceptionDetails) || {}
			this.errors.push({ type: 'exception', text: exceptionText(d) })
		} else if (msg.method === 'Runtime.consoleAPICalled') {
			const p = msg.params || {}
			if (p.type !== 'error') return
			const text = (p.args || [])
				.map(a => (a.value !== undefined ? a.value : (a.description || '')))
				.join(' ')
			this.errors.push({ type: 'console.error', text: String(text) })
		}
	}

	send(method, params) {
		const id = ++this._id
		return new Promise((resolve, reject) => {
			this._pending.set(id, { resolve, reject })
			try { this.ws.send(JSON.stringify({ id, method, params: params || {} })) }
			catch (e) { this._pending.delete(id); reject(e) }
		})
	}

	// Every evaluate goes through here, so there is exactly one place that can
	// decide what to do with exceptionDetails — and it always prints.
	async evaluate(expression, opts) {
		const res = await this.send('Runtime.evaluate', {
			expression,
			awaitPromise: true,
			returnByValue: true,
		})
		if (res && res.exceptionDetails) {
			this.evalThrewCount++
			const line = formatEvalThrew(res.exceptionDetails)
			if (!(opts && opts.quiet)) this.say(line)
			this.errors.push({ type: 'eval', text: exceptionText(res.exceptionDetails) })
			return { threw: true, text: exceptionText(res.exceptionDetails), value: undefined }
		}
		return { threw: false, value: res && res.result ? res.result.value : undefined }
	}

	close() { try { this.ws.close() } catch (_) { /* already closed */ } }
}

// Poll the readiness predicate. Returns ms taken, or throws after the cap.
// Quiet evaluates: on a page that has not loaded, the predicate is false, not
// an exception — a throw here is real and still counted.
async function waitForReady(probe, timeoutMs) {
	const t0 = Date.now()
	const deadline = t0 + timeoutMs
	for (;;) {
		const r = await probe.evaluate(READY_EXPR, { quiet: true })
		if (r.value === true) return Date.now() - t0
		if (Date.now() >= deadline) {
			throw new Error(`renderer not ready after ${Math.round(timeoutMs / 1000)}s ` +
				`(${READY_EXPR} still false)`)
		}
		await sleep(POLL_MS)
	}
}

// One --nav step. Navigating and reading straight back reports the OLD page,
// so wait for state.currentPage to actually change (or give up after 5 s and
// say so rather than reporting a page that never painted).
async function navStep(probe, step) {
	const before = (await probe.evaluate('typeof state !== "undefined" && state ? state.currentPage : null',
		{ quiet: true })).value
	const errorsBefore = probe.errors.length

	const call = step.navId === null
		? `navigate(${JSON.stringify(step.page)})`
		: `navigate(${JSON.stringify(step.page)}, ${JSON.stringify(step.navId)})`
	const navRes = await probe.evaluate(call)

	const deadline = Date.now() + NAV_SETTLE_MS
	let settled = false
	while (Date.now() < deadline) {
		const now = (await probe.evaluate('typeof state !== "undefined" && state ? state.currentPage : null',
			{ quiet: true })).value
		if (now !== before) { settled = true; break }
		await sleep(POLL_MS)
	}

	const snap = await probe.evaluate(`(() => {
		const c = document.getElementById('content')
		return {
			page: (typeof state !== 'undefined' && state) ? state.currentPage : null,
			navId: (typeof state !== 'undefined' && state) ? (state.currentVideoNavId || null) : null,
			contentLen: c ? (c.innerText || '').trim().length : -1,
			skeleton: !!document.querySelector('[class*="skel"], .artist-bio-skeleton'),
		}
	})()`)

	return {
		requested: step,
		navThrew: navRes.threw,
		settled,
		page: snap.value ? snap.value.page : null,
		navId: snap.value ? snap.value.navId : null,
		contentLen: snap.value ? snap.value.contentLen : -1,
		skeleton: snap.value ? snap.value.skeleton : null,
		newErrors: groupErrors(probe.errors.slice(errorsBefore)),
	}
}

// getAppInfo().dryRun plus whether the pill is really on screen. Both, because
// the whole point is that the flag being true is not the same as the user
// being able to SEE that it is true.
async function readDryRun(probe) {
	const r = await probe.evaluate(`(async () => {
		let dryRun = null, err = null
		try { const i = await window.api.getAppInfo(); dryRun = i ? !!i.dryRun : null }
		catch (e) { err = String(e && e.message || e) }
		return {
			dryRun,
			err,
			pill: !!document.getElementById('dry-run-pill'),
			bodyClass: !!(document.body && document.body.classList.contains('is-dry-run')),
		}
	})()`)
	return r.value || { dryRun: null, err: 'evaluate threw', pill: false, bodyClass: false }
}

async function run(opts, out) {
	const say = out || console.log
	const report = { port: opts.port, ready: null, dryRun: null, nav: [], evals: [], errors: [], evalThrew: 0 }

	const targets = await fetchJson(`http://127.0.0.1:${opts.port}/json/list`)
	const wsUrl = pickPageTarget(targets)
	if (!wsUrl) throw new Error(`no CDP page target on port ${opts.port} (is the twin running?)`)

	const probe = new Probe(wsUrl, say)
	await probe.open()
	try {
		await probe.send('Runtime.enable')

		if (opts.reload) {
			await probe.send('Page.enable').catch(() => {})
			await probe.send('Page.reload', { ignoreCache: false })
			say('reloaded the page')
		}

		if (opts.waitReady) {
			const ms = await waitForReady(probe, opts.readyTimeoutMs)
			report.ready = ms
			say(`ready in ${ms} ms`)
		}

		const dr = await readDryRun(probe)
		report.dryRun = dr
		say(`dryRun=${dr.dryRun} pill=${dr.pill ? 'present' : 'MISSING'} ` +
			`body.is-dry-run=${dr.bodyClass ? 'yes' : 'no'}` + (dr.err ? ` (getAppInfo: ${dr.err})` : ''))
		if (dr.dryRun === false) {
			say('WARNING: this twin is NOT in dry run — main will perform real side effects')
		}

		for (const step of opts.nav) {
			const r = await navStep(probe, step)
			report.nav.push(r)
			const want = step.navId ? `${step.page}:${step.navId}` : step.page
			say(`nav ${want} -> page=${r.page}${r.navId ? ' id=' + r.navId : ''} ` +
				`content=${r.contentLen} chars skeleton=${r.skeleton ? 'yes' : 'no'} ` +
				`${r.settled ? '' : '(page never changed within 5s) '}` +
				`errors=${r.newErrors.reduce((n, g) => n + g.count, 0)}`)
			for (const g of r.newErrors) say(`    x${g.count} ${g.shape}`)
		}

		for (const expr of opts.evals) {
			const r = await probe.evaluate(expr)
			report.evals.push({ expr, threw: r.threw, value: r.threw ? undefined : r.value })
			if (!r.threw) say(`eval ${expr} => ${JSON.stringify(r.value)}`)
		}

		// Give any last async exception a tick to arrive before we group.
		await sleep(250)
		report.errors = groupErrors(probe.errors)
		report.evalThrew = probe.evalThrewCount
		say(`errors: ${report.errors.reduce((n, g) => n + g.count, 0)} in ${report.errors.length} shapes` +
			(probe.evalThrewCount ? `, ${probe.evalThrewCount} evaluate(s) threw` : ''))
		for (const g of report.errors) say(`  x${g.count} [${g.type}] ${g.shape}`)
	} finally {
		probe.close()
	}
	return report
}

async function main() {
	let opts
	try { opts = parseArgs(process.argv.slice(2)) }
	catch (e) {
		console.error(String(e.message))
		console.error('usage: node tools/twin-probe.js --port N [--reload] [--wait-ready] ' +
			'[--ready-timeout MS] [--nav a,b:id] [--eval EXPR] [--json]')
		process.exit(2)
	}
	const lines = []
	const say = opts.json ? l => lines.push(l) : console.log
	try {
		const report = await run(opts, say)
		if (opts.json) console.log(JSON.stringify(report, null, 2))
		const bad = report.evalThrew > 0 || (opts.waitReady && report.ready === null)
		process.exit(bad ? 1 : 0)
	} catch (e) {
		if (opts.json) console.log(JSON.stringify({ error: String(e && e.message || e), lines }, null, 2))
		else console.error('PROBE FAILED: ' + String(e && e.message || e))
		process.exit(1)
	}
}

module.exports = {
	parseArgs,
	parseNavList,
	READY_EXPR,
	DEFAULT_READY_TIMEOUT_MS,
	NAV_SETTLE_MS,
	IGNORED_ERROR_PATTERNS,
	isIgnoredError,
	errorShape,
	groupErrors,
	exceptionText,
	formatEvalThrew,
	pickPageTarget,
	Probe,
	run,
}

if (require.main === module) main()
