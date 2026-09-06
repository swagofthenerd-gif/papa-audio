#!/usr/bin/env node
'use strict'

// ── Papa Audio end-to-end smoke harness (App #94) ────────────────────────────
// Launches the REAL app (`electron .`) in a throwaway profile, drives the live
// renderer over the Chrome DevTools Protocol, and proves the core surfaces
// actually render. Not a mock: this is the shipped main.js + renderer.js running
// on a real display.
//
// It must be able to run ALONGSIDE the user's already-running copy of the app,
// so it:
//   • points the child at a fresh temp userData dir via PAPA_USER_DATA (which
//     also scopes main.js's single-instance lock to that dir — see main.js), and
//   • opens its own --remote-debugging-port so it never touches the real app.
//
// The whole run is capped at 90 s; the child (and its process tree) is always
// killed and the temp dir always removed, pass or fail.
//
// The pure, side-effect-free helpers at the top are exported so
// test/e2e-format.test.js can unit-test the arg-building and result-formatting
// logic without launching anything.

const path = require('path')
const fs = require('fs')
const os = require('os')
const net = require('net')
const http = require('http')
const { spawn } = require('child_process')
const WebSocket = require('ws')

const REPO_ROOT = path.resolve(__dirname, '..')
const RUN_TIMEOUT_MS = 90000

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

// Build the argv for `electron .` with the debugging port. Kept pure so the
// test can assert the exact flags without spawning. --remote-debugging-port
// exposes the CDP endpoint; --remote-allow-origins=* lets our localhost
// WebSocket attach (Chromium 111+ rejects DevTools WS connections otherwise);
// --no-sandbox keeps the child from needing SUID sandbox in CI-like shells.
function buildElectronArgs(port, entry) {
	return [
		entry,
		`--remote-debugging-port=${port}`,
		'--remote-allow-origins=*',
		'--no-sandbox',
	]
}

// The environment for the child: inherit the parent's, but force the throwaway
// profile dir. Returned as a plain object so the test can assert PAPA_USER_DATA
// is set without reading process.env.
function buildChildEnv(baseEnv, userDataDir) {
	return Object.assign({}, baseEnv, { PAPA_USER_DATA: userDataDir })
}

// Format a single check result line. `ok === true` → PASS, anything else FAIL.
// Pure string formatting, so the test can pin the exact output shape.
function formatResultLine(name, ok, detail) {
	const tag = ok === true ? 'PASS' : 'FAIL'
	const suffix = detail ? `  (${detail})` : ''
	return `[${tag}] ${name}${suffix}`
}

// Reduce a list of {name, ok} results to an exit code: 0 iff every check
// passed. Pure, so the test can verify the gate logic directly.
function exitCodeFor(results) {
	return results.every(r => r.ok === true) ? 0 : 1
}

// Decide whether a captured console/exception entry counts as an "uncaught
// error" for the zero-errors check. We only fail on genuine error-level console
// output and thrown exceptions — warnings, logs and info are ignored. A small
// allowlist swallows noise that is expected in a fresh, network-isolated smoke
// profile (missing API keys, blocked catalog fetches) and is not a rendering
// bug. Pure: takes an entry, returns boolean.
function isFatalConsoleEntry(entry) {
	if (!entry || typeof entry !== 'object') return false
	const type = String(entry.type || '')
	const text = String(entry.text || '')
	if (type === 'exception') return !isBenignErrorText(text)
	if (type === 'error') return !isBenignErrorText(text)
	return false
}

// Substrings that mark an error as expected-in-a-fresh-offline-profile rather
// than a real rendering fault. Separated out so the test can exercise it.
const BENIGN_ERROR_PATTERNS = [
	'net::ERR_',                 // any blocked network fetch (no keys/offline)
	'Failed to load resource',   // blocked image/catalog request
	'ERR_INTERNET_DISCONNECTED',
	'ERR_NAME_NOT_RESOLVED',
	'TMDB',                      // catalog needs a key we don't set
	'tmdb',
	'ollama',                    // local LLM not running in a smoke run
	'ECONNREFUSED',              // slskd / ollama / any local daemon not up
	'5030',                      // slskd port
	'11434',                     // ollama port
]

function isBenignErrorText(text) {
	const t = String(text || '')
	return BENIGN_ERROR_PATTERNS.some(p => t.includes(p))
}

// Pick the page-target WebSocket URL from CDP's /json/list payload: the first
// entry of type "page". Pure list→url so the test can feed it a canned payload.
function pickPageTarget(targets) {
	if (!Array.isArray(targets)) return null
	const page = targets.find(t => t && t.type === 'page' && t.webSocketDebuggerUrl)
	return page ? page.webSocketDebuggerUrl : null
}

// ── Impure runtime plumbing ──────────────────────────────────────────────────

// Grab a free TCP port from the OS (bind :0, read the assigned port, release).
function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer()
		srv.on('error', reject)
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address()
			srv.close(() => resolve(port))
		})
	})
}

function sleep(ms) {
	return new Promise(r => setTimeout(r, ms))
}

// Poll CDP's HTTP /json/list until a page target appears, or time out.
async function waitForPageTarget(port, deadline) {
	while (Date.now() < deadline) {
		const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`)
			.catch(() => null)
		const url = pickPageTarget(targets)
		if (url) return url
		await sleep(250)
	}
	throw new Error('timed out waiting for a CDP page target')
}

function fetchJson(url) {
	return new Promise((resolve, reject) => {
		const req = http.get(url, res => {
			let body = ''
			res.on('data', c => { body += c })
			res.on('end', () => {
				try { resolve(JSON.parse(body)) }
				catch (e) { reject(e) }
			})
		})
		req.on('error', reject)
		req.setTimeout(2000, () => req.destroy(new Error('json/list timeout')))
	})
}

// A minimal CDP-over-WebSocket client: enough to enable Runtime, collect its
// console/exception events, and run Runtime.evaluate with an awaited result.
class CdpClient {
	constructor(wsUrl) {
		this.ws = new WebSocket(wsUrl, { perMessageDeflate: false })
		this._id = 0
		this._pending = new Map()
		this.consoleEntries = []
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
		// Events: collect console API calls and thrown exceptions.
		if (msg.method === 'Runtime.consoleAPICalled') {
			const args = (msg.params.args || [])
				.map(a => a.value !== undefined ? a.value : (a.description || ''))
				.join(' ')
			this.consoleEntries.push({ type: msg.params.type, text: args })
		} else if (msg.method === 'Runtime.exceptionThrown') {
			const d = msg.params.exceptionDetails || {}
			const text = (d.exception && (d.exception.description || d.exception.value))
				|| d.text || 'exception'
			this.consoleEntries.push({ type: 'exception', text: String(text) })
		}
	}

	send(method, params) {
		const id = ++this._id
		return new Promise((resolve, reject) => {
			this._pending.set(id, { resolve, reject })
			this.ws.send(JSON.stringify({ id, method, params: params || {} }))
		})
	}

	// Evaluate an expression in the page. Returns the resolved value (awaits
	// promises) or throws on a renderer-side exception.
	async evaluate(expression) {
		const res = await this.send('Runtime.evaluate', {
			expression,
			awaitPromise: true,
			returnByValue: true,
		})
		if (res.exceptionDetails) {
			const d = res.exceptionDetails
			const msg = (d.exception && (d.exception.description || d.exception.value))
				|| d.text || 'evaluate failed'
			throw new Error(String(msg))
		}
		return res.result ? res.result.value : undefined
	}

	close() {
		try { this.ws.close() } catch (_) { /* already closed */ }
	}
}

// Poll an expression until it returns truthy, or time out. Used to wait for
// asynchronously-rendered DOM to appear.
async function waitFor(cdp, expression, deadline, label) {
	while (Date.now() < deadline) {
		const v = await cdp.evaluate(expression).catch(() => false)
		if (v) return v
		await sleep(150)
	}
	throw new Error(`timed out waiting for: ${label || expression}`)
}

// Kill the child and its whole process tree. Electron forks helper processes;
// killing only the top pid leaves them running and holding the debug port.
function killTree(child) {
	if (!child || child.killed) return
	try { process.kill(-child.pid, 'SIGKILL') }   // negative pid → process group
	catch (_) {
		try { child.kill('SIGKILL') } catch (_) { /* already gone */ }
	}
}

// Remove the temp profile, retrying a few times: the just-killed Electron
// helpers may still be releasing handles, which makes the first rmSync throw.
async function removeDirWithRetry(dir) {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			fs.rmSync(dir, { recursive: true, force: true })
			if (!fs.existsSync(dir)) return
		} catch (_) { /* handles still open — wait and retry */ }
		await sleep(300)
	}
}

// ── The run ──────────────────────────────────────────────────────────────────

async function main() {
	const results = []
	const record = (name, ok, detail) => {
		results.push({ name, ok })
		console.log(formatResultLine(name, ok, detail))
	}

	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-e2e-'))
	const port = await freePort()
	const electronBin = require('electron') // resolves to the binary path
	const args = buildElectronArgs(port, REPO_ROOT)
	const env = buildChildEnv(process.env, userDataDir)

	let child = null
	let cdp = null
	const deadline = Date.now() + RUN_TIMEOUT_MS

	try {
		child = spawn(electronBin, args, {
			cwd: REPO_ROOT,
			env,
			detached: true,       // own process group, so killTree() reaps helpers
			stdio: 'ignore',
		})

		// ── Check: app window created ────────────────────────────────────────
		const wsUrl = await waitForPageTarget(port, deadline)
		record('app window created', !!wsUrl)

		cdp = new CdpClient(wsUrl)
		await cdp.open()
		await cdp.send('Runtime.enable')   // start collecting console/exceptions

		// Wait for the renderer to have finished its first paint: either the
		// wizard overlay or real content is present.
		await waitFor(
			cdp,
			`!!document.getElementById('setup-overlay') && !!document.getElementById('content')`,
			deadline,
			'renderer bootstrap',
		)

		// ── Check: first-run wizard shows on a fresh profile ─────────────────
		// A brand-new profile has no music folders, so init() shows the setup
		// overlay and returns early. Assert it, then skip through it via its own
		// buttons before touching anything else.
		const wizardShown = await waitFor(
			cdp,
			`(() => { const o = document.getElementById('setup-overlay');
			   return o && getComputedStyle(o).display !== 'none'; })()`,
			deadline,
			'first-run wizard',
		).then(() => true).catch(() => false)
		record('first-run wizard shows on fresh profile', wizardShown)

		// Dismiss it: Skip step 1 → Skip step 2 → Finish step 3, each guarded by
		// the button actually being visible. This drives the wizard's OWN wiring
		// (_initSetupWizard), not a shortcut around it.
		await cdp.evaluate(`document.getElementById('setup-skip-1')?.click()`)
		await sleep(120)
		await cdp.evaluate(`document.getElementById('setup-skip-2')?.click()`)
		await sleep(120)
		await cdp.evaluate(`document.getElementById('setup-finish')?.click()`)
		await sleep(200)

		const wizardGone = await waitFor(
			cdp,
			`(() => { const o = document.getElementById('setup-overlay');
			   return !o || getComputedStyle(o).display === 'none'; })()`,
			deadline,
			'wizard dismissed',
		).then(() => true).catch(() => false)
		record('first-run wizard dismissed via its own buttons', wizardGone)

		// init() returned early at the wizard, so Home was never rendered. Drive
		// the app's own navigate() to Home, the same call the sidebar makes.
		await cdp.evaluate(`navigate('home')`)

		// ── Check: home page rendered ────────────────────────────────────────
		const homeOk = await waitFor(
			cdp,
			`!!document.querySelector('#content .greeting')`,
			deadline,
			'home greeting',
		).then(() => true).catch(() => false)
		record('home page rendered', homeOk)

		// ── Check: navigate to the video tab via the app's navigate() ────────
		await cdp.evaluate(`navigate('video')`)
		const videoOk = await waitFor(
			cdp,
			`!!document.querySelector('#content .vpage.cinema')
			   && document.querySelector('.nav-item[data-page="video"]')?.classList.contains('active')`,
			deadline,
			'video tab shell',
		).then(() => true).catch(() => false)
		record('video tab shell rendered', videoOk)

		// ── Check: the search input exists ───────────────────────────────────
		// The video tab renders its own search field; the top bar carries the
		// music search. Assert both are present.
		const searchOk = await cdp.evaluate(
			`!!document.getElementById('video-search-input') && !!document.getElementById('tb-search')`,
		).catch(() => false)
		record('search input exists', searchOk === true)

		// ── Check: Settings opens and closes ─────────────────────────────────
		// Settings lives in the agent sidebar (#mcs). Open it via the app's
		// toggleChatSidebar(), switch to the Settings tab via _switchMcsTab, and
		// confirm the settings panel is the visible one; then close it again.
		await cdp.evaluate(`toggleChatSidebar()`)
		await cdp.evaluate(`_switchMcsTab('settings')`)
		const settingsOpen = await waitFor(
			cdp,
			`(() => { const m = document.getElementById('mcs');
			   const p = document.getElementById('mcs-panel-settings');
			   return m && m.classList.contains('open')
			     && p && !p.classList.contains('mcs-panel-hidden'); })()`,
			deadline,
			'settings panel open',
		).then(() => true).catch(() => false)

		await cdp.evaluate(`toggleChatSidebar()`)  // toggle closed again
		const settingsClosed = await waitFor(
			cdp,
			`(() => { const m = document.getElementById('mcs');
			   return m && !m.classList.contains('open'); })()`,
			deadline,
			'settings panel closed',
		).then(() => true).catch(() => false)
		record('Settings modal opens and closes', settingsOpen && settingsClosed)

		// ── Check: zero uncaught console errors during the run ───────────────
		const fatal = cdp.consoleEntries.filter(isFatalConsoleEntry)
		record(
			'zero uncaught console errors',
			fatal.length === 0,
			fatal.length ? fatal.map(f => f.text).slice(0, 3).join(' | ') : '',
		)
	} catch (err) {
		record('harness completed without throwing', false, err && err.message)
	} finally {
		if (cdp) cdp.close()
		killTree(child)
		// The killed Electron helpers can still hold handles into the profile for
		// a beat; give them a moment to actually exit, then remove with a couple
		// of retries so we don't litter /tmp with 2 MB profiles per run.
		await removeDirWithRetry(userDataDir)
	}

	const code = exitCodeFor(results)
	console.log('')
	console.log(code === 0
		? `SMOKE OK — ${results.length}/${results.length} checks passed`
		: `SMOKE FAILED — ${results.filter(r => !r.ok).length}/${results.length} checks failed`)
	return code
}

// ── Entry / exports ──────────────────────────────────────────────────────────

if (require.main === module) {
	// Hard wall-clock cap: if the run wedges past the timeout, force-exit.
	const guard = setTimeout(() => {
		console.error(`\nSMOKE FAILED — run exceeded ${RUN_TIMEOUT_MS}ms wall-clock cap`)
		process.exit(1)
	}, RUN_TIMEOUT_MS + 5000)
	guard.unref()

	main()
		.then(code => process.exit(code))
		.catch(err => {
			console.error('SMOKE FAILED — unexpected:', err && err.stack || err)
			process.exit(1)
		})
}

module.exports = {
	buildElectronArgs,
	buildChildEnv,
	formatResultLine,
	exitCodeFor,
	isFatalConsoleEntry,
	isBenignErrorText,
	pickPageTarget,
	BENIGN_ERROR_PATTERNS,
	RUN_TIMEOUT_MS,
}
